import { afterEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Keys, ActivityPanel } from "../web/src/panels.js";
afterEach(() => vi.unstubAllGlobals());
it("renders diagnostic details and incomplete outcomes alongside older activity entries", () => {
  const html = renderToStaticMarkup(
    createElement(ActivityPanel, {
      resource: {
        loading: false,
        data: [
          {
            requestId: "upstream-id",
            localRequestId: "local-id",
            upstreamRequestId: "upstream-id",
            model: "synthetic",
            format: "chat",
            time: "2026-10-14T00:00:00Z",
            durationMs: 1,
            result: "incomplete",
            ignored: [],
            stage: "response",
            httpStatus: 200,
            upstreamCalled: true,
            incompleteReason: "max_output_tokens",
            diagnostics: [
              {
                path: "messages[2].reasoning_content",
                action: "filtered",
                reason: "client_metadata",
              },
            ],
          },
          {
            requestId: "old-id",
            format: "responses",
            time: "2026-10-14T00:00:00Z",
            durationMs: 1,
            result: "error",
            ignored: [],
          },
        ],
      },
    }),
  );
  for (const text of [
    "未完整完成",
    "local-id",
    "upstream-id",
    "response",
    "200",
    "max_output_tokens",
    "messages[2].reasoning_content",
    "client_metadata",
    "filtered",
    "old-id",
    "进入上游调用流程",
  ])
    expect(html).toContain(text);
});
it("renders a PowerShell example that reads credentials inside the process", () => {
  vi.stubGlobal("location", { origin: "http://127.0.0.1:8317" });
  const html = renderToStaticMarkup(
    createElement(Keys, {
      resource: { data: [], loading: false },
      busy: "",
      model: "model-test",
      onCreate() {},
      onRevoke() {},
      onCopy() {},
      onDismiss() {},
    }),
  );
  expect(html).toContain("http://127.0.0.1:8317/v1/responses");
  expect(html).toContain("Read-Host");
  expect(html).toContain("-AsSecureString");
  expect(html).toContain("Invoke-RestMethod");
  expect(html).not.toContain("curl ");
  expect(html).not.toContain("-H &quot;Authorization:");
});
it("keeps show-once secrets out of the rendered and copied request example", () => {
  vi.stubGlobal("location", { origin: "http://127.0.0.1:8317" });
  const secret = "mp_fixture_show_once_secret";
  const html = renderToStaticMarkup(
    createElement(Keys, {
      resource: { data: [], loading: false },
      busy: "",
      model: "model-test",
      created: {
        secret,
        key: {
          id: "key-fixture",
          name: "editor",
          prefix: "mp_fixture",
          createdAt: "2026-10-13T00:00:00Z",
        },
      },
      onCreate() {},
      onRevoke() {},
      onCopy() {},
      onDismiss() {},
    }),
  );
  const example = html.match(/<pre>([\s\S]*?)<\/pre>/)?.[1];
  expect(example).toBeDefined();
  expect(example).not.toContain(secret);
  expect(html.split(secret)).toHaveLength(2); // Only the separate show-once card.
  expect(example).toContain("Read-Host");
});
