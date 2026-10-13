import type { JsonObject } from "../auth/runtime.js";
import type { RequestDiagnostic } from "./types.js";
import { requestError } from "./chat.js";

// Only optional protocol positions are nullable. Never walk schemas or payloads.
const optionalTopLevel = [
  "stream",
  "store",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "reasoning",
  "text",
  "reasoning_effort",
  "response_format",
  "verbosity",
  "instructions",
  "include",
  "stream_options",
  "prompt_cache_key",
  "prompt_cache_options",
  "service_tier",
  "access_programs",
  "context_management",
  "n",
  "logprobs",
  "top_logprobs",
  "modalities",
  "background",
  "conversation",
  "previous_response_id",
  "prompt",
  "moderation",
  "multi_agent",
  "max_tool_calls",
  "prompt_cache_retention",
  "truncation",
  "audio",
  "prediction",
  "functions",
  "function_call",
  "web_search_options",
  "temperature",
  "top_p",
  "max_tokens",
  "max_completion_tokens",
  "max_output_tokens",
  "metadata",
  "safety_identifier",
  "user",
  "stop",
  "seed",
  "frequency_penalty",
  "presence_penalty",
  "logit_bias",
  "top_k",
  "min_p",
  "repeat_penalty",
];
const chatMessageFields = new Set([
  "role",
  "content",
  "tool_calls",
  "tool_call_id",
  "refusal",
  "annotations",
  // Known feature semantics must still be rejected until supported explicitly.
  "function_call",
  "audio",
]);
const clientMessageFields = new Set([
  "name",
  "startsNewUserRequest",
  "reasoning_content",
]);

function record(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function cleanClientRequest(
  source: JsonObject,
  format: "chat" | "responses",
  diagnostics: RequestDiagnostic[],
): JsonObject {
  let copied: JsonObject;
  try {
    copied = JSON.parse(JSON.stringify(source));
  } catch {
    requestError("body", "Request must be a JSON object.");
  }

  function nulls(value: unknown, keys: string[], path: string) {
    if (!record(value)) return;
    for (const key of keys) {
      if (value[key] !== null) continue;
      delete value[key];
      diagnostics.push({
        path: path ? `${path}.${key}` : key,
        action: "normalized",
        reason: "null_optional",
      });
    }
  }
  function tools(value: unknown, path: string) {
    if (!Array.isArray(value)) return;
    for (const [i, tool] of value.entries()) {
      if (!record(tool)) continue;
      const at = `${path}[${i}]`;
      if (tool.type === "namespace") {
        tools(tool.tools, `${at}.tools`);
        continue;
      }
      if (!["function", "custom"].includes(tool.type)) continue;
      const nested = format === "chat";
      const spec = nested ? tool[tool.type] : tool;
      const specPath = nested ? `${at}.${tool.type}` : at;
      nulls(
        spec,
        [
          "description",
          "defer_loading",
          "allowed_callers",
          ...(tool.type === "function" ? ["parameters", "strict"] : ["format"]),
        ],
        specPath,
      );
    }
  }
  function parts(value: unknown, path: string) {
    if (!Array.isArray(value)) return;
    for (const [i, part] of value.entries()) {
      if (!record(part)) continue;
      const at = `${path}[${i}]`;
      if (format === "responses") {
        if (part.type === "input_image") nulls(part, ["detail", "file_id"], at);
        else if (part.type === "input_file")
          nulls(
            part,
            ["detail", "file_id", "file_data", "file_url", "filename"],
            at,
          );
        else if (part.type === "output_text") nulls(part, ["logprobs"], at);
      }
      if (format === "chat" && part.type === "image_url")
        nulls(part.image_url, ["detail"], `${at}.image_url`);
      if (format === "chat" && part.type === "file")
        nulls(
          part.file,
          ["file_id", "file_data", "file_url", "filename"],
          `${at}.file`,
        );
    }
  }
  nulls(copied, optionalTopLevel, "");
  for (const key of ["tools", "stop"]) {
    const emptyArray = Array.isArray(copied[key]) && copied[key].length === 0;
    if (!emptyArray && !(key === "stop" && copied[key] === "")) continue;
    delete copied[key];
    diagnostics.push({
      path: key,
      action: "normalized",
      reason: "empty_optional",
    });
  }
  nulls(
    copied.reasoning,
    ["effort", "summary", "generate_summary"],
    "reasoning",
  );
  nulls(copied.text, ["format", "verbosity"], "text");
  if (copied.text?.format?.type === "json_schema")
    nulls(copied.text.format, ["strict", "description"], "text.format");
  if (format === "chat" && copied.response_format?.type === "json_schema")
    nulls(
      copied.response_format.json_schema,
      ["strict", "description"],
      "response_format.json_schema",
    );
  nulls(
    copied.stream_options,
    ["include_usage", "include_obfuscation"],
    "stream_options",
  );
  tools(copied.tools, "tools");
  if (format === "chat" && Array.isArray(copied.functions))
    for (const [i, spec] of copied.functions.entries())
      nulls(
        spec,
        [
          "description",
          "parameters",
          "strict",
          "defer_loading",
          "allowed_callers",
        ],
        `functions[${i}]`,
      );

  const history = format === "chat" ? copied.messages : copied.input;
  const root = format === "chat" ? "messages" : "input";
  if (Array.isArray(history))
    for (const [i, item] of history.entries()) {
      if (!record(item)) continue;
      const path = `${root}[${i}]`;
      if (format === "chat" || item.type === "message" || item.role) {
        for (const key of Object.keys(item)) {
          if (
            format === "chat"
              ? !chatMessageFields.has(key) &&
                !(key === "name" && item.role === "function")
              : clientMessageFields.has(key)
          ) {
            delete item[key];
            diagnostics.push({
              path: `${path}.${key}`,
              action: "filtered",
              reason: "client_metadata",
            });
          }
        }
        if (format === "chat")
          nulls(
            item,
            ["tool_calls", "refusal", "annotations", "function_call", "audio"],
            path,
          );
        parts(item.content, `${path}.content`);
      } else if (item.type === "additional_tools")
        tools(item.tools, `${path}.tools`);
      else if (
        [
          "function_call",
          "custom_tool_call",
          "function_call_output",
          "custom_tool_call_output",
        ].includes(item.type)
      ) {
        if (
          ["function_call", "custom_tool_call"].includes(item.type) ||
          (item.type === "function_call_output" && item.call_id == null)
        )
          nulls(item, ["namespace"], path);
        parts(item.output, `${path}.output`);
      }
    }
  return copied;
}
