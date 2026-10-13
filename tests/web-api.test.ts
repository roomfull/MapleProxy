import { expect, it } from "vitest";
import { ApiClient } from "../web/src/api.js";

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
  const client = new ApiClient(
    async () =>
      new Response(
        JSON.stringify({
          error: { code: "admin_unauthorized", message: "请重新登录" },
        }),
        { status: 401 },
      ),
  );
  let expired = false;
  client.onExpired = () => {
    expired = true;
  };
  await expect(client.request("/keys")).rejects.toThrow("请重新登录");
  expect(expired).toBe(true);
});
