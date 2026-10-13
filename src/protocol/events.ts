import type { JsonObject } from "../auth/runtime.js";
import { AppError } from "../shared/errors.js";
import {
  chatToolCall,
  chatUsage,
  responseToChat,
  unsupportedOutput,
} from "./chat.js";

function terminalError(event: JsonObject): AppError | undefined {
  if (event.type === "error")
    return new AppError(
      502,
      "upstream_stream_error",
      event.message ?? "Upstream stream failed.",
      event.param,
    );
  const response = event.response;
  if (event.type === "response.failed" || response?.status === "failed")
    return new AppError(
      502,
      "response_failed",
      response?.error?.message ?? "Upstream response failed.",
    );
  if (
    event.type === "response.incomplete" ||
    (event.type === "response.completed" && response?.status !== "completed")
  )
    return new AppError(
      502,
      "response_incomplete",
      `Upstream response is incomplete (${response?.incomplete_details?.reason ?? response?.status ?? "missing status"}).`,
    );
  return undefined;
}
function interrupted(): AppError {
  return new AppError(
    502,
    "stream_interrupted",
    "Upstream stream ended before response.completed.",
  );
}
function streamError(error: unknown): never {
  if (error instanceof AppError) throw error;
  throw interrupted();
}
function invalidStream(message: string): never {
  throw new AppError(502, "invalid_stream", message);
}
function sse(value: JsonObject, native = false): string {
  return `${native ? `event: ${value.type}\n` : ""}data: ${JSON.stringify(value)}\n\n`;
}
interface ToolState {
  index: number;
  item: {
    type: "function_call" | "custom_tool_call";
    name: string;
    call_id: string;
    namespace?: string;
  };
  emitted: string;
}

/** Streaming Chat representation; authoritative complete snapshots fill unsent tails. */
class ChatStream {
  private response: JsonObject = { id: "chatcmpl-mapleproxy", created_at: 0 };
  private started = false;
  private tools: ToolState[] = [];
  private itemTools = new Map<string, ToolState>();
  private outputTools = new Map<number, ToolState>();
  private text = new Map<string, string>();
  constructor(private readonly model: string) {}
  private chunk(delta: JsonObject, finish: string | null = null): JsonObject {
    return {
      id: this.response.id,
      object: "chat.completion.chunk",
      created: this.response.created_at,
      model: this.response.model ?? this.model,
      choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
    };
  }
  private role(): JsonObject[] {
    if (this.started) return [];
    this.started = true;
    return [this.chunk({ role: "assistant", content: "" })];
  }
  private register(
    item: JsonObject,
    outputIndex: number,
  ): { state: ToolState; chunks: JsonObject[] } {
    const existing =
      (item.id ? this.itemTools.get(item.id) : undefined) ??
      this.tools.find((t) => t.item.call_id === item.call_id);
    if (existing) {
      if (
        existing.item.call_id !== item.call_id ||
        existing.item.name !== item.name ||
        existing.item.namespace !== item.namespace ||
        existing.item.type !== item.type
      )
        invalidStream("Tool identity changed during the stream.");
      return { state: existing, chunks: [] };
    }
    const call = chatToolCall(item),
      state: ToolState = {
        index: this.tools.length,
        item: {
          type: item.type,
          name: item.name,
          call_id: item.call_id,
          namespace: item.namespace,
        },
        emitted: "",
      };
    this.tools.push(state);
    if (item.id) this.itemTools.set(item.id, state);
    this.outputTools.set(outputIndex, state);
    const field = item.type === "function_call" ? "function" : "custom",
      payload = item.type === "function_call" ? "arguments" : "input";
    return {
      state,
      chunks: [
        this.chunk({
          tool_calls: [
            {
              index: state.index,
              ...call,
              [field]: { ...call[field], [payload]: "" },
            },
          ],
        }),
      ],
    };
  }
  private toolDelta(state: ToolState, delta: string): JsonObject[] {
    if (!delta) return [];
    state.emitted += delta;
    const field = state.item.type === "function_call" ? "function" : "custom",
      payload = state.item.type === "function_call" ? "arguments" : "input";
    return [
      this.chunk({
        tool_calls: [{ index: state.index, [field]: { [payload]: delta } }],
      }),
    ];
  }
  private finishTool(state: ToolState, value: string): JsonObject[] {
    if (typeof value !== "string" || !value.startsWith(state.emitted))
      invalidStream("Completed tool payload disagrees with streamed deltas.");
    return this.toolDelta(state, value.slice(state.emitted.length));
  }
  private textKey(
    itemId: string,
    contentIndex: number,
    refusal: boolean,
  ): string {
    return JSON.stringify([itemId, contentIndex, refusal]);
  }
  private textDelta(
    key: string,
    value: string,
    refusal: boolean,
  ): JsonObject[] {
    if (typeof value !== "string")
      invalidStream("Output delta must be a string.");
    this.text.set(key, (this.text.get(key) ?? "") + value);
    return value
      ? [this.chunk({ [refusal ? "refusal" : "content"]: value })]
      : [];
  }
  private finishText(
    key: string,
    value: string,
    refusal: boolean,
  ): JsonObject[] {
    const prior = this.text.get(key) ?? "";
    if (typeof value !== "string" || !value.startsWith(prior))
      invalidStream("Completed output text disagrees with streamed deltas.");
    return this.textDelta(key, value.slice(prior.length), refusal);
  }
  private finishItem(item: JsonObject, outputIndex: number): JsonObject[] {
    const result: JsonObject[] = [];
    if (item.type === "function_call" || item.type === "custom_tool_call") {
      const { state, chunks } = this.register(item, outputIndex);
      result.push(
        ...chunks,
        ...this.finishTool(
          state,
          item.type === "function_call" ? item.arguments : item.input,
        ),
      );
    } else if (item.type === "message") {
      for (const [i, part] of (item.content ?? []).entries()) {
        if (!["output_text", "refusal"].includes(part.type))
          unsupportedOutput(
            `Cannot represent ${part.type} in Chat. Use Responses.`,
          );
        const refusal = part.type === "refusal",
          key = this.textKey(item.id ?? `output_${outputIndex}`, i, refusal);
        result.push(
          ...this.finishText(key, refusal ? part.refusal : part.text, refusal),
        );
      }
    } else if (!["reasoning", "web_search_call"].includes(item.type))
      unsupportedOutput(
        `Cannot represent ${item.type} in Chat. Use Responses.`,
      );
    return result;
  }
  accept(event: JsonObject): JsonObject[] {
    const result: JsonObject[] = [];
    if (event.response && !this.started) this.response = event.response;
    if (event.type === "response.created") return this.role();
    if (event.type === "response.output_item.added") {
      if (["function_call", "custom_tool_call"].includes(event.item.type)) {
        result.push(...this.role());
        const registered = this.register(event.item, event.output_index);
        result.push(
          ...registered.chunks,
          ...this.toolDelta(
            registered.state,
            event.item.type === "function_call"
              ? (event.item.arguments ?? "")
              : (event.item.input ?? ""),
          ),
        );
      } else if (
        !["message", "reasoning", "web_search_call"].includes(event.item.type)
      )
        unsupportedOutput(
          `Cannot represent ${event.item.type} in Chat. Use Responses.`,
        );
    } else if (
      [
        "response.function_call_arguments.delta",
        "response.custom_tool_call_input.delta",
        "response.function_call_arguments.done",
        "response.custom_tool_call_input.done",
      ].includes(event.type)
    ) {
      const state = event.item_id
        ? this.itemTools.get(event.item_id)
        : this.outputTools.get(event.output_index);
      if (!state)
        invalidStream("Tool delta arrived without an identified tool call.");
      result.push(
        ...this.role(),
        ...(event.type.endsWith(".delta")
          ? this.toolDelta(state, event.delta)
          : this.finishTool(state, event.arguments ?? event.input)),
      );
    } else if (
      [
        "response.output_text.delta",
        "response.refusal.delta",
        "response.output_text.done",
        "response.refusal.done",
      ].includes(event.type)
    ) {
      const refusal = event.type.startsWith("response.refusal"),
        key = this.textKey(
          event.item_id ?? `output_${event.output_index}`,
          event.content_index ?? 0,
          refusal,
        );
      result.push(
        ...this.role(),
        ...(event.type.endsWith(".delta")
          ? this.textDelta(key, event.delta, refusal)
          : this.finishText(
              key,
              refusal ? event.refusal : event.text,
              refusal,
            )),
      );
    } else if (event.type === "response.output_item.done") {
      result.push(
        ...this.role(),
        ...this.finishItem(event.item, event.output_index),
      );
    } else if (event.type === "response.completed") {
      // Validate the full native output before emitting a successful finish.
      const chat = responseToChat(event.response, this.model);
      result.push(...this.role());
      for (const [i, item] of (event.response.output ?? []).entries())
        result.push(...this.finishItem(item, i));
      const annotations = chat.choices[0].message.annotations;
      if (annotations?.length) result.push(this.chunk({ annotations }));
      result.push(this.chunk({}, this.tools.length ? "tool_calls" : "stop"));
      if (event.response.usage)
        result.push({
          ...this.chunk({}),
          choices: [],
          usage: chatUsage(event.response.usage),
        });
    }
    return result;
  }
}

export async function* renderStream(
  events: AsyncIterable<JsonObject>,
  format: "responses" | "chat",
  model: string,
): AsyncIterable<string> {
  const chat = format === "chat" ? new ChatStream(model) : undefined;
  try {
    for await (const event of events) {
      const error = terminalError(event);
      if (format === "responses") yield sse(event, true);
      if (error) throw error;
      if (chat) for (const chunk of chat.accept(event)) yield sse(chunk);
      if (event.type === "response.completed") {
        if (chat) yield "data: [DONE]\n\n";
        return;
      }
    }
  } catch (error) {
    streamError(error);
  }
  throw interrupted();
}
export async function collectResponse(
  events: AsyncIterable<JsonObject>,
  format: "responses" | "chat",
  model: string,
): Promise<JsonObject> {
  try {
    for await (const event of events) {
      const error = terminalError(event);
      if (error) throw error;
      if (event.type === "response.completed")
        return format === "responses"
          ? event.response
          : responseToChat(event.response, model);
    }
  } catch (error) {
    streamError(error);
  }
  throw interrupted();
}
