import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { SecurityStore } from "../src/server/security.js";
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
it("initializes via password stdin, requires deliberate reset and never echoes secrets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "maple-setup-"));
  dirs.push(dir);
  const run = (args: string[], password: string) =>
    spawnSync(
      process.execPath,
      [resolve("node_modules/tsx/dist/cli.mjs"), "scripts/setup.ts", ...args],
      {
        env: { ...process.env, MAPLEPROXY_DATA_DIR: dir },
        input: `${password}\n`,
        encoding: "utf8",
      },
    );
  const first = run(["--password-stdin"], "first private password");
  expect(first.status).toBe(0);
  expect(first.stdout + first.stderr).not.toContain("first private password");
  const store = new SecurityStore(dir),
    session = await store.createSession();
  expect(run(["--password-stdin"], "second private password").status).toBe(1);
  expect(await store.verifyPassword("first private password")).toBe(true);
  expect(
    run(["--reset", "--password-stdin"], "second private password").status,
  ).toBe(0);
  expect(await store.session(session.token)).toBeUndefined();
  expect(await store.verifyPassword("second private password")).toBe(true);
}, 15000);
