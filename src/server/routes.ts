import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AccountRuntime } from "../auth/runtime.js";
import { AppError } from "../shared/errors.js";
import { LoginLimiter, SecurityStore } from "./security.js";
import type { ActivityLog } from "./activity.js";

export const sessionToken = (request: FastifyRequest): string =>
  request.headers.cookie
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("maple_session="))
    ?.slice(14) ?? "";
export function bodyObject(
  body: unknown,
  fields: string[],
): Record<string, unknown> {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some((key) => !fields.includes(key))
  )
    throw new AppError(400, "invalid_request", "请求包含无效字段。");
  return body as Record<string, unknown>;
}
function text(
  value: unknown,
  name: string,
  optional = false,
): string | undefined {
  if (optional && value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > 1024)
    throw new AppError(400, "invalid_request", "字段格式无效。", name);
  return value;
}
function boolean(
  value: unknown,
  name: string,
  optional = false,
): boolean | undefined {
  if (optional && value === undefined) return undefined;
  if (typeof value !== "boolean")
    throw new AppError(400, "invalid_request", "字段必须是布尔值。", name);
  return value;
}
interface Job {
  id: string;
  status: "pending" | "completed" | "failed" | "cancelled";
  createdAt: string;
  code?: string;
}
export function registerAdmin(
  app: FastifyInstance,
  runtime: AccountRuntime,
  security: SecurityStore,
  activity: ActivityLog,
): void {
  const limiter = new LoginLimiter(),
    jobs = new Map<string, Job>();
  let active: string | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  app.addHook("onClose", async () => {
    if (deadline) clearTimeout(deadline);
    if (active) runtime.cancelSignIn();
  });
  const auth = async (request: FastifyRequest) => {
    const session = await security.session(sessionToken(request));
    if (!session)
      throw new AppError(401, "admin_unauthorized", "请先登录管理控制台。");
    if (
      !["GET", "HEAD"].includes(request.method) &&
      request.headers["x-csrf-token"] !== session.csrfToken
    )
      throw new AppError(
        403,
        "csrf_failed",
        "管理操作验证失败，请刷新后重试。",
      );
  };
  app.get("/api/admin/session", async (request) => {
    const session = await security.session(sessionToken(request));
    return {
      configured: await security.configured(),
      authenticated: !!session,
      ...(session ? { csrfToken: session.csrfToken } : {}),
    };
  });
  app.post("/api/admin/login", async (request, reply) => {
    limiter.check(`${request.ip}|${request.headers.origin}`);
    const body = bodyObject(request.body, ["password"]);
    const password = text(body.password, "password")!;
    if (!(await security.configured()))
      throw new AppError(
        409,
        "password_not_configured",
        "请在本机运行 npm run setup 设置管理密码。",
      );
    const session = await security.authenticate(password);
    if (!session) throw new AppError(401, "invalid_password", "密码不正确。");
    security.endSession(sessionToken(request));
    reply.header(
      "set-cookie",
      `maple_session=${session.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`,
    );
    return { authenticated: true, csrfToken: session.csrfToken };
  });
  app.post(
    "/api/admin/logout",
    { preHandler: auth },
    async (request, reply) => {
      security.endSession(sessionToken(request));
      reply.header(
        "set-cookie",
        "maple_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
      );
      return { authenticated: false };
    },
  );
  app.get("/api/admin/accounts", { preHandler: auth }, async () => ({
    accounts: await runtime.listAccounts(),
  }));
  app.post(
    "/api/admin/accounts/:id/default",
    { preHandler: auth },
    async (request) => {
      await runtime.selectAccount((request.params as { id: string }).id);
      return { ok: true };
    },
  );
  app.patch(
    "/api/admin/accounts/:id",
    { preHandler: auth },
    async (request) => {
      const body = bodyObject(request.body, ["enabled"]);
      await runtime.setEnabled(
        (request.params as { id: string }).id,
        boolean(body.enabled, "enabled")!,
      );
      return { ok: true };
    },
  );
  app.post(
    "/api/admin/accounts/:id/disconnect",
    { preHandler: auth },
    async (request) => {
      await runtime.disconnect((request.params as { id: string }).id);
      return { ok: true };
    },
  );
  app.get("/api/admin/models", { preHandler: auth }, async () => ({
    models: await runtime.listModels(),
  }));
  app.get("/api/admin/keys", { preHandler: auth }, async () => ({
    keys: await security.listKeys(),
  }));
  app.post("/api/admin/keys", { preHandler: auth }, async (request, reply) => {
    const body = bodyObject(request.body, ["name"]);
    return reply
      .code(201)
      .send(await security.createKey(text(body.name, "name")!));
  });
  app.post(
    "/api/admin/keys/:id/secret",
    { preHandler: auth },
    async (request) => ({
      secret: await security.getKeySecret(
        (request.params as { id: string }).id,
      ),
    }),
  );
  app.delete(
    "/api/admin/keys/:id",
    { preHandler: auth },
    async (request, reply) => {
      await security.revokeKey((request.params as { id: string }).id);
      return reply.code(204).send();
    },
  );
  app.get("/api/admin/requests", { preHandler: auth }, async () => ({
    requests: activity.list(),
  }));
  app.post(
    "/api/admin/sign-in",
    { preHandler: auth },
    async (request, reply) => {
      const body = bodyObject(request.body ?? {}, [
        "profileId",
        "newProfile",
        "label",
        "reconsent",
      ]);
      const options = {
        profileId: text(body.profileId, "profileId", true),
        newProfile: boolean(body.newProfile, "newProfile", true),
        label: text(body.label, "label", true),
        reconsent: boolean(body.reconsent, "reconsent", true),
      };
      if (active) throw new AppError(409, "sign_in_busy", "已有登录正在进行。");
      while (jobs.size >= 32) jobs.delete(jobs.keys().next().value!);
      const job: Job = {
        id: randomUUID(),
        status: "pending",
        createdAt: new Date().toISOString(),
      };
      jobs.set(job.id, job);
      active = job.id;
      const finish = () => {
        if (active === job.id) {
          active = undefined;
          if (deadline) clearTimeout(deadline);
          deadline = undefined;
        }
      };
      deadline = setTimeout(() => {
        if (job.status === "pending") {
          job.status = "failed";
          job.code = "sign_in_timeout";
          runtime.cancelSignIn();
          // Retain the reservation until the sign-in promise actually settles.
        }
      }, 5 * 60_000);
      deadline.unref();
      Promise.resolve()
        .then(() => runtime.signIn(options))
        .then(
          () => {
            if (job.status === "pending") job.status = "completed";
          },
          (error) => {
            if (job.status === "pending") {
              job.status = "failed";
              job.code =
                error instanceof AppError
                  ? safeField(error.code)
                  : "sign_in_failed";
            }
          },
        )
        .finally(finish);
      return reply.code(202).send({ ...job });
    },
  );
  app.get("/api/admin/sign-in/:id", { preHandler: auth }, async (request) => {
    const job = jobs.get((request.params as { id: string }).id);
    if (!job) throw new AppError(404, "not_found", "登录任务不存在。");
    return { ...job };
  });
  app.delete(
    "/api/admin/sign-in/:id",
    { preHandler: auth },
    async (request) => {
      const job = jobs.get((request.params as { id: string }).id);
      if (!job) throw new AppError(404, "not_found", "登录任务不存在。");
      if (job.status === "pending") {
        job.status = "cancelled";
        runtime.cancelSignIn(); /* Keep active until cancellation settles. */
      }
      return { ...job };
    },
  );
}
export const safeField = (value: unknown, max = 128): string | undefined =>
  typeof value === "string" &&
  value.length <= max &&
  /^[A-Za-z0-9_.:/-]+$/.test(value)
    ? value
    : undefined;
