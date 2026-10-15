import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { AccountRuntime, SignInOptions } from "../src/auth/runtime.js";
import { createApp } from "../src/server/app.js";
import { SecurityStore } from "../src/server/security.js";
import { AppError } from "../src/shared/errors.js";
import { encryption } from "./helpers.js";

const host = "localhost:8317",
  origin = `http://${host}`;
let app: FastifyInstance, dir: string, cookie: string, csrf: string;
let options: SignInOptions[],
  resolve: () => void,
  reject: (error: unknown) => void,
  cancellations: number,
  accepted: string[];
const runtime: AccountRuntime = {
  listAccounts: async () => [],
  listModels: async () => [],
  selectAccount: async () => {},
  setEnabled: async () => {},
  disconnect: async () => {},
  requestResponses: async () => {
    throw new Error("unused");
  },
  signIn: (request = {}) => {
    options.push(request);
    return new Promise<void>((ok, fail) => {
      resolve = ok;
      reject = fail;
    });
  },
  cancelSignIn: () => {
    cancellations++;
  },
};
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "maple-manual-admin-"));
  await new SecurityStore(dir, encryption).setPassword(
    "synthetic management password",
  );
  options = [];
  cancellations = 0;
  accepted = [];
  app = await createApp({ runtime, dataDir: dir, encryption });
  const login = await app.inject({
    method: "POST",
    url: "/api/admin/login",
    headers: { host, origin },
    payload: { password: "synthetic management password" },
  });
  cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  csrf = login.json().csrfToken;
});
afterEach(async () => {
  resolve?.();
  vi.useRealTimers();
  await app.close();
  await rm(dir, { recursive: true, force: true });
});
const headers = () => ({ host, origin, cookie, "x-csrf-token": csrf });
const start = (payload: Record<string, unknown> = { mode: "manual" }) =>
  app.inject({
    method: "POST",
    url: "/api/admin/sign-in",
    headers: headers(),
    payload,
  });
const read = (id: string) =>
  app.inject({ url: `/api/admin/sign-in/${id}`, headers: headers() });
const active = () =>
  app.inject({ url: "/api/admin/sign-in/active", headers: headers() });
const submit = (
  id: string,
  payload: Record<string, unknown> = {
    callbackUrl:
      "http://127.0.0.1:1234/auth/callback?state=synthetic&code=synthetic",
  },
) =>
  app.inject({
    method: "POST",
    url: `/api/admin/sign-in/${id}/callback`,
    headers: headers(),
    payload,
  });
function progress(
  index = options.length - 1,
  url = "https://auth.openai.com/authorize?state=synthetic",
) {
  expect(options[index]).toBeDefined();
  options[index]!.onProgress?.({
    phase: "awaiting_callback",
    authorizationUrl: url,
    submitCallback: (value) => {
      if (value === "invalid")
        throw new AppError(400, "callback_invalid", "safe callback error");
      accepted.push(value);
      options[index]!.onProgress?.({ phase: "exchanging" });
    },
  });
}
const settle = async () => {
  resolve();
  await new Promise((ok) => setImmediate(ok));
};

test("manual jobs recover original safe options and expose URL only while awaiting callback", async () => {
  const requested = {
    mode: "manual",
    profileId: "b",
    reconsent: true,
    label: "Original",
  };
  const initial = await start(requested);
  expect(initial.statusCode).toBe(202);
  const job = initial.json();
  expect(job).toMatchObject({
    status: "pending",
    mode: "manual",
    phase: "preparing",
    options: requested,
  });
  expect(Date.parse(job.expiresAt) - Date.parse(job.createdAt)).toBe(
    10 * 60_000,
  );
  expect(job).not.toHaveProperty("authorizationUrl");
  progress();
  const recovery = await active();
  expect(recovery.headers["cache-control"]).toBe("no-store");
  expect(recovery.json().job).toMatchObject({
    id: job.id,
    phase: "awaiting_callback",
    authorizationUrl: "https://auth.openai.com/authorize?state=synthetic",
    options: requested,
  });
  expect(Object.keys(recovery.json().job).sort()).toEqual(
    [
      "id",
      "status",
      "mode",
      "phase",
      "options",
      "createdAt",
      "expiresAt",
      "authorizationUrl",
    ].sort(),
  );
  const acceptedJob = await submit(job.id, {
    callbackUrl: `  ${"x".repeat(2000)}  `,
  });
  expect(acceptedJob.statusCode).toBe(202);
  expect(acceptedJob.json().phase).toBe("exchanging");
  expect(acceptedJob.json()).not.toHaveProperty("authorizationUrl");
  expect(accepted).toEqual(["x".repeat(2000)]);
  expect((await submit(job.id)).statusCode).toBe(409);
  await settle();
  expect((await read(job.id)).json()).toMatchObject({
    status: "completed",
    phase: "exchanging",
  });
  expect((await active()).json()).toEqual({ job: null });
});
test("browser mode is the default, never serializes authorization URL and rejects manual submission", async () => {
  const response = await start({ newProfile: true });
  const job = response.json();
  expect(response.statusCode).toBe(202);
  expect(job.mode).toBe("browser");
  expect(job.options).toEqual({ newProfile: true, mode: "browser" });
  expect(Date.parse(job.expiresAt) - Date.parse(job.createdAt)).toBe(
    5 * 60_000,
  );
  progress();
  expect((await read(job.id)).json()).not.toHaveProperty("authorizationUrl");
  expect((await submit(job.id)).statusCode).toBe(409);
  await settle();
  expect((await start({ mode: "wrong" })).statusCode).toBe(400);
});
test("callback routes distinguish malformed input, missing jobs, not ready and replay", async () => {
  expect((await submit("missing")).statusCode).toBe(404);
  const job = (await start()).json();
  expect((await submit(job.id)).statusCode).toBe(409);
  progress();
  for (const payload of [
    {},
    { callbackUrl: 1 },
    { callbackUrl: "" },
    { callbackUrl: "invalid", extra: true },
    { callbackUrl: "é".repeat(8193) },
    { callbackUrl: "invalid" },
  ]) {
    expect((await submit(job.id, payload)).statusCode).toBe(400);
    expect((await read(job.id)).json().phase).toBe("awaiting_callback");
  }
  expect((await submit(job.id)).statusCode).toBe(202);
  reject(new AppError(400, "access_denied", "safe"));
  await new Promise((ok) => setImmediate(ok));
  const failed = (await read(job.id)).json();
  expect(failed).toMatchObject({ status: "failed", code: "access_denied" });
  expect(failed).not.toHaveProperty("authorizationUrl");
  expect((await submit(job.id)).statusCode).toBe(409);
});
test("new routes require admin authentication, CSRF, exact Host and Origin", async () => {
  const job = (await start()).json();
  progress();
  for (const url of [
    "/api/admin/sign-in/active",
    `/api/admin/sign-in/${job.id}`,
  ]) {
    expect((await app.inject({ url, headers: { host } })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          url,
          headers: { ...headers(), host: "evil.invalid" },
        })
      ).statusCode,
    ).toBe(403);
  }
  for (const mutationHeaders of [
    { host, origin },
    { host, origin, cookie },
    { ...headers(), origin: "https://evil.invalid" },
    { ...headers(), host: "evil.invalid" },
  ]) {
    const response = await app.inject({
      method: "POST",
      url: `/api/admin/sign-in/${job.id}/callback`,
      headers: mutationHeaders,
      payload: { callbackUrl: "private callback" },
    });
    expect(response.statusCode).toBe(mutationHeaders.cookie ? 403 : 401);
    expect(response.body).not.toContain("private callback");
  }
  expect(accepted).toHaveLength(0);
});
test("cancelled reservation survives delayed settlement and ignores old progress after replacement", async () => {
  const job = (await start()).json();
  progress();
  await app.inject({
    method: "DELETE",
    url: `/api/admin/sign-in/${job.id}`,
    headers: headers(),
  });
  progress(0, "https://auth.openai.com/authorize?state=late");
  expect((await active()).json().job).toMatchObject({ status: "cancelled" });
  expect((await active()).json().job).not.toHaveProperty("authorizationUrl");
  expect((await start()).statusCode).toBe(409);
  expect((await submit(job.id)).statusCode).toBe(409);
  await settle();
  const next = (await start()).json();
  progress(1);
  progress(0, "https://auth.openai.com/authorize?state=old");
  expect((await read(next.id)).json().authorizationUrl).not.toContain("old");
  expect(cancellations).toBe(1);
});
test.each(["browser", "manual"])(
  "%s deadline applies to entire job including fresh retry progress",
  async (mode) => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const duration = (mode === "manual" ? 10 : 5) * 60_000;
    const job = (await start({ mode })).json();
    progress();
    await vi.advanceTimersByTimeAsync(duration - 1);
    options[0]!.onProgress?.({ phase: "exchanging" });
    progress(0, "https://auth.openai.com/authorize?state=retry");
    expect((await read(job.id)).json().expiresAt).toBe(job.expiresAt);
    await vi.advanceTimersByTimeAsync(1);
    const expired = (await active()).json().job;
    expect(expired).toMatchObject({
      status: "failed",
      code: "sign_in_timeout",
    });
    expect(expired).not.toHaveProperty("authorizationUrl");
    progress();
    expect((await submit(job.id)).statusCode).toBe(409);
    expect((await start()).statusCode).toBe(409);
    expect(cancellations).toBe(1);
    await settle();
    expect((await active()).json()).toEqual({ job: null });
  },
);
test("callback admission enforces absolute expiry even before the timer runs", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const job = (await start()).json();
  progress();
  vi.setSystemTime(Date.parse(job.expiresAt));
  expect((await submit(job.id)).statusCode).toBe(409);
  const expired = (await read(job.id)).json();
  expect(expired).toMatchObject({ status: "failed", code: "sign_in_timeout" });
  expect(expired).not.toHaveProperty("authorizationUrl");
  expect(accepted).toHaveLength(0);
  expect(cancellations).toBe(1);
  expect((await start()).statusCode).toBe(409);
});
test("unexpected callback exceptions cannot leak pasted secrets", async () => {
  const job = (await start()).json();
  expect(options[0]).toBeDefined();
  options[0]!.onProgress?.({
    phase: "awaiting_callback",
    authorizationUrl: "https://auth.openai.com/authorize",
    submitCallback: () => {
      throw new Error("private callback code verifier");
    },
  });
  const response = await submit(job.id);
  expect(response.statusCode).toBe(400);
  expect(response.body).not.toContain("private");
  expect((await read(job.id)).json().phase).toBe("awaiting_callback");
});
