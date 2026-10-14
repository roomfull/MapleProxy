import { expect, it, vi } from "vitest";
import OpenAI from "openai";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { SecurityStore } from "../src/server/security.js";
import { createApp } from "../src/server/app.js";
import { AppError } from "../src/shared/errors.js";
import type { AccountRuntime, JsonObject } from "../src/auth/runtime.js";

async function eventually(check: () => boolean) {
  const deadline = performance.now() + 2000;
  while (!check()) {
    if (performance.now() > deadline) throw new Error("HTTP event timeout");
    await tick();
  }
}
async function fixture(
  source: (
    signal: AbortSignal,
  ) => AsyncIterable<JsonObject> | Promise<AsyncIterable<JsonObject>>,
  deadlineMs?: number,
) {
  const dir = await mkdtemp(join(tmpdir(), "maple-sse-contract-"));
  const secret = (await new SecurityStore(dir).createKey("test")).secret;
  let signal!: AbortSignal;
  const runtime = {
    requestResponses: async (request: { signal: AbortSignal }) => {
      signal = request.signal;
      return {
        profileId: "a",
        status: 200,
        headers: new Headers({ "x-request-id": "synthetic-stream-id" }),
        events: await source(signal),
        ...(deadlineMs === undefined
          ? {}
          : { deadlineAt: Date.now() + deadlineMs }),
      };
    },
  } as unknown as AccountRuntime;
  const app = await createApp({ runtime, dataDir: dir, port: 0 });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const port = (app.server.address() as { port: number }).port;
  return {
    app,
    requests: async () => {
      await new SecurityStore(dir).setPassword("synthetic-password");
      const host = `127.0.0.1:${port}`;
      const login = await app.inject({
        method: "POST",
        url: "/api/admin/login",
        headers: { host, origin: `http://${host}` },
        payload: { password: "synthetic-password" },
      });
      const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
      return (
        await app.inject({
          url: "/api/admin/requests",
          headers: { host, cookie },
        })
      ).json().requests;
    },
    signal: () => signal,
    open: (format: "responses" | "chat", stream = true) =>
      new Promise<{
        response: IncomingMessage;
        body: () => string;
        ended: () => boolean;
      }>((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port,
            path: format === "chat" ? "/v1/chat/completions" : "/v1/responses",
            method: "POST",
            headers: {
              authorization: `Bearer ${secret}`,
              "content-type": "application/json",
            },
          },
          (response) => {
            let body = "",
              ended = false;
            response.setEncoding("utf8");
            response.on("data", (data) => {
              body += data;
            });
            response.on("end", () => {
              ended = true;
            });
            resolve({ response, body: () => body, ended: () => ended });
          },
        );
        req.on("error", reject);
        req.end(
          JSON.stringify({
            model: "m",
            stream,
            ...(format === "responses"
              ? { input: "x" }
              : {
                  messages: [{ role: "user", content: "x" }],
                  stream_options: { include_usage: true },
                }),
          }),
        );
      }),
    close: async () => {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

it.each(["responses", "chat"] as const)(
  "returns real HTTP JSON before first %s output on terminal failure",
  async (format) => {
    for (const type of ["response.failed", "error", "eof", "throw"]) {
      const f = await fixture(async function* () {
        if (type === "throw")
          throw new AppError(504, "request_timeout", "timeout");
        if (type !== "eof")
          yield {
            type,
            response: {
              status: "failed",
              error: { message: "private failure" },
            },
            message: "private failure",
          };
      });
      try {
        const stream = await f.open(format);
        await eventually(stream.ended);
        expect(stream.response.statusCode).toBe(type === "throw" ? 504 : 502);
        expect(stream.response.headers["content-type"]).toContain(
          "application/json",
        );
        expect(JSON.parse(stream.body()).error.request_id).toBe(
          "synthetic-stream-id",
        );
        expect(stream.body()).not.toContain("private failure");
        expect(stream.body()).not.toContain("[DONE]");
      } finally {
        await f.close();
      }
    }
  },
);

it("bounds first-frame drain by the total deadline and classifies timeout as error", async () => {
  let closed = false,
    reads = 0;
  const f = await fixture(async function* () {
    try {
      reads++;
      yield {
        type: "response.created",
        response: { id: "r", status: "in_progress" },
      };
      reads++;
    } finally {
      closed = true;
    }
  }, 20000);
  let downstream: import("node:http").ServerResponse | undefined;
  f.app.server.on("request", (_request, response) => {
    downstream = response;
    const write = response.write.bind(response);
    vi.spyOn(response, "write").mockImplementation(
      (chunk: string | Uint8Array) => {
        write(chunk);
        return false;
      },
    );
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let connection: Awaited<ReturnType<typeof f.open>> | undefined;
  try {
    connection = await f.open("responses");
    await eventually(() => connection!.body().includes("response.created"));
    await vi.advanceTimersByTimeAsync(20000);
    await eventually(() => f.signal().aborted && closed && connection!.ended());
    expect(connection.body()).toContain('"code":"request_timeout"');
    expect(f.signal().reason).toMatchObject({
      status: 504,
      code: "request_timeout",
    });
    expect(reads).toBe(1);
    expect(downstream!.listenerCount("drain")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect((await f.requests())[0]).toMatchObject({
      result: "error",
      code: "request_timeout",
    });
  } finally {
    connection?.response.destroy();
    vi.useRealTimers();
    await f.close();
  }
});

it("keeps a terminal incomplete drain timeout as an HTTP 200 transport error", async () => {
  let closed = false;
  const f = await fixture(async function* () {
    try {
      yield {
        type: "response.incomplete",
        response: {
          id: "r",
          status: "incomplete",
          output: [],
          incomplete_details: { reason: "max_output_tokens" },
        },
      };
    } finally {
      closed = true;
    }
  }, 20000);
  f.app.server.on("request", (_request, response) => {
    const write = response.write.bind(response);
    vi.spyOn(response, "write").mockImplementation(
      (chunk: string | Uint8Array) => {
        write(chunk);
        return false;
      },
    );
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let connection: Awaited<ReturnType<typeof f.open>> | undefined;
  try {
    connection = await f.open("responses");
    await eventually(() => connection!.body().includes("response.incomplete"));
    await vi.advanceTimersByTimeAsync(20000);
    await eventually(() => f.signal().aborted && closed && connection!.ended());
    expect(connection.response.statusCode).toBe(200);
    expect((await f.requests())[0]).toMatchObject({
      result: "error",
      code: "request_timeout",
      stage: "transport",
      httpStatus: 200,
      responseStatus: "incomplete",
      incompleteReason: "max_output_tokens",
    });
  } finally {
    connection?.response.destroy();
    vi.useRealTimers();
    await f.close();
  }
});

it("closes a socket still under backpressure at deadline without waiting for an error-frame drain", async () => {
  let returned = false;
  const f = await fixture(async function* () {
    try {
      yield {
        type: "response.created",
        response: { id: "r", status: "in_progress" },
      };
    } finally {
      returned = true;
    }
  }, 20000);
  let downstream: import("node:http").ServerResponse | undefined,
    writes = 0;
  f.app.server.on("request", (_request, response) => {
    downstream = response;
    const write = response.write.bind(response);
    Object.defineProperty(response, "writableNeedDrain", {
      configurable: true,
      get: () => true,
    });
    vi.spyOn(response, "write").mockImplementation(
      (chunk: string | Uint8Array) => {
        writes++;
        write(chunk);
        return false;
      },
    );
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let connection: Awaited<ReturnType<typeof f.open>> | undefined;
  try {
    connection = await f.open("responses");
    connection.response.on("error", () => {});
    await eventually(() => connection!.body().includes("response.created"));
    await vi.advanceTimersByTimeAsync(20000);
    await eventually(() => returned && downstream!.destroyed);
    expect(writes).toBe(1);
    expect(f.signal().reason).toMatchObject({ code: "request_timeout" });
    expect(downstream!.listenerCount("drain")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    connection?.response.destroy();
    vi.useRealTimers();
    await f.close();
  }
});

it("rejects unknown Chat incomplete as first-output JSON or midstream error", async () => {
  for (const started of [false, true]) {
    const f = await fixture(async function* () {
      if (started)
        yield {
          type: "response.created",
          response: { id: "r", status: "in_progress" },
        };
      yield {
        type: "response.incomplete",
        response: {
          id: "r",
          status: "incomplete",
          incomplete_details: { reason: "private-future-reason" },
        },
      };
    });
    try {
      const stream = await f.open("chat");
      await eventually(stream.ended);
      expect(stream.response.statusCode).toBe(started ? 200 : 502);
      expect(stream.body()).toContain('"code":"response_incomplete"');
      expect(stream.body()).not.toContain("private-future-reason");
      expect(stream.body()).not.toContain("[DONE]");
      if (started) expect(stream.body()).toContain("event: error");
      else
        expect(stream.response.headers["content-type"]).toContain(
          "application/json",
        );
    } finally {
      await f.close();
    }
  }
});

it.each(["responses", "chat"] as const)(
  "accepts a first known incomplete event over %s HTTP",
  async (format) => {
    for (const reason of ["max_output_tokens", "content_filter"])
      for (const streamed of [true, false]) {
        const terminal = {
          type: "response.incomplete",
          response: {
            id: "r",
            created_at: 1,
            status: "incomplete",
            incomplete_details: { reason },
            output: [
              {
                type: "function_call",
                id: "i",
                call_id: "c",
                name: "f",
                arguments: "{}",
              },
            ],
            usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
          },
        };
        const f = await fixture(async function* () {
          yield terminal;
        });
        try {
          const stream = await f.open(format, streamed);
          await eventually(stream.ended);
          expect(stream.response.statusCode).toBe(200);
          expect(stream.body()).not.toContain("event: error");
          if (format === "responses") {
            if (streamed)
              expect(stream.body()).toBe(
                `event: response.incomplete\ndata: ${JSON.stringify(terminal)}\n\n`,
              );
            else expect(JSON.parse(stream.body())).toEqual(terminal.response);
          } else {
            const finish =
              reason === "max_output_tokens" ? "length" : "content_filter";
            if (streamed) {
              expect(stream.body()).toContain(`"finish_reason":"${finish}"`);
              expect(stream.body()).toContain("[DONE]");
            } else
              expect(JSON.parse(stream.body()).choices[0].finish_reason).toBe(
                finish,
              );
          }
        } finally {
          await f.close();
        }
      }
  },
);

it.each(["responses", "chat"] as const)(
  "keeps a midstream %s timeout an SSE error without success",
  async (format) => {
    const f = await fixture(async function* () {
      yield {
        type: "response.created",
        response: { id: "r", status: "in_progress" },
      };
      yield {
        type: "response.output_text.delta",
        item_id: "m",
        output_index: 0,
        content_index: 0,
        delta: "partial",
      };
      throw new AppError(504, "request_timeout", "timeout");
    });
    try {
      const stream = await f.open(format);
      await eventually(stream.ended);
      expect(stream.response.statusCode).toBe(200);
      expect(stream.body()).toContain("partial");
      expect(stream.body()).toContain("event: error");
      expect(stream.body()).toContain('"code":"request_timeout"');
      expect(stream.body()).not.toContain("[DONE]");
    } finally {
      await f.close();
    }
  },
);

it("writes bytewise SDK UTF8/tool/summary events and usage over real HTTP", async () => {
  const tool = {
    type: "function_call",
    id: "i",
    call_id: "c",
    name: "f",
    arguments: "",
  };
  const output = [
    {
      type: "reasoning",
      id: "reason",
      summary: [{ type: "summary_text", text: "证据🍁" }],
    },
    { ...tool, arguments: '{"城市":"上海"}' },
  ];
  const values = [
    {
      type: "response.reasoning_summary_text.delta",
      item_id: "reason",
      output_index: 0,
      summary_index: 0,
      delta: "证据",
    },
    { type: "response.output_item.added", output_index: 1, item: tool },
    {
      type: "response.function_call_arguments.delta",
      item_id: "i",
      output_index: 1,
      delta: '{"城市":',
    },
    {
      type: "response.completed",
      response: {
        id: "r",
        created_at: 1,
        status: "completed",
        output,
        usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
      },
    },
  ];
  const f = await fixture(async () => {
    const bytes = new TextEncoder().encode(
      values
        .map((v) => `event: ${v.type}\r\ndata: ${JSON.stringify(v)}\r\n\r\n`)
        .join(""),
    );
    const client = new OpenAI({
      apiKey: "synthetic",
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(c) {
              for (const byte of bytes) c.enqueue(Uint8Array.of(byte));
              c.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    });
    return client.responses.create({
      model: "m",
      input: [],
      stream: true,
      store: false,
    });
  });
  try {
    const stream = await f.open("chat");
    await eventually(stream.ended);
    const chunks = stream
      .body()
      .split("\n\n")
      .filter((v) => v.startsWith("data: ") && !v.includes("[DONE]"))
      .map((v) => JSON.parse(v.slice(6)));
    const deltas = chunks.flatMap((c) =>
      c.choices.map((choice: JsonObject) => choice.delta),
    );
    expect(deltas.map((d) => d.reasoning_content ?? "").join("")).toBe(
      "证据🍁",
    );
    const calls = deltas.flatMap((d) => d.tool_calls ?? []);
    expect(
      calls.filter((c) => c.id).map((c) => [c.index, c.id, c.function.name]),
    ).toEqual([[0, "c", "f"]]);
    expect(calls.map((c) => c.function?.arguments ?? "").join("")).toBe(
      '{"城市":"上海"}',
    );
    expect(chunks.at(-1).usage.total_tokens).toBe(6);
    expect(stream.body()).toContain("[DONE]");
  } finally {
    await f.close();
  }
});

it.each(["responses", "chat"] as const)(
  "heartbeats after precisely 15 idle seconds on started %s SSE and cancels pending reads",
  async (format) => {
    let release!: () => void,
      reads = 0,
      active = 0,
      maximum = 0,
      closed = false;
    const f = await fixture((signal) =>
      (async function* () {
        try {
          active++;
          maximum = Math.max(maximum, active);
          reads++;
          await new Promise<void>((resolve) => {
            release = resolve;
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
          active--;
          yield {
            type: "response.created",
            response: { id: "r", status: "in_progress" },
          };
          active++;
          maximum = Math.max(maximum, active);
          reads++;
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
          active--;
        } finally {
          closed = true;
        }
      })(),
    );
    // Idle deadlines and timers must use the same clock; HTTP polling stays real.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let connection: Awaited<ReturnType<typeof f.open>> | undefined;
    try {
      let headers = false;
      const opening = f.open(format).then((value) => {
        connection = value;
        headers = true;
        return value;
      });
      await eventually(() => reads === 1);
      await vi.advanceTimersByTimeAsync(15000);
      expect(headers).toBe(false);
      release();
      const stream = await opening;
      await eventually(() =>
        stream
          .body()
          .includes(format === "responses" ? "response.created" : "assistant"),
      );
      await vi.advanceTimersByTimeAsync(14999);
      await tick();
      expect(stream.body()).not.toContain(": heartbeat");
      await vi.advanceTimersByTimeAsync(1);
      await eventually(() => stream.body().includes(": heartbeat\n\n"));
      expect(reads).toBe(2);
      expect(maximum).toBe(1);
      await vi.advanceTimersByTimeAsync(15000);
      await eventually(
        () => stream.body().split(": heartbeat\n\n").length === 3,
      );
      expect(reads).toBe(2);
      stream.response.destroy();
      await eventually(() => f.signal().aborted && closed);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      connection?.response.destroy();
      vi.useRealTimers();
      await f.close();
    }
  },
);

it("returns the renderer when a client cancels during first-frame drain", async () => {
  let closed = false,
    reads = 0;
  const f = await fixture(async function* () {
    try {
      reads++;
      yield {
        type: "response.created",
        response: { id: "r", status: "in_progress" },
      };
      reads++;
      throw new Error("must not read through backpressure");
    } finally {
      closed = true;
    }
  });
  let downstream: import("node:http").ServerResponse | undefined;
  f.app.server.on("request", (_request, response) => {
    downstream = response;
    const write = response.write.bind(response);
    // Keep a real TCP write, but hold the drain boundary deterministically.
    vi.spyOn(response, "write").mockImplementation(
      (chunk: string | Uint8Array) => {
        write(chunk);
        return false;
      },
    );
  });
  try {
    const stream = await f.open("responses");
    await eventually(() => stream.body().includes("response.created"));
    expect(reads).toBe(1);
    expect(downstream!.listenerCount("drain")).toBe(1);
    stream.response.destroy();
    await eventually(() => f.signal().aborted && closed);
    expect(downstream!.listenerCount("drain")).toBe(0);
    expect(reads).toBe(1);
  } finally {
    await f.close();
  }
});
