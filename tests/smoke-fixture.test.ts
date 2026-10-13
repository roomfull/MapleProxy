import { expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as server from "../src/server/app.js";
import { SecurityStore } from "../src/server/security.js";
import { startSmokeFixture, smokePassword } from "../scripts/smoke-fixture.js";
vi.mock("node:fs/promises", { spy: true });

it.each(["password", "app"])(
  "removes owned synthetic temp data when %s initialization fails",
  async (stage) => {
    let owned!: string;
    const { mkdtemp: realMkdtemp } =
      await vi.importActual<typeof fs>("node:fs/promises");
    const directory = vi
      .spyOn(fs, "mkdtemp")
      .mockImplementation(async (prefix, options) => {
        owned = (await realMkdtemp(prefix, options)) as string;
        return owned;
      });
    const failure =
      stage === "password"
        ? vi
            .spyOn(SecurityStore.prototype, "setPassword")
            .mockRejectedValue(new Error("synthetic startup failure"))
        : vi
            .spyOn(server, "createApp")
            .mockRejectedValue(new Error("synthetic startup failure"));
    try {
      await expect(startSmokeFixture()).rejects.toThrow(
        "synthetic startup failure",
      );
      await expect(fs.stat(owned)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      directory.mockRestore();
      failure.mockRestore();
      if (owned) await fs.rm(owned, { recursive: true, force: true });
    }
  },
);

it("starts an isolated browser fixture, seeds activity through HTTP, and closes its listener", async () => {
  const fixture = await startSmokeFixture();
  try {
    const login = await fetch(`${fixture.url}/api/admin/login`, {
      method: "POST",
      headers: { origin: fixture.url, "content-type": "application/json" },
      body: JSON.stringify({ password: smokePassword }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const headers = { cookie };
    const accounts = await fetch(`${fixture.url}/api/admin/accounts`, {
      headers,
    });
    expect((await accounts.json()).accounts).toHaveLength(2);
    const activity = await fetch(`${fixture.url}/api/admin/requests`, {
      headers,
    });
    const rows = (await activity.json()).requests;
    expect(rows.map((r: { result: string }) => r.result).sort()).toEqual([
      "error",
      "error",
      "incomplete",
      "success",
    ]);
    expect(rows).toContainEqual(
      expect.objectContaining({
        result: "error",
        stage: "validation",
        httpStatus: 400,
        code: "unsupported_parameter",
        param: "n",
        upstreamCalled: false,
        diagnostics: expect.arrayContaining([
          {
            path: "messages[0].startsNewUserRequest",
            action: "filtered",
            reason: "client_metadata",
          },
        ]),
      }),
    );
    expect(rows).toContainEqual(
      expect.objectContaining({
        result: "incomplete",
        responseStatus: "incomplete",
        httpStatus: 200,
        incompleteReason: "max_output_tokens",
        upstreamCalled: true,
        upstreamRequestId: "upstream-fixture-incomplete",
      }),
    );
    for (const row of rows) {
      expect(row.localRequestId).toMatch(/^[a-f0-9-]{36}$/);
      expect(row.requestId).toBe(row.upstreamRequestId ?? row.localRequestId);
    }
    expect(JSON.stringify(rows)).not.toMatch(
      /"fixture-(success|failure|incomplete|validation)"/,
    );
    expect(
      rows.some((r: { ignored: string[] }) =>
        r.ignored.includes("temperature"),
      ),
    ).toBe(true);
    const keys = await fetch(`${fixture.url}/api/admin/keys`, { headers });
    expect((await keys.json()).keys).toHaveLength(0);
  } finally {
    await fixture.close();
  }
  await expect(fetch(fixture.url)).rejects.toThrow();
});
