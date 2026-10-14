import { afterEach, beforeEach, expect, it } from "vitest";
import OpenAI from "openai";
import { createServer, request as httpRequest } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import {
  setTimeout as delay,
  setImmediate as immediate,
} from "node:timers/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import { createApp } from "../src/server/app.js";
import { SecurityStore } from "../src/server/security.js";
import { createAccountRuntime } from "../src/auth/runtime.js";
import type { AccountRuntime, JsonObject } from "../src/auth/runtime.js";
import { fixture, encryption } from "./helpers.js";

const message = (text: string) => ({
  type: "message",
  id: "msg_local",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text, annotations: [] }],
});
const completed = (output = [message("hello你好🍁")]) => ({
  id: "resp_local",
  object: "response",
  created_at: 1,
  status: "completed",
  model: "test-model",
  output,
  usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
});
async function fragmented(res: ServerResponse, events: JsonObject[]) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "x-request-id": "local-upstream",
  });
  const bytes = Buffer.from(
    events
      .map(
        (event) =>
          `: fixture\r\nevent: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`,
      )
      .join(""),
  );
  // Deliberately split JSON, CRLF framing and multibyte UTF-8 over real TCP writes.
  for (let offset = 0; offset < bytes.length && !res.destroyed; offset += 3) {
    res.write(bytes.subarray(offset, offset + 3));
    await immediate();
  }
  res.end();
}
type Handler = (
  body: JsonObject,
  response: ServerResponse,
  request: IncomingMessage,
) => Promise<void>;
let upstream: Server,
  app: FastifyInstance,
  client: OpenAI,
  url: string,
  secret: string;
let cleanup: () => Promise<void>, runtime: AccountRuntime;
let calls: { body: JsonObject; authorization?: string }[], handler: Handler;
beforeEach(async () => {
  const data = await fixture();
  cleanup = data.cleanup;
  calls = [];
  handler = async (_body, response) =>
    fragmented(response, [
      { type: "response.completed", response: completed() },
    ]);
  upstream = createServer((request, response) => {
    void (async () => {
      if (request.url === "/v1/models") {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            models: [
              {
                slug: "test-model",
                display_name: "Test model",
                visibility: "list",
              },
            ],
          }),
        );
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      calls.push({ body, authorization: request.headers.authorization });
      await handler(body, response, request);
    })().catch(() => response.destroy());
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  const upstreamURL = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  runtime = createAccountRuntime({
    dataDir: data.dataDir,
    encryption,
    fetch: async (input, init) => {
      const remote = new URL(String(input));
      expect(remote.origin).toBe("https://api.openai.com");
      expect(["/v1/responses", "/v1/models"]).toContain(remote.pathname);
      return fetch(`${upstreamURL}${remote.pathname}`, init);
    },
  });
  secret = (
    await new SecurityStore(data.dataDir, encryption).createKey("integration")
  ).secret;
  app = await createApp({
    runtime,
    dataDir: data.dataDir,
    port: 0,
    encryption,
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  client = new OpenAI({
    apiKey: secret,
    baseURL: `${url}/v1`,
    maxRetries: 0,
    logLevel: "off",
  });
});
afterEach(async () => {
  app?.server.closeAllConnections();
  await app?.close();
  upstream?.closeAllConnections();
  await new Promise<void>((resolve) => upstream?.close(() => resolve()));
  await cleanup?.();
});

it("uses official downstream SDK models and both nonstream routes through fragmented real upstream sockets", async () => {
  expect((await client.models.list()).data[0]?.id).toBe("test-model");
  const chat = await client.chat.completions.create({
    model: "test-model",
    messages: [{ role: "user", content: "hello" }],
    temperature: 0.5,
  });
  expect(chat.choices[0]?.message.content).toBe("hello你好🍁");
  const native = await client.responses.create({
    model: "test-model",
    input: "hello",
  });
  expect(native.output_text).toBe("hello你好🍁");
  expect(calls).toHaveLength(2);
  for (const call of calls) {
    expect(call.authorization).toBe("Bearer access_a");
    expect(call.body).toMatchObject({ stream: true, store: false });
    expect(call.body).not.toHaveProperty("temperature");
  }
});

it("roundtrips streamed Chat function calls and full multi-turn history with stable call identity", async () => {
  const tool = {
    type: "function",
    function: {
      name: "weather",
      parameters: { type: "object", properties: { city: { type: "string" } } },
    },
  } as const;
  handler = async (body, response) => {
    if (calls.length === 1) {
      const call = {
        type: "function_call",
        id: "fc_local",
        call_id: "call_weather",
        namespace: body.tools[0].name,
        name: "weather",
        arguments: '{"city":"上海"}',
        status: "completed",
      };
      await fragmented(response, [
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { ...call, arguments: "" },
        },
        {
          type: "response.function_call_arguments.delta",
          output_index: 0,
          item_id: call.id,
          delta: '{"city":',
        },
        { type: "response.completed", response: completed([call] as any) },
      ]);
    } else
      await fragmented(response, [
        {
          type: "response.completed",
          response: completed([message("上海晴🍁")]),
        },
      ]);
  };
  const stream = await client.chat.completions.create({
    model: "test-model",
    tools: [tool],
    messages: [{ role: "user", content: "天气?" }],
    stream: true,
    stream_options: { include_usage: true },
  });
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const parts = chunks.flatMap((c) =>
    c.choices.flatMap((choice) => choice.delta.tool_calls ?? []),
  );
  const call = {
    id: parts.find((p) => p.id)?.id!,
    type: "function" as const,
    function: {
      name: parts.find((p) => p.function?.name)?.function?.name!,
      arguments: parts.map((p) => p.function?.arguments ?? "").join(""),
    },
  };
  expect(call).toEqual({
    id: "call_weather",
    type: "function",
    function: { name: "weather", arguments: '{"city":"上海"}' },
  });
  expect(chunks.at(-1)?.usage?.total_tokens).toBe(5);
  const result = await client.chat.completions.create({
    model: "test-model",
    tools: [tool],
    messages: [
      { role: "user", content: "天气?" },
      { role: "assistant", content: null, tool_calls: [call] },
      { role: "tool", tool_call_id: call.id, content: "晴" },
      { role: "user", content: "中文回答" },
    ],
  });
  expect(result.choices[0]?.message.content).toBe("上海晴🍁");
  expect(calls[1]?.body.input).toMatchObject([
    { role: "user" },
    {
      type: "function_call",
      call_id: "call_weather",
      name: "weather",
      namespace: calls[0]?.body.tools[0].name,
      arguments: '{"city":"上海"}',
    },
    { type: "function_call_output", call_id: "call_weather", output: "晴" },
    { role: "user" },
  ]);
});

it("replays complete native tool and encrypted reasoning output over SDK multi-turn Responses", async () => {
  const call = {
    type: "function_call",
    id: "fc_native",
    call_id: "call_native",
    namespace: "weather_api",
    name: "weather",
    arguments: '{"city":"上海"}',
    status: "completed",
  };
  const reasoning = {
    type: "reasoning",
    id: "rs_native",
    summary: [],
    encrypted_content: "synthetic-encrypted",
  };
  handler = async (_body, response) =>
    fragmented(response, [
      {
        type: "response.completed",
        response: completed(
          calls.length === 1
            ? ([reasoning, call] as any)
            : [message("上海晴🍁")],
        ),
      },
    ]);
  const tools = [
    {
      type: "namespace",
      name: "weather_api",
      description: "Fixture",
      tools: [
        {
          type: "function",
          name: "weather",
          parameters: { type: "object", properties: {} },
          strict: false,
        },
      ],
    },
  ] as any;
  const input = [{ role: "user", content: "天气?" }] as const;
  const stream = await client.responses.create({
    model: "test-model",
    input: [...input],
    tools,
    stream: true,
  });
  let first: OpenAI.Responses.Response | undefined;
  for await (const event of stream)
    if (event.type === "response.completed") first = event.response;
  expect(first?.output).toEqual([reasoning, call]);
  const replay = first!.output.filter(
    (
      item,
    ): item is
      | OpenAI.Responses.ResponseFunctionToolCall
      | OpenAI.Responses.ResponseReasoningItem =>
      item.type === "function_call" || item.type === "reasoning",
  );
  const result = await client.responses.create({
    model: "test-model",
    tools,
    input: [
      ...input,
      ...replay,
      { type: "function_call_output", call_id: call.call_id, output: "晴" },
    ],
  });
  expect(result.output_text).toBe("上海晴🍁");
  expect(calls[1]?.body.input.slice(1, 3)).toEqual([reasoning, call]);
  expect(calls[1]?.body.input[3]).toMatchObject({
    type: "function_call_output",
    call_id: "call_native",
    output: "晴",
  });
});

it.each(["failed", "eof", "error"])(
  "never reports success after %s streams, through both official downstream SDKs",
  async (failure) => {
    const events: JsonObject[] = [
      {
        type: "response.output_text.delta",
        item_id: "msg_local",
        output_index: 0,
        content_index: 0,
        delta: "partial🍁",
      },
    ];
    if (failure === "error")
      events.push({
        type: "error",
        code: "invalid_token",
        message: "synthetic-private-detail",
        param: "model",
        sequence_number: 7,
      });
    else if (failure !== "eof")
      events.push({
        type: `response.${failure}`,
        response: {
          id: "resp_local",
          status: failure,
          error: { message: "synthetic-private-detail" },
          incomplete_details: { reason: "max_output_tokens" },
        },
      });
    handler = async (_body, response) => fragmented(response, events);
    for (const format of ["chat", "responses"] as const) {
      const stream =
        format === "chat"
          ? await client.chat.completions.create({
              model: "test-model",
              messages: [{ role: "user", content: "fail" }],
              stream: true,
              stream_options: { include_usage: true },
            })
          : await client.responses.create({
              model: "test-model",
              input: "fail",
              stream: true,
            });
      const received: JsonObject[] = [];
      await expect(
        (async () => {
          for await (const event of stream) received.push(event);
        })(),
      ).rejects.toThrow();
      expect(JSON.stringify(received)).toContain("partial🍁");
      expect(
        received.some(
          (event) =>
            event.type === "response.completed" ||
            event.choices?.some((c: JsonObject) => c.finish_reason),
        ),
      ).toBe(false);
      expect(received.some((event) => event.usage != null)).toBe(false);
      const raw = await fetch(
        `${url}/v1/${format === "chat" ? "chat/completions" : "responses"}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${secret}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(
            format === "chat"
              ? {
                  model: "test-model",
                  messages: [{ role: "user", content: "fail" }],
                  stream: true,
                }
              : { model: "test-model", input: "fail", stream: true },
          ),
        },
      );
      const text = await raw.text();
      expect(text).toContain("event: error");
      expect(text).not.toContain("[DONE]");
      if (failure === "error" && format === "responses") {
        const native = text
          .split("\n\n")
          .find((frame) => frame.includes('"sequence_number":7'))!;
        expect(JSON.parse(native.split("data: ")[1]!)).toEqual(events.at(-1));
      }
      // Native terminal events preserve upstream payloads by contract; our generated error stays generic.
      expect(text.split("event: error").at(-1)).not.toContain(
        "synthetic-private-detail",
      );
    }
  },
);

it.each(["max_output_tokens", "content_filter"])(
  "retains incomplete %s through official SDKs and real upstream sockets",
  async (reason) => {
    const response = {
      ...completed([message("partial🍁")]),
      status: "incomplete",
      incomplete_details: { reason },
    };
    handler = async (_body, downstream) =>
      fragmented(downstream, [
        {
          type: "response.output_text.delta",
          item_id: "msg_local",
          output_index: 0,
          content_index: 0,
          delta: "partial",
        },
        { type: "response.incomplete", response },
      ]);
    const native = await client.responses.create({
      model: "test-model",
      input: "x",
    });
    expect(native).toMatchObject({
      status: "incomplete",
      incomplete_details: { reason },
      output: response.output,
    });
    const chat = await client.chat.completions.create({
      model: "test-model",
      messages: [{ role: "user", content: "x" }],
    });
    expect(chat.choices[0]).toMatchObject({
      finish_reason:
        reason === "max_output_tokens" ? "length" : "content_filter",
      message: { content: "partial🍁" },
    });
    const stream = await client.responses.create({
      model: "test-model",
      input: "x",
      stream: true,
    });
    const received: JsonObject[] = [];
    for await (const event of stream) received.push(event);
    expect(received.at(-1)).toEqual({ type: "response.incomplete", response });
  },
);

it("pauses a real socket producer under backpressure, then aborts and closes it on disconnect", async () => {
  // Keep the HTTP server real; measure bounded demand and cancellation of a synthetic upstream.
  let produced = 0,
    returned = false,
    aborted = false,
    blockedWrites = 0;
  let producedAtAbort: number | undefined;
  const original = runtime.requestResponses;
  runtime.requestResponses = async ({ signal }) => {
    signal!.addEventListener(
      "abort",
      () => {
        producedAtAbort = produced;
        aborted = true;
      },
      { once: true },
    );
    return {
      status: 200,
      profileId: "a",
      headers: new Headers(),
      events: (async function* () {
        try {
          while (produced < 1024) {
            produced++;
            yield {
              type: "response.output_text.delta",
              item_id: "msg_local",
              output_index: 0,
              content_index: 0,
              delta: "x".repeat(128 * 1024),
            };
          }
        } finally {
          returned = true;
        }
      })(),
    };
  };
  app.server.prependListener("request", (_req, res) => {
    const write = res.write;
    res.write = function (this: ServerResponse, ...args: any[]) {
      const result = (write as any).apply(this, args);
      if (!result) blockedWrites++;
      return result;
    } as typeof res.write;
  });
  let response: IncomingMessage | undefined;
  const request = httpRequest(`${url}/v1/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
    },
  });
  const connected = new Promise<void>((resolve, reject) => {
    request.once("response", (r) => {
      response = r;
      r.pause();
      resolve();
    });
    request.once("error", reject);
  });
  request.end(
    JSON.stringify({ model: "test-model", input: "pressure", stream: true }),
  );
  try {
    await connected;
    await delay(200);
    expect(blockedWrites).toBeGreaterThan(0);
    expect(produced).toBeGreaterThan(0);
    expect(produced).toBeLessThan(1024);
    const pausedAt = produced;
    await delay(100);
    expect(produced).toBe(pausedAt);
    response!.destroy();
    await expect.poll(() => aborted && returned, { timeout: 2000 }).toBe(true);
    // Local destroy initiates disconnect; TCP may drain before the server sees it.
    // Once the server observes abort, finalization must consume no further events.
    expect(produced).toBe(producedAtAbort);
    expect(produced).toBeLessThan(1024);
    await immediate();
    expect(produced).toBe(producedAtAbort);
  } finally {
    response?.destroy();
    request.destroy();
    runtime.requestResponses = original;
  }
});

it("propagates downstream SDK abort to a stalled real upstream socket without replay", async () => {
  let closed = false;
  handler = async (_body, response) => {
    response.once("close", () => {
      closed = true;
    });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(
      `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_stalled", status: "in_progress" } })}\n\n`,
    );
  };
  const stream = await client.responses.create({
    model: "test-model",
    input: "stall",
    stream: true,
  });
  for await (const event of stream) {
    expect(event.type).toBe("response.created");
    stream.controller.abort();
    break;
  }
  await expect.poll(() => closed, { timeout: 2000 }).toBe(true);
  expect(calls).toHaveLength(1);
});

it("runs the documented SDK example with credentials in environment only", async () => {
  const result = await promisify(execFile)(
    process.execPath,
    ["examples/client.mjs"],
    {
      env: {
        ...process.env,
        MAPLEPROXY_API_KEY: secret,
        MAPLEPROXY_BASE_URL: `${url}/v1`,
      },
      windowsHide: true,
    },
  );
  expect(result.stdout.trim().split(/\r?\n/)).toEqual([
    "hello你好🍁",
    "hello你好🍁",
  ]);
  expect(result.stderr).toBe("");
  expect(calls).toHaveLength(2);
});

it("freezes the runtime account on each socket stream and disables only that account", async () => {
  const closed: boolean[] = [];
  handler = async (_body, response) => {
    const index = calls.length - 1;
    closed[index] = false;
    response.once("close", () => {
      closed[index] = true;
    });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(
      `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: `resp_${index}`, status: "in_progress" } })}\n\n`,
    );
  };
  const first = await client.responses.create({
    model: "test-model",
    input: "first",
    stream: true,
  });
  const firstIterator = first[Symbol.asyncIterator]();
  expect((await firstIterator.next()).value.type).toBe("response.created");
  await runtime.selectAccount("b");
  const second = await client.responses.create({
    model: "test-model",
    input: "second",
    stream: true,
  });
  const secondIterator = second[Symbol.asyncIterator]();
  expect((await secondIterator.next()).value.type).toBe("response.created");
  try {
    expect(calls.map((c) => c.authorization)).toEqual([
      "Bearer access_a",
      "Bearer access_b",
    ]);
    await runtime.setEnabled("a", false);
    await expect(firstIterator.next()).rejects.toThrow();
    await expect.poll(() => closed[0], { timeout: 2000 }).toBe(true);
    expect(closed[1]).toBe(false);
    expect(calls).toHaveLength(2);
  } finally {
    first.controller.abort();
    second.controller.abort();
    await Promise.allSettled([
      firstIterator.return?.(),
      secondIterator.return?.(),
    ]);
  }
});
