import { createHash } from "node:crypto";
import type { ResponseOutputMessage } from "openai/resources/responses/responses";
import type { JsonObject } from "../auth/runtime.js";
import { AppError } from "../shared/errors.js";
import type { ResponseContext } from "./types.js";

// Reserved names carry identity across independent requests; no request registry.
const encodedPrefix = "_mpn_";
const flatPrefix = "_mpf_v1_";
export function flatNamespace(name: string): string {
  return (
    flatPrefix + createHash("sha256").update(name).digest("hex").slice(0, 32)
  );
}
/** Chat history uses the SDK's full output-message shape to retain rich parts. */
export function assistantHistory(
  content: JsonObject[],
  position: number,
): ResponseOutputMessage {
  const parts: ResponseOutputMessage["content"] = content.map((part) => {
    if (part.type === "output_text")
      return {
        type: "output_text",
        text: part.text,
        annotations: part.annotations ?? [],
      };
    if (part.type === "refusal")
      return { type: "refusal", refusal: part.refusal };
    requestError("messages.content", "Unsupported assistant history content.");
  });
  return {
    type: "message",
    role: "assistant",
    status: "completed",
    id:
      "msg_mapleproxy_" +
      createHash("sha256")
        .update(JSON.stringify([position, parts]))
        .digest("hex")
        .slice(0, 32),
    content: parts,
  };
}
export function requestError(
  param: string,
  message: string,
  code = "invalid_request",
): never {
  throw new AppError(400, code, message, param);
}
export function object(value: unknown, param: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value))
    requestError(param, `${param} must be an object.`);
  return value as JsonObject;
}
export function string(value: unknown, param: string): string {
  if (typeof value !== "string" || !value.length)
    requestError(param, `${param} must be a nonempty string.`);
  return value;
}
export function nativeName(name: unknown, param: string): string {
  const result = string(name, param);
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(result))
    requestError(
      param,
      "Tool names must contain 1–64 letters, digits, underscores or hyphens.",
    );
  return result;
}
export function assertNativeNamespace(name: unknown, param: string): void {
  const value = string(name, param);
  if (value.startsWith(flatPrefix))
    requestError(
      param,
      `${flatPrefix} is reserved for flat tool conversion.`,
      "unsupported_parameter",
    );
}
export function decodeChatName(
  value: unknown,
  param: string,
): { name: string; namespace: string; flat: boolean } {
  const name = nativeName(value, param);
  if (!name.startsWith(encodedPrefix))
    return { name, namespace: flatNamespace(name), flat: true };
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(name.slice(encodedPrefix.length), "base64url").toString(
        "utf8",
      ),
    );
    if (
      !Array.isArray(decoded) ||
      decoded.length !== 2 ||
      !decoded.every((x) => typeof x === "string" && x.length)
    )
      throw new Error();
    const [namespace, toolName] = decoded as [string, string];
    assertNativeNamespace(namespace, param);
    nativeName(toolName, param);
    if (
      encodedPrefix +
        Buffer.from(JSON.stringify(decoded)).toString("base64url") !==
      name
    )
      throw new Error();
    return { name: toolName, namespace, flat: false };
  } catch {
    requestError(
      param,
      `${encodedPrefix} is reserved for canonical encoded namespace/tool names.`,
    );
  }
}
export function chatName(item: JsonObject, context?: ResponseContext): string {
  const name = item.name as string;
  if (typeof name !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(name))
    unsupportedOutput("Invalid tool name in upstream output.");
  const requested =
    context?.toolNames.filter(
      (tool) =>
        tool.name === name &&
        (!item.namespace || tool.namespace === item.namespace),
    ) ?? [];
  if (requested.length === 1) return requested[0]!.clientName;
  if (requested.length > 1)
    unsupportedOutput("Ambiguous tool namespace in upstream output.");
  if (!item.namespace || item.namespace === flatNamespace(name)) {
    if (name.startsWith(encodedPrefix))
      unsupportedOutput(
        `${encodedPrefix} is reserved for encoded namespace/tool names.`,
      );
    return name;
  }
  if (
    typeof item.namespace !== "string" ||
    item.namespace.startsWith(flatPrefix)
  )
    unsupportedOutput("Conflicting reserved tool namespace.");
  const encoded =
    encodedPrefix +
    Buffer.from(JSON.stringify([item.namespace, name])).toString("base64url");
  if (encoded.length > 64)
    unsupportedOutput(
      "Namespace/tool identity exceeds Chat’s 64 character tool name limit. Use Responses.",
    );
  return encoded;
}
export function unsupportedOutput(message: string): never {
  throw new AppError(502, "unsupported_output", message);
}
export function functionArguments(value: string): string {
  return value.trim() ? value : "{}";
}
export function chatToolCall(
  item: JsonObject,
  context?: ResponseContext,
): JsonObject {
  if (typeof item.call_id !== "string" || !item.call_id)
    unsupportedOutput("Tool output is missing call_id.");
  const name = chatName(item, context);
  if (item.type === "function_call")
    return {
      id: item.call_id,
      type: "function",
      function: { name, arguments: functionArguments(item.arguments ?? "") },
    };
  return {
    id: item.call_id,
    type: "custom",
    custom: { name, input: item.input ?? "" },
  };
}
export function chatUsage(
  usage: JsonObject | null | undefined,
): JsonObject | undefined {
  if (!usage) return undefined;
  return {
    prompt_tokens: usage.input_tokens,
    completion_tokens: usage.output_tokens,
    total_tokens: usage.total_tokens,
    ...(usage.input_tokens_details
      ? { prompt_tokens_details: usage.input_tokens_details }
      : {}),
    ...(usage.output_tokens_details
      ? { completion_tokens_details: usage.output_tokens_details }
      : {}),
  };
}
export function chatAnnotation(
  annotation: JsonObject,
  offset = 0,
): JsonObject | undefined {
  if (annotation.type !== "url_citation") return undefined;
  return {
    type: "url_citation",
    url_citation: {
      url: annotation.url,
      title: annotation.title,
      start_index: annotation.start_index + offset,
      end_index: annotation.end_index + offset,
    },
  };
}
export function responseToChat(
  response: JsonObject,
  model: string,
  context?: ResponseContext,
): JsonObject {
  let content = "",
    refusal = "",
    reasoning = "";
  const calls: JsonObject[] = [],
    annotations: JsonObject[] = [];
  for (const item of response.output ?? []) {
    if (item.type === "message") {
      for (const part of item.content ?? []) {
        if (part.type === "output_text") {
          for (const annotation of part.annotations ?? []) {
            const mapped = chatAnnotation(annotation, content.length);
            if (mapped) annotations.push(mapped);
          }
          content += part.text;
        } else if (part.type === "refusal") refusal += part.refusal;
        else
          unsupportedOutput(
            `Cannot represent ${part.type} in Chat. Use Responses.`,
          );
      }
    } else if (
      item.type === "function_call" ||
      item.type === "custom_tool_call"
    )
      calls.push(chatToolCall(item, context));
    else if (item.type === "reasoning") {
      for (const part of item.summary ?? [])
        if (part.type === "summary_text" && typeof part.text === "string")
          reasoning += part.text;
    } else if (item.type !== "web_search_call")
      unsupportedOutput(
        `Cannot represent ${item.type} in Chat. Use Responses.`,
      );
  }
  const legacy = context?.legacyFunctionCall === true;
  if (
    legacy &&
    (calls.length > 1 || calls.some((call) => call.type !== "function"))
  )
    unsupportedOutput(
      "Legacy function_call cannot represent parallel or custom calls.",
    );
  return {
    id: response.id,
    object: "chat.completion",
    created: response.created_at,
    model: response.model ?? model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: content || null,
          refusal: refusal || null,
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          ...(calls.length
            ? legacy
              ? { function_call: calls[0]!.function }
              : { tool_calls: calls }
            : {}),
          ...(annotations.length ? { annotations } : {}),
        },
        finish_reason:
          incompleteFinishReason(response) ??
          (calls.length ? (legacy ? "function_call" : "tool_calls") : "stop"),
        logprobs: null,
      },
    ],
    ...(response.usage ? { usage: chatUsage(response.usage) } : {}),
    ...(response.service_tier ? { service_tier: response.service_tier } : {}),
  };
}

/** Known partial endings have protocol finish reasons; unknown ones must fail. */
export function incompleteFinishReason(
  response: JsonObject,
): string | undefined {
  if (response.status !== "incomplete") return undefined;
  if (response.incomplete_details?.reason === "max_output_tokens")
    return "length";
  if (response.incomplete_details?.reason === "content_filter")
    return "content_filter";
  throw new AppError(
    502,
    "response_incomplete",
    "Upstream response has an unknown incomplete reason.",
  );
}
