import { expect, it, vi } from "vitest";
import { ApiClient } from "../web/src/api.js";

it("provides typed manual sign-in, recovery, status, cancel and exact callback payload helpers", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const client = new ApiClient(async (url, init) => {
    calls.push({ url, init });
    return Response.json(
      url.endsWith("/active") ? { job: null } : { id: "synthetic" },
    );
  });
  expect(typeof client.startSignIn).toBe("function");
  await client.startSignIn({ mode: "manual", profileId: "a", reconsent: true });
  await client.activeSignIn();
  await client.signInStatus("id /?");
  await client.submitSignInCallback(
    "id /?",
    "http://127.0.0.1:1234/auth/callback?code=synthetic&state=fixture",
  );
  await client.cancelSignIn("id /?");
  expect(calls.map((call) => [call.url, call.init.method])).toEqual([
    ["/api/admin/sign-in", "POST"],
    ["/api/admin/sign-in/active", "GET"],
    ["/api/admin/sign-in/id%20%2F%3F", "GET"],
    ["/api/admin/sign-in/id%20%2F%3F/callback", "POST"],
    ["/api/admin/sign-in/id%20%2F%3F", "DELETE"],
  ]);
  expect(JSON.parse(calls[3]!.init.body as string)).toEqual({
    callbackUrl:
      "http://127.0.0.1:1234/auth/callback?code=synthetic&state=fixture",
  });
});

it("ignores a previous session's late 401 after relogin", async () => {
  let finish!: (response: Response) => void;
  let logins = 0;
  const calls: RequestInit[] = [];
  const client = new ApiClient(async (url, init) => {
    calls.push(init);
    if (url.endsWith("/login"))
      return Response.json({
        authenticated: true,
        csrfToken: `csrf-${++logins}`,
      });
    if (url.endsWith("/sign-in/old"))
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    return Response.json({ ok: true });
  });
  client.onExpired = vi.fn();
  await client.login("synthetic");
  const old = client.signInStatus("old");
  await client.logout();
  await client.login("synthetic");
  finish(
    Response.json(
      { error: { code: "admin_unauthorized", message: "Expired old session" } },
      { status: 401 },
    ),
  );
  await expect(old).rejects.toThrow("Expired old session");
  expect(client.onExpired).not.toHaveBeenCalled();
  await client.startSignIn({ mode: "manual" });
  expect(new Headers(calls.at(-1)!.headers).get("x-csrf-token")).toBe("csrf-2");
});

it("does not restore stale CSRF from bootstrap after logout", async () => {
  let finish!: (response: Response) => void;
  const calls: RequestInit[] = [];
  const client = new ApiClient(async (url, init) => {
    calls.push(init);
    return url.endsWith("/session")
      ? new Promise<Response>((resolve) => {
          finish = resolve;
        })
      : Response.json({ ok: true });
  });
  const bootstrap = client.session();
  await client.logout();
  finish(Response.json({ authenticated: true, csrfToken: "old-csrf" }));
  await bootstrap;
  await client.startSignIn({ mode: "manual" });
  expect(new Headers(calls.at(-1)!.headers).has("x-csrf-token")).toBe(false);
});

it("invokes the default browser fetch with its global receiver", async () => {
  vi.stubGlobal("fetch", function (this: unknown) {
    if (this !== globalThis) throw new TypeError("Illegal invocation");
    return Promise.resolve(
      Response.json({ configured: true, authenticated: false }),
    );
  });
  try {
    await expect(new ApiClient().session()).resolves.toEqual({
      configured: true,
      authenticated: false,
    });
  } finally {
    vi.unstubAllGlobals();
  }
});

it("keeps CSRF in memory, uses same-origin cookies and exposes show-once key response", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = async (input: string, init: RequestInit) => {
    calls.push({ url: input, init });
    return new Response(
      JSON.stringify(
        input.endsWith("login")
          ? { authenticated: true, csrfToken: "session-csrf" }
          : input.endsWith("keys")
            ? { key: { id: "key1", name: "editor" }, secret: "show-once" }
            : { ok: true },
      ),
    );
  };
  const client = new ApiClient(fetcher);
  await client.login("private-password");
  const created = await client.request<{ secret: string }>("/keys", "POST", {
    name: "editor",
  });
  await client.request("/accounts/a/default", "POST");
  expect(created.secret).toBe("show-once");
  expect(calls[1]?.init.credentials).toBe("same-origin");
  expect(new Headers(calls[1]?.init.headers).get("X-CSRF-Token")).toBe(
    "session-csrf",
  );
  expect(calls[2]?.url).toBe("/api/admin/accounts/a/default");
  expect(JSON.stringify(calls.slice(1))).not.toContain("private-password");
});
it("reports backend errors and clears authentication on session expiry", async () => {
  const calls: RequestInit[] = [];
  const client = new ApiClient(async (path, init) => {
    calls.push(init);
    if (path.endsWith("/login"))
      return Response.json({ authenticated: true, csrfToken: "local-csrf" });
    return new Response(
      JSON.stringify({
        error: { code: "admin_unauthorized", message: "请重新登录" },
      }),
      { status: 401 },
    );
  });
  let expired = false;
  client.onExpired = () => {
    expired = true;
  };
  await client.login("synthetic-password");
  await expect(client.request("/keys")).rejects.toThrow("请重新登录");
  expect(expired).toBe(true);
  await expect(client.request("/accounts/a/default", "POST")).rejects.toThrow();
  expect(new Headers(calls.at(-1)!.headers).has("x-csrf-token")).toBe(false);
});
it("keeps the management session and CSRF usable after an upstream 401", async () => {
  const calls: RequestInit[] = [];
  const client = new ApiClient(async (path, init) => {
    calls.push(init);
    if (path.endsWith("/login"))
      return Response.json({ authenticated: true, csrfToken: "local-csrf" });
    if (path.endsWith("/models"))
      return Response.json(
        {
          error: {
            code: "invalid_token",
            message: "Upstream rejected the selected connection.",
          },
        },
        { status: 401 },
      );
    return Response.json({ ok: true });
  });
  client.onExpired = vi.fn();
  await client.login("synthetic-password");
  await expect(client.request("/models")).rejects.toThrow("Upstream rejected");
  expect(client.onExpired).not.toHaveBeenCalled();
  for (const path of [
    "/sign-in",
    "/accounts/a/default",
    "/accounts/a/disconnect",
  ])
    await client.request(path, "POST", {});
  for (const call of calls.slice(2))
    expect(new Headers(call.headers).get("x-csrf-token")).toBe("local-csrf");
});

it("retrieves a retained key only for clipboard and waits for write completion", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const client = new ApiClient(async (url, init) => {
    calls.push({ url, init });
    return Response.json(
      url.endsWith("login")
        ? { authenticated: true, csrfToken: "csrf" }
        : { secret: "mp_private_fixture" },
    );
  });
  await client.login("fixture-password");
  let resolveWrite!: () => void;
  const written = new Promise<void>((resolve) => {
    resolveWrite = resolve;
  });
  const write = vi.fn(() => written);
  let settled = false;
  const copy = client.copyKeyToClipboard("id /?", write).then(() => {
    settled = true;
  });
  await vi.waitFor(() =>
    expect(write).toHaveBeenCalledWith("mp_private_fixture"),
  );
  expect(settled).toBe(false);
  expect(calls[1]?.url).toBe("/api/admin/keys/id%20%2F%3F/secret");
  expect(calls[1]?.init.method).toBe("POST");
  expect(new Headers(calls[1]?.init.headers).get("x-csrf-token")).toBe("csrf");
  expect(JSON.stringify(calls)).not.toContain("mp_private_fixture");
  resolveWrite();
  await copy;
  expect(settled).toBe(true);
});

it("propagates clipboard denial so success cannot be shown and a retry can succeed", async () => {
  const client = new ApiClient(async () =>
    Response.json({ secret: "mp_fixture" }),
  );
  const denied = vi.fn(async () => {
    throw new Error("clipboard denied");
  });
  await expect(client.copyKeyToClipboard("key", denied)).rejects.toThrow(
    "clipboard denied",
  );
  const write = vi.fn(async () => {});
  await expect(
    client.copyKeyToClipboard("key", write),
  ).resolves.toBeUndefined();
  expect(write).toHaveBeenCalledWith("mp_fixture");
});

it("does not write clipboard when protected retrieval fails", async () => {
  const client = new ApiClient(async () =>
    Response.json({ error: { message: "旧密钥无法复制" } }, { status: 409 }),
  );
  const write = vi.fn(async () => {});
  await expect(client.copyKeyToClipboard("legacy", write)).rejects.toThrow(
    "旧密钥无法复制",
  );
  expect(write).not.toHaveBeenCalled();
});
