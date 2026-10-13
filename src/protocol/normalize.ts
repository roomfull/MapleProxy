import type { JsonObject } from "../auth/runtime.js";
import {
  assertNativeNamespace,
  decodeChatName,
  flatNamespace,
  nativeName,
  object,
  requestError,
  string,
} from "./chat.js";

// Ordinary unsupported knobs may be filtered; feature semantics must be rejected.
const ordinary = new Set([
  "temperature",
  "top_p",
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
  "stop",
  "top_logprobs",
  "audio",
  "prediction",
  "functions",
  "function_call",
  "web_search_options",
  "frequency_penalty",
  "presence_penalty",
  "logit_bias",
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
  "reasoning_effort",
  "response_format",
  "service_tier",
  "stream_options",
  "prompt_cache_key",
  "prompt_cache_options",
]);
const webTools = new Set([
  "web_search",
  "web_search_2025_08_26",
  "web_search_preview",
  "web_search_preview_2025_03_11",
]);
const clientTools = new Set(["shell", "local_shell", "apply_patch"]);
const efforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
function array(value: unknown, param: string): any[] {
  if (!Array.isArray(value)) requestError(param, `${param} must be an array.`);
  return value;
}
function toolDefinition(value: unknown, param: string): JsonObject {
  const tool = object(value, param);
  if (!["function", "custom"].includes(tool.type))
    requestError(param, `Unsupported tool ${tool.type}.`, "unsupported_tool");
  nativeName(tool.name, `${param}.name`);
  if (
    tool.defer_loading ||
    (tool.allowed_callers != null &&
      array(tool.allowed_callers, `${param}.allowed_callers`).some(
        (x: unknown) => x !== "direct",
      ))
  )
    requestError(
      param,
      "Tool discovery/programmatic calling is not supported.",
      "unsupported_tool",
    );
  if (tool.parameters !== undefined && tool.parameters !== null)
    object(tool.parameters, `${param}.parameters`);
  if (
    tool.strict !== undefined &&
    tool.strict !== null &&
    typeof tool.strict !== "boolean"
  )
    requestError(`${param}.strict`, "strict must be boolean.");
  if (tool.type === "custom" && tool.format !== undefined) {
    const config = object(tool.format, `${param}.format`);
    if (!["text", "grammar"].includes(config.type))
      requestError(`${param}.format`, "Unsupported custom tool format.");
    if (config.type === "grammar") {
      if (!["lark", "regex"].includes(config.syntax))
        requestError(`${param}.format.syntax`, "Unsupported grammar syntax.");
      string(config.definition, `${param}.format.definition`);
    }
  }
  return tool;
}
function nativeTools(value: unknown, param: string): JsonObject[] {
  return array(value, param).map((value, index) => {
    const path = `${param}[${index}]`,
      tool = object(value, path);
    if (tool.type === "namespace") {
      assertNativeNamespace(tool.name, `${path}.name`);
      if (typeof tool.description !== "string")
        requestError(
          `${path}.description`,
          "Namespace description must be a string.",
        );
      array(tool.tools, `${path}.tools`).forEach((child, i) =>
        toolDefinition(child, `${path}.tools[${i}]`),
      );
      return tool;
    }
    if (tool.type === "function" || tool.type === "custom") {
      toolDefinition(tool, path);
      return {
        type: "namespace",
        name: flatNamespace(tool.name),
        description: `Client tool ${tool.name}`,
        tools: [tool],
      };
    }
    if (webTools.has(tool.type) || clientTools.has(tool.type)) return tool;
    requestError(path, `Unsupported tool ${tool.type}.`, "unsupported_tool");
  });
}
function inputPart(value: unknown, param: string): JsonObject {
  const part = object(value, param);
  if (part.type === "input_text" || part.type === "output_text") {
    if (typeof part.text !== "string")
      requestError(param, "Text must be a string.");
  } else if (part.type === "refusal") {
    string(part.refusal, param);
  } else if (part.type === "input_image" || part.type === "input_file") {
    if (part.file_id)
      requestError(
        `${param}.file_id`,
        "Uploaded file references are not supported by SIWC; use inline data or URLs.",
        "unsupported_parameter",
      );
    const source =
      part.type === "input_image"
        ? part.image_url
        : (part.file_data ?? part.file_url);
    string(source, param);
    if (
      part.detail !== undefined &&
      !["auto", "low", "high", "original"].includes(part.detail)
    )
      requestError(`${param}.detail`, "Invalid media detail.");
  } else
    requestError(
      param,
      `Unsupported content type ${part.type}.`,
      "unsupported_input",
    );
  return part;
}
function nativeInput(value: unknown): JsonObject[] {
  if (typeof value === "string")
    return [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: value }],
      },
    ];
  const values = array(value, "input");
  if (!values.length)
    requestError("input", "input must contain at least one item.");
  return values.map((value, i) => {
    const param = `input[${i}]`,
      item = object(value, param);
    if (item.type === "additional_tools") {
      item.tools = nativeTools(item.tools, `${param}.tools`);
      return item;
    }
    if (item.type === "message" || item.role) {
      if (!["system", "developer", "user", "assistant"].includes(item.role))
        requestError(`${param}.role`, "Unsupported message role.");
      if (item.role === "system") item.role = "developer";
      if (typeof item.content !== "string")
        array(item.content, `${param}.content`).forEach((part, j) =>
          inputPart(part, `${param}.content[${j}]`),
        );
      return item;
    }
    if (["function_call", "custom_tool_call"].includes(item.type)) {
      nativeName(item.name, `${param}.name`);
      string(item.call_id, `${param}.call_id`);
      if (item.namespace && item.namespace !== flatNamespace(item.name))
        assertNativeNamespace(item.namespace, `${param}.namespace`);
      else item.namespace = flatNamespace(item.name);
      if (
        typeof item[item.type === "function_call" ? "arguments" : "input"] !==
        "string"
      )
        requestError(param, "Tool call payload must be a string.");
      return item;
    }
    if (
      ["function_call_output", "custom_tool_call_output"].includes(item.type)
    ) {
      if (item.type === "function_call_output" && item.call_id == null) {
        nativeName(item.name, `${param}.name`);
        if (item.namespace && item.namespace !== flatNamespace(item.name))
          assertNativeNamespace(item.namespace, `${param}.namespace`);
      } else string(item.call_id, `${param}.call_id`);
      if (typeof item.output !== "string")
        array(item.output, `${param}.output`).forEach((part, j) =>
          inputPart(part, `${param}.output[${j}]`),
        );
      return item;
    }
    if (
      [
        "reasoning",
        "web_search_call",
        "shell_call",
        "shell_call_output",
        "local_shell_call",
        "local_shell_call_output",
        "apply_patch_call",
        "apply_patch_call_output",
        "compaction",
      ].includes(item.type)
    )
      return item;
    requestError(
      param,
      `Unsupported input item ${item.type}.`,
      "unsupported_input",
    );
  });
}
function chatContent(
  value: unknown,
  role: string,
  param: string,
): JsonObject[] {
  const values =
    typeof value === "string"
      ? [{ type: "text", text: value }]
      : array(value, param);
  return values.map((value, i) => {
    const path = `${param}[${i}]`,
      part = object(value, path);
    if (part.type === "text")
      return inputPart(
        {
          type: role === "assistant" ? "output_text" : "input_text",
          text: part.text,
          ...(role === "assistant" ? { annotations: [] } : {}),
        },
        path,
      );
    if (part.type === "refusal" && role === "assistant")
      return inputPart(part, path);
    if (role === "assistant")
      requestError(
        path,
        "Assistant media is not representable in Responses.",
        "unsupported_input",
      );
    if (part.type === "image_url") {
      const image = object(part.image_url, path);
      return inputPart(
        {
          type: "input_image",
          image_url: image.url,
          ...(image.detail ? { detail: image.detail } : {}),
        },
        path,
      );
    }
    if (part.type === "file")
      return inputPart(
        { type: "input_file", ...object(part.file, path) },
        path,
      );
    requestError(
      path,
      `Unsupported Chat content ${part.type}.`,
      "unsupported_input",
    );
  });
}
function chatInput(value: unknown): JsonObject[] {
  const messages = array(value, "messages");
  if (!messages.length)
    requestError("messages", "messages must contain at least one message.");
  const inputs: JsonObject[] = [],
    calls = new Map<string, string>();
  for (const [i, value] of messages.entries()) {
    const param = `messages[${i}]`,
      message = object(value, param);
    if (
      !["system", "developer", "user", "assistant", "tool"].includes(
        message.role,
      )
    )
      requestError(`${param}.role`, "Unsupported Chat role.");
    for (const key of Object.keys(message))
      if (
        ![
          "role",
          "content",
          "tool_calls",
          "tool_call_id",
          "refusal",
          "annotations",
        ].includes(key)
      )
        requestError(
          `${param}.${key}`,
          `Unsupported message field ${key}.`,
          "unsupported_parameter",
        );
    if (message.role === "tool") {
      const callId = string(message.tool_call_id, `${param}.tool_call_id`),
        type = calls.get(callId);
      if (!type)
        requestError(
          `${param}.tool_call_id`,
          "Tool output must reference a preceding assistant call.",
        );
      inputs.push({
        type:
          type === "custom"
            ? "custom_tool_call_output"
            : "function_call_output",
        call_id: callId,
        output:
          typeof message.content === "string"
            ? message.content
            : chatContent(message.content, "user", `${param}.content`),
      });
      continue;
    }
    const content =
      message.content == null && message.role === "assistant"
        ? []
        : chatContent(message.content, message.role, `${param}.content`);
    if (message.refusal) {
      if (message.role !== "assistant")
        requestError(
          `${param}.refusal`,
          "Only assistant messages may contain refusals.",
        );
      content.push(
        inputPart({ type: "refusal", refusal: message.refusal }, param),
      );
    }
    if (message.annotations?.length) {
      const text = content.find((x) => x.type === "output_text");
      if (!text)
        requestError(
          `${param}.annotations`,
          "Citations require assistant output text.",
        );
      text.annotations = array(message.annotations, `${param}.annotations`).map(
        (a) => {
          if (a.type !== "url_citation")
            requestError(param, "Unsupported Chat annotation.");
          return { type: "url_citation", ...object(a.url_citation, param) };
        },
      );
    }
    if (content.length)
      inputs.push({
        type: "message",
        role: message.role === "system" ? "developer" : message.role,
        content,
      });
    if (message.tool_calls !== undefined) {
      if (message.role !== "assistant")
        requestError(
          `${param}.tool_calls`,
          "Only assistant messages may contain tool calls.",
        );
      for (const [j, value] of array(
        message.tool_calls,
        `${param}.tool_calls`,
      ).entries()) {
        const path = `${param}.tool_calls[${j}]`,
          call = object(value, path);
        if (!["function", "custom"].includes(call.type))
          requestError(path, "Unsupported tool call.");
        const id = string(call.id, `${path}.id`),
          spec = object(call[call.type], path),
          decoded = decodeChatName(spec.name, `${path}.name`);
        if (calls.has(id))
          requestError(`${path}.id`, "Duplicate tool call ID.");
        calls.set(id, call.type);
        const field = call.type === "function" ? "arguments" : "input";
        if (typeof spec[field] !== "string")
          requestError(path, "Tool call payload must be a string.");
        inputs.push({
          type: call.type === "function" ? "function_call" : "custom_tool_call",
          call_id: id,
          name: decoded.name,
          namespace: decoded.namespace,
          [field]: spec[field],
        });
      }
    }
  }
  return inputs;
}
function chatTools(toolValues: unknown): JsonObject[] {
  const result: JsonObject[] = [],
    groups = new Map<string, JsonObject>(),
    names = new Set<string>();
  for (const [i, value] of array(toolValues, "tools").entries()) {
    const param = `tools[${i}]`,
      tool = object(value, param);
    if (!["function", "custom"].includes(tool.type))
      requestError(
        param,
        "Only function/custom tools are supported through Chat.",
        "unsupported_tool",
      );
    const spec = object(tool[tool.type], param),
      decoded = decodeChatName(spec.name, `${param}.name`);
    if (names.has(spec.name))
      requestError(`${param}.name`, "Duplicate tool name.");
    names.add(spec.name);
    const native: JsonObject = { type: tool.type, ...spec, name: decoded.name };
    if (tool.type === "custom" && spec.format?.type === "grammar")
      native.format = {
        type: "grammar",
        ...object(spec.format.grammar, `${param}.format.grammar`),
      };
    toolDefinition(native, param);
    let group = groups.get(decoded.namespace);
    if (!group) {
      group = {
        type: "namespace",
        name: decoded.namespace,
        description: "Client tools",
        tools: [],
      };
      groups.set(decoded.namespace, group);
      result.push(group);
    }
    group.tools.push(native);
  }
  return result;
}
function choice(value: unknown, format: "responses" | "chat"): unknown {
  if (typeof value === "string") {
    if (!["auto", "none", "required"].includes(value))
      requestError("tool_choice", "Invalid tool choice.");
    return value;
  }
  const tool = object(value, "tool_choice");
  if (format === "chat") {
    if (tool.type === "allowed_tools") {
      const allowed = object(tool.allowed_tools, "tool_choice.allowed_tools");
      if (!["auto", "required"].includes(allowed.mode))
        requestError(
          "tool_choice.allowed_tools.mode",
          "Invalid allowed-tool mode.",
        );
      return {
        type: "allowed_tools",
        mode: allowed.mode,
        tools: array(allowed.tools, "tool_choice.allowed_tools.tools").map(
          (t) => choice(t, "chat"),
        ),
      };
    }
    if (!["function", "custom"].includes(tool.type))
      requestError(
        "tool_choice",
        "Unsupported Chat tool choice.",
        "unsupported_parameter",
      );
    const decoded = decodeChatName(
      object(tool[tool.type], "tool_choice").name,
      "tool_choice.name",
    );
    if (!decoded.flat)
      requestError(
        "tool_choice",
        "Selecting an encoded namespace tool cannot be represented by the native named-choice schema. Use Responses.",
        "unsupported_parameter",
      );
    return { type: tool.type, name: decoded.name };
  }
  if (tool.type === "function" || tool.type === "custom") {
    nativeName(tool.name, "tool_choice.name");
    return tool;
  }
  if (tool.type === "allowed_tools") {
    if (!["auto", "required"].includes(tool.mode))
      requestError("tool_choice.mode", "Invalid allowed-tool mode.");
    array(tool.tools, "tool_choice.tools").forEach((t) =>
      choice(t, "responses"),
    );
    return tool;
  }
  if (webTools.has(tool.type) || clientTools.has(tool.type)) return tool;
  requestError(
    "tool_choice",
    "Unsupported native tool choice.",
    "unsupported_parameter",
  );
}
export function normalizeRequest(
  input: unknown,
  format: "responses" | "chat",
): { body: JsonObject; stream: boolean; ignoredParams: string[] } {
  const source = object(input, "body");
  const model = string(source.model, "model");
  if (!model.trim()) requestError("model", "model must not be blank.");
  if (source.stream !== undefined && typeof source.stream !== "boolean")
    requestError("stream", "stream must be boolean.");
  if (source.store !== undefined && source.store !== false)
    requestError(
      "store",
      "Persistent response storage is not supported.",
      "unsupported_parameter",
    );
  let copied: JsonObject;
  try {
    copied = JSON.parse(JSON.stringify(source));
  } catch {
    requestError("body", "Request must be a JSON object.");
  }
  const body: JsonObject = { model, store: false, stream: true },
    ignoredParams: string[] = [];
  for (const [key, value] of Object.entries(copied)) {
    if (["model", "store", "stream"].includes(key)) continue;
    if (ordinary.has(key)) {
      ignoredParams.push(key);
      continue;
    }
    if (key === "n" && format === "chat" && value === 1) continue;
    if (key === "logprobs" && value === false) continue;
    if (
      key === "modalities" &&
      Array.isArray(value) &&
      value.length === 1 &&
      value[0] === "text" &&
      format === "chat"
    )
      continue;
    if (
      unsupported.has(key) ||
      key === "n" ||
      key === "logprobs" ||
      key === "modalities"
    )
      requestError(
        key,
        `${key} is not supported by this route.`,
        "unsupported_parameter",
      );
    if (!(format === "chat" ? chatFields : nativeFields).has(key))
      requestError(
        key,
        `Unknown or unsupported parameter ${key}.`,
        "unsupported_parameter",
      );
    if (
      [
        "input",
        "messages",
        "tools",
        "tool_choice",
        "reasoning_effort",
        "response_format",
      ].includes(key)
    )
      continue;
    body[key] = value;
  }
  body.input =
    format === "chat" ? chatInput(copied.messages) : nativeInput(copied.input);
  if (copied.tools !== undefined)
    body.tools =
      format === "chat"
        ? chatTools(copied.tools)
        : nativeTools(copied.tools, "tools");
  if (copied.tool_choice !== undefined)
    body.tool_choice = choice(copied.tool_choice, format);
  if (copied.reasoning_effort !== undefined) {
    if (
      copied.reasoning_effort !== null &&
      !efforts.includes(copied.reasoning_effort)
    )
      requestError("reasoning_effort", "Invalid reasoning effort.");
    body.reasoning = { effort: copied.reasoning_effort };
  }
  if (copied.response_format !== undefined) {
    const config = object(copied.response_format, "response_format");
    if (config.type === "json_schema")
      body.text = {
        format: {
          type: "json_schema",
          ...object(config.json_schema, "response_format.json_schema"),
        },
      };
    else if (["text", "json_object"].includes(config.type))
      body.text = { format: config };
    else
      requestError(
        "response_format",
        "Unsupported response format.",
        "unsupported_parameter",
      );
  }
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
    !efforts.includes(body.reasoning.effort)
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
    body.stream_options = Object.fromEntries(
      Object.entries(options).filter(([key]) => key !== "include_usage"),
    );
  }
  return { body, stream: source.stream === true, ignoredParams };
}
