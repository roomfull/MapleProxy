// Modified by MapleProxy: see ../PROVENANCE.md.
import OpenAI from "openai";
import { _iterSSEMessages } from "openai/core/streaming";
import { apiError, ChatGPTError, isObject } from "./errors.js";
import type { StreamResponseOptions } from "./types.js";
import type { ChatGPTConfig } from "./types.js";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses";

/** MapleProxy extension: complete typed body and complete event stream. */
export async function requestResponseStream(
  accessToken: string,
  body: ResponseCreateParamsStreaming,
  signal: AbortSignal,
  config: Pick<ChatGPTConfig, "fetch" | "timeoutMs"> = {},
  onClose: () => void = () => {},
) {
  const deadline = AbortSignal.timeout(config.timeoutMs ?? 180_000);
  const streamController = new AbortController();
  const requestSignal = AbortSignal.any([
    signal,
    deadline,
    streamController.signal,
  ]);
  const headers: Record<string, string | null> = {
    authorization: `Bearer ${accessToken}`,
    "openai-organization": null,
    "openai-project": null,
  };
  // Remove every inherited custom header, including prompt logging/alternate auth settings.
  for (const line of (process.env.OPENAI_CUSTOM_HEADERS ?? "").split("\n")) {
    const separator = line.indexOf(":");
    if (separator > 0)
      headers[line.slice(0, separator).trim().toLowerCase()] = null;
  }
  headers.authorization = `Bearer ${accessToken}`;
  const client = new OpenAI({
    apiKey: accessToken,
    adminAPIKey: null,
    baseURL: "https://api.openai.com/v1",
    organization: null,
    project: null,
    maxRetries: 0,
    timeout: config.timeoutMs ?? 180_000,
    logLevel: "off",
    fetch: config.fetch,
    fetchOptions: { redirect: "error" },
    defaultHeaders: headers,
  });
  let response: Response | undefined;
  const sanitize = (error: unknown): ChatGPTError => {
    if (signal.aborted)
      return new ChatGPTError("cancelled", "The response was cancelled.");
    if (deadline.aborted)
      return new ChatGPTError(
        "request_timeout",
        "The upstream request timed out.",
        true,
        504,
      );
    if (error instanceof ChatGPTError) return error;
    if (
      error instanceof OpenAI.APIError &&
      !(error instanceof OpenAI.APIConnectionError)
    )
      return apiError(
        typeof error.error === "string" ? { error: error.error } : error.error,
        error.status,
        error.requestID,
      );
    if (error instanceof SyntaxError)
      return new ChatGPTError(
        "invalid_stream",
        "The response stream contained an invalid event.",
        true,
      );
    return new ChatGPTError(
      response ? "stream_interrupted" : "network_error",
      "The upstream connection was interrupted.",
      true,
      502,
    );
  };
  try {
    response = await client.responses
      .create(
        { ...body, store: false, stream: true },
        { signal: requestSignal, headers: { accept: "text/event-stream" } },
      )
      .asResponse();
    const contentType = response.headers
      .get("content-type")
      ?.split(";")[0]
      ?.trim()
      .toLowerCase();
    if (
      !response.body ||
      (contentType && contentType !== "text/event-stream")
    ) {
      await response.body?.cancel();
      throw new ChatGPTError(
        "invalid_stream",
        "The upstream did not return an event stream.",
        true,
        502,
      );
    }
    // Use the pinned SDK's UTF-8/SSE decoder before its high-level parser
    // consumes event:error as an APIError. Preserve native payloads for clients.
    const source = (async function* () {
      for await (const frame of _iterSSEMessages(response!, streamController)) {
        if (frame.data === "[DONE]") return;
        const data = JSON.parse(frame.data);
        if (!isObject(data)) throw new SyntaxError("Invalid response event.");
        const event =
          frame.event === "error" ? { ...data, type: "error" } : data;
        yield event;
        if (event.type === "error" || data.error)
          throw apiError(
            data,
            response!.status,
            response!.headers.get("x-request-id"),
          );
      }
    })();
    let completed = false;
    let closed = false;
    const close = (abort = true) => {
      if (!closed) {
        closed = true;
        requestSignal.removeEventListener("abort", onAbort);
        if (abort) streamController.abort();
        onClose();
      }
    };
    const onAbort = () => close();
    // A custom iterator also cleans up when return() is called before first next().
    const events: AsyncIterable<Record<string, any>> = {
      [Symbol.asyncIterator]: () => ({
        async next() {
          try {
            requestSignal.throwIfAborted();
            const item = await source.next();
            requestSignal.throwIfAborted();
            if (item.done) {
              close(false);
              if (!completed)
                throw new ChatGPTError(
                  "stream_interrupted",
                  "The response ended before completion.",
                  true,
                  502,
                );
              return item;
            }
            const event = item.value;
            if (
              event.type === "response.completed" ||
              event.type === "response.failed" ||
              event.type === "response.incomplete"
            )
              completed = true;
            return {
              done: false as const,
              value: event as unknown as Record<string, any>,
            };
          } catch (e) {
            close();
            throw sanitize(e);
          }
        },
        async return() {
          // SDK async-generator return is queued behind an outstanding next().
          // Abort first so a stalled SSE reader can finish that outstanding read.
          close();
          try {
            await source.return?.();
            return { done: true as const, value: undefined };
          } finally {
            close();
          }
        },
        async throw(e: unknown) {
          close();
          throw sanitize(e);
        },
      }),
    };
    requestSignal.addEventListener("abort", onAbort, { once: true });
    return { status: response.status, headers: response.headers, events };
  } catch (e) {
    throw sanitize(e);
  }
}

export async function streamResponse(
  accessToken: string,
  options: StreamResponseOptions,
  signal: AbortSignal,
): Promise<{ text: string }> {
  const input =
    typeof options.input === "string"
      ? [{ role: "user" as const, content: options.input }]
      : options.input;
  if (
    !Array.isArray(input) ||
    input.some(
      (message) =>
        !isObject(message) ||
        !["user", "assistant", "developer"].includes(String(message.role)) ||
        typeof message.content !== "string",
    )
  ) {
    throw new ChatGPTError(
      "invalid_request",
      "Use text messages with user, assistant, or developer roles. Put system guidance in instructions.",
    );
  }

  // The DevKit supplies the selected ChatGPT account's refreshed OAuth token.
  // Leave org/project unset; they are not placeholders for a Platform API account.
  const client = new OpenAI({
    apiKey: accessToken,
    baseURL: "https://api.openai.com/v1",
    organization: null,
    project: null,
    // Keep the SDK's default without inheriting OPENAI_LOG=debug, which can log clipboard text.
    logLevel: "warn",
    // Report ChatGPT sharing-limit errors immediately instead of retrying HTTP 429s.
    maxRetries: 0,
    // A redirect can forward the clipboard body to another origin.
    fetchOptions: { redirect: "error" },
    // Also prevent OPENAI_CUSTOM_HEADERS from replacing this account's credentials or tenant.
    defaultHeaders: {
      authorization: `Bearer ${accessToken}`,
      "openai-organization": null,
      "openai-project": null,
    },
  });
  // The SDK's timeout ends at headers; keep the existing deadline on the body too.
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(180_000)]);
  let response: Response | undefined;
  try {
    const result = await client.responses
      .create(
        {
          model: options.model,
          input: input.map((message) => ({
            role: message.role,
            content: message.content,
          })),
          ...(options.instructions !== undefined
            ? { instructions: options.instructions }
            : {}),
          store: false,
          stream: true,
        },
        { signal: requestSignal, headers: { accept: "text/event-stream" } },
      )
      .withResponse();
    response = result.response;
    const contentType = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    // The direct route can return valid SSE without Content-Type. In that case,
    // validate the events below and still require response.completed for success.
    if (
      !response.body ||
      (contentType && contentType !== "text/event-stream")
    ) {
      await response.body?.cancel();
      throw new ChatGPTError(
        "invalid_stream",
        "ChatGPT did not return the expected response stream.",
        true,
        response.status,
      );
    }

    let completed = false;
    let text = "";
    for await (const event of result.data) {
      requestSignal.throwIfAborted();
      if (!isObject(event)) continue;
      if (
        event.type === "response.output_text.delta" &&
        typeof event.delta === "string"
      ) {
        text += event.delta;
        if (text.length > 16 * 1024 * 1024)
          throw new ChatGPTError(
            "response_too_large",
            "The response was too large. Try a smaller request.",
          );
        options.onDelta?.(event.delta);
      } else if (event.type === "response.failed" || event.type === "error") {
        const detail =
          event.type === "response.failed" ? event.response : event;
        throw apiError(detail, response.status, result.request_id);
      } else if (event.type === "response.incomplete") {
        throw new ChatGPTError(
          "response_incomplete",
          "ChatGPT stopped before completing the response. You can keep the partial text or try again.",
          true,
        );
      } else if (event.type === "response.completed") {
        completed = true;
        break;
      }
    }
    // The SDK may finish iteration on an aborted connection without throwing.
    requestSignal.throwIfAborted();
    if (!completed)
      throw new ChatGPTError(
        "stream_interrupted",
        "The response ended before completion. You can keep the partial text or try again.",
        true,
      );
    return { text };
  } catch (error) {
    if (signal.aborted)
      throw new ChatGPTError("cancelled", "The response was cancelled.");
    if (error instanceof ChatGPTError) throw error;
    // SDK errors can contain submitted text. Only expose our sanitized diagnostics,
    // including errors the SDK raises while decoding an SSE 'error' event.
    if (
      error instanceof OpenAI.APIError &&
      !(error instanceof OpenAI.APIConnectionError) &&
      !(error instanceof OpenAI.APIUserAbortError)
    ) {
      // The SDK also unwraps the string in an OAuth { error: "code" } response.
      const detail =
        typeof error.error === "string" ? { error: error.error } : error.error;
      throw apiError(
        detail,
        error.status ?? response?.status,
        error.requestID ?? response?.headers.get("x-request-id"),
      );
    }
    if (!response)
      throw new ChatGPTError(
        "network_error",
        "Could not reach ChatGPT. Check your connection and try again.",
        true,
      );
    if (error instanceof SyntaxError)
      throw new ChatGPTError(
        "invalid_stream",
        "The response stream contained an invalid event. Try again.",
        true,
      );
    throw new ChatGPTError(
      "stream_interrupted",
      "The connection was interrupted. You can keep the partial text or try again.",
      true,
    );
  }
}
