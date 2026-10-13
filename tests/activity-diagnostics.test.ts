import { expect, it } from "vitest";
import { ActivityLog } from "../src/server/activity.js";
import { normalizeRequest } from "../src/protocol/normalize.js";
import { errorEnvelope } from "../src/server/app.js";
import { AppError } from "../src/shared/errors.js";

it("keeps bracket-aware error paths while rejecting unsafe or unbounded paths", () => {
  expect(
    errorEnvelope(
      new AppError(
        400,
        "invalid_request",
        "invalid",
        "messages[2].reasoning_content",
      ),
      "local",
    ).error.param,
  ).toBe("messages[2].reasoning_content");
  for (const path of [
    "messages[2].secret\nvalue",
    "messages[2]." + "x".repeat(65),
  ])
    expect(
      errorEnvelope(
        new AppError(400, "invalid_request", "invalid", path),
        "local",
      ).error.param,
    ).toBeNull();
});

it("bounds collected diagnostics and omits unsafe or oversized arbitrary client keys", () => {
  const fields = Object.fromEntries(
    Array.from({ length: 300 }, (_, i) => [`client_${i}`, "private value"]),
  );
  const normalized = normalizeRequest(
    {
      model: "synthetic",
      messages: [
        {
          role: "user",
          content: "private prompt",
          ["x".repeat(10000)]: "private value",
          "bad\nkey": "private value",
          ...fields,
        },
      ],
    },
    "chat",
  );
  expect(normalized.diagnostics).toHaveLength(100);
  expect(
    normalized.diagnostics.every((entry) => entry.path.length <= 512),
  ).toBe(true);
  expect(JSON.stringify(normalized.diagnostics)).not.toContain("private");
  expect(JSON.stringify(normalized.diagnostics)).not.toContain("x".repeat(65));
  expect(JSON.stringify(normalized.diagnostics)).not.toContain("bad");
});

it("retains only 200 defensive copies of bounded metadata", () => {
  const log = new ActivityLog();
  const diagnostic = {
    path: "messages[2].reasoning_content",
    action: "filtered" as const,
    reason: "client_metadata" as const,
  };
  for (let i = 0; i < 205; i++)
    log.add({
      requestId: String(i),
      format: "chat",
      time: "2026-10-14T00:00:00Z",
      durationMs: 1,
      result: "error",
      ignored: [],
      diagnostics: [diagnostic],
      privatePrompt: "never stored",
    } as any);
  const entries = log.list();
  expect(entries).toHaveLength(200);
  expect(entries.at(-1)?.requestId).toBe("5");
  expect(JSON.stringify(entries)).not.toContain("never stored");
  (entries[0] as any).diagnostics[0].path = "modified";
  diagnostic.path = "also modified";
  expect((log.list()[0] as any).diagnostics[0].path).toBe(
    "messages[2].reasoning_content",
  );
});
