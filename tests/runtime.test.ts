import { afterEach, expect, test, vi } from "vitest";
import { renderStream } from "../src/protocol/events.js";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createAccountRuntime } from "../src/auth/runtime.js";
import { encryption, fixture, streamResponse } from "./helpers.js";
test("the production SSE parser stages initial native errors before HTTP commitment", async () => {
  const event = {
    type: "error",
    code: "invalid_token",
    message: "private synthetic provider message 中文 🦊",
    param: "model",
    sequence_number: 7,
  };
  const logs = ["debug", "log", "info", "warn", "error"].map((method) =>
    vi.spyOn(console, method as "log").mockImplementation(() => {}),
  );
  try {
    const { runtime } = await setup(async () => {
      const bytes = new TextEncoder().encode(
        `event: error\r\ndata: ${JSON.stringify(event)}\r\n\r\ndata: [DONE]\r\n\r\n`,
      );
      return new Response(
        new ReadableStream({
          start(controller) {
            for (let i = 0; i < bytes.length; i += 3)
              controller.enqueue(bytes.slice(i, i + 3));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const upstream = await runtime.requestResponses({
      body: { model: "m", input: "x" },
    });
    const frames: string[] = [];
    await expect(
      (async () => {
        for await (const frame of renderStream(
          upstream.events,
          "responses",
          "m",
        ))
          frames.push(frame);
      })(),
    ).rejects.toMatchObject({ code: "upstream_stream_error" });
    expect(frames).toHaveLength(0);
    expect(frames.join("")).not.toContain("[DONE]");
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  } finally {
    for (const log of logs) log.mockRestore();
  }
});
test("logout during locked refresh prevents inference and revokes the persisted successor", async () => {
  let received!: () => void;
  const started = new Promise<void>((r) => (received = r));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let inferenceCalls = 0;
  let persisted = false;
  let revoked: string | null = null;
  const { runtime, store } = await setup(
    async (url, init) => {
      if (String(url).includes("openid-configuration"))
        return Response.json({
          issuer: "https://auth.openai.com",
          authorization_endpoint: "https://auth.openai.com/authorize",
          token_endpoint: "https://auth.openai.com/token",
          jwks_uri: "https://auth.openai.com/jwks",
          revocation_endpoint: "https://auth.openai.com/revoke",
        });
      if (String(url).endsWith("/token")) {
        received();
        await gate;
        return Response.json({
          access_token: "successor-access",
          refresh_token: "successor-refresh",
          token_type: "Bearer",
          expires_in: 3600,
        });
      }
      if (String(url).endsWith("/revoke")) {
        revoked = (init!.body as URLSearchParams).get("token");
        return new Response("", { status: 200 });
      }
      inferenceCalls++;
      return streamResponse();
    },
    undefined,
    Date.now() - 100,
  );
  // Observe the actual encrypted-write boundary used by every store instance.
  const { ConnectionStore } = await import("../vendor/siwc/src/storage.js");
  const write = ConnectionStore.prototype.write;
  ConnectionStore.prototype.write = async function (saved) {
    if (
      saved.profiles.find((p) => p.id === "a")?.credentials?.refreshToken ===
      "successor-refresh"
    )
      persisted = true;
    return write.call(this, saved);
  };
  const pending = runtime
    .requestResponses({ body: { model: "m", input: "x" } })
    .then(
      async (response) => {
        await response.events[Symbol.asyncIterator]().return?.();
        return { ok: true };
      },
      (error) => ({ ok: false, error }),
    );
  await started;
  const logout = runtime.disconnect("a");
  const following = runtime
    .requestResponses({ body: { model: "m", input: "following" } })
    .then(
      async (response) => {
        await response.events[Symbol.asyncIterator]().return?.();
        return { ok: true };
      },
      (error) => ({ ok: false, error }),
    );
  await new Promise((resolve) => setTimeout(resolve, 30));
  release();
  try {
    await logout;
    expect(await pending).toMatchObject({
      ok: false,
      error: { code: "cancelled" },
    });
    expect(await following).toMatchObject({ ok: false });
    expect(inferenceCalls).toBe(0);
    expect(persisted).toBe(true);
    expect(revoked).toBe("successor-refresh");
    const saved = await store.withLock(() => store.read());
    expect(saved!.profiles.find((p) => p.id === "a")).toMatchObject({
      status: "disconnected",
    });
    expect(
      saved!.profiles.find((p) => p.id === "a")!.credentials,
    ).toBeUndefined();
  } finally {
    ConnectionStore.prototype.write = write;
    release();
    await Promise.allSettled([logout, pending, following]);
  }
});
test("return promptly aborts transport while next awaits a stalled SSE body", async () => {
  const caller = new AbortController();
  let transport: AbortSignal | undefined;
  let reading!: () => void;
  const started = new Promise<void>((resolve) => (reading = resolve));
  const { runtime } = await setup(async (_url, init) => {
    transport = init!.signal!;
    return new Response(
      new ReadableStream(
        {
          start(controller) {
            transport!.addEventListener(
              "abort",
              () => controller.error(transport!.reason),
              { once: true },
            );
          },
          pull() {
            reading();
          },
        },
        { highWaterMark: 0 },
      ),
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  const iterator = (
    await runtime.requestResponses({
      body: { model: "m", input: "x" },
      signal: caller.signal,
    })
  ).events[Symbol.asyncIterator]();
  const next = iterator.next().then(
    () => undefined,
    () => undefined,
  );
  await started;
  const returned = iterator.return!();
  try {
    const prompt = await Promise.race([
      returned.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250)),
    ]);
    expect(prompt).toBe(true);
    expect(transport!.aborted).toBe(true);
  } finally {
    caller.abort();
    await Promise.allSettled([next, returned]);
  }
});
test("cleanup of an older canceled generator preserves cancellation of its successor", async () => {
  const signals: AbortSignal[] = [];
  const { runtime } = await setup(async (_url, init) => {
    signals.push(init!.signal!);
    return streamResponse();
  });
  const old = await runtime.requestResponses({
    body: { model: "m", input: "old" },
  });
  await runtime.setEnabled("a", false);
  await runtime.setEnabled("a", true);
  const current = await runtime.requestResponses({
    body: { model: "m", input: "new" },
  });
  await old.events[Symbol.asyncIterator]().return?.();
  await runtime.setEnabled("a", false);
  expect(signals[1]!.aborted).toBe(true);
  await current.events[Symbol.asyncIterator]().return?.();
});
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()));
});
async function setup(
  fetch: typeof globalThis.fetch,
  timeoutMs?: number,
  expiresAt?: number,
) {
  const f = await fixture(expiresAt);
  cleanup.push(f.cleanup);
  return {
    ...f,
    runtime: createAccountRuntime({
      dataDir: f.dataDir,
      encryption,
      fetch,
      timeoutMs,
    }),
  };
}
test("explicit disconnect rejects unknown profile IDs", async () => {
  const { runtime } = await setup(async () => streamResponse());
  await expect(runtime.disconnect("unknown")).rejects.toMatchObject({
    code: "profile_not_found",
  });
});
test("selection snapshots account and disabling only aborts its live generator", async () => {
  const signals: AbortSignal[] = [];
  const { runtime } = await setup(async (_url, init) => {
    signals.push(init!.signal!);
    return streamResponse();
  });
  const a = await runtime.requestResponses({
    body: { model: "m", input: "a" },
  });
  await runtime.selectAccount("b");
  const b = await runtime.requestResponses({
    body: { model: "m", input: "b" },
  });
  expect(a.profileId).toBe("a");
  expect(b.profileId).toBe("b");
  expect(signals[0]!.aborted).toBe(false);
  await runtime.setEnabled("a", false);
  expect(signals[0]!.aborted).toBe(true);
  expect(signals[1]!.aborted).toBe(false);
  await b.events[Symbol.asyncIterator]().return?.();
});
test("disabled default cannot start inference and enabled preference persists", async () => {
  const { runtime, dataDir } = await setup(async () => {
    throw new Error("must not send");
  });
  await runtime.setEnabled("a", false);
  await expect(
    runtime.requestResponses({ body: { model: "m", input: "x" } }),
  ).rejects.toMatchObject({ code: "account_disabled" });
  expect(
    (await createAccountRuntime({ dataDir, encryption }).listAccounts()).find(
      (a) => a.id === "a",
    ),
  ).toMatchObject({ enabled: false, isDefault: true });
});
test("full body and typed event variants pass through with secure transport settings", async () => {
  process.env.OPENAI_ORG_ID = "bad";
  process.env.OPENAI_PROJECT_ID = "bad";
  process.env.OPENAI_CUSTOM_HEADERS = "Authorization: bad";
  process.env.OPENAI_LOG = "debug";
  const body = {
    model: "m",
    input: [
      {
        role: "user",
        content: [
          { type: "input_image", image_url: "https://example.invalid/image" },
        ],
      },
    ],
    tools: [{ type: "function", name: "f", parameters: { type: "object" } }],
    reasoning: { effort: "high" },
    text: { format: { type: "json_object" } },
  };
  const event = {
    type: "response.output_item.added",
    item: { type: "function_call", name: "f", arguments: "{}" },
  };
  const { runtime } = await setup(async (url, init) => {
    expect(String(url)).toBe("https://api.openai.com/v1/responses");
    expect(init!.redirect).toBe("error");
    const h = new Headers(init!.headers);
    expect(h.get("authorization")).toBe("Bearer access_a");
    expect(h.has("openai-organization")).toBe(false);
    expect(h.has("openai-project")).toBe(false);
    expect(JSON.parse(String(init!.body))).toMatchObject({
      ...body,
      store: false,
      stream: true,
    });
    return streamResponse([
      event,
      { type: "response.completed", response: { id: "r" } },
    ]);
  });
  const result = await runtime.requestResponses({ body });
  const events = [];
  for await (const e of result.events) events.push(e);
  expect(events[0]).toEqual(event);
  delete process.env.OPENAI_ORG_ID;
  delete process.env.OPENAI_PROJECT_ID;
  delete process.env.OPENAI_CUSTOM_HEADERS;
  delete process.env.OPENAI_LOG;
});
test("completed generators release cancellation controllers", async () => {
  let signal: AbortSignal | undefined;
  const { runtime } = await setup(async (_url, init) => {
    signal = init!.signal!;
    return streamResponse();
  });
  for await (const _ of (
    await runtime.requestResponses({ body: { model: "m", input: "x" } })
  ).events) {
  }
  await runtime.setEnabled("a", false);
  expect(signal!.aborted).toBe(false);
});
test("body timeout remains active after headers and never retries", async () => {
  let calls = 0;
  const { runtime } = await setup(async (_url, init) => {
    calls++;
    return new Response(
      new ReadableStream({
        start(controller) {
          init!.signal!.addEventListener("abort", () =>
            controller.error(init!.signal!.reason),
          );
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  }, 30);
  const result = await runtime.requestResponses({
    body: { model: "m", input: "x" },
  });
  await expect(async () => {
    for await (const _ of result.events) {
    }
  }).rejects.toMatchObject({ code: "request_timeout" });
  expect(calls).toBe(1);
});

test("exposes the existing body deadline without restarting it at headers", async () => {
  let fetchAt = 0;
  const { runtime } = await setup(async () => {
    fetchAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 30));
    return streamResponse();
  }, 1000);
  const started = Date.now();
  const result = await runtime.requestResponses({
    body: { model: "m", input: "x" },
  });
  try {
    const deadline = (result as typeof result & { deadlineAt?: number })
      .deadlineAt;
    expect(deadline).toBeTypeOf("number");
    expect(deadline).toBeGreaterThanOrEqual(started + 1000);
    expect(deadline).toBeLessThanOrEqual(fetchAt + 1000);
    expect(deadline).toBeLessThan(Date.now() + 1000);
  } finally {
    await result.events[Symbol.asyncIterator]().return?.();
  }
});
test("two calls needing refresh perform one persisted rotation", async () => {
  let refreshes = 0;
  const { runtime, store } = await setup(
    async (url, init) => {
      if (String(url).includes("openid-configuration"))
        return Response.json({
          issuer: "https://auth.openai.com",
          authorization_endpoint: "https://auth.openai.com/authorize",
          token_endpoint: "https://auth.openai.com/token",
          jwks_uri: "https://auth.openai.com/jwks",
        });
      if (String(url).endsWith("/token")) {
        refreshes++;
        return Response.json({
          access_token: "replacement",
          refresh_token: "rotated",
          expires_in: 3600,
          token_type: "Bearer",
        });
      }
      expect(new Headers(init!.headers).get("authorization")).toBe(
        "Bearer replacement",
      );
      return streamResponse();
    },
    undefined,
    Date.now() - 100,
  );
  const results = await Promise.all([
    runtime.requestResponses({ body: { model: "m", input: "x" } }),
    runtime.requestResponses({ body: { model: "m", input: "y" } }),
  ]);
  for (const r of results)
    for await (const _ of r.events) {
    }
  expect(refreshes).toBe(1);
  expect(
    (await store.withLock(() => store.read()))!.profiles[0]!.credentials!
      .refreshToken,
  ).toBe("rotated");
});
test("malformed encrypted credentials are preserved during sign in", async () => {
  const { runtime, dataDir } = await setup(async () => {
    throw new Error("no network");
  });
  const path = join(dataDir, "chatgpt-auth.json");
  const damaged = '{"version":3,"provider":"test-only","ciphertext":"broken"}';
  await writeFile(path, damaged);
  await expect(runtime.signIn()).rejects.toMatchObject({
    code: "storage_encrypted_invalid",
  });
  expect(await readFile(path, "utf8")).toBe(damaged);
});
test("safe account views contain no credential or subject fields", async () => {
  const { runtime } = await setup(async () => streamResponse());
  const views = await runtime.listAccounts();
  expect(views.filter((a) => a.isDefault).map((a) => a.id)).toEqual(["a"]);
  expect(JSON.stringify(views)).not.toMatch(
    /access_a|refresh_a|client_a|subject|credentials/,
  );
});
test("disconnect only aborts the target account and never falls back", async () => {
  const signals: AbortSignal[] = [];
  const { runtime } = await setup(async (url, init) => {
    if (String(url).includes("openid-configuration"))
      return Response.json({
        issuer: "https://auth.openai.com",
        authorization_endpoint: "https://auth.openai.com/authorize",
        token_endpoint: "https://auth.openai.com/token",
        jwks_uri: "https://auth.openai.com/jwks",
        revocation_endpoint: "https://auth.openai.com/revoke",
      });
    if (String(url).endsWith("/revoke"))
      return new Response("", { status: 200 });
    signals.push(init!.signal!);
    return streamResponse();
  });
  await runtime.requestResponses({ body: { model: "m", input: "a" } });
  await runtime.selectAccount("b");
  const b = await runtime.requestResponses({
    body: { model: "m", input: "b" },
  });
  await runtime.disconnect("a");
  expect(signals[0]!.aborted).toBe(true);
  expect(signals[1]!.aborted).toBe(false);
  await runtime.selectAccount("a");
  await expect(
    runtime.requestResponses({ body: { model: "m", input: "x" } }),
  ).rejects.toMatchObject({ code: "sign_in_required" });
  await b.events[Symbol.asyncIterator]().return?.();
});
test("HTTP admission is sanitized, keeps request ID, and is never retried", async () => {
  let calls = 0;
  const { runtime } = await setup(async () => {
    calls++;
    return Response.json(
      {
        error: {
          code: "subscription_sharing_usage_limit_exceeded",
          message: "access_a prompt secret",
        },
      },
      { status: 429, headers: { "x-request-id": "req-safe" } },
    );
  });
  await expect(
    runtime.requestResponses({ body: { model: "m", input: "secret" } }),
  ).rejects.toMatchObject({
    status: 429,
    code: "subscription_sharing_usage_limit_exceeded",
    requestId: "req-safe",
  });
  expect(calls).toBe(1);
});
test("failed stream iteration releases its controller without leaking server text", async () => {
  let signal: AbortSignal | undefined;
  const { runtime } = await setup(async (_url, init) => {
    signal = init!.signal!;
    return streamResponse([
      { type: "response.output_text.delta", delta: "partial" },
    ]);
  });
  const result = await runtime.requestResponses({
    body: { model: "m", input: "x" },
  });
  await expect(async () => {
    for await (const _ of result.events) {
    }
  }).rejects.toMatchObject({ code: "stream_interrupted" });
  const after = signal!.aborted;
  await runtime.setEnabled("a", false);
  expect(signal!.aborted).toBe(after);
});
test("model catalog uses the selected account and injected provider", async () => {
  const { runtime } = await setup(async (url, init) => {
    expect(String(url)).toBe("https://api.openai.com/v1/models");
    expect(new Headers(init!.headers).get("authorization")).toBe(
      "Bearer access_b",
    );
    return Response.json({
      models: [
        { slug: "m", display_name: "Model", visibility: "list" },
        { slug: "hidden", display_name: "Hidden", visibility: "hidden" },
      ],
    });
  });
  await runtime.selectAccount("b");
  expect(await runtime.listModels()).toEqual([
    { id: "m", displayName: "Model" },
  ]);
});
