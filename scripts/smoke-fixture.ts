// Test-only fixture. Never imported by the production server or exposed as an HTTP toggle.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../src/server/app.js";
import { SecurityStore } from "../src/server/security.js";
import type { AccountRuntime, AccountView } from "../src/auth/runtime.js";
import { AppError } from "../src/shared/errors.js";

export const smokePassword = "MapleProxy smoke fixture 2026";
export async function startSmokeFixture(): Promise<{
  url: string;
  seed(): Promise<void>;
  close(): Promise<void>;
}> {
  const dataDir = await mkdtemp(join(tmpdir(), "maple-browser-smoke-"));
  const security = new SecurityStore(dataDir);
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
  const runtime: AccountRuntime = {
    listAccounts: async () => accounts.map((a) => ({ ...a })),
    signIn: async () => {
      throw new AppError(400, "fixture_only", "此隔离测试不会启动真实 OAuth。");
    },
    cancelSignIn: () => {},
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
      return {
        profileId: account.id,
        status: 200,
        headers: new Headers(),
        events: (async function* () {
          yield {
            type: "response.completed",
            response: {
              id: "resp_fixture",
              status: "completed",
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
                      text: "本地隔离测试成功。",
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
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const seed = async () => {
      const key = await security.createKey("internal-smoke-seed");
      try {
        for (const input of ["fixture-success", "fixture-failure"]) {
          const response = await fetch(`${url}/v1/responses`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${key.secret}`,
            },
            body: JSON.stringify({
              model: "test-model",
              input,
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
    return { url, seed, close };
  } catch (error) {
    await close();
    throw error;
  }
}
