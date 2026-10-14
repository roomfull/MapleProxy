import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecurityStore } from "../src/server/security.js";
import { encryption } from "./helpers.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "maple-security-"));
  dirs.push(dir);
  return { dir, store: new SecurityStore(dir, encryption) };
}
describe("local security store", () => {
  it("accepts a six-character password and rejects lengths outside 6–1024", async () => {
    const { dir, store } = await fixture();
    await store.setPassword("654321");
    const restored = new SecurityStore(dir);
    expect(await restored.authenticate("654321")).toMatchObject({
      token: expect.any(String),
      csrfToken: expect.any(String),
    });
    for (const invalid of ["12345", "x".repeat(1025)]) {
      await expect(restored.setPassword(invalid)).rejects.toMatchObject({
        code: "invalid_password",
        message: "密码长度应为 6–1024 个字符。",
      });
    }
    expect(await restored.verifyPassword("654321")).toBe(true);
  });
  it("has no HTTP-style initial password and persists only salted digests", async () => {
    const { dir, store } = await fixture();
    expect(await store.configured()).toBe(false);
    await store.setPassword("a long private password");
    expect(await store.verifyPassword("wrong")).toBe(false);
    expect(await store.verifyPassword("a long private password")).toBe(true);
    const disk = await readFile(join(dir, "security.json"), "utf8");
    expect(disk).not.toContain("a long private password");
    await expect(
      new SecurityStore(dir).verifyPassword("a long private password"),
    ).resolves.toBe(true);
  });
  it("authenticates a created API key and revokes its persisted record", async () => {
    const { dir, store } = await fixture();
    const created = await store.createKey("editor");
    expect(Object.keys(created.key).sort()).toEqual(
      ["canCopy", "createdAt", "id", "name", "prefix"].sort(),
    );
    expect(await store.acceptKey(created.secret)).toBe(true);
    expect(await store.acceptKey("wrong")).toBe(false);
    expect(JSON.stringify(await store.listKeys())).not.toContain(
      created.secret,
    );
    expect(await readFile(join(dir, "security.json"), "utf8")).not.toContain(
      created.secret,
    );
    await new SecurityStore(dir).revokeKey(created.key.id);
    expect(await store.acceptKey(created.secret)).toBe(false);
  });
  it("restores the original key through another store without exposing it in views or on disk", async () => {
    const { dir, store } = await fixture();
    const created = await store.createKey("editor");
    const restored = new SecurityStore(dir, encryption);
    expect(await restored.getKeySecret(created.key.id)).toBe(created.secret);
    expect(Object.keys((await restored.listKeys())[0]!).sort()).toEqual(
      ["canCopy", "createdAt", "id", "name", "prefix"].sort(),
    );
    expect((await restored.listKeys())[0]?.canCopy).toBe(true);
    const disk = await readFile(join(dir, "security.json"), "utf8");
    expect(disk).not.toContain(created.secret);
    expect(disk).not.toContain(Buffer.from(created.secret).toString("base64"));
  });
  it("keeps a legacy hash-only key usable but cannot recover its original", async () => {
    const { dir, store } = await fixture();
    const created = await store.createKey("legacy");
    const path = join(dir, "security.json");
    const data = JSON.parse(await readFile(path, "utf8"));
    delete data.keys[0].encryptedSecret;
    delete data.keys[0].encryptionId;
    await writeFile(path, JSON.stringify(data));
    expect(await store.acceptKey(created.secret)).toBe(true);
    expect((await store.listKeys())[0]?.canCopy).toBe(false);
    await expect(store.getKeySecret(created.key.id)).rejects.toMatchObject({
      status: 409,
    });
    await store.revokeKey(created.key.id);
    await expect(store.getKeySecret(created.key.id)).rejects.toMatchObject({
      status: 404,
    });
    expect(await store.acceptKey(created.secret)).toBe(false);
  });
  it("creates no record when encryption is unavailable or throws", async () => {
    const { dir } = await fixture();
    for (const bad of [
      { ...encryption, isAvailable: () => false },
      {
        ...encryption,
        encrypt: () => {
          throw new Error("private provider details");
        },
      },
    ]) {
      const store = new SecurityStore(dir, bad);
      await expect(store.createKey("failed")).rejects.toMatchObject({
        status: 503,
      });
      expect(await store.listKeys()).toEqual([]);
    }
  });
  it.each(["malformed", "provider", "hash"])(
    "fails closed for %s key corruption while other keys work",
    async (fault) => {
      const { dir, store } = await fixture();
      const bad = await store.createKey("bad");
      const good = await store.createKey("good");
      const path = join(dir, "security.json");
      const data = JSON.parse(await readFile(path, "utf8"));
      if (fault === "malformed") data.keys[0].encryptedSecret = "!!";
      if (fault === "provider") data.keys[0].encryptionId = "other-provider";
      if (fault === "hash") data.keys[0].hash = "0".repeat(64);
      await writeFile(path, JSON.stringify(data));
      const before = await readFile(path);
      await expect(store.getKeySecret(bad.key.id)).rejects.toMatchObject({
        status: 503,
      });
      expect(await readFile(path)).toEqual(before);
      expect(await store.getKeySecret(good.key.id)).toBe(good.secret);
    },
  );
  it("hides decrypt provider errors and preserves stored ciphertext", async () => {
    const { dir, store } = await fixture();
    const created = await store.createKey("provider failure");
    const path = join(dir, "security.json");
    const before = await readFile(path);
    const broken = new SecurityStore(dir, {
      ...encryption,
      decrypt: () => {
        throw new Error("private provider details");
      },
    });
    await expect(broken.getKeySecret(created.key.id)).rejects.toMatchObject({
      status: 503,
      code: "key_secret_unavailable",
    });
    expect(await readFile(path)).toEqual(before);
    expect(await store.getKeySecret(created.key.id)).toBe(created.secret);
  });
  it("expires opaque sessions and invalidates them on external password reset", async () => {
    const { dir, store } = await fixture();
    await store.setPassword("first long password");
    const session = await store.createSession();
    expect((await store.session(session.token))?.csrfToken).toBe(
      session.csrfToken,
    );
    expect(
      await store.session(session.token, Date.now() + 12 * 3600_000 + 1),
    ).toBeUndefined();
    const second = await store.createSession();
    await new SecurityStore(dir).setPassword("second long password");
    expect(await store.session(second.token)).toBeUndefined();
  });
  it("preserves keys during simultaneous independent-store reset and key creation", async () => {
    const { dir, store } = await fixture();
    await store.setPassword("original password long");
    const [created] = await Promise.all([
      store.createKey("parallel"),
      new SecurityStore(dir).setPassword("replacement password long"),
    ]);
    expect(await store.verifyPassword("replacement password long")).toBe(true);
    expect(await store.acceptKey(created.secret)).toBe(true);
  });
  it("does not let an old password login acquire the new password revision during reset", async () => {
    const { dir, store } = await fixture();
    await store.setPassword("original password long");
    const attempt = store.authenticate("original password long");
    await new SecurityStore(dir).setPassword("replacement password long");
    const session = await attempt;
    if (session) expect(await store.session(session.token)).toBeUndefined();
    expect(await store.authenticate("original password long")).toBeUndefined();
  });
});
