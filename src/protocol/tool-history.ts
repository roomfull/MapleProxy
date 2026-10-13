import type { JsonObject } from "../auth/runtime.js";
import type { RequestDiagnostic, ResponseContext } from "./types.js";
import {
  decodeChatName,
  functionArguments,
  object,
  requestError,
  string,
} from "./chat.js";

/** Legacy IDs are deterministic for the supplied full history, never session state. */
export function convertLegacyFunctions(
  request: JsonObject,
  context: ResponseContext,
  diagnostics: RequestDiagnostic[],
): void {
  const converted = (path: string) =>
    diagnostics.push({
      path,
      action: "normalized",
      reason: "protocol_conversion",
    });
  if (request.functions !== undefined) {
    if (request.tools !== undefined)
      requestError("functions", "functions conflicts with tools.");
    if (!Array.isArray(request.functions))
      requestError("functions", "functions must be an array.");
    request.tools = request.functions.map((value: unknown, i: number) => {
      const spec = object(value, `functions[${i}]`);
      if (spec.strict == null) {
        spec.strict = false;
        converted(`functions[${i}].strict`);
      }
      return { type: "function", function: spec };
    });
    delete request.functions;
    context.legacyFunctionCall = true;
    converted("functions");
  }
  if (request.function_call !== undefined) {
    if (request.tool_choice !== undefined)
      requestError(
        "function_call",
        "function_call conflicts with tool_choice.",
      );
    const value = request.function_call;
    if (typeof value === "string") {
      if (!["auto", "none"].includes(value))
        requestError("function_call", "Invalid legacy function choice.");
      request.tool_choice = value;
    } else
      request.tool_choice = {
        type: "function",
        function: { name: object(value, "function_call").name },
      };
    delete request.function_call;
    context.legacyFunctionCall = true;
    converted("function_call");
  }
  if (!Array.isArray(request.messages)) return;
  const pending = new Map<string, Array<{ id: string; resolved: boolean }>>();
  for (const [i, message] of request.messages.entries()) {
    if (!message || typeof message !== "object") continue;
    const path = `messages[${i}]`;
    if (message.function_call !== undefined) {
      if (message.role !== "assistant")
        requestError(
          `${path}.function_call`,
          "Only assistant messages may call functions.",
        );
      if (message.tool_calls !== undefined)
        requestError(
          `${path}.function_call`,
          "function_call conflicts with tool_calls.",
        );
      const spec = object(message.function_call, `${path}.function_call`);
      decodeChatName(spec.name, `${path}.function_call.name`);
      if (typeof spec.arguments !== "string")
        requestError(
          `${path}.function_call.arguments`,
          "Function arguments must be a string.",
        );
      if (!spec.arguments.trim()) {
        spec.arguments = functionArguments(spec.arguments);
        converted(`${path}.function_call.arguments`);
      }
      const id = `call_mapleproxy_legacy_${i}`;
      message.tool_calls = [{ id, type: "function", function: spec }];
      const entries = pending.get(spec.name) ?? [];
      entries.push({ id, resolved: false });
      pending.set(spec.name, entries);
      delete message.function_call;
      context.legacyFunctionCall = true;
      converted(`${path}.function_call`);
    } else if (message.role === "function") {
      const name = string(message.name, `${path}.name`);
      const entries = (pending.get(name) ?? []).filter((x) => !x.resolved);
      if (entries.length !== 1)
        requestError(
          `${path}.name`,
          "Function output must uniquely match a preceding legacy call.",
        );
      entries[0]!.resolved = true;
      message.role = "tool";
      message.tool_call_id = entries[0]!.id;
      delete message.name;
      context.legacyFunctionCall = true;
      converted(`${path}.role`);
    }
  }
}

/** Native named outputs without a call are supported; ID pairs are exact/unique. */
export function validateToolHistory(input: JsonObject[], root: string): void {
  const calls = new Map<
    string,
    { item: JsonObject; path: string; resolved: boolean }
  >();
  for (const [i, item] of input.entries()) {
    const path = `${root}[${i}]`;
    if (["function_call", "custom_tool_call"].includes(item.type)) {
      if (calls.has(item.call_id))
        requestError(`${path}.call_id`, "Duplicate tool call ID.");
      calls.set(item.call_id, { item, path, resolved: false });
    } else if (
      ["function_call_output", "custom_tool_call_output"].includes(item.type)
    ) {
      if (item.type === "function_call_output" && item.call_id == null) {
        const matches = [...calls.values()].filter(
          (x) =>
            !x.resolved &&
            x.item.type === "function_call" &&
            x.item.name === item.name &&
            x.item.namespace === item.namespace,
        );
        if (matches.length > 1)
          requestError(path, "Named output cannot uniquely match a tool call.");
        if (matches.length === 1) matches[0]!.resolved = true;
        continue;
      }
      const call = calls.get(item.call_id);
      if (!call || call.item.type + "_output" !== item.type)
        requestError(
          `${path}.call_id`,
          "Tool output must match a preceding call of the same type.",
        );
      if (call.resolved)
        requestError(`${path}.call_id`, "Duplicate tool output.");
      call.resolved = true;
    }
  }
  for (const call of calls.values())
    if (!call.resolved)
      requestError(
        call.path,
        "Tool call is missing its output in the full history.",
      );
}
