import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { AccountRuntime, JsonObject } from "../src/auth/runtime.js";
import { AppError } from "../src/shared/errors.js";
import { SecurityStore } from "../src/server/security.js";
import { createApp } from "../src/server/app.js";

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
