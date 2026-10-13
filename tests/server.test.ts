import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { AccountRuntime, JsonObject } from "../src/auth/runtime.js";
import { AppError } from "../src/shared/errors.js";
import { SecurityStore } from "../src/server/security.js";
import { createApp } from "../src/server/app.js";
import { ApiClient } from "../web/src/api.js";

const host = "localhost:8317",
  origin = "http://localhost:8317";
let app: FastifyInstance, dir: string, security: SecurityStore;
let selected = "a",
  calls: JsonObject[],
  cookie: string,
  csrf: string,
  secret: string;
let failure: Error | undefined;
let signInResolve: (() => void) | undefined;
const runtime: AccountRuntime = {
  listAccounts: async () => [
    {
      id: selected,
      label: "Local",
      status: "connected",
      sharing: true,
      enabled: true,
      isDefault: true,
    },
  ],
  signIn: async () =>
    new Promise<void>((resolve) => {
      signInResolve = resolve;
    }),
  cancelSignIn: () => {
    signInResolve?.();
  },
  selectAccount: async (id) => {
    selected = id;
  },
  setEnabled: async () => {},
  disconnect: async () => {},
  listModels: async () => [{ id: "test-model", displayName: "Test model" }],
  requestResponses: async ({ body }) => {
    calls.push(body);
    if (failure) throw failure;
    return {
      profileId: selected,
      status: 200,
      headers: new Headers({ "x-request-id": "upstream-safe" }),
      events: (async function* () {
        yield {
          type: "response.completed",
          response: {
            id: "resp_test",
            status: "completed",
            model: "test-model",
            output: [
              {
                type: "message",
                id: "msg",
                role: "assistant",
                content: [{ type: "output_text", text: "private reply" }],
              },
            ],
            usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
          },
        };
      })(),
    };
  },
};
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "maple-http-"));
  security = new SecurityStore(dir);
  selected = "a";
  calls = [];
  failure = undefined;
  await security.setPassword("a strong local password");
  app = await createApp({ runtime, dataDir: dir });
  const login = await app.inject({
    method: "POST",
    url: "/api/admin/login",
    headers: { host, origin },
    payload: { password: "a strong local password" },
  });
  expect(login.statusCode).toBe(200);
  cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  csrf = login.json().csrfToken;
  secret = (await security.createKey("test")).secret;
});
afterEach(async () => {
  await app?.close();
  await rm(dir, { recursive: true, force: true });
});
const admin = () => ({ host, origin, cookie, "x-csrf-token": csrf });
const inference = () => ({ host, authorization: `Bearer ${secret}` });
describe("HTTP isolation and local origin protections", () => {
  it("identifies local requests even when the Host guard rejects before normal headers", async () => {
    const response = await app.inject({
      url: "/v1/models",
      headers: { host: "evil.invalid:8317" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.headers["x-mapleproxy-local-request-id"]).toBe(
      response.json().error.local_request_id,
    );
    expect(response.headers["x-mapleproxy-local-request-id"]).toMatch(
      /^[a-f0-9-]{36}$/,
    );
    expect(
      response.headers["x-mapleproxy-upstream-request-id"],
    ).toBeUndefined();
  });
  it("distinguishes upstream catalog 401 from real management expiry through HTTP and ApiClient", async () => {
    const requests: RequestInit[] = [];
    const client = new ApiClient(async (url, init) => {
      requests.push(init);
      const headers = Object.fromEntries(new Headers(init.headers));
      const response = await app.inject({
        method: init.method as "GET" | "POST",
        url,
        headers: {
          ...admin(),
          ...headers,
          "x-csrf-token": headers["x-csrf-token"] ?? "",
        },
        ...(init.body ? { payload: String(init.body) } : {}),
      });
      return new Response(response.body, { status: response.statusCode });
    });
    client.onExpired = vi.fn();
    await client.session();
    const upstream = vi
      .spyOn(runtime, "listModels")
      .mockRejectedValue(
        new AppError(
          401,
          "invalid_token",
          "Upstream rejected the selected connection.",
        ),
      );
    try {
      await expect(client.request("/models")).rejects.toThrow(
        "Upstream rejected",
      );
      expect(client.onExpired).not.toHaveBeenCalled();
      await expect(
        client.request("/accounts/a/disconnect", "POST"),
      ).resolves.toEqual({ ok: true });
      expect(new Headers(requests.at(-1)!.headers).get("x-csrf-token")).toBe(
        csrf,
      );
      await client.logout();
      await expect(client.request("/models")).rejects.toThrow("请先登录");
      expect(client.onExpired).toHaveBeenCalledOnce();
      await expect(
        client.request("/accounts/a/default", "POST"),
      ).rejects.toThrow();
      expect(new Headers(requests.at(-1)!.headers).has("x-csrf-token")).toBe(
        false,
      );
    } finally {
      upstream.mockRestore();
    }
  });
  it("keeps a timed-out sign-in reserved until asynchronous cancellation settles", async () => {
    let timeout!: () => void;
    const realSetTimeout = globalThis.setTimeout;
    const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: () => void,
      delay: number,
      ...args: any[]
    ) => {
      if (delay === 5 * 60_000) timeout = callback;
      return realSetTimeout(callback, delay, ...args);
    }) as typeof setTimeout);
    const cancel = vi
      .spyOn(runtime, "cancelSignIn")
      .mockImplementation(() => {});
    try {
      const start = () =>
        app.inject({
          method: "POST",
          url: "/api/admin/sign-in",
          headers: admin(),
          payload: {},
        });
      const first = await start();
      timeout();
      const status = await app.inject({
        url: `/api/admin/sign-in/${first.json().id}`,
        headers: admin(),
      });
      expect(status.json()).toMatchObject({
        status: "failed",
        code: "sign_in_timeout",
      });
      expect(cancel).toHaveBeenCalledOnce();
      expect((await start()).statusCode).toBe(409);
      signInResolve!();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect((await start()).statusCode).toBe(202);
      signInResolve!();
    } finally {
      timer.mockRestore();
      cancel.mockRestore();
    }
  });
  it("requires API keys independently of management sessions", async () => {
    expect(
      (await app.inject({ url: "/v1/models", headers: { host } })).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ url: "/v1/models", headers: { host, cookie } }))
        .statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ url: "/api/admin/accounts", headers: inference() }))
        .statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ url: "/v1/models", headers: inference() })).json()
        .data[0].id,
    ).toBe("test-model");
  });
  it("enforces exact Host, Origin and CSRF on mutations including login", async () => {
    for (const badHost of [
      "evil.invalid:8317",
      "localhost:9999",
      "localhost",
      "localhost:8317.evil.invalid",
    ]) {
      expect(
        (
          await app.inject({
            url: "/api/admin/session",
            headers: { host: badHost },
          })
        ).statusCode,
      ).toBe(403);
    }
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/admin/keys",
          headers: { host, cookie },
          payload: { name: "bad" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/admin/keys",
          headers: { ...admin(), origin: "http://127.0.0.1:8317" },
          payload: { name: "bad" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/admin/login",
          headers: { host, origin: "https://evil.invalid" },
          payload: { password: "a strong local password" },
        })
      ).statusCode,
    ).toBe(403);
    const key = await app.inject({
      method: "POST",
      url: "/api/admin/keys",
      headers: admin(),
      payload: { name: "new" },
    });
    expect(key.statusCode).toBe(201);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/admin/keys/${key.json().key.id}`,
          headers: admin(),
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await app.inject({
          url: "/v1/models",
          headers: { host, authorization: `Bearer ${key.json().secret}` },
        })
      ).statusCode,
    ).toBe(401);
  });
  it("sets secure cookie attributes and logout invalidates session", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/admin/login",
      headers: { host, origin },
      payload: { password: "a strong local password" },
    });
    expect(login.headers["set-cookie"]).toMatch(/HttpOnly/);
    expect(login.headers["set-cookie"]).toMatch(/SameSite=Strict/);
    expect(login.headers["set-cookie"]).toMatch(/Path=\//);
    expect(login.headers["set-cookie"]).toMatch(/Max-Age=43200/);
    await app.inject({
      method: "POST",
      url: "/api/admin/logout",
      headers: admin(),
    });
    expect(
      (
        await app.inject({
          url: "/api/admin/session",
          headers: { host, cookie },
        })
      ).json().authenticated,
    ).toBe(false);
  });
  it("rate limits unsuccessful local logins with bounded attempts", async () => {
    let code = 0;
    for (let i = 0; i < 11; i++)
      code = (
        await app.inject({
          method: "POST",
          url: "/api/admin/login",
          headers: { host, origin },
          payload: { password: "wrong" },
        })
      ).statusCode;
    expect(code).toBe(429);
  });
  it("offers no HTTP initial setup and rejects credential injection or malformed mutations", async () => {
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/admin/setup",
          headers: admin(),
          payload: { password: "new" },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/admin/sign-in",
          headers: admin(),
          payload: { accessToken: "secret" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: "/api/admin/accounts/a",
          headers: admin(),
          payload: { enabled: "false" },
        })
      ).statusCode,
    ).toBe(400);
  });
  it("bounds sign-in jobs and returns only safe status", async () => {
    const job = await app.inject({
      method: "POST",
      url: "/api/admin/sign-in",
      headers: admin(),
      payload: { newProfile: true },
    });
    expect(job.statusCode).toBe(202);
    expect(job.json().status).toBe("pending");
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/admin/sign-in",
          headers: admin(),
          payload: {},
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/admin/sign-in/${job.json().id}`,
          headers: admin(),
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          url: `/api/admin/sign-in/${job.json().id}`,
          headers: { host, cookie },
        })
      ).json().status,
    ).toBe("cancelled");
  });
});
describe("inference rendering and privacy", () => {
  it("records safe model, validation phase and prior cleanup when rejecting before runtime", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: inference(),
      payload: {
        model: "synthetic",
        temperature: 0.5,
        messages: [
          { role: "user", content: "private prompt" },
          { role: "assistant", content: "private reply" },
          {
            role: "user",
            content: "private prompt",
            reasoning_content: "private reasoning",
            audio: "private audio",
          },
        ],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.param).toBe("messages[2].audio");
    expect(calls).toHaveLength(0);
    const log = await app.inject({
      url: "/api/admin/requests",
      headers: admin(),
    });
    expect(log.json().requests[0]).toMatchObject({
      model: "synthetic",
      result: "error",
      stage: "validation",
      httpStatus: 400,
      param: "messages[2].audio",
      upstreamCalled: false,
      localRequestId: response.headers["x-mapleproxy-local-request-id"],
      requestId: response.headers["x-request-id"],
      diagnostics: expect.arrayContaining([
        {
          path: "messages[2].reasoning_content",
          action: "filtered",
          reason: "client_metadata",
        },
      ]),
      ignored: ["temperature"],
    });
    expect(log.body).not.toContain("private");
    expect(log.body).not.toContain(secret);
    expect(response.json().error.local_request_id).toBe(
      response.headers["x-mapleproxy-local-request-id"],
    );
    expect(
      response.headers["x-mapleproxy-upstream-request-id"],
    ).toBeUndefined();
  });
  it("drops unsafe pre-validation model values", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: inference(),
      payload: {
        model: "private unsafe model",
        store: true,
        input: "private prompt",
      },
    });
    const log = await app.inject({
      url: "/api/admin/requests",
      headers: admin(),
    });
    expect(log.json().requests[0].model).toBeUndefined();
    expect(log.body).not.toContain("private");
    expect(calls).toHaveLength(0);
  });
  it("keeps separate local and upstream IDs and cleanup on runtime errors", async () => {
    failure = new AppError(
      429,
      "rate_limit_exceeded",
      "private credentials",
      "tools[1].name",
      "synthetic-429",
    );
    (failure as AppError).diagnostics = [];
    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: inference(),
      payload: {
        model: "synthetic",
        input: "private prompt",
        temperature: 0.5,
      },
    });
    const local = response.headers["x-mapleproxy-local-request-id"];
    expect(local).toMatch(/^[a-f0-9-]{36}$/);
    expect(response.headers["x-mapleproxy-upstream-request-id"]).toBe(
      "synthetic-429",
    );
    expect(response.headers["x-request-id"]).toBe("synthetic-429");
    expect(response.json().error).toMatchObject({
      local_request_id: local,
      upstream_request_id: "synthetic-429",
      param: "tools[1].name",
    });
    const log = await app.inject({
      url: "/api/admin/requests",
      headers: admin(),
    });
    expect(log.json().requests[0]).toMatchObject({
      localRequestId: local,
      upstreamRequestId: "synthetic-429",
      upstreamCalled: true,
      stage: "upstream",
      httpStatus: 429,
      diagnostics: [
        {
          path: "temperature",
          action: "filtered",
          reason: "siwc_ignored_parameter",
        },
      ],
    });
    expect(log.body).not.toContain("private");
  });
  it("keeps an expired nonstream deadline an error even if a terminal fixture resolves", async () => {
    const mock = vi.spyOn(runtime, "requestResponses").mockResolvedValue({
      profileId: "a",
      status: 200,
      deadlineAt: Date.now() - 1,
      headers: new Headers({ "x-request-id": "synthetic-expired" }),
      events: (async function* () {
        yield {
          type: "response.incomplete",
          response: {
            id: "r",
            status: "incomplete",
            output: [],
            incomplete_details: { reason: "max_output_tokens" },
          },
        };
      })(),
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/responses",
        headers: inference(),
        payload: { model: "synthetic", input: "x", stream: false },
      });
      expect(response.statusCode).toBe(504);
      const log = await app.inject({
        url: "/api/admin/requests",
        headers: admin(),
      });
      expect(log.json().requests[0]).toMatchObject({
        result: "error",
        code: "request_timeout",
        httpStatus: 504,
        stage: "response",
      });
    } finally {
      mock.mockRestore();
    }
  });
  it.each(["responses", "chat"] as const)(
    "records incomplete %s for streaming and collected outputs while errors dominate",
    async (format) => {
      for (const stream of [false, true])
        for (const reason of [
          "max_output_tokens",
          "content_filter",
          "private unknown reason",
        ]) {
          const mock = vi.spyOn(runtime, "requestResponses").mockResolvedValue({
            profileId: "a",
            status: 200,
            headers: new Headers({ "x-request-id": "synthetic-incomplete" }),
            events: (async function* () {
              yield {
                type: "response.incomplete",
                response: {
                  id: "r",
                  status: "incomplete",
                  output: [],
                  incomplete_details: { reason },
                },
              };
            })(),
          });
          try {
            const response = await app.inject({
              method: "POST",
              url: format === "chat" ? "/v1/chat/completions" : "/v1/responses",
              headers: inference(),
              payload: {
                model: "synthetic",
                stream,
                ...(format === "chat"
                  ? { messages: [{ role: "user", content: "private prompt" }] }
                  : { input: "private prompt" }),
              },
            });
            const isError =
              format === "chat" && reason === "private unknown reason";
            expect(response.statusCode).toBe(isError ? 502 : 200);
            const log = await app.inject({
              url: "/api/admin/requests",
              headers: admin(),
            });
            expect(log.json().requests[0]).toMatchObject({
              result: isError ? "error" : "incomplete",
              responseStatus: "incomplete",
              incompleteReason: reason.startsWith("private")
                ? "unknown"
                : reason,
              stage: "response",
              httpStatus: isError ? 502 : 200,
              upstreamCalled: true,
              upstreamRequestId: "synthetic-incomplete",
            });
            if (isError)
              expect(log.json().requests[0].code).toBe("response_incomplete");
            expect(log.body).not.toContain("private");
          } finally {
            mock.mockRestore();
          }
        }
    },
  );
  it.each(["responses", "chat"] as const)(
    "passes future model options to captured %s upstream body",
    async (format) => {
      const response = await app.inject({
        method: "POST",
        url: format === "responses" ? "/v1/responses" : "/v1/chat/completions",
        headers: inference(),
        payload: {
          model: "synthetic",
          future_model_option: { level: 2 },
          future_scalar: "future",
          temperature: 0.5,
          stream: false,
          ...(format === "responses"
            ? { input: "x", reasoning: { effort: "future" } }
            : {
                messages: [{ role: "user", content: "x" }],
                reasoning_effort: "future",
              }),
        },
      });
      expect(response.statusCode).toBe(200);
      expect(calls.at(-1)).toMatchObject({
        future_model_option: { level: 2 },
        future_scalar: "future",
        reasoning: { effort: "future" },
        store: false,
        stream: true,
      });
      expect(calls.at(-1)).not.toHaveProperty("temperature");
      expect(response.headers["x-mapleproxy-ignored-params"]).toBe(
        "temperature",
      );
    },
  );
  it.each(["responses", "chat"] as const)(
    "keeps effective request IDs for nonstream %s terminal failures",
    async (format) => {
      const route =
        format === "chat" ? "/v1/chat/completions" : "/v1/responses";
      const input =
        format === "chat"
          ? { messages: [{ role: "user", content: "x" }] }
          : { input: "x" };
      for (const id of ["upstream-synthetic-id", "unsafe id", undefined]) {
        for (const terminal of [
          "response.failed",
          "invalid_completed",
          "eof",
        ]) {
          const mock = vi.spyOn(runtime, "requestResponses").mockResolvedValue({
            profileId: "a",
            status: 200,
            headers: new Headers(id ? { "x-request-id": id } : {}),
            events: (async function* () {
              if (terminal !== "eof")
                yield {
                  type:
                    terminal === "invalid_completed"
                      ? "response.completed"
                      : terminal,
                  response: {
                    status:
                      terminal === "invalid_completed"
                        ? "in_progress"
                        : terminal.slice(9),
                    error: { code: "synthetic_failure" },
                  },
                };
            })(),
          });
          try {
            const response = await app.inject({
              method: "POST",
              url: route,
              headers: inference(),
              payload: { model: "synthetic", ...input },
            });
            expect(response.statusCode).toBe(502);
            const effective = response.headers["x-request-id"];
            expect(response.json().error.request_id).toBe(effective);
            if (id === "upstream-synthetic-id") expect(effective).toBe(id);
            else expect(effective).toMatch(/^[a-f0-9-]{36}$/);
            const log = await app.inject({
              url: "/api/admin/requests",
              headers: admin(),
            });
            expect(log.json().requests[0].requestId).toBe(effective);
          } finally {
            mock.mockRestore();
          }
        }
      }
    },
  );
  it("passes usage rendering options without forwarding metadata upstream", async () => {
    for (const includeUsage of [false, true]) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: inference(),
        payload: {
          model: "test-model",
          messages: [{ role: "user", content: "private prompt" }],
          stream: true,
          stream_options: { include_usage: includeUsage },
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["x-request-id"]).toBe("upstream-safe");
      expect(response.body.includes('"total_tokens":5')).toBe(includeUsage);
      expect(response.body).toContain("data: [DONE]");
      expect(calls.at(-1)).not.toHaveProperty("renderOptions");
      expect(calls.at(-1)?.stream_options).not.toHaveProperty("include_usage");
    }
  });
  it("renders request-local tool identities and legacy functions through HTTP", async () => {
    const encoded =
      "_mpn_" +
      Buffer.from(JSON.stringify(["workspace", "read"])).toString("base64url");
    const mock = vi
      .spyOn(runtime, "requestResponses")
      .mockImplementation(async ({ body }) => {
        calls.push(body);
        return {
          profileId: "a",
          status: 200,
          headers: new Headers(),
          events: (async function* () {
            yield {
              type: "response.completed",
              response: {
                id: "r",
                status: "completed",
                output: [
                  {
                    type: "function_call",
                    id: "i",
                    call_id: "c",
                    name: "read",
                    arguments: "{}",
                  },
                ],
              },
            };
          })(),
        };
      });
    try {
      for (const stream of [false, true])
        for (const legacy of [false, true]) {
          const response = await app.inject({
            method: "POST",
            url: "/v1/chat/completions",
            headers: inference(),
            payload: {
              model: "synthetic",
              messages: [{ role: "user", content: "go" }],
              stream,
              ...(legacy
                ? { functions: [{ name: encoded }] }
                : {
                    tools: [{ type: "function", function: { name: encoded } }],
                  }),
            },
          });
          expect(response.statusCode).toBe(200);
          if (stream) {
            expect(response.body).toContain(encoded);
            expect(response.body).toContain(
              `"finish_reason":"${legacy ? "function_call" : "tool_calls"}"`,
            );
            expect(response.body).toContain("[DONE]");
          } else {
            const choice = response.json().choices[0];
            expect(
              legacy
                ? choice.message.function_call.name
                : choice.message.tool_calls[0].function.name,
            ).toBe(encoded);
            expect(choice.finish_reason).toBe(
              legacy ? "function_call" : "tool_calls",
            );
          }
          expect(calls.at(-1)).not.toHaveProperty("responseContext");
          expect(calls.at(-1)).not.toHaveProperty("renderOptions");
          expect(calls.at(-1)).toMatchObject({ stream: true, store: false });
        }
    } finally {
      mock.mockRestore();
    }
  });
  it("uses next-request default and records metadata without content", async () => {
    await app.inject({
      method: "POST",
      url: "/api/admin/accounts/b/default",
      headers: admin(),
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: inference(),
      payload: {
        model: "test-model",
        input: "private prompt",
        temperature: 0.5,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["x-mapleproxy-ignored-params"]).toBe("temperature");
    const log = await app.inject({
      url: "/api/admin/requests",
      headers: { host, cookie },
    });
    expect(log.json().requests[0]).toMatchObject({
      profileId: "b",
      model: "test-model",
      format: "responses",
      result: "success",
      ignored: ["temperature"],
    });
    expect(log.body).not.toContain("private");
    expect(log.body).not.toContain(secret);
  });
  it("keeps unexpected errors generic and structured app errors identified", async () => {
    failure = new Error("private credentials");
    let response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: inference(),
      payload: { model: "test-model", input: "x" },
    });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("private credentials");
    expect(response.json().error.request_id).toBeTruthy();
    failure = new AppError(
      429,
      "rate_limit_exceeded",
      "limit",
      undefined,
      "upstream-429",
    );
    response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: inference(),
      payload: { model: "test-model", input: "x" },
    });
    expect(response.statusCode).toBe(429);
    expect(response.json().error.code).toBe("rate_limit_exceeded");
    expect(response.headers["x-request-id"]).toBe("upstream-429");
    expect(calls).toHaveLength(2);
  });
  it("returns JSON 404 for unknown API routes", async () => {
    for (const url of ["/api/unknown", "/v1/unknown"])
      expect(
        (await app.inject({ url, headers: { host } })).json().error.code,
      ).toBe("not_found");
  });
});
