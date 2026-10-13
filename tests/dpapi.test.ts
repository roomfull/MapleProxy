import { expect, test } from "vitest";
import { createDpapiEncryption } from "../src/auth/dpapi.js";
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
