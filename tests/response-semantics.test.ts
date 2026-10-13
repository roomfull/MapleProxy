import { expect, it } from "vitest";
import {
  collectResponse,
  renderStream,
  type RenderStreamOptions,
} from "../src/protocol/events.js";
import type { JsonObject } from "../src/auth/runtime.js";
async function* events(...values: JsonObject[]) {
  yield* values;
}
async function frames(source: AsyncIterable<string>) {
  const result: string[] = [];
  for await (const value of source) result.push(value);
  return result;
}
const usage = { input_tokens: 11, output_tokens: 5, total_tokens: 16 };
const finalResponse = (output: JsonObject[]) => ({
  id: "r",
  created_at: 1,
  status: "completed",
  output,
  usage,
});

const message = {
  type: "message",
  id: "m",
  role: "assistant",
  content: [{ type: "output_text", text: "partial🍁", annotations: [] }],
};
const summary = {
  type: "reasoning",
  id: "reason",
  summary: [
    { type: "summary_text", text: "核对证据" },
    { type: "summary_text", text: "后续" },
  ],
  encrypted_content: "never-map-encrypted",
};
const complete = (output = [summary, message]) => ({
  type: "response.completed",
  response: finalResponse(output),
});
const chunks = (values: string[]) =>
  values
    .filter((v) => !v.includes("[DONE]"))
    .map((v) => JSON.parse(v.slice(6)));

it("maps only received summaries in nonstream Chat", async () => {
  const result = await collectResponse(events(complete()), "chat", "m");
  expect(result.choices[0].message.reasoning_content).toBe("核对证据后续");
  expect(JSON.stringify(result)).not.toContain("never-map-encrypted");
  const empty = await collectResponse(
    events(complete([{ ...summary, summary: [] }, message])),
    "chat",
    "m",
  );
  expect(empty.choices[0].message).not.toHaveProperty("reasoning_content");
});

it("agrees on complete-only multi-part summaries in Chat stream and JSON", async () => {
  const native = complete([
    summary,
    {
      ...summary,
      id: "reason2",
      summary: [{ type: "summary_text", text: "末尾" }],
    },
    message,
  ]);
  const rendered = chunks(
    await frames(renderStream(events(native), "chat", "m")),
  );
  const collected = await collectResponse(events(native), "chat", "m");
  expect(
    rendered
      .flatMap((c) => c.choices)
      .map((c) => c.delta.reasoning_content ?? "")
      .join(""),
  ).toBe(collected.choices[0].message.reasoning_content);
  expect(collected.choices[0].message.reasoning_content).toBe(
    "核对证据后续末尾",
  );
});

it("uses incomplete finish reasons ahead of legacy function completion", async () => {
  const source = {
    type: "response.incomplete",
    response: {
      ...finalResponse([
        {
          type: "function_call",
          id: "i",
          call_id: "c",
          name: "f",
          arguments: "{}",
        },
      ]),
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
    },
  };
  const options = {
    responseContext: { legacyFunctionCall: true, toolNames: [] },
  };
  expect(
    (await collectResponse(events(source), "chat", "m", options)).choices[0]
      .finish_reason,
  ).toBe("length");
  expect(
    chunks(await frames(renderStream(events(source), "chat", "m", options))).at(
      -1,
    ).choices[0].finish_reason,
  ).toBe("length");
});

it("assembles summary deltas and fills done/item/final tails once", async () => {
  const result = chunks(
    await frames(
      renderStream(
        events(
          { type: "response.reasoning_text.delta", delta: "raw-never-map" },
          {
            type: "response.reasoning_summary_text.delta",
            item_id: "reason",
            output_index: 0,
            summary_index: 0,
            delta: "核对",
          },
          {
            type: "response.reasoning_summary_text.done",
            item_id: "reason",
            output_index: 0,
            summary_index: 0,
            text: "核对证据",
          },
          {
            type: "response.reasoning_summary_part.done",
            item_id: "reason",
            output_index: 0,
            summary_index: 0,
            part: { type: "summary_text", text: "核对证据" },
          },
          { type: "response.output_item.done", output_index: 0, item: summary },
          complete(),
        ),
        "chat",
        "m",
      ),
    ),
  );
  expect(
    result
      .flatMap((c) => c.choices)
      .map((c) => c.delta.reasoning_content ?? "")
      .join(""),
  ).toBe("核对证据后续");
  expect(JSON.stringify(result)).not.toContain("raw-never-map");
  expect(JSON.stringify(result)).not.toContain("never-map-encrypted");
});

it.each(["max_output_tokens", "content_filter"])(
  "maps Chat incomplete %s with partial output, usage and DONE",
  async (reason) => {
    const response = {
      ...finalResponse([message]),
      status: "incomplete",
      incomplete_details: { reason },
    };
    const terminal = { type: "response.incomplete", response };
    const outcome: unknown[] = [];
    const options = {
      includeUsage: true,
      onTerminal: (value: unknown) => outcome.push(value),
    } as RenderStreamOptions;
    const collected = await collectResponse(
      events(terminal),
      "chat",
      "m",
      options,
    );
    const finish = reason === "max_output_tokens" ? "length" : "content_filter";
    expect(collected.choices[0]).toMatchObject({
      finish_reason: finish,
      message: { content: "partial🍁" },
    });
    const output = await frames(
      renderStream(
        events(
          {
            type: "response.output_text.delta",
            item_id: "m",
            output_index: 0,
            content_index: 0,
            delta: "partial",
          },
          terminal,
        ),
        "chat",
        "m",
        options,
      ),
    );
    const rendered = chunks(output);
    expect(
      rendered
        .flatMap((c) => c.choices)
        .map((c) => c.delta.content ?? "")
        .join(""),
    ).toBe("partial🍁");
    expect(rendered.at(-2).choices[0].finish_reason).toBe(finish);
    expect(rendered.at(-1).usage.total_tokens).toBe(usage.total_tokens);
    expect(output.at(-1)).toBe("data: [DONE]\n\n");
    expect(outcome).toEqual([
      { status: "incomplete", incompleteReason: reason },
      { status: "incomplete", incompleteReason: reason },
    ]);
  },
);

it.each(["max_output_tokens", "future_reason"])(
  "preserves native incomplete %s and reports safe outcome",
  async (reason) => {
    const response = {
      ...finalResponse([message]),
      status: "incomplete",
      incomplete_details: { reason },
    };
    const terminal = { type: "response.incomplete", response };
    const outcome: unknown[] = [];
    const options = {
      onTerminal: (value: unknown) => outcome.push(value),
    } as RenderStreamOptions;
    expect(
      await collectResponse(events(terminal), "responses", "m", options),
    ).toEqual(response);
    expect(
      await frames(renderStream(events(terminal), "responses", "m", options)),
    ).toEqual([
      `event: response.incomplete\ndata: ${JSON.stringify(terminal)}\n\n`,
    ]);
    expect(outcome).toEqual(
      Array(2).fill({
        status: "incomplete",
        incompleteReason: reason === "future_reason" ? "unknown" : reason,
      }),
    );
  },
);

it("rejects unknown Chat truncation with no success markers and safe metadata", async () => {
  const seen: unknown[] = [],
    emitted: string[] = [];
  const terminal = {
    type: "response.incomplete",
    response: {
      ...finalResponse([message]),
      status: "incomplete",
      incomplete_details: { reason: "private unknown reason" },
    },
  };
  try {
    for await (const frame of renderStream(
      events({ type: "response.created", response: { id: "r" } }, terminal),
      "chat",
      "m",
      { onTerminal: (v: unknown) => seen.push(v) } as RenderStreamOptions,
    ))
      emitted.push(frame);
    expect.fail("must throw");
  } catch (error) {
    expect(error).toMatchObject({ code: "response_incomplete" });
  }
  expect(emitted.join("")).not.toContain("[DONE]");
  expect(emitted.join("")).not.toContain('"finish_reason":"stop"');
  expect(seen).toEqual([{ status: "incomplete", incompleteReason: "unknown" }]);
});

it.each(["response.failed", "error"])(
  "stages initial native %s before yielding anything",
  async (type) => {
    const iterator = renderStream(
      events({ type, message: "failure", response: { status: "failed" } }),
      "responses",
      "m",
    )[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toMatchObject({ status: 502 });
  },
);

it.each(["response.completed", "response.incomplete"])(
  "does not report a mismatched %s terminal status",
  async (type) => {
    const seen: unknown[] = [];
    const value = {
      type,
      response: {
        ...finalResponse([message]),
        status: type === "response.completed" ? "incomplete" : "completed",
      },
    };
    const options = { onTerminal: (outcome: unknown) => seen.push(outcome) };
    await expect(
      collectResponse(events(value), "responses", "m", options),
    ).rejects.toMatchObject({ code: "response_incomplete" });
    await expect(
      frames(renderStream(events(value), "responses", "m", options)),
    ).rejects.toMatchObject({ code: "response_incomplete" });
    expect(seen).toEqual([]);
  },
);
