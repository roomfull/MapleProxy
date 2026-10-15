import { afterEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Keys, ActivityPanel, Accounts } from "../web/src/panels.js";
import type { Job } from "../web/src/types.js";
import { ApiClient } from "../web/src/api.js";
import { SignInController } from "../web/src/sign-in-controller.js";

const manualJob = {
  id: "fixture-job",
  status: "pending",
  createdAt: new Date().toISOString(),
  mode: "manual",
  phase: "awaiting_callback",
  expiresAt: new Date(Date.now() + 600000).toISOString(),
  options: { mode: "manual", profileId: "a", reconsent: true },
  authorizationUrl: "https://example.invalid/authorize?state=synthetic",
} as Job;
const accountHtml = (job?: Job, busy = "") =>
  renderToStaticMarkup(
    createElement(Accounts, {
      resource: {
        loading: false,
        data: [
          {
            id: "a",
            label: "合成账户",
            enabled: true,
            isDefault: true,
            status: "connected",
            sharing: true,
          },
        ],
      },
      busy,
      job,
      onSignIn() {},
      onRetry() {},
      onCancel() {},
      onAction() {},
      callbackUrl: "",
      onCallbackChange() {},
      onSubmitCallback() {},
    }),
  );
it("disables login and reauthorization controls while active recovery is pending", async () => {
  let finish!: (response: Response) => void;
  const controller = new SignInController(
    new ApiClient(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    ),
    () => {},
  );
  try {
    const recovery = controller.activate();
    const controls = () =>
      accountHtml(
        controller.state.job,
        controller.state.working ? "sign-in" : "",
      ).match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [];
    const pendingButtons = controls();
    finish(Response.json({ job: null }));
    await recovery;
    for (const label of [
      "Continue with ChatGPT",
      "远程登录",
      "重新授权",
      "远程重新授权",
    ]) {
      expect(pendingButtons.find((button) => button.includes(label))).toContain(
        'disabled=""',
      );
      expect(controls().find((button) => button.includes(label))).not.toContain(
        'disabled=""',
      );
    }
  } finally {
    controller.deactivate();
  }
});
it("offers separate manual login and reauthorization with full callback guidance", () => {
  const html = accountHtml(manualJob);
  for (const text of [
    "Continue with ChatGPT",
    "远程登录",
    "远程重新授权",
    "完整回调 URL",
    "地址栏",
    "10 分钟",
    "提交回调",
    "取消登录",
    "readOnly",
    "textarea",
    "https://example.invalid/authorize?state=synthetic",
  ])
    expect(html).toContain(text);
  expect(html).not.toContain("账号授权完成");
});
it.each([
  ["preparing", "正在准备授权"],
  ["exchanging", "正在交换授权"],
] as const)(
  "distinguishes %s from callback waiting and hides sensitive input",
  (phase, text) => {
    const html = accountHtml({
      ...manualJob,
      phase,
      authorizationUrl: undefined,
    });
    expect(html).toContain(text);
    expect(html).not.toContain("textarea");
    expect(html).not.toContain("账号授权完成");
  },
);
it("uses the browser deadline and only marks completed jobs as success", () => {
  expect(
    accountHtml({ ...manualJob, mode: "browser", authorizationUrl: undefined }),
  ).toContain("5 分钟");
  expect(
    accountHtml({
      ...manualJob,
      status: "completed",
      authorizationUrl: undefined,
    }),
  ).toContain("账号授权完成");
});
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
      onCopyKey() {},
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
          canCopy: true,
        },
      },
      onCreate() {},
      onRevoke() {},
      onCopy() {},
      onCopyKey() {},
      onDismiss() {},
    }),
  );
  const example = html.match(/<pre>([\s\S]*?)<\/pre>/)?.[1];
  expect(example).toBeDefined();
  expect(example).not.toContain(secret);
  expect(html.split(secret)).toHaveLength(2); // Only the separate show-once card.
  expect(example).toContain("Read-Host");
});

it("offers copy before revoke for retained keys and explains legacy keys", () => {
  vi.stubGlobal("location", { origin: "http://127.0.0.1:8317" });
  const html = renderToStaticMarkup(
    createElement(Keys, {
      resource: {
        loading: false,
        data: [
          {
            id: "saved",
            name: "saved",
            prefix: "mp_saved",
            createdAt: "2026-10-14T00:00:00Z",
            canCopy: true,
          },
          {
            id: "legacy",
            name: "legacy",
            prefix: "mp_legacy",
            createdAt: "2026-10-13T00:00:00Z",
            canCopy: false,
          },
        ],
      },
      busy: "",
      onCreate() {},
      onRevoke() {},
      onCopy() {},
      onCopyKey() {},
      onDismiss() {},
    }),
  );
  expect(html).toMatch(/saved[\s\S]*复制密钥[\s\S]*撤销/);
  expect(html).toContain("旧密钥未保存完整值，请新建密钥后复制。");
  expect(html).toMatch(/legacy[\s\S]*disabled=""[\s\S]*撤销/);
});

it("disables the pending key-copy button and updates creation guidance", () => {
  vi.stubGlobal("location", { origin: "http://127.0.0.1:8317" });
  const html = renderToStaticMarkup(
    createElement(Keys, {
      resource: {
        loading: false,
        data: [
          {
            id: "saved",
            name: "saved",
            prefix: "mp_saved",
            createdAt: "2026-10-14T00:00:00Z",
            canCopy: true,
          },
        ],
      },
      busy: "copy-key-saved",
      onCreate() {},
      onRevoke() {},
      onCopy() {},
      onCopyKey() {},
      onDismiss() {},
      created: {
        key: {
          id: "new",
          name: "new",
          prefix: "mp_new",
          createdAt: "2026-10-14T00:00:00Z",
          canCopy: true,
        },
        secret: "mp_fixture_secret",
      },
    }),
  );
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>复制中…<\/button>/);
  expect(html).toContain("密钥已创建，可随时从列表复制");
  expect(html).toContain("隐藏密钥");
  expect(html).not.toContain("仅显示这一次");
});
