import Fastify from "fastify";
import staticFiles from "@fastify/static";
import { randomUUID } from "node:crypto";
import type { AccountRuntime } from "../auth/runtime.js";
import { normalizeRequest } from "../protocol/normalize.js";
import {
  collectResponse,
  renderStream,
  type ResponseOutcome,
} from "../protocol/events.js";
import type { RequestDiagnostic } from "../protocol/types.js";
import { AppError } from "../shared/errors.js";
import { safeParam, safeDiagnostics } from "../shared/diagnostics.js";
import { SecurityStore } from "./security.js";
import { ActivityLog, type Activity } from "./activity.js";
import { registerAdmin, safeField } from "./routes.js";
import { withSseHeartbeat, writeChunk } from "./streaming.js";

export interface AppOptions {
  runtime: AccountRuntime;
  dataDir: string;
  webDir?: string;
  port?: number;
}
export function errorEnvelope(
  error: unknown,
  requestId: string,
  upstreamRequestId?: string,
) {
  const known = error instanceof AppError;
  const upstreamId =
    (known ? safeField(error.requestId) : undefined) ??
    safeField(upstreamRequestId);
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
      param: known ? (safeParam(error.param) ?? null) : null,
      request_id: upstreamId ?? requestId,
      local_request_id: requestId,
      ...(upstreamId ? { upstream_request_id: upstreamId } : {}),
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
      .header("x-mapleproxy-local-request-id", request.id)
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
    if (envelope.error.upstream_request_id)
      reply.header(
        "x-mapleproxy-upstream-request-id",
        envelope.error.upstream_request_id,
      );
    reply
      .header("x-request-id", envelope.error.request_id)
      .header("x-mapleproxy-local-request-id", request.id)
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
      let model = safeField(
          (request.body as { model?: unknown } | null)?.model,
        ),
        profileId: string | undefined,
        ignored: string[] = [],
        requestId = request.id,
        result: Activity["result"] = "error",
        code: string | undefined;
      let upstreamRequestId: string | undefined,
        stage: Activity["stage"] = "validation",
        httpStatus = 500,
        param: string | undefined,
        upstreamCalled = false,
        diagnostics: RequestDiagnostic[] = [],
        outcome: ResponseOutcome | undefined;
      const recordError = (error: unknown, fallback: string) => {
        code = error instanceof AppError ? safeField(error.code) : fallback;
        param = error instanceof AppError ? safeParam(error.param) : undefined;
        if (error instanceof AppError) {
          if (error.diagnostics)
            diagnostics = safeDiagnostics([
              ...diagnostics,
              ...error.diagnostics,
            ]);
          upstreamRequestId = safeField(error.requestId) ?? upstreamRequestId;
          requestId = upstreamRequestId ?? request.id;
        }
        ignored = [
          ...new Set([
            ...ignored,
            ...diagnostics
              .filter((entry) => entry.reason === "siwc_ignored_parameter")
              .map((entry) => entry.path),
          ]),
        ];
      };
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      const close = () => {
        if (!reply.raw.writableEnded) controller.abort();
      };
      request.raw.once("aborted", close);
      reply.raw.once("close", close);
      try {
        const normalized = normalizeRequest(request.body, format);
        model = safeField(normalized.body.model);
        ignored = normalized.ignoredParams;
        diagnostics = normalized.diagnostics;
        const renderOptions = {
          ...normalized.renderOptions,
          onTerminal: (value: ResponseOutcome) => {
            outcome = value;
          },
        };
        if (ignored.length)
          reply.header("x-mapleproxy-ignored-params", ignored.join(","));
        stage = "upstream";
        upstreamCalled = true;
        const upstream = await runtime.requestResponses({
          body: normalized.body,
          signal: controller.signal,
        });
        profileId = safeField(upstream.profileId);
        upstreamRequestId = safeField(upstream.headers.get("x-request-id"));
        requestId = upstreamRequestId ?? request.id;
        reply.header("x-request-id", requestId);
        if (upstreamRequestId)
          reply.header("x-mapleproxy-upstream-request-id", upstreamRequestId);
        stage = "response";
        if (upstream.deadlineAt !== undefined) {
          const expire = () =>
            controller.abort(
              new AppError(
                504,
                "request_timeout",
                "The upstream request timed out.",
              ),
            );
          const remaining = upstream.deadlineAt - Date.now();
          if (remaining <= 0) expire();
          else deadlineTimer = setTimeout(expire, remaining);
        }
        if (!normalized.stream) {
          controller.signal.throwIfAborted();
          const response = await collectResponse(
            upstream.events,
            format,
            normalized.body.model,
            renderOptions,
          );
          controller.signal.throwIfAborted();
          result = outcome?.status === "incomplete" ? "incomplete" : "success";
          httpStatus = 200;
          return reply.send(response);
        }
        const stream = withSseHeartbeat(
          renderStream(
            upstream.events,
            format,
            normalized.body.model,
            renderOptions,
          ),
          controller.signal,
        );
        // Read and validate the first output before committing HTTP 200.
        const first = await stream.next();
        reply.hijack();
        httpStatus = 200;
        reply.raw.writeHead(200, {
          ...reply.getHeaders(),
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          connection: "keep-alive",
        } as import("node:http").OutgoingHttpHeaders);
        try {
          if (!first.done) {
            stage = "transport";
            await writeChunk(reply.raw, first.value, controller.signal);
          }
          while (true) {
            stage = "response";
            const next = await stream.next();
            if (next.done) break;
            stage = "transport";
            await writeChunk(reply.raw, next.value, controller.signal);
          }
          result = outcome?.status === "incomplete" ? "incomplete" : "success";
        } catch (caught) {
          const error =
            controller.signal.reason instanceof AppError
              ? controller.signal.reason
              : caught;
          recordError(error, "stream_failed");
          const frame = `event: error\ndata: ${JSON.stringify(errorEnvelope(error, request.id, upstreamRequestId))}\n\n`;
          if (
            controller.signal.aborted &&
            code === "request_timeout" &&
            !reply.raw.destroyed
          ) {
            // A timed-out blocked socket cannot drain a further error frame.
            if (reply.raw.writableNeedDrain) reply.raw.destroy();
            else reply.raw.write(frame);
          } else if (!controller.signal.aborted && !reply.raw.destroyed)
            await writeChunk(reply.raw, frame, controller.signal).catch(
              () => {},
            );
        } finally {
          await stream.return(undefined).catch(() => {});
          reply.raw.end();
        }
        return reply;
      } catch (caught) {
        const error =
          controller.signal.reason instanceof AppError
            ? controller.signal.reason
            : caught;
        recordError(error, "internal_error");
        httpStatus = error instanceof AppError ? error.status : 500;
        if (error instanceof AppError) {
          const mapped = new AppError(
            error.status,
            error.code,
            error.message,
            error.param,
            upstreamRequestId,
          );
          mapped.diagnostics = diagnostics;
          throw mapped;
        }
        throw error;
      } finally {
        if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
        if (
          controller.signal.aborted &&
          !(
            controller.signal.reason instanceof AppError &&
            controller.signal.reason.code === "request_timeout"
          )
        )
          result = "cancelled";
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
          localRequestId: request.id,
          upstreamRequestId,
          stage,
          httpStatus,
          param,
          upstreamCalled,
          diagnostics,
          responseStatus: outcome?.status,
          incompleteReason: outcome?.incompleteReason,
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
