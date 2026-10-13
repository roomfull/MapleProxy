import type { JsonObject } from "../auth/runtime.js";
import type { RenderStreamOptions } from "./events.js";
import type { RequestDiagnostic } from "./types.js";
import { nativeName, object, requestError } from "./chat.js";

function array(value: unknown, param: string): any[] {
  if (!Array.isArray(value)) requestError(param, `${param} must be an array.`);
  return value;
}

// Ordinary unsupported knobs may be filtered; feature semantics must be rejected.
const ordinary = new Set([
  "temperature",
  "top_p",
  "stop",
  "seed",
  "frequency_penalty",
  "presence_penalty",
  "logit_bias",
  "top_k",
  "min_p",
  "repeat_penalty",
  "max_tokens",
  "max_completion_tokens",
  "max_output_tokens",
  "metadata",
  "safety_identifier",
  "user",
]);
const unsupported = new Set([
  "background",
  "conversation",
  "previous_response_id",
  "prompt",
  "moderation",
  "multi_agent",
  "max_tool_calls",
  "prompt_cache_retention",
  "truncation",
  "top_logprobs",
  "audio",
  "prediction",
  "functions",
  "function_call",
  "web_search_options",
]);
const nativeFields = new Set([
  "model",
  "input",
  "instructions",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "reasoning",
  "text",
  "include",
  "prompt_cache_key",
  "prompt_cache_options",
  "service_tier",
  "stream_options",
  "access_programs",
  "context_management",
]);
const chatFields = new Set([
  "model",
  "messages",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "reasoning",
  "text",
  "reasoning_effort",
  "response_format",
  "verbosity",
  "service_tier",
  "stream_options",
  "prompt_cache_key",
  "prompt_cache_options",
]);
export const webTools = new Set([
  "web_search",
  "web_search_2025_08_26",
  "web_search_preview",
  "web_search_preview_2025_03_11",
]);
export const clientTools = new Set(["shell", "local_shell", "apply_patch"]);

/** Decide local SIWC capabilities independently of client cleanup/conversion. */
export function filterRequestField(
  key: string,
  value: unknown,
  format: "chat" | "responses",
  ignoredParams: string[],
  diagnostics: RequestDiagnostic[],
): boolean {
  if (["model", "store", "stream"].includes(key)) return true;
  if (ordinary.has(key)) {
    ignoredParams.push(key);
    diagnostics.push({
      path: key,
      action: "filtered",
      reason: "siwc_ignored_parameter",
    });
    return true;
  }
  if (
    (key === "n" && format === "chat" && value === 1) ||
    (key === "logprobs" && value === false) ||
    (key === "top_logprobs" && value === 0) ||
    (key === "background" && value === false) ||
    (key === "modalities" &&
      format === "chat" &&
      Array.isArray(value) &&
      value.length === 1 &&
      value[0] === "text")
  ) {
    diagnostics.push({
      path: key,
      action: "normalized",
      reason: "disabled_default",
    });
    return true;
  }
  if (unsupported.has(key) || ["n", "logprobs", "modalities"].includes(key))
    requestError(
      key,
      `${key} is not supported by this route.`,
      "unsupported_parameter",
    );
  if (
    (format === "chat" ? nativeFields : chatFields).has(key) &&
    !(format === "chat" ? chatFields : nativeFields).has(key)
  )
    requestError(
      key,
      `${key} is not supported by this route.`,
      "unsupported_parameter",
    );
  return [
    "input",
    "messages",
    "tools",
    "tool_choice",
    "reasoning_effort",
    "response_format",
    "verbosity",
  ].includes(key);
}

export function validateNativeOptions(
  body: JsonObject,
  format: "chat" | "responses",
  renderOptions: RenderStreamOptions,
): void {
  if (
    body.parallel_tool_calls !== undefined &&
    typeof body.parallel_tool_calls !== "boolean"
  )
    requestError("parallel_tool_calls", "parallel_tool_calls must be boolean.");
  if (
    body.instructions !== undefined &&
    body.instructions !== null &&
    typeof body.instructions !== "string"
  )
    requestError("instructions", "instructions must be a string.");
  for (const key of [
    "reasoning",
    "text",
    "prompt_cache_options",
    "access_programs",
  ])
    if (body[key] !== undefined && body[key] !== null) object(body[key], key);
  if (body.context_management != null)
    array(body.context_management, "context_management").forEach((x) =>
      object(x, "context_management"),
    );
  if (
    body.reasoning?.effort != null &&
    typeof body.reasoning.effort !== "string"
  )
    requestError("reasoning.effort", "Invalid reasoning effort.");
  for (const key of ["summary", "generate_summary"])
    if (
      body.reasoning?.[key] != null &&
      !["auto", "concise", "detailed"].includes(body.reasoning[key])
    )
      requestError(`reasoning.${key}`, "Invalid reasoning summary setting.");
  if (body.text?.format !== undefined) {
    const config = object(body.text.format, "text.format");
    if (!["text", "json_object", "json_schema"].includes(config.type))
      requestError("text.format", "Unsupported text format.");
    if (config.type === "json_schema") {
      nativeName(config.name, "text.format.name");
      object(config.schema, "text.format.schema");
      if (config.strict != null && typeof config.strict !== "boolean")
        requestError("text.format.strict", "strict must be boolean.");
    }
  }
  if (
    body.text?.verbosity != null &&
    !["low", "medium", "high"].includes(body.text.verbosity)
  )
    requestError("text.verbosity", "Invalid text verbosity.");
  if (body.include !== undefined)
    array(body.include, "include").forEach((x) => {
      if (
        ![
          "web_search_call.results",
          "web_search_call.action.sources",
          "message.input_image.image_url",
          "reasoning.encrypted_content",
        ].includes(x)
      )
        requestError(
          "include",
          `Unsupported include field ${x}.`,
          "unsupported_parameter",
        );
    });
  if (body.stream_options !== undefined) {
    const options = object(body.stream_options, "stream_options");
    const keys =
      format === "chat"
        ? ["include_usage", "include_obfuscation"]
        : ["include_obfuscation"];
    for (const [key, value] of Object.entries(options))
      if (!keys.includes(key) || typeof value !== "boolean")
        requestError(
          `stream_options.${key}`,
          "Unsupported stream option.",
          "unsupported_parameter",
        );
    if (format === "chat")
      renderOptions.includeUsage = options.include_usage === true;
    body.stream_options = Object.fromEntries(
      Object.entries(options).filter(([key]) => key !== "include_usage"),
    );
  }
}
