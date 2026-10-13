import { expect, it } from "vitest";
import { startSmokeFixture, smokePassword } from "../scripts/smoke-fixture.js";

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
      "success",
    ]);
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
