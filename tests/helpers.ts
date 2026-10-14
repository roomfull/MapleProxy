import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConnectionStore } from "../vendor/siwc/src/storage.js";
import type {
  CredentialEncryption,
  StoredProfile,
} from "../vendor/siwc/src/types.js";
export const encryption: CredentialEncryption = {
  id: "test-only",
  isAvailable: () => true,
  encrypt: (s) => Buffer.from(s).map((byte) => byte ^ 0xa5),
  decrypt: (b) =>
    Buffer.from(b)
      .map((byte) => byte ^ 0xa5)
      .toString(),
};
export async function fixture(expiresAt = Date.now() + 3600000) {
  const dataDir = await mkdtemp(join(tmpdir(), "maple-runtime-"));
  const store = new ConnectionStore(dataDir, encryption);
  const profile = (id: string): StoredProfile => ({
    version: 1,
    id,
    label: id,
    clientId: `client_${id}`,
    status: "connected",
    scopes: ["chatgpt.tokens.use.direct", "offline_access"],
    savedAt: new Date().toISOString(),
    subject: id,
    identity: { email: `${id}@example.invalid` },
    credentials: {
      accessToken: `access_${id}`,
      refreshToken: `refresh_${id}`,
      expiresAt,
    },
  });
  await store.withLock(() =>
    store.write({
      version: 2,
      activeProfileId: "a",
      profiles: [profile("a"), profile("b")],
      pendingRegistrations: [],
    }),
  );
  return {
    dataDir,
    store,
    cleanup: () => rm(dataDir, { recursive: true, force: true }),
  };
}
export function streamResponse(
  events: unknown[] = [{ type: "response.completed", response: { id: "r" } }],
) {
  return new Response(
    events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}
