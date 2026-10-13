import OpenAI from "openai";
import { expect, it } from "vitest";
import { collectResponse, renderStream } from "../src/protocol/events.js";
import type { JsonObject } from "../src/auth/runtime.js";

async function sdkEvents(
  values: JsonObject[],
  fragment: number,
  newline = "\r\n",
) {
  const bytes = new TextEncoder().encode(
    values
      .map(
        (v) =>
          `: comment${newline}event: ${v.type}${newline}data: ${JSON.stringify(v)}${newline}${newline}`,
      )
      .join(""),
  );
  const client = new OpenAI({
    apiKey: "test-not-real",
    fetch: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (let p = 0; p < bytes.length; p += fragment)
              controller.enqueue(bytes.slice(p, p + fragment));
            controller.close();
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      ),
  });
  return client.responses.create({
    model: "test",
    input: [],
    stream: true,
    store: false,
  });
}
it.each([1, 2, 3, 7, 53])(
  "uses runtime SDK transport for UTF8/SSE fragments of %i bytes",
  async (fragment) => {
    const response = {
      id: "r",
      created_at: 1,
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          id: "m",
          content: [{ type: "output_text", text: "你好🍁", annotations: [] }],
        },
      ],
    };
    const source = await sdkEvents(
      [
        {
          type: "response.output_text.delta",
          item_id: "m",
          output_index: 0,
          content_index: 0,
          delta: "你好🍁",
        },
        { type: "response.completed", response },
      ],
      fragment,
    );
    const result: string[] = [];
    for await (const frame of renderStream(source, "chat", "test"))
      result.push(frame);
    expect(result.join("")).toContain("你好🍁");
    expect(result.at(-1)).toBe("data: [DONE]\n\n");
  },
);
it("detects premature transport EOF and incomplete terminal after SDK-parsed deltas", async () => {
  const delta = {
    type: "response.output_text.delta",
    item_id: "m",
    output_index: 0,
    content_index: 0,
    delta: "partial",
  };
  await expect(
    collectResponse(await sdkEvents([delta], 1, "\n"), "responses", "test"),
  ).rejects.toMatchObject({ code: "stream_interrupted" });
  await expect(
    collectResponse(
      await sdkEvents(
        [
          delta,
          {
            type: "response.incomplete",
            response: {
              id: "r",
              status: "incomplete",
              incomplete_details: { reason: "max_output_tokens" },
            },
          },
        ],
        2,
      ),
      "chat",
      "test",
    ),
  ).rejects.toMatchObject({ code: "response_incomplete" });
});
it("preserves call IDs and mixed text/tool payloads through bytewise SDK parsing", async () => {
  const tool = {
    type: "function_call",
    id: "item_f",
    call_id: "call_f",
    name: "f",
    arguments: "",
  };
  const output = [
    {
      type: "message",
      id: "m",
      role: "assistant",
      content: [{ type: "output_text", text: "查🍁", annotations: [] }],
    },
    { ...tool, arguments: '{"城市":"上海"}' },
  ];
  const source = await sdkEvents(
    [
      { type: "response.output_item.added", output_index: 1, item: tool },
      {
        type: "response.output_text.delta",
        item_id: "m",
        output_index: 0,
        content_index: 0,
        delta: "查🍁",
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: 1,
        item_id: "item_f",
        delta: '{"城市":',
      },
      {
        type: "response.completed",
        response: { id: "r", created_at: 1, status: "completed", output },
      },
    ],
    1,
  );
  const result: JsonObject[] = [];
  for await (const frame of renderStream(source, "chat", "test"))
    if (!frame.includes("[DONE]")) result.push(JSON.parse(frame.slice(6)));
  const deltas = result.flatMap((r) =>
    r.choices.map((c: JsonObject) => c.delta),
  );
  expect(deltas.map((d) => d.content ?? "").join("")).toBe("查🍁");
  const calls = deltas.flatMap((d) => d.tool_calls ?? []);
  expect(calls.filter((c) => c.id).map((c) => c.id)).toEqual(["call_f"]);
  expect(calls.map((c) => c.function?.arguments ?? "").join("")).toBe(
    '{"城市":"上海"}',
  );
});
it("preserves the native failed event after parsed deltas and never emits success", async () => {
  const failed = {
    type: "response.failed",
    response: {
      id: "r",
      status: "failed",
      error: { code: "limit", message: "Limit" },
    },
  };
  const source = await sdkEvents(
    [
      {
        type: "response.output_text.delta",
        item_id: "m",
        output_index: 0,
        content_index: 0,
        delta: "部分",
      },
      failed,
    ],
    3,
  );
  const frames: string[] = [];
  try {
    for await (const frame of renderStream(source, "responses", "test"))
      frames.push(frame);
    expect.fail("must throw");
  } catch (error) {
    expect(error).toMatchObject({ code: "response_failed" });
  }
  expect(frames.at(-1)).toBe(
    `event: response.failed\ndata: ${JSON.stringify(failed)}\n\n`,
  );
  expect(frames.join("")).not.toContain("[DONE]");
});
