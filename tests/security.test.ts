import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecurityStore } from "../src/server/security.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "maple-security-"));
  dirs.push(dir);
  return { dir, store: new SecurityStore(dir) };
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
  it("shows an API key once and revokes its persisted digest", async () => {
    const { dir, store } = await fixture();
    const created = await store.createKey("editor");
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
