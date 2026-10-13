import Fastify from "fastify";
import staticFiles from "@fastify/static";
import { randomUUID } from "node:crypto";
import type { AccountRuntime } from "../auth/runtime.js";
import { normalizeRequest } from "../protocol/normalize.js";
import { collectResponse, renderStream } from "../protocol/events.js";
import { AppError } from "../shared/errors.js";
import { SecurityStore } from "./security.js";
import { ActivityLog } from "./activity.js";
import { registerAdmin, safeField } from "./routes.js";
import { writeChunk } from "./streaming.js";

export interface AppOptions {
  runtime: AccountRuntime;
  dataDir: string;
  webDir?: string;
  port?: number;
}
export function errorEnvelope(error: unknown, requestId: string) {
  const known = error instanceof AppError;
  return {
    error: {
      message:
        known && error.status < 500
          ? error.message.slice(0, 512)
          : "请求失败，请检查账号状态或稍后重试。",
      type: "mapleproxy_error",
      code: known
        ? (safeField(error.code) ?? "request_failed")
        : "internal_error",
      param: known ? (safeField(error.param) ?? null) : null,
      request_id: known ? (safeField(error.requestId) ?? requestId) : requestId,
    },
  };
}
export async function createApp({
  runtime,
  dataDir,
  webDir,
  port = 8317,
}: AppOptions) {
  const app = Fastify({
    logger: false,
    bodyLimit: 32 * 1024 * 1024,
    requestIdHeader: false,
    genReqId: () => randomUUID(),
  });
  const security = new SecurityStore(dataDir),
    activity = new ActivityLog();
  app.addHook("onRequest", async (request, reply) => {
    const host = request.headers.host;
    const address = app.server.address();
    const actualPort =
      address && typeof address === "object" ? address.port : port;
    if (
      host !== `localhost:${actualPort}` &&
      host !== `127.0.0.1:${actualPort}`
    )
      throw new AppError(403, "invalid_host", "仅允许本机访问。");
    if (
      request.url.startsWith("/api/admin/") &&
      !["GET", "HEAD"].includes(request.method) &&
      request.headers.origin !== `http://${host}`
    )
      throw new AppError(403, "invalid_origin", "请求来源验证失败。");
    reply
      .header("x-request-id", request.id)
      .header("x-content-type-options", "nosniff")
      .header("referrer-policy", "no-referrer");
    if (request.url.startsWith("/api/") || request.url.startsWith("/v1/"))
      reply.header("cache-control", "no-store");
    else
      reply.header(
        "content-security-policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      );
  });
  app.setErrorHandler((error, request, reply) => {
    const fastifyError = error as { code?: string; statusCode?: number };
    const mapped =
      error instanceof AppError
        ? error
        : fastifyError.code === "FST_ERR_CTP_BODY_TOO_LARGE"
          ? new AppError(413, "body_too_large", "请求体超过 32 MiB 限制。")
          : fastifyError.statusCode && fastifyError.statusCode < 500
            ? new AppError(
                fastifyError.statusCode,
                "invalid_request",
                "请求格式无效。",
              )
            : error;
    const envelope = errorEnvelope(mapped, request.id);
    reply
      .header("x-request-id", envelope.error.request_id)
      .code(mapped instanceof AppError ? mapped.status : 500)
      .send(envelope);
  });
  registerAdmin(app, runtime, security, activity);
  const keyAuth = async (request: import("fastify").FastifyRequest) => {
    const bearer = request.headers.authorization?.match(
      /^Bearer ([A-Za-z0-9_-]+)$/,
    )?.[1];
    if (!bearer || !(await security.acceptKey(bearer)))
      throw new AppError(401, "invalid_api_key", "访问密钥无效。");
  };
  app.get("/v1/models", { preHandler: keyAuth }, async () => ({
    object: "list",
    data: (await runtime.listModels()).map((model) => ({
      id: model.id,
      object: "model",
      owned_by: "openai",
    })),
  }));
  for (const [path, format] of [
    ["/v1/responses", "responses"],
    ["/v1/chat/completions", "chat"],
  ] as const) {
    app.post(path, { preHandler: keyAuth }, async (request, reply) => {
      const started = Date.now(),
        controller = new AbortController();
      let model: string | undefined,
        profileId: string | undefined,
        ignored: string[] = [],
        requestId = request.id,
        result: "success" | "error" | "cancelled" = "error",
        code: string | undefined;
      const close = () => {
        if (!reply.raw.writableEnded) controller.abort();
      };
      request.raw.once("aborted", close);
      reply.raw.once("close", close);
      try {
        const normalized = normalizeRequest(request.body, format);
        model = safeField(normalized.body.model);
        ignored = normalized.ignoredParams;
        if (ignored.length)
          reply.header("x-mapleproxy-ignored-params", ignored.join(","));
        const upstream = await runtime.requestResponses({
          body: normalized.body,
          signal: controller.signal,
        });
        profileId = safeField(upstream.profileId);
        requestId =
          safeField(upstream.headers.get("x-request-id")) ?? requestId;
        reply.header("x-request-id", requestId);
        if (!normalized.stream) {
          const response = await collectResponse(
            upstream.events,
            format,
            normalized.body.model,
          );
          result = "success";
          return reply.send(response);
        }
        reply.hijack();
        reply.raw.writeHead(200, {
          ...reply.getHeaders(),
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          connection: "keep-alive",
        } as import("node:http").OutgoingHttpHeaders);
        try {
          for await (const chunk of renderStream(
            upstream.events,
            format,
            normalized.body.model,
            normalized.renderOptions,
          ))
            await writeChunk(reply.raw, chunk, controller.signal);
          result = "success";
        } catch (error) {
          code =
            error instanceof AppError ? safeField(error.code) : "stream_failed";
          if (!controller.signal.aborted && !reply.raw.destroyed)
            await writeChunk(
              reply.raw,
              `event: error\ndata: ${JSON.stringify(errorEnvelope(error, requestId))}\n\n`,
              controller.signal,
            ).catch(() => {});
        } finally {
          reply.raw.end();
        }
        return reply;
      } catch (error) {
        code =
          error instanceof AppError ? safeField(error.code) : "internal_error";
        if (error instanceof AppError)
          requestId = safeField(error.requestId) ?? requestId;
        throw error;
      } finally {
        if (controller.signal.aborted) result = "cancelled";
        controller.abort();
        request.raw.off("aborted", close);
        reply.raw.off("close", close);
        activity.add({
          requestId,
          profileId,
          model,
          format,
          time: new Date(started).toISOString(),
          durationMs: Date.now() - started,
          result,
          code,
          ignored,
        });
      }
    });
  }
  if (webDir)
    await app.register(staticFiles, { root: webDir, index: "index.html" });
  app.setNotFoundHandler(async (request, reply) => {
    if (
      request.url.startsWith("/api") ||
      request.url.startsWith("/v1") ||
      !webDir ||
      request.method !== "GET" ||
      request.url.split("?")[0]?.includes(".")
    )
      throw new AppError(404, "not_found", "路径不存在。");
    return reply.sendFile("index.html");
  });
  return app;
}
