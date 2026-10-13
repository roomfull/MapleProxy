import type { JsonObject } from "../auth/runtime.js";
import type { RenderStreamOptions } from "./events.js";
import { isDeepStrictEqual } from "node:util";
import { AppError } from "../shared/errors.js";
import { cleanClientRequest } from "./client-cleanup.js";
import {
  clientTools,
  filterRequestField,
  validateNativeOptions,
  webTools,
} from "./capabilities.js";
import type { RequestDiagnostic, ResponseContext } from "./types.js";
import { convertLegacyFunctions, validateToolHistory } from "./tool-history.js";
import {
  assertNativeNamespace,
  assistantHistory,
  decodeChatName,
  flatNamespace,
  nativeName,
  object,
  requestError,
  string,
  functionArguments,
} from "./chat.js";

function array(value: unknown, param: string): any[] {
  if (!Array.isArray(value)) requestError(param, `${param} must be an array.`);
  return value;
}
function normalizeArguments(
  value: string,
  path: string,
  diagnostics: RequestDiagnostic[],
): string {
  const normalized = functionArguments(value);
  if (normalized !== value)
    diagnostics.push({
      path,
      action: "normalized",
      reason: "protocol_conversion",
    });
  return normalized;
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
function nativeInput(
  value: unknown,
  diagnostics: RequestDiagnostic[],
): JsonObject[] {
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
      if (item.type === "function_call")
        item.arguments = normalizeArguments(
          item.arguments,
          `${param}.arguments`,
          diagnostics,
        );
      return item;
    }
    if (
      ["function_call_output", "custom_tool_call_output"].includes(item.type)
    ) {
      if (item.type === "function_call_output" && item.call_id == null) {
        nativeName(item.name, `${param}.name`);
        if (item.namespace && item.namespace !== flatNamespace(item.name))
          assertNativeNamespace(item.namespace, `${param}.namespace`);
        else item.namespace = flatNamespace(item.name);
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
function rememberToolName(
  context: ResponseContext,
  namespace: string,
  name: string,
  clientName: string,
) {
  if (
    !context.toolNames.some(
      (tool) =>
        tool.namespace === namespace &&
        tool.name === name &&
        tool.clientName === clientName,
    )
  )
    context.toolNames.push({ namespace, name, clientName });
}
function chatInput(
  value: unknown,
  context: ResponseContext,
  diagnostics: RequestDiagnostic[],
): JsonObject[] {
  const messages = array(value, "messages");
  if (!messages.length)
    requestError("messages", "messages must contain at least one message.");
  const inputs: JsonObject[] = [],
    calls = new Map<
      string,
      { type: string; path: string; resolved: boolean }
    >();
  for (const [i, value] of messages.entries()) {
    const param = `messages[${i}]`,
      message = object(value, param);
    if (
      !["system", "developer", "user", "assistant", "tool"].includes(
        message.role,
      )
    )
      requestError(`${param}.role`, "Unsupported Chat role.");
    for (const key of ["audio"])
      if (message[key] !== undefined)
        requestError(
          `${param}.${key}`,
          `Unsupported message field ${key}.`,
          "unsupported_parameter",
        );
    if (message.role === "tool") {
      const callId = string(message.tool_call_id, `${param}.tool_call_id`),
        call = calls.get(callId);
      if (!call)
        requestError(
          `${param}.tool_call_id`,
          "Tool output must reference a preceding assistant call.",
        );
      if (call.resolved)
        requestError(`${param}.tool_call_id`, "Duplicate tool output.");
      call.resolved = true;
      inputs.push({
        type:
          call.type === "custom"
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
      inputs.push(
        message.role === "assistant"
          ? assistantHistory(content, i)
          : {
              type: "message",
              role: message.role === "system" ? "developer" : message.role,
              content,
            },
      );
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
        rememberToolName(context, decoded.namespace, decoded.name, spec.name);
        if (calls.has(id))
          requestError(`${path}.id`, "Duplicate tool call ID.");
        calls.set(id, { type: call.type, path, resolved: false });
        const field = call.type === "function" ? "arguments" : "input";
        if (typeof spec[field] !== "string")
          requestError(path, "Tool call payload must be a string.");
        inputs.push({
          type: call.type === "function" ? "function_call" : "custom_tool_call",
          call_id: id,
          name: decoded.name,
          namespace: decoded.namespace,
          [field]:
            call.type === "function"
              ? normalizeArguments(
                  spec[field],
                  `${path}.function.arguments`,
                  diagnostics,
                )
              : spec[field],
        });
      }
    }
  }
  for (const call of calls.values())
    if (!call.resolved)
      requestError(
        call.path,
        "Tool call is missing its output in the full history.",
      );
  return inputs;
}
function chatTools(
  toolValues: unknown,
  context: ResponseContext,
  diagnostics: RequestDiagnostic[],
): JsonObject[] {
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
    if (tool.type === "function" && native.strict == null) {
      native.strict = false;
      diagnostics.push({
        path: `${param}.function.strict`,
        action: "normalized",
        reason: "protocol_conversion",
      });
    }
    rememberToolName(context, decoded.namespace, decoded.name, spec.name);
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
): {
  body: JsonObject;
  stream: boolean;
  ignoredParams: string[];
  renderOptions: RenderStreamOptions;
  diagnostics: RequestDiagnostic[];
  responseContext: ResponseContext;
} {
  const diagnostics: RequestDiagnostic[] = [];
  try {
    return normalize(input, format, diagnostics);
  } catch (error) {
    if (error instanceof AppError) error.diagnostics = diagnostics;
    throw error;
  }
}

function normalize(
  input: unknown,
  format: "responses" | "chat",
  diagnostics: RequestDiagnostic[],
) {
  const source = object(input, "body");
  const copied = cleanClientRequest(source, format, diagnostics);
  const model = string(copied.model, "model");
  if (!model.trim()) requestError("model", "model must not be blank.");
  if (copied.stream !== undefined && typeof copied.stream !== "boolean")
    requestError("stream", "stream must be boolean.");
  if (copied.store !== undefined && copied.store !== false)
    requestError(
      "store",
      "Persistent response storage is not supported.",
      "unsupported_parameter",
    );
  const body: JsonObject = { model, store: false, stream: true },
    ignoredParams: string[] = [],
    renderOptions: RenderStreamOptions = { includeUsage: false },
    responseContext: ResponseContext = {
      toolNames: [],
      legacyFunctionCall: false,
    };
  renderOptions.responseContext = responseContext;
  if (format === "chat")
    convertLegacyFunctions(copied, responseContext, diagnostics);
  for (const [key, value] of Object.entries(copied)) {
    if (filterRequestField(key, value, format, ignoredParams, diagnostics))
      continue;
    // Own JSON keys such as __proto__ must never invoke inherited setters.
    Object.defineProperty(body, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  body.input =
    format === "chat"
      ? chatInput(copied.messages, responseContext, diagnostics)
      : nativeInput(copied.input, diagnostics);
  if (format === "responses") validateToolHistory(body.input, "input");
  if (copied.tools !== undefined)
    body.tools =
      format === "chat"
        ? chatTools(copied.tools, responseContext, diagnostics)
        : nativeTools(copied.tools, "tools");
  if (copied.tool_choice !== undefined)
    body.tool_choice = choice(copied.tool_choice, format);
  if (copied.reasoning_effort !== undefined) {
    if (
      copied.reasoning_effort !== null &&
      typeof copied.reasoning_effort !== "string"
    )
      requestError("reasoning_effort", "Invalid reasoning effort.");
    if (body.reasoning !== undefined) object(body.reasoning, "reasoning");
    if (
      body.reasoning?.effort !== undefined &&
      body.reasoning.effort !== copied.reasoning_effort
    )
      requestError(
        "reasoning_effort",
        "reasoning_effort conflicts with reasoning.effort.",
      );
    body.reasoning = { ...body.reasoning, effort: copied.reasoning_effort };
    diagnostics.push({
      path: "reasoning_effort",
      action: "normalized",
      reason: "protocol_conversion",
    });
  }
  if (copied.response_format !== undefined) {
    const config = object(copied.response_format, "response_format");
    let converted: JsonObject;
    if (config.type === "json_schema")
      converted = {
        type: "json_schema",
        ...object(config.json_schema, "response_format.json_schema"),
      };
    else if (["text", "json_object"].includes(config.type)) converted = config;
    else
      requestError(
        "response_format",
        "Unsupported response format.",
        "unsupported_parameter",
      );
    if (body.text !== undefined) object(body.text, "text");
    if (
      body.text?.format !== undefined &&
      !isDeepStrictEqual(body.text.format, converted)
    )
      requestError(
        "response_format",
        "response_format conflicts with text.format.",
      );
    body.text = { ...body.text, format: converted };
    diagnostics.push({
      path: "response_format",
      action: "normalized",
      reason: "protocol_conversion",
    });
  }
  if (format === "chat" && copied.verbosity !== undefined) {
    if (body.text !== undefined) object(body.text, "text");
    if (
      body.text?.verbosity !== undefined &&
      body.text.verbosity !== copied.verbosity
    )
      requestError("verbosity", "verbosity conflicts with text.verbosity.");
    body.text = { ...body.text, verbosity: copied.verbosity };
    diagnostics.push({
      path: "verbosity",
      action: "normalized",
      reason: "protocol_conversion",
    });
  }
  validateNativeOptions(body, format, renderOptions);
  return {
    body,
    stream: copied.stream === true,
    ignoredParams,
    renderOptions,
    diagnostics,
    responseContext,
  };
}
