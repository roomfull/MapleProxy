import { afterEach, expect, test } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAccountRuntime } from "../src/auth/runtime.js";
import { encryption, fixture, streamResponse } from "./helpers.js";
import { ConnectionStore } from "../vendor/siwc/src/storage.js";
const issuer = "https://auth.openai.com";
const pair = await generateKeyPair("RS256");
const jwks = {
  keys: [
    {
      ...(await exportJWK(pair.publicKey)),
      kid: "runtime-test",
      use: "sig",
      alg: "RS256",
    },
  ],
};
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((f) => f()));
});
const token = (aud: string, sub: string, nonce?: string) =>
  new SignJWT({
    iss: issuer,
    aud,
    sub,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...(nonce ? { nonce } : {}),
  })
    .setProtectedHeader({ alg: "RS256", kid: "runtime-test" })
    .sign(pair.privateKey);
function discovery() {
  return Response.json({
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/jwks`,
    revocation_endpoint: `${issuer}/revoke`,
  });
}
async function callback(url: URL, overrides: Record<string, string> = {}) {
  const result = new URL(url.searchParams.get("redirect_uri")!);
  result.searchParams.set("state", url.searchParams.get("state")!);
  result.searchParams.set("code", "synthetic-code");
  result.searchParams.set("client_id", "issued_client");
  for (const [key, value] of Object.entries(overrides))
    result.searchParams.set(key, value);
  return fetch(result);
}
test("OAuth new profile retains default, uses PKCE and host identity, rejects unrelated callbacks", async () => {
  const f = await fixture();
  cleanups.push(f.cleanup);
  let auth: URL;
  let codes = 0;
  const runtime = createAccountRuntime({
    dataDir: f.dataDir,
    encryption,
    openBrowser: async (url) => {
      auth = new URL(url);
      expect(auth.searchParams.get("ext_agent_host_id")).toMatch(/^urn:uuid:/);
      expect(auth.searchParams.has("id_token_hint")).toBe(false);
      expect((await callback(auth, { state: "wrong" })).status).toBe(400);
      await callback(auth);
    },
    fetch: async (url, init) => {
      if (String(url).includes("openid-configuration")) return discovery();
      if (String(url).endsWith("/jwks")) return Response.json(jwks);
      if (String(url).endsWith("/token")) {
        codes++;
        const params = init!.body as URLSearchParams;
        expect(
          createHash("sha256")
            .update(params.get("code_verifier")!)
            .digest("base64url"),
        ).toBe(auth!.searchParams.get("code_challenge"));
        return Response.json({
          id_token: await token(
            "issued_client",
            "new-subject",
            auth!.searchParams.get("nonce")!,
          ),
          access_token: "synthetic-access",
          refresh_token: "synthetic-refresh",
          token_type: "Bearer",
          scope: "openid offline_access chatgpt.tokens.use.direct",
          expires_in: 3600,
        });
      }
      throw new Error("Unexpected URL");
    },
  });
  await runtime.signIn({ newProfile: true, label: "Third" });
  expect(codes).toBe(1);
  expect(
    (await runtime.listAccounts()).filter((a) => a.isDefault).map((a) => a.id),
  ).toEqual(["a"]);
});
test("parallel OAuth attempts return connection_busy and cancellation preserves issued registration", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "maple-oauth-"));
  cleanups.push(() => rm(dataDir, { force: true, recursive: true }));
  let opened!: () => void;
  const ready = new Promise<void>((r) => (opened = r));
  let released!: () => void;
  const hold = new Promise<void>((r) => (released = r));
  const runtime = createAccountRuntime({
    dataDir,
    encryption,
    fetch: async () => discovery(),
    openBrowser: async (url) => {
      await callback(new URL(url));
      opened();
      await hold;
    },
  });
  const pending = runtime.signIn({ newProfile: true });
  await ready;
  await expect(runtime.signIn({ newProfile: true })).rejects.toMatchObject({
    code: "connection_busy",
  });
  runtime.cancelSignIn();
  released();
  await expect(pending).rejects.toMatchObject({ code: "cancelled" });
  expect(
    (await runtime.listAccounts()).filter((a) => a.isDefault),
  ).toHaveLength(0);
});
test("JWKS outage preserves received rotation and recovery never spends old refresh token twice", async () => {
  const f = await fixture(Date.now() - 100);
  cleanups.push(f.cleanup);
  let refreshes = 0;
  let unavailable = true;
  const runtime = createAccountRuntime({
    dataDir: f.dataDir,
    encryption,
    fetch: async (url) => {
      if (String(url).includes("openid-configuration")) return discovery();
      if (String(url).endsWith("/jwks"))
        return unavailable
          ? new Response("", { status: 503 })
          : Response.json(jwks);
      if (String(url).endsWith("/token")) {
        refreshes++;
        return Response.json({
          id_token: await token("client_a", "a"),
          access_token: "rotated-access",
          refresh_token: "rotated-refresh",
          token_type: "Bearer",
          expires_in: 3600,
        });
      }
      return streamResponse();
    },
  });
  await expect(
    runtime.requestResponses({ body: { model: "m", input: "x" } }),
  ).rejects.toMatchObject({ code: "identity_verification_unavailable" });
  let saved = await f.store.withLock(() => f.store.read());
  expect(saved!.profiles[0]!.pendingRefresh!.credentials.refreshToken).toBe(
    "rotated-refresh",
  );
  expect(saved!.profiles[0]!.credentials!.refreshToken).toBe("refresh_a");
  unavailable = false;
  for await (const _ of (
    await runtime.requestResponses({ body: { model: "m", input: "x" } })
  ).events) {
  }
  saved = await f.store.withLock(() => f.store.read());
  expect(refreshes).toBe(1);
  expect(saved!.profiles[0]!.pendingRefresh).toBeUndefined();
  expect(saved!.profiles[0]!.credentials!.refreshToken).toBe("rotated-refresh");
});
test("only the first sharing-ready profile is automatically selected", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "maple-first-"));
  cleanups.push(() => rm(dataDir, { force: true, recursive: true }));
  let auth: URL;
  let sharing = false;
  let client = 0;
  const runtime = createAccountRuntime({
    dataDir,
    encryption,
    openBrowser: async (url) => {
      auth = new URL(url);
      client++;
      await callback(auth, { client_id: `client_${client}` });
    },
    fetch: async (url) => {
      if (String(url).includes("openid-configuration")) return discovery();
      if (String(url).endsWith("/jwks")) return Response.json(jwks);
      if (String(url).endsWith("/token"))
        return Response.json({
          id_token: await token(
            `client_${client}`,
            `subject_${client}`,
            auth!.searchParams.get("nonce")!,
          ),
          ...(sharing
            ? {
                access_token: "synthetic-access",
                refresh_token: "synthetic-refresh",
                token_type: "Bearer",
                expires_in: 3600,
              }
            : {}),
          scope: sharing
            ? "openid offline_access chatgpt.tokens.use.direct"
            : "openid",
        });
      throw new Error("unexpected");
    },
  });
  await runtime.signIn({ newProfile: true });
  expect(
    (await runtime.listAccounts()).filter((a) => a.isDefault),
  ).toHaveLength(0);
  sharing = true;
  await runtime.signIn({ newProfile: true });
  const selected = (await runtime.listAccounts()).find((a) => a.isDefault)!.id;
  await runtime.signIn({ newProfile: true });
  expect(
    (await runtime.listAccounts()).filter((a) => a.isDefault).map((a) => a.id),
  ).toEqual([selected]);
});
test("caller cancellation during refresh still checkpoints and persists the rotating grant", async () => {
  const f = await fixture(Date.now() - 100);
  cleanups.push(f.cleanup);
  let received!: () => void;
  const started = new Promise<void>((r) => (received = r));
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  let refreshes = 0;
  const runtime = createAccountRuntime({
    dataDir: f.dataDir,
    encryption,
    fetch: async (url) => {
      if (String(url).includes("openid-configuration")) return discovery();
      if (String(url).endsWith("/token")) {
        refreshes++;
        received();
        await hold;
        return Response.json({
          access_token: "successor",
          refresh_token: "successor-refresh",
          token_type: "Bearer",
          expires_in: 3600,
        });
      }
      return streamResponse();
    },
  });
  const controller = new AbortController();
  const pending = runtime.requestResponses({
    body: { model: "m", input: "x" },
    signal: controller.signal,
  });
  await started;
  controller.abort();
  release();
  await expect(pending).rejects.toMatchObject({ code: "cancelled" });
  expect(
    (await f.store.withLock(() => f.store.read()))!.profiles[0]!.credentials!
      .refreshToken,
  ).toBe("successor-refresh");
  for await (const _ of (
    await runtime.requestResponses({ body: { model: "m", input: "y" } })
  ).events) {
  }
  expect(refreshes).toBe(1);
});
