import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type {
  AccountRuntime,
  SignInMode,
  SignInRequest,
  SignInProgress,
} from "../auth/runtime.js";
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
  mode: SignInMode;
  expiresAt: string;
  phase: "preparing" | "awaiting_callback" | "exchanging";
  options: SignInRequest & { mode: SignInMode };
  authorizationUrl?: string;
}
interface InternalJob extends Job {
  submitCallback?: (callbackUrl: string) => void;
}
function publicJob(job: InternalJob): Job {
  const options: Job["options"] = { mode: job.mode };
  for (const key of [
    "profileId",
    "newProfile",
    "label",
    "reconsent",
  ] as const) {
    if (job.options[key] !== undefined)
      Object.assign(options, { [key]: job.options[key] });
  }
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    ...(job.code ? { code: job.code } : {}),
    mode: job.mode,
    expiresAt: job.expiresAt,
    phase: job.phase,
    options,
    ...(job.mode === "manual" &&
    job.status === "pending" &&
    job.phase === "awaiting_callback" &&
    job.authorizationUrl
      ? { authorizationUrl: job.authorizationUrl }
      : {}),
  };
}
function clearCallback(job: InternalJob): void {
  delete job.authorizationUrl;
  delete job.submitCallback;
}
export function registerAdmin(
  app: FastifyInstance,
  runtime: AccountRuntime,
  security: SecurityStore,
  activity: ActivityLog,
): void {
  const limiter = new LoginLimiter(),
    jobs = new Map<string, InternalJob>();
  let active: string | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const expire = (job: InternalJob, timerElapsed = false): boolean => {
    if (job.status !== "pending") return false;
    if (!timerElapsed && Date.now() < Date.parse(job.expiresAt)) return false;
    job.status = "failed";
    job.code = "sign_in_timeout";
    clearCallback(job);
    if (active === job.id) runtime.cancelSignIn();
    return true;
  };
  app.addHook("onClose", async () => {
    if (deadline) clearTimeout(deadline);
    if (active) {
      const job = jobs.get(active);
      if (job) {
        clearCallback(job);
        if (job.status === "pending") job.status = "cancelled";
      }
      runtime.cancelSignIn();
    }
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
        "mode",
      ]);
      if (
        body.mode !== undefined &&
        body.mode !== "browser" &&
        body.mode !== "manual"
      )
        throw new AppError(400, "invalid_request", "登录模式无效。", "mode");
      const mode: SignInMode = body.mode === "manual" ? "manual" : "browser";
      const options = {
        profileId: text(body.profileId, "profileId", true),
        newProfile: boolean(body.newProfile, "newProfile", true),
        label: text(body.label, "label", true),
        reconsent: boolean(body.reconsent, "reconsent", true),
        mode,
      };
      if (active) throw new AppError(409, "sign_in_busy", "已有登录正在进行。");
      while (jobs.size >= 32) jobs.delete(jobs.keys().next().value!);
      const createdAt = Date.now();
      const duration = (mode === "manual" ? 10 : 5) * 60_000;
      const job: InternalJob = {
        id: randomUUID(),
        status: "pending",
        createdAt: new Date(createdAt).toISOString(),
        mode,
        expiresAt: new Date(createdAt + duration).toISOString(),
        phase: "preparing",
        options,
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
      const onProgress = (progress: SignInProgress) => {
        if (active !== job.id || job.status !== "pending" || expire(job))
          return;
        clearCallback(job);
        job.phase = progress.phase;
        if (progress.phase === "awaiting_callback" && mode === "manual") {
          job.authorizationUrl = progress.authorizationUrl;
          job.submitCallback = progress.submitCallback;
        }
      };
      deadline = setTimeout(() => expire(job, true), duration);
      deadline.unref();
      Promise.resolve()
        .then(() =>
          job.status === "pending" && !expire(job)
            ? runtime.signIn({ ...options, onProgress })
            : undefined,
        )
        .then(
          () => {
            if (job.status === "pending" && !expire(job))
              job.status = "completed";
            clearCallback(job);
          },
          (error) => {
            if (job.status === "pending" && !expire(job)) {
              job.status = "failed";
              job.code =
                error instanceof AppError
                  ? safeField(error.code)
                  : "sign_in_failed";
            }
            clearCallback(job);
          },
        )
        .finally(finish);
      return reply.code(202).send(publicJob(job));
    },
  );
  app.get("/api/admin/sign-in/:id", { preHandler: auth }, async (request) => {
    const job = jobs.get((request.params as { id: string }).id);
    if (!job) throw new AppError(404, "not_found", "登录任务不存在。");
    expire(job);
    return publicJob(job);
  });
  app.get("/api/admin/sign-in/active", { preHandler: auth }, async () => {
    const job = active ? jobs.get(active) : undefined;
    if (job) expire(job);
    return { job: job ? publicJob(job) : null };
  });
  app.post(
    "/api/admin/sign-in/:id/callback",
    { preHandler: auth },
    async (request, reply) => {
      const job = jobs.get((request.params as { id: string }).id);
      if (!job) throw new AppError(404, "not_found", "登录任务不存在。");
      expire(job);
      if (
        active !== job.id ||
        job.mode !== "manual" ||
        job.status !== "pending" ||
        job.phase !== "awaiting_callback" ||
        !job.submitCallback
      )
        throw new AppError(
          409,
          "callback_unavailable",
          "当前登录任务无法接收回调。",
        );
      const body = bodyObject(request.body, ["callbackUrl"]);
      if (
        typeof body.callbackUrl !== "string" ||
        !body.callbackUrl.trim() ||
        Buffer.byteLength(body.callbackUrl.trim(), "utf8") > 16 * 1024
      )
        throw new AppError(
          400,
          "callback_invalid",
          "回调地址格式无效，请复制完整地址后重试。",
          "callbackUrl",
        );
      try {
        job.submitCallback(body.callbackUrl.trim());
      } catch (error) {
        const unavailable =
          error !== null &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "callback_unavailable";
        throw new AppError(
          unavailable ? 409 : 400,
          unavailable ? "callback_unavailable" : "callback_invalid",
          "回调地址无效或已失效，请检查登录任务后重试。",
          "callbackUrl",
        );
      }
      clearCallback(job);
      job.phase = "exchanging";
      return reply.code(202).send(publicJob(job));
    },
  );
  app.delete(
    "/api/admin/sign-in/:id",
    { preHandler: auth },
    async (request) => {
      const job = jobs.get((request.params as { id: string }).id);
      if (!job) throw new AppError(404, "not_found", "登录任务不存在。");
      if (job.status === "pending") {
        job.status = "cancelled";
        clearCallback(job);
        runtime.cancelSignIn(); /* Keep active until cancellation settles. */
      }
      return publicJob(job);
    },
  );
}
export const safeField = (value: unknown, max = 128): string | undefined =>
  typeof value === "string" &&
  value.length <= max &&
  /^[A-Za-z0-9_.:/-]+$/.test(value)
    ? value
    : undefined;
