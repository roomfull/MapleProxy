import { afterEach, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createAccountRuntime } from "../src/auth/runtime.js";
import type { SignInProgress } from "../vendor/siwc/src/types.js";
import { encryption, fixture } from "./helpers.js";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { createApp } from "../src/server/app.js";
import { SecurityStore } from "../src/server/security.js";

const issuer = "https://auth.openai.com";
const pair = await generateKeyPair("RS256");
const jwks = {
  keys: [
    {
      ...(await exportJWK(pair.publicKey)),
      kid: "manual",
      alg: "RS256",
      use: "sig",
    },
  ],
};
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});
type Waiting = Extract<SignInProgress, { phase: "awaiting_callback" }>;
async function setup(
  options: {
    retry?: boolean;
    subject?: string;
    nonce?: string;
    defaultOpener?: boolean;
    openerFailure?: boolean;
  } = {},
) {
  const f = await fixture();
  cleanups.push(f.cleanup);
  let opened = 0,
    exchanges = 0;
  const waiting: Waiting[] = [];
  const progress: string[] = [];
  const fetches: string[] = [];
  const runtime = createAccountRuntime({
    dataDir: f.dataDir,
    encryption,
    openBrowser: options.defaultOpener
      ? undefined
      : async (url) => {
          opened++;
          if (options.openerFailure)
            throw new Error("synthetic opener failure");
          // Old behavior completes promptly so RED is an assertion, not a timeout.
          await fetch(callbackUrl(new URL(url)));
        },
    fetch: async (input, init) => {
      const url = String(input);
      fetches.push(url);
      if (url.endsWith("openid-configuration"))
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
        });
      if (url.endsWith("/jwks")) return Response.json(jwks);
      if (url.endsWith("/token")) {
        exchanges++;
        const auth = new URL(waiting.at(-1)!.authorizationUrl);
        const body = init!.body as URLSearchParams;
        expect(body.get("redirect_uri")).toBe(
          auth.searchParams.get("redirect_uri"),
        );
        expect(
          createHash("sha256")
            .update(body.get("code_verifier")!)
            .digest("base64url"),
        ).toBe(auth.searchParams.get("code_challenge"));
        if (options.retry && exchanges === 1)
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        const idToken = await new SignJWT({
          nonce: options.nonce ?? auth.searchParams.get("nonce"),
        })
          .setProtectedHeader({ alg: "RS256", kid: "manual" })
          .setIssuer(issuer)
          .setAudience(body.get("client_id")!)
          .setSubject(options.subject ?? "a")
          .setIssuedAt()
          .setExpirationTime("1h")
          .sign(pair.privateKey);
        return Response.json({
          id_token: idToken,
          access_token: "synthetic-access",
          refresh_token: "synthetic-refresh",
          token_type: "Bearer",
          scope: "openid offline_access chatgpt.tokens.use.direct",
          expires_in: 3600,
        });
      }
      throw new Error("Unexpected synthetic provider endpoint");
    },
  });
  const onProgress = (event: SignInProgress) => {
    progress.push(event.phase);
    if (event.phase === "awaiting_callback") waiting.push(event);
  };
  return {
    ...f,
    runtime,
    waiting,
    progress,
    fetches,
    onProgress,
    opened: () => opened,
    exchanges: () => exchanges,
  };
}
function callbackUrl(auth: URL, clientId = "client_a") {
  const url = new URL(auth.searchParams.get("redirect_uri")!);
  url.search = new URLSearchParams({
    state: auth.searchParams.get("state")!,
    code: "synthetic-code",
    client_id: clientId,
  }).toString();
  return url.toString();
}
async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 100 && !predicate(); i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  expect(predicate()).toBe(true);
}
test.each([false, true])(
  "manual authorization keeps original PKCE/redirect and skips opener (new=%s)",
  async (newProfile) => {
    const f = await setup({ subject: newProfile ? "new" : "a" });
    const result = f.runtime
      .signIn({ mode: "manual", newProfile, onProgress: f.onProgress })
      .then(
        () => "ok",
        (error) => error,
      );
    try {
      await waitFor(() => f.waiting.length === 1 || f.opened() > 0);
      expect(f.opened()).toBe(0);
      const waiting = f.waiting[0]!;
      const callback = callbackUrl(
        new URL(waiting.authorizationUrl),
        newProfile ? "issued_client" : "client_a",
      );
      waiting.submitCallback(` \n${callback} \t`);
      expect(() => waiting.submitCallback(callback)).toThrowError(
        expect.objectContaining({ code: "callback_unavailable" }),
      );
      expect(await result).toBe("ok");
      expect(f.exchanges()).toBe(1);
      expect(f.progress).toEqual(["awaiting_callback", "exchanging"]);
      expect(
        (await f.runtime.listAccounts())
          .filter((a) => a.isDefault)
          .map((a) => a.id),
      ).toEqual(["a"]);
      expect(() => waiting.submitCallback(callback)).toThrow();
    } finally {
      f.runtime.cancelSignIn();
      await result;
    }
  },
);
test("manual mode never launches the default system opener", async () => {
  const spawn = vi.spyOn(childProcess, "spawn").mockImplementation(() => {
    throw new Error("Unexpected system opener");
  });
  syncBuiltinESMExports();
  const f = await setup({ defaultOpener: true });
  const result = f.runtime
    .signIn({ mode: "manual", onProgress: f.onProgress })
    .then(
      () => "ok",
      (error) => error,
    );
  try {
    await waitFor(() => f.waiting.length === 1);
    const w = f.waiting[0]!;
    w.submitCallback(callbackUrl(new URL(w.authorizationUrl)));
    expect(await result).toBe("ok");
    expect(spawn).not.toHaveBeenCalled();
  } finally {
    f.runtime.cancelSignIn();
    await result;
    spawn.mockRestore();
    syncBuiltinESMExports();
  }
});
test("a new registration can correct a missing client ID without consuming the code", async () => {
  const f = await setup({ subject: "new" });
  const result = f.runtime
    .signIn({ mode: "manual", newProfile: true, onProgress: f.onProgress })
    .then(
      () => "ok",
      (error) => error,
    );
  try {
    await waitFor(() => f.waiting.length === 1);
    const w = f.waiting[0]!,
      url = new URL(callbackUrl(new URL(w.authorizationUrl), "issued_client"));
    url.searchParams.delete("client_id");
    expect(() => w.submitCallback(url.toString())).toThrowError(
      expect.objectContaining({ code: "callback_invalid" }),
    );
    expect(f.exchanges()).toBe(0);
    url.searchParams.set("client_id", "issued_client");
    w.submitCallback(url.toString());
    expect(await result).toBe("ok");
  } finally {
    f.runtime.cancelSignIn();
    await result;
  }
});
test("callback handles reject after listener close caused by browser opener failure", async () => {
  const f = await setup({ openerFailure: true });
  const result = f.runtime
    .signIn({ mode: "browser", onProgress: f.onProgress })
    .catch((error) => error);
  expect(await result).toMatchObject({ code: "connection_error" });
  expect(f.waiting).toHaveLength(1);
  const w = f.waiting[0]!;
  expect(() =>
    w.submitCallback(callbackUrl(new URL(w.authorizationUrl))),
  ).toThrow();
  expect(f.exchanges()).toBe(0);
});
test("an external abort signal invalidates the callback closure", async () => {
  const f = await setup();
  const controller = new AbortController();
  const result = f.runtime
    .signIn({
      mode: "manual",
      signal: controller.signal,
      onProgress: f.onProgress,
    })
    .catch((error) => error);
  try {
    await waitFor(() => f.waiting.length === 1);
    controller.abort();
    const w = f.waiting[0]!;
    expect(() =>
      w.submitCallback(callbackUrl(new URL(w.authorizationUrl))),
    ).toThrow();
    expect(await result).toMatchObject({ code: "cancelled" });
  } finally {
    f.runtime.cancelSignIn();
    await result;
  }
});
test("authenticated management submission completes the real manual runtime asynchronously", async () => {
  const f = await setup();
  const host = "localhost:8317",
    origin = `http://${host}`;
  await new SecurityStore(f.dataDir, encryption).setPassword(
    "synthetic password",
  );
  const app = await createApp({
    runtime: f.runtime,
    dataDir: f.dataDir,
    encryption,
  });
  // Retain real progress while allowing this test to verify PKCE at its synthetic provider.
  const signIn = f.runtime.signIn.bind(f.runtime);
  f.runtime.signIn = (options) =>
    signIn({
      ...options,
      onProgress: (p) => {
        f.onProgress(p);
        options?.onProgress?.(p);
      },
    });
  try {
    const login = await app.inject({
      method: "POST",
      url: "/api/admin/login",
      headers: { host, origin },
      payload: { password: "synthetic password" },
    });
    const headers = {
      host,
      origin,
      cookie: String(login.headers["set-cookie"]).split(";")[0]!,
      "x-csrf-token": login.json().csrfToken,
    };
    const job = (
      await app.inject({
        method: "POST",
        url: "/api/admin/sign-in",
        headers,
        payload: { mode: "manual" },
      })
    ).json();
    await waitFor(() => f.waiting.length === 1);
    const recovered = (
      await app.inject({ url: "/api/admin/sign-in/active", headers })
    ).json().job;
    expect(recovered.options).toEqual({ mode: "manual" });
    const url = new URL(callbackUrl(new URL(recovered.authorizationUrl)));
    url.searchParams.delete("client_id");
    const invalid = await app.inject({
      method: "POST",
      url: `/api/admin/sign-in/${job.id}/callback`,
      headers,
      payload: { callbackUrl: `${url}&code=duplicate` },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.body).not.toContain("synthetic-code");
    const accepted = await app.inject({
      method: "POST",
      url: `/api/admin/sign-in/${job.id}/callback`,
      headers,
      payload: { callbackUrl: url.toString() },
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).not.toHaveProperty("authorizationUrl");
    await waitFor(() => f.exchanges() === 1);
    for (let i = 0; i < 100; i++) {
      const status = (
        await app.inject({ url: `/api/admin/sign-in/${job.id}`, headers })
      ).json();
      if (status.status !== "pending") {
        expect(status.status).toBe("completed");
        break;
      }
      await new Promise((ok) => setTimeout(ok, 10));
      if (i === 99) throw new Error("Synthetic job did not complete");
    }
    expect(f.opened()).toBe(0);
    expect(
      (await app.inject({ url: "/api/admin/sign-in/active", headers })).json(),
    ).toEqual({ job: null });
  } finally {
    await app.close();
  }
});
test("invalid pasted callbacks never consume the attempt or fetch unknown URLs", async () => {
  const f = await setup();
  const result = f.runtime
    .signIn({ mode: "manual", onProgress: f.onProgress })
    .then(
      () => "ok",
      (error) => error,
    );
  try {
    await waitFor(() => f.waiting.length === 1);
    const waiting = f.waiting[0]!,
      valid = callbackUrl(new URL(waiting.authorizationUrl));
    const variants = [
      "not a URL",
      "https://unknown.invalid/auth/callback",
      valid.replace("127.0.0.1", "localhost"),
      valid.replace("/auth/callback", "/wrong"),
      valid.replace("http://", "http://user@"),
      `${valid}#fragment`,
      valid.replace("synthetic-code", "bad\ncode"),
      `${valid}&code=duplicate`,
      `${valid}&state=duplicate`,
      `${valid}&client_id=duplicate`,
      `${valid}&error=access_denied`,
      valid.replace(/state=[^&]+/, "state=wrong"),
      valid.replace(/&code=[^&]+/, ""),
      valid.replace(/client_id=[^&]+/, "client_id=dynamic_agent_client"),
      valid.replace(/client_id=[^&]+/, "client_id=wrong"),
      `${valid}&extra=${"é".repeat(9000)}`,
      `${valid}&extra=%0A`,
      `${valid}&extra=%ZZ`,
      valid.replace("127.0.0.1", "127.0.0.1."),
    ];
    for (const invalid of variants) {
      expect(
        () => waiting.submitCallback(invalid),
        invalid.slice(0, 180),
      ).toThrowError(expect.objectContaining({ code: "callback_invalid" }));
      expect(f.exchanges()).toBe(0);
    }
    waiting.submitCallback(valid);
    expect(await result).toBe("ok");
    expect(f.fetches.every((url) => url.startsWith(issuer))).toBe(true);
  } finally {
    f.runtime.cancelSignIn();
    await result;
  }
});
test("correct state OAuth denial consumes the attempt with a safe error", async () => {
  const f = await setup();
  const result = f.runtime
    .signIn({ mode: "manual", onProgress: f.onProgress })
    .catch((error) => error);
  try {
    await waitFor(() => f.waiting.length === 1);
    const w = f.waiting[0]!,
      url = new URL(callbackUrl(new URL(w.authorizationUrl)));
    url.searchParams.delete("code");
    url.searchParams.set("error", "access_denied");
    url.searchParams.set("error_description", "sensitive callback text");
    expect(() => w.submitCallback(`${url}&error=access_denied`)).toThrow();
    w.submitCallback(url.toString());
    expect(await result).toMatchObject({ code: "access_denied" });
    expect(JSON.stringify(await result)).not.toContain("sensitive callback");
    expect(f.exchanges()).toBe(0);
    expect(() => w.submitCallback(url.toString())).toThrow();
  } finally {
    f.runtime.cancelSignIn();
    await result;
  }
});
test("HTTP and manual callbacks compete through one consumption gate", async () => {
  const f = await setup();
  const result = f.runtime
    .signIn({ mode: "manual", onProgress: f.onProgress })
    .then(
      () => "ok",
      (error) => error,
    );
  try {
    await waitFor(() => f.waiting.length === 1);
    const w = f.waiting[0]!,
      valid = callbackUrl(new URL(w.authorizationUrl));
    expect((await fetch(`${valid}&code=duplicate`)).status).toBe(400);
    expect((await fetch(valid)).status).toBe(200);
    expect(() => w.submitCallback(valid)).toThrow();
    expect(await result).toBe("ok");
    expect(f.exchanges()).toBe(1);
  } finally {
    f.runtime.cancelSignIn();
    await result;
  }
});
test("a manual callback wins an in-flight HTTP race without a second exchange", async () => {
  const f = await setup();
  const result = f.runtime
    .signIn({ mode: "manual", onProgress: f.onProgress })
    .then(
      () => "ok",
      (error) => error,
    );
  try {
    await waitFor(() => f.waiting.length === 1);
    const w = f.waiting[0]!,
      valid = callbackUrl(new URL(w.authorizationUrl));
    const http = fetch(valid).then(
      (response) => response.status,
      () => 0,
    );
    w.submitCallback(valid);
    expect(await result).toBe("ok");
    expect([0, 404]).toContain(await http);
    expect(f.exchanges()).toBe(1);
  } finally {
    f.runtime.cancelSignIn();
    await result;
  }
});
test("invalid grant retries with fresh callback handle and retained registration", async () => {
  const f = await setup({ retry: true, subject: "new" });
  const result = f.runtime
    .signIn({ mode: "manual", newProfile: true, onProgress: f.onProgress })
    .then(
      () => "ok",
      (error) => error,
    );
  try {
    await waitFor(() => f.waiting.length === 1);
    const old = f.waiting[0]!,
      first = new URL(old.authorizationUrl);
    old.submitCallback(callbackUrl(first, "issued_client"));
    await waitFor(() => f.waiting.length === 2);
    const fresh = f.waiting[1]!,
      next = new URL(fresh.authorizationUrl);
    expect(next.searchParams.get("client_id")).toBe("issued_client");
    expect(next.searchParams.get("state")).not.toBe(
      first.searchParams.get("state"),
    );
    expect(next.searchParams.get("code_challenge")).not.toBe(
      first.searchParams.get("code_challenge"),
    );
    expect(() =>
      old.submitCallback(callbackUrl(first, "issued_client")),
    ).toThrow();
    fresh.submitCallback(callbackUrl(next, "issued_client"));
    expect(await result).toBe("ok");
    expect(f.exchanges()).toBe(2);
    expect(f.progress).toEqual([
      "awaiting_callback",
      "exchanging",
      "awaiting_callback",
      "exchanging",
    ]);
  } finally {
    f.runtime.cancelSignIn();
    await result;
  }
});
test.each([
  { nonce: "wrong", code: "invalid_id_token" },
  { subject: "other", code: "account_mismatch" },
])(
  "manual identity verification rejects $code",
  async ({ code, ...options }) => {
    const f = await setup(options);
    const result = f.runtime
      .signIn({ mode: "manual", onProgress: f.onProgress })
      .catch((error) => error);
    try {
      await waitFor(() => f.waiting.length === 1);
      const w = f.waiting[0]!;
      w.submitCallback(callbackUrl(new URL(w.authorizationUrl)));
      expect(await result).toMatchObject({ code });
    } finally {
      f.runtime.cancelSignIn();
      await result;
    }
  },
);
test("cancel invalidates a saved manual callback closure immediately", async () => {
  const f = await setup();
  const result = f.runtime
    .signIn({ mode: "manual", onProgress: f.onProgress })
    .catch((error) => error);
  try {
    await waitFor(() => f.waiting.length === 1);
    const w = f.waiting[0]!;
    f.runtime.cancelSignIn();
    expect(() =>
      w.submitCallback(callbackUrl(new URL(w.authorizationUrl))),
    ).toThrow();
    expect(await result).toMatchObject({ code: "cancelled" });
    expect(f.exchanges()).toBe(0);
  } finally {
    f.runtime.cancelSignIn();
    await result;
  }
});
