import { expect, it, vi } from "vitest";
import * as progress from "../web/src/SignInProgress.js";
it("selects the authorization URL for manual copy if the clipboard rejects and never reports success", async () => {
  expect(typeof progress.copyAuthorizationUrl).toBe("function");
  const select = vi.fn(),
    denied = vi.fn(async () => {
      throw new Error("clipboard denied");
    });
  const message = await progress.copyAuthorizationUrl(
    "https://example.invalid/synthetic",
    denied,
    select,
  );
  expect(select).toHaveBeenCalledOnce();
  expect(message).toContain("Ctrl+C");
  expect(message).not.toContain("已复制");
  const write = vi.fn(async () => {});
  expect(
    await progress.copyAuthorizationUrl(
      "https://example.invalid/synthetic",
      write,
      select,
    ),
  ).toBe("授权链接已复制。");
  expect(write).toHaveBeenCalledWith("https://example.invalid/synthetic");
});
