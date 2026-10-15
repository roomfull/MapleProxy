// Test-only fixture. Never imported by the production server or exposed as an HTTP toggle.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../src/server/app.js";
import { SecurityStore } from "../src/server/security.js";
import type { AccountRuntime, AccountView } from "../src/auth/runtime.js";
import { AppError } from "../src/shared/errors.js";
import { encryption } from "../tests/helpers.js";

export const smokePassword = "MapleProxy smoke fixture 2026";
export async function startSmokeFixture(): Promise<{
  url: string;
  seed(): Promise<void>;
  callback(code?: "success" | "retry" | "fail"): string;
  complete(code?: "success" | "retry" | "fail"): void;
  rotate(): void;
  close(): Promise<void>;
}> {
  const dataDir = await mkdtemp(join(tmpdir(), "maple-browser-smoke-"));
  const security = new SecurityStore(dataDir, encryption);
  const accounts: AccountView[] = ["a", "b"].map((id, index) => ({
    id,
    label: index ? "测试账户 B" : "测试账户 A",
    status: "connected",
    sharing: true,
    enabled: true,
    isDefault: !index,
    identity: { email: `${id}@example.invalid` },
  }));
  const find = (id: string) => {
    const account = accounts.find((a) => a.id === id);
    if (!account)
      throw new AppError(404, "profile_not_found", "测试账户不存在。");
    return account;
  };
  let attempt = 0;
  let currentState = "";
  let cancelAuthorization: (() => void) | undefined;
  let rotateAuthorization: (() => void) | undefined;
  let submitAuthorization: ((url: string) => void) | undefined;
  const callback = (code: "success" | "retry" | "fail" = "success") => {
    if (!currentState) throw new Error("No active synthetic authorization.");
    return `http://127.0.0.1:1/auth/callback?state=${currentState}&code=${code}&client_id=fixture-client`;
  };
  const runtime: AccountRuntime = {
    listAccounts: async () => accounts.map((a) => ({ ...a })),
    signIn: (options = {}) =>
      new Promise((resolveSignIn, rejectSignIn) => {
        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const cleanup = () => {
          stopped = true;
          clearTimeout(timer);
          cancelAuthorization =
            rotateAuthorization =
            submitAuthorization =
              undefined;
          currentState = "";
          options.signal?.removeEventListener("abort", cancel);
        };
        const cancel = () => {
          cleanup();
          rejectSignIn(
            new AppError(
              499,
              "cancelled",
              "Synthetic authorization cancelled.",
            ),
          );
        };
        const waiting = () => {
          if (stopped) return;
          currentState = `fixture-attempt-${++attempt}`;
          const state = currentState;
          let consumed = false;
          const authorizationUrl = `https://example.invalid/authorize?state=${state}&client_id=fixture-client&redirect_uri=${encodeURIComponent("http://127.0.0.1:1/auth/callback")}`;
          const submit = (text: string) => {
            if (stopped || consumed || state !== currentState)
              throw new AppError(
                409,
                "callback_unavailable",
                "Synthetic callback unavailable.",
              );
            let parsed: URL;
            try {
              parsed = new URL(text);
            } catch {
              throw new AppError(
                400,
                "callback_invalid",
                "Synthetic callback invalid.",
              );
            }
            const code = parsed.searchParams.get("code");
            if (
              parsed.origin !== "http://127.0.0.1:1" ||
              parsed.pathname !== "/auth/callback" ||
              parsed.searchParams.get("state") !== state ||
              parsed.searchParams.get("client_id") !== "fixture-client" ||
              !["success", "retry", "fail"].includes(code ?? "") ||
              ["state", "code", "client_id"].some(
                (name) => parsed.searchParams.getAll(name).length !== 1,
              )
            )
              throw new AppError(
                400,
                "callback_invalid",
                "Synthetic callback invalid.",
              );
            consumed = true;
            options.onProgress?.({ phase: "exchanging" });
            timer = setTimeout(() => {
              if (stopped) return;
              if (code === "retry") {
                waiting();
                return;
              }
              if (code === "fail") {
                cleanup();
                rejectSignIn(
                  new AppError(
                    400,
                    "synthetic_authorization_failed",
                    "Synthetic failure.",
                  ),
                );
                return;
              }
              const account = options.profileId
                ? find(options.profileId)
                : {
                    id: `fixture-profile-${attempt}`,
                    label: options.label ?? "合成跨设备账户",
                    status: "connected",
                    sharing: true,
                    enabled: true,
                    isDefault: false,
                    identity: { email: `fixture-${attempt}@example.invalid` },
                  };
              Object.assign(account, {
                status: "connected",
                sharing: true,
                enabled: true,
              });
              if (!options.profileId) accounts.push(account);
              cleanup();
              resolveSignIn({ profileId: account.id });
            }, 2000);
          };
          submitAuthorization = submit;
          rotateAuthorization = () => {
            consumed = true;
            clearTimeout(timer);
            waiting();
          };
          options.onProgress?.({
            phase: "awaiting_callback",
            authorizationUrl,
            submitCallback: submit,
          });
        };
        cancelAuthorization = cancel;
        options.signal?.addEventListener("abort", cancel, { once: true });
        if (options.signal?.aborted) cancel();
        else waiting();
      }),
    cancelSignIn: () => cancelAuthorization?.(),
    selectAccount: async (id) => {
      find(id);
      accounts.forEach((a) => {
        a.isDefault = a.id === id;
      });
    },
    setEnabled: async (id, enabled) => {
      find(id).enabled = enabled;
    },
    disconnect: async (id) => {
      const a = find(id);
      a.status = "disconnected";
      a.sharing = false;
      a.enabled = false;
    },
    listModels: async () => [{ id: "test-model", displayName: "隔离测试模型" }],
    requestResponses: async ({ body }) => {
      const account = accounts.find((a) => a.isDefault)!;
      if (!account.enabled || account.status !== "connected")
        throw new AppError(409, "account_disabled", "测试账户已停用。");
      if (JSON.stringify(body.input).includes("fixture-failure"))
        throw new AppError(429, "rate_limit_exceeded", "隔离测试限流示例。");
      const incomplete = JSON.stringify(body.input).includes(
        "fixture-incomplete",
      );
      return {
        profileId: account.id,
        status: 200,
        headers: new Headers({
          "x-request-id": incomplete
            ? "upstream-fixture-incomplete"
            : "upstream-fixture-success",
        }),
        events: (async function* () {
          yield {
            type: incomplete ? "response.incomplete" : "response.completed",
            response: {
              id: "resp_fixture",
              status: incomplete ? "incomplete" : "completed",
              ...(incomplete
                ? { incomplete_details: { reason: "max_output_tokens" } }
                : {}),
              model: "test-model",
              output: [
                {
                  type: "message",
                  id: "msg_fixture",
                  role: "assistant",
                  status: "completed",
                  content: [
                    {
                      type: "output_text",
                      text: incomplete
                        ? "本地隔离测试部分结果。"
                        : "本地隔离测试成功。",
                      annotations: [],
                    },
                  ],
                },
              ],
              usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
            },
          };
        })(),
      };
    },
  };
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    cancelAuthorization?.();
    try {
      await app?.close();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  };
  try {
    await security.setPassword(smokePassword);
    app = await createApp({
      runtime,
      dataDir,
      webDir: resolve("web/dist"),
      port: 0,
      encryption,
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const seed = async () => {
      const key = await security.createKey("internal-smoke-seed");
      try {
        const cases = [
          { path: "responses", body: { input: "fixture-success" } },
          { path: "responses", body: { input: "fixture-failure" } },
          { path: "responses", body: { input: "fixture-incomplete" } },
          {
            path: "chat/completions",
            body: {
              n: 2,
              messages: [
                {
                  role: "user",
                  content: "fixture-validation",
                  startsNewUserRequest: true,
                },
              ],
            },
          },
        ];
        for (const entry of cases) {
          const response = await fetch(`${url}/v1/${entry.path}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${key.secret}`,
            },
            body: JSON.stringify({
              model: "test-model",
              ...entry.body,
              temperature: 0.5,
            }),
          });
          await response.text();
        }
      } finally {
        await security.revokeKey(key.key.id);
      }
    };
    await seed();
    return {
      url,
      seed,
      callback,
      complete: (code = "success") => submitAuthorization?.(callback(code)),
      rotate: () => rotateAuthorization?.(),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
