import { afterEach, beforeEach, expect, it } from "vitest";
import { createServer } from "node:http";
import type { Server, ServerResponse } from "node:http";
import type { FastifyInstance } from "fastify";
import { createApp } from "../src/server/app.js";
import { SecurityStore } from "../src/server/security.js";
import { createAccountRuntime } from "../src/auth/runtime.js";
import type { JsonObject } from "../src/auth/runtime.js";
import { encryption, fixture } from "./helpers.js";
import {
  agent2apiChatRequest,
  agent2apiResponsesRequest,
  contractSources,
  mediaStructuredRequest,
  nullableSchema,
  workBuddyRequest,
} from "./fixtures/client-contracts.js";

// End-to-end synthetic contracts through local downstream HTTP, the production
// runtime/DevKit and a local upstream HTTP server. No actual client/account calls.
const message = (text: string) => ({
  type: "message",
  id: "msg_synthetic",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text, annotations: [] }],
});
const completed = (output: JsonObject[]) => ({
  id: "resp_synthetic",
  object: "response",
  created_at: 1,
  status: "completed",
  model: "test-model",
  output,
  usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
});
function sendEvents(response: ServerResponse, events: JsonObject[]) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "x-request-id": "synthetic-contract-upstream",
  });
  response.end(
    events
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
  );
}
function chatFrames(text: string): JsonObject[] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)));
}
let app: FastifyInstance,
  upstream: Server,
  url: string,
  secret: string,
  cookie: string;
let cleanup: () => Promise<void>, calls: JsonObject[], runtimeEntries: number;
let handler: (body: JsonObject, response: ServerResponse) => void;
let fixtureCleanup: Promise<void> | undefined;
let upstreamFailure: { error: unknown } | undefined;
beforeEach(async () => {
  fixtureCleanup = undefined;
  upstreamFailure = undefined;
  const data = await fixture();
  cleanup = data.cleanup;
  calls = [];
  runtimeEntries = 0;
  handler = (_body, response) =>
    sendEvents(response, [
      {
        type: "response.completed",
        response: completed([message("synthetic result")]),
      },
    ]);
  upstream = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      calls.push(body);
      expect(request.url).toBe("/v1/responses");
      expect(request.headers.authorization).toBe("Bearer access_a");
      handler(body, response);
    })().catch((error: unknown) => {
      upstreamFailure ??= { error };
      response.destroy();
    });
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  const upstreamURL = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  const runtime = createAccountRuntime({
    dataDir: data.dataDir,
    encryption,
    fetch: async (input, init) => {
      const remote = new URL(String(input));
      expect(remote.origin).toBe("https://api.openai.com");
      return fetch(`${upstreamURL}${remote.pathname}`, init);
    },
  });
  const original = runtime.requestResponses.bind(runtime);
  runtime.requestResponses = async (request) => {
    runtimeEntries++;
    return original(request);
  };
  const security = new SecurityStore(data.dataDir);
  await security.setPassword("synthetic contract password");
  secret = (await security.createKey("synthetic-contract")).secret;
  app = await createApp({ runtime, dataDir: data.dataDir, port: 0 });
  await app.listen({ host: "127.0.0.1", port: 0 });
  url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const login = await fetch(`${url}/api/admin/login`, {
    method: "POST",
    headers: { origin: url, "content-type": "application/json" },
    body: JSON.stringify({ password: "synthetic contract password" }),
  });
  expect(login.status).toBe(200);
  cookie = login.headers.get("set-cookie")!.split(";")[0]!;
});
async function finishFixture() {
  fixtureCleanup ??= (async () => {
    app?.server.closeAllConnections();
    await app?.close();
    upstream?.closeAllConnections();
    await new Promise<void>((resolve) => upstream?.close(() => resolve()));
    await cleanup?.();
  })();
  await fixtureCleanup;
  if (upstreamFailure) {
    const { error } = upstreamFailure;
    upstreamFailure = undefined;
    throw error;
  }
}
afterEach(finishFixture);
async function post(body: JsonObject, route = "chat/completions") {
  return fetch(`${url}/v1/${route}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}
async function activity() {
  return (
    await (
      await fetch(`${url}/api/admin/requests`, { headers: { cookie } })
    ).json()
  ).requests as JsonObject[];
}

it("SYNTHETIC upstream handler failure reports the original error after fixture cleanup", async () => {
  const originalError = new Error(
    "synthetic upstream handler assertion failed",
  );
  const laterError = new Error("later synthetic upstream handler failure");
  let cleanupFinished = false;
  const cleanupData = cleanup;
  cleanup = async () => {
    await cleanupData();
    cleanupFinished = true;
  };
  handler = () => {
    throw calls.length === 1 ? originalError : laterError;
  };
  const response = await post(workBuddyRequest());
  expect(response.ok).toBe(false);
  expect((await post(workBuddyRequest())).ok).toBe(false);
  expect(calls).toHaveLength(2);
  await expect(finishFixture()).rejects.toBe(originalError);
  expect(cleanupFinished).toBe(true);
  expect(app.server.listening).toBe(false);
  expect(upstream.listening).toBe(false);
  // Reporting consumes the error; the registered afterEach can await cleanup again.
  await expect(finishFixture()).resolves.toBeUndefined();
});

it(`${contractSources.workBuddy.version}: filters the observed field in a SYNTHETIC request through HTTP`, async () => {
  const response = await post(workBuddyRequest());
  expect(response.status).toBe(200);
  expect((await response.json()).choices[0].message.content).toBe(
    "synthetic result",
  );
  expect(calls[0]).toMatchObject({
    stream: true,
    store: false,
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: "synthetic WorkBuddy text" }],
      },
    ],
  });
  expect(JSON.stringify(calls)).not.toContain("startsNewUserRequest");
  expect((await activity())[0]?.diagnostics).toContainEqual({
    path: "messages[0].startsNewUserRequest",
    action: "filtered",
    reason: "client_metadata",
  });
});

it(`${contractSources.agent2api.version}: SOURCE-DERIVED Chat outbound preserves second-turn body and identity`, async () => {
  const source = agent2apiChatRequest();
  expect(JSON.stringify(source)).not.toContain("_wb_");
  const response = await post(source),
    frames = chatFrames(await response.text());
  expect(
    frames
      .flatMap((frame) =>
        frame.choices.map((choice: JsonObject) => choice.delta.content ?? ""),
      )
      .join(""),
  ).toBe("synthetic result");
  expect(calls[0]).toMatchObject({
    model: "test-model",
    stream: true,
    store: false,
    reasoning: { effort: "low" },
  });
  expect(calls[0]?.input).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        role: "developer",
        content: [{ type: "input_text", text: "Synthetic system" }],
      }),
      expect.objectContaining({
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "Synthetic prior text",
            annotations: [],
          },
        ],
      }),
      expect.objectContaining({
        type: "function_call",
        call_id: "call_agent_chat",
        name: "read_alpha",
        arguments: '{"path":null}',
      }),
      expect.objectContaining({
        type: "function_call_output",
        call_id: "call_agent_chat",
        output: '{"value":null}',
      }),
    ]),
  );
});

it(`${contractSources.agent2api.version}: SOURCE-DERIVED Responses outbound preserves encrypted continuity and converted options`, async () => {
  const source = agent2apiResponsesRequest();
  const response = await post(source, "responses");
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const native = await response.text();
  expect(native).toContain('"type":"response.completed"');
  expect(native).toContain("synthetic result");
  expect(calls[0]).toMatchObject({
    model: "test-model",
    stream: true,
    store: false,
    instructions: "Synthetic system\n\nSynthetic developer",
    reasoning: { effort: "low", summary: "auto" },
    service_tier: "auto",
    parallel_tool_calls: true,
    text: {
      format: {
        type: "json_schema",
        name: "answer",
        schema: nullableSchema,
        strict: true,
      },
    },
  });
  expect(calls[0]?.input.slice(0, 3)).toEqual(source.input.slice(0, 3));
  expect(calls[0]?.input.slice(3, 6)).toEqual([
    expect.objectContaining({
      ...source.input[3],
      namespace: calls[0]?.tools[0].name,
    }),
    source.input[4],
    source.input[5],
  ]);
  expect(calls[0]?.tools[0].tools[0].parameters).toEqual(
    source.tools[0].parameters,
  );
  for (const name of [
    "temperature",
    "top_p",
    "max_output_tokens",
    "user",
    "metadata",
  ])
    expect(calls[0]).not.toHaveProperty(name);
  expect(JSON.stringify((await activity())[0]?.diagnostics)).not.toMatch(
    /synthetic-encrypted-agent|Synthetic summary/,
  );
});

it("SYNTHETIC media/structured-output HTTP contract preserves inline data, schema nulls and nonstream JSON", async () => {
  handler = (_body, response) =>
    sendEvents(response, [
      {
        type: "response.completed",
        response: completed([message('{"result":{"value":null}}')]),
      },
    ]);
  const response = await post(mediaStructuredRequest());
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(
    JSON.parse((await response.json()).choices[0].message.content),
  ).toEqual({ result: { value: null } });
  expect(calls[0]?.input[0].content).toEqual([
    { type: "input_text", text: "Synthetic media prompt" },
    {
      type: "input_image",
      image_url: "data:image/png;base64,c3ludGhldGlj",
      detail: "low",
    },
    {
      type: "input_file",
      filename: "synthetic.txt",
      file_data: "data:text/plain;base64,c3ludGhldGlj",
    },
  ]);
  expect(calls[0]?.text.format).toEqual({
    type: "json_schema",
    name: "answer",
    strict: true,
    schema: nullableSchema,
  });
  expect(calls[0]).toMatchObject({ stream: true, store: false });
});

it.each([
  {
    name: "multiple choices",
    route: "chat/completions",
    options: { n: 2 },
    param: "n",
    code: "unsupported_parameter",
  },
  {
    name: "probabilities",
    route: "chat/completions",
    options: { logprobs: true },
    param: "logprobs",
    code: "unsupported_parameter",
  },
  {
    name: "positive top probabilities",
    route: "chat/completions",
    options: { top_logprobs: 1 },
    param: "top_logprobs",
    code: "unsupported_parameter",
  },
  {
    name: "audio",
    route: "chat/completions",
    options: {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "input_audio",
              input_audio: { data: "synthetic-private", format: "wav" },
            },
          ],
        },
      ],
    },
    param: "messages[0].content[0]",
    code: "unsupported_input",
  },
  {
    name: "uploaded file reference",
    route: "responses",
    options: {
      input: [
        {
          role: "user",
          content: [{ type: "input_file", file_id: "synthetic-private" }],
        },
      ],
    },
    param: "input[0].content[0].file_id",
    code: "unsupported_parameter",
  },
  {
    name: "persistent continuation",
    route: "responses",
    options: { previous_response_id: "synthetic-private" },
    param: "previous_response_id",
    code: "unsupported_parameter",
  },
  {
    name: "server file-search tool",
    route: "responses",
    options: { tools: [{ type: "file_search" }] },
    param: "tools[0]",
    code: "unsupported_tool",
  },
])(
  "SYNTHETIC unsupported $name never enters runtime or upstream and returns identified safe 400",
  async ({ route, options, param, code }) => {
    const response = await post(
      {
        model: "test-model",
        ...(route === "responses"
          ? { input: "synthetic-private" }
          : { messages: [{ role: "user", content: "synthetic-private" }] }),
        ...options,
      },
      route,
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatchObject({
      code,
      param,
      type: "mapleproxy_error",
      local_request_id: response.headers.get("x-mapleproxy-local-request-id"),
      request_id: response.headers.get("x-request-id"),
    });
    expect(body.error.request_id).toMatch(/^[a-f0-9-]{36}$/);
    expect(response.headers.get("x-mapleproxy-upstream-request-id")).toBeNull();
    expect(JSON.stringify(body)).not.toContain("synthetic-private");
    expect(runtimeEntries).toBe(0);
    expect(calls).toHaveLength(0);
    expect((await activity())[0]).toMatchObject({
      result: "error",
      stage: "validation",
      httpStatus: 400,
      param,
      code,
      upstreamCalled: false,
    });
  },
);
