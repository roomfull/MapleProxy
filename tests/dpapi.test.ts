import { expect, test } from "vitest";
import { createDpapiEncryption } from "../src/auth/dpapi.js";
import { SecurityStore } from "../src/server/security.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
test.runIf(process.platform === "win32")(
  "real DPAPI CurrentUser roundtrip rejects tampering",
  async () => {
    const p = createDpapiEncryption();
    expect(await p.isAvailable()).toBe(true);
    const blob = await p.encrypt("synthetic-test-secret");
    expect(Buffer.from(blob).toString()).not.toContain("synthetic-test-secret");
    expect(await p.decrypt(blob)).toBe("synthetic-test-secret");
    blob[blob.length - 1] = blob[blob.length - 1]! ^ 1;
    await expect(p.decrypt(blob)).rejects.toThrow();
  },
);
test("DPAPI provider fails closed on unsupported platform", async () => {
  const p = createDpapiEncryption({ platform: "linux" });
  expect(await p.isAvailable()).toBe(false);
  await expect(p.encrypt("secret")).rejects.toThrow();
});
test.runIf(process.platform === "win32")(
  "default security store persists DPAPI ciphertext and restores the key",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "maple-dpapi-store-"));
    try {
      const created = await new SecurityStore(dir).createKey(
        "dpapi integration",
      );
      const disk = await readFile(join(dir, "security.json"), "utf8");
      expect(disk).not.toContain(created.secret);
      expect(disk).not.toContain(
        Buffer.from(created.secret).toString("base64"),
      );
      expect(await new SecurityStore(dir).getKeySecret(created.key.id)).toBe(
        created.secret,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
