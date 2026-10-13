import type { JsonObject } from "../auth/runtime.js";
import { AppError } from "../shared/errors.js";
import type { ResponseContext } from "./types.js";
import {
  chatToolCall,
  chatUsage,
  responseToChat,
  unsupportedOutput,
  functionArguments,
  incompleteFinishReason,
} from "./chat.js";

export interface RenderStreamOptions {
  includeUsage?: boolean;
  responseContext?: ResponseContext;
  onTerminal?: (outcome: ResponseOutcome) => void;
}

/** Fixed metadata only: no response body or upstream reason strings. */
export interface ResponseOutcome {
  status: "completed" | "incomplete";
  incompleteReason?: "max_output_tokens" | "content_filter" | "unknown";
}

function terminal(event: JsonObject): boolean {
  return (
    event.type === "response.completed" || event.type === "response.incomplete"
  );
}
function reportTerminal(event: JsonObject, options: RenderStreamOptions): void {
  if (!terminal(event)) return;
  if (event.response?.status === "incomplete") {
    const reason = event.response.incomplete_details?.reason;
    options.onTerminal?.({
      status: "incomplete",
      incompleteReason:
        reason === "max_output_tokens" || reason === "content_filter"
          ? reason
          : "unknown",
    });
  } else if (event.response?.status === "completed")
    options.onTerminal?.({ status: "completed" });
}

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
    terminal(event) &&
    (event.type === "response.incomplete"
      ? response?.status !== "incomplete"
      : response?.status !== "completed")
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
  pending: string;
}

/** Streaming Chat representation; authoritative complete snapshots fill unsent tails. */
class ChatStream {
  private response: JsonObject = { id: "chatcmpl-mapleproxy", created_at: 0 };
  private started = false;
  private tools: ToolState[] = [];
  private itemTools = new Map<string, ToolState>();
  private outputTools = new Map<number, ToolState>();
  private text = new Map<string, string>();
  private summaries = new Map<string, string>();
  constructor(
    private readonly model: string,
    private readonly includeUsage: boolean,
    private readonly context?: ResponseContext,
  ) {}
  private chunk(delta: JsonObject, finish: string | null = null): JsonObject {
    return {
      id: this.response.id,
      object: "chat.completion.chunk",
      created: this.response.created_at,
      model: this.response.model ?? this.model,
      choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
      ...(this.includeUsage ? { usage: null } : {}),
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
    if (
      this.context?.legacyFunctionCall &&
      (this.tools.length || item.type !== "function_call")
    )
      unsupportedOutput(
        "Legacy function_call cannot represent parallel or custom calls.",
      );
    const call = chatToolCall(item, this.context),
      state: ToolState = {
        index: this.tools.length,
        item: {
          type: item.type,
          name: item.name,
          call_id: item.call_id,
          namespace: item.namespace,
        },
        emitted: "",
        pending: "",
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
          ...(this.context?.legacyFunctionCall
            ? { function_call: { name: call.function.name, arguments: "" } }
            : {
                tool_calls: [
                  {
                    index: state.index,
                    ...call,
                    [field]: { ...call[field], [payload]: "" },
                  },
                ],
              }),
        }),
      ],
    };
  }
  private toolDelta(state: ToolState, delta: string): JsonObject[] {
    if (typeof delta !== "string")
      invalidStream("Tool delta must be a string.");
    if (!delta) return [];
    state.pending += delta;
    if (state.item.type === "function_call" && !state.pending.trim()) return [];
    return this.emitToolDelta(state, state.pending.slice(state.emitted.length));
  }
  private emitToolDelta(state: ToolState, delta: string): JsonObject[] {
    if (!delta) return [];
    state.emitted += delta;
    const field = state.item.type === "function_call" ? "function" : "custom",
      payload = state.item.type === "function_call" ? "arguments" : "input";
    return [
      this.chunk({
        ...(this.context?.legacyFunctionCall
          ? { function_call: { arguments: delta } }
          : {
              tool_calls: [
                { index: state.index, [field]: { [payload]: delta } },
              ],
            }),
      }),
    ];
  }
  private finishTool(state: ToolState, value: string): JsonObject[] {
    if (typeof value !== "string" || !value.startsWith(state.pending))
      invalidStream("Completed tool payload disagrees with streamed deltas.");
    state.pending = value;
    if (state.item.type === "function_call") value = functionArguments(value);
    if (!value.startsWith(state.emitted))
      invalidStream("Completed tool payload disagrees with streamed deltas.");
    return this.emitToolDelta(state, value.slice(state.emitted.length));
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
    } else if (item.type === "reasoning") {
      for (const [i, part] of (item.summary ?? []).entries())
        if (part.type === "summary_text")
          result.push(...this.summaryText(outputIndex, i, part.text, true));
    } else if (item.type !== "web_search_call")
      unsupportedOutput(
        `Cannot represent ${item.type} in Chat. Use Responses.`,
      );
    return result;
  }
  private summaryText(
    outputIndex: number,
    summaryIndex: number,
    value: string,
    done: boolean,
  ): JsonObject[] {
    const key = JSON.stringify([outputIndex, summaryIndex]),
      prior = this.summaries.get(key) ?? "";
    if (typeof value !== "string" || (done && !value.startsWith(prior)))
      invalidStream(
        "Completed reasoning summary disagrees with streamed deltas.",
      );
    const delta = done ? value.slice(prior.length) : value;
    this.summaries.set(key, prior + delta);
    return delta ? [this.chunk({ reasoning_content: delta })] : [];
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
    } else if (
      [
        "response.reasoning_summary_text.delta",
        "response.reasoning_summary_text.done",
        "response.reasoning_summary_part.added",
        "response.reasoning_summary_part.done",
      ].includes(event.type)
    ) {
      if (!event.part || event.part.type === "summary_text")
        result.push(
          ...this.role(),
          ...this.summaryText(
            event.output_index,
            event.summary_index,
            event.delta ?? event.text ?? event.part?.text,
            !event.type.endsWith(".delta"),
          ),
        );
    } else if (event.type === "response.output_item.done") {
      result.push(
        ...this.role(),
        ...this.finishItem(event.item, event.output_index),
      );
    } else if (terminal(event)) {
      // Validate the full native output before emitting a successful finish.
      const chat = responseToChat(event.response, this.model, this.context);
      result.push(...this.role());
      for (const [i, item] of (event.response.output ?? []).entries())
        result.push(...this.finishItem(item, i));
      const annotations = chat.choices[0].message.annotations;
      if (annotations?.length) result.push(this.chunk({ annotations }));
      result.push(this.chunk({}, chat.choices[0].finish_reason));
      if (this.includeUsage && event.response.usage)
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
  options: RenderStreamOptions = {},
): AsyncIterable<string> {
  const chat =
    format === "chat"
      ? new ChatStream(
          model,
          options.includeUsage === true,
          options.responseContext,
        )
      : undefined;
  let emitted = false;
  try {
    for await (const event of events) {
      reportTerminal(event, options);
      const error = terminalError(event);
      if (error && !emitted) throw error;
      if (format === "responses") {
        emitted = true;
        yield sse(event, true);
      }
      if (error) throw error;
      if (chat) {
        if (terminal(event)) incompleteFinishReason(event.response);
        for (const chunk of chat.accept(event)) {
          emitted = true;
          yield sse(chunk);
        }
      }
      if (terminal(event)) {
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
  options: RenderStreamOptions = {},
): Promise<JsonObject> {
  try {
    for await (const event of events) {
      reportTerminal(event, options);
      const error = terminalError(event);
      if (error) throw error;
      if (terminal(event))
        return format === "responses"
          ? event.response
          : responseToChat(event.response, model, options.responseContext);
    }
  } catch (error) {
    streamError(error);
  }
  throw interrupted();
}
