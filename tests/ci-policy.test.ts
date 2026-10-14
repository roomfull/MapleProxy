import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const script = fileURLToPath(
  new URL("../.github/scripts/check-pr-target.mjs", import.meta.url),
);
function run(eventName: string, payload: unknown, raw = false) {
  const directory = mkdtempSync(join(tmpdir(), "maple-ci-policy-"));
  try {
    const eventPath = join(directory, "event.json");
    writeFileSync(eventPath, raw ? String(payload) : JSON.stringify(payload));
    return spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: eventName,
        GITHUB_EVENT_PATH: eventPath,
      },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
function pullRequest(base: string, head: string, fork = false) {
  return {
    pull_request: {
      base: { ref: base, repo: { full_name: "roomfull/MapleProxy" } },
      head: {
        ref: head,
        repo: {
          full_name: fork ? "contributor/MapleProxy" : "roomfull/MapleProxy",
        },
      },
    },
  };
}

it.each([
  ["develop", "roomfull/fix-login", false, true],
  ["develop", "fix-login", true, true],
  ["develop", "main", false, true],
  ["main", "develop", false, true],
  ["main", "develop", true, false],
  ["main", "roomfull/fix-login", false, false],
  ["main", "fix-login", true, false],
  ["other", "develop", false, false],
])("PR %s <- %s (fork=%s) allowed=%s", (base, head, fork, allowed) => {
  const result = run(
    "pull_request",
    pullRequest(base as string, head as string, fork as boolean),
  );
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(allowed ? 0 : 1);
  expect(result.stdout + result.stderr).toContain(
    allowed ? "allowed" : "rejected",
  );
});

it.each(["push", "workflow_dispatch"])(
  "%s does not require a PR payload",
  (event) => {
    const result = run(event, {});
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("not applicable");
  },
);

it.each([
  {},
  { pull_request: { base: { ref: "main" }, head: { ref: "develop" } } },
])("fails closed on incomplete pull request metadata: %j", (payload) => {
  const result = run("pull_request", payload);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("rejected");
});

it("fails closed on malformed event JSON without echoing the payload", () => {
  const result = run("pull_request", "private-invalid-event", true);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("rejected");
  expect(result.stderr).not.toContain("private-invalid-event");
});

it("rejects unexpected workflow event types", () => {
  const result = run("pull_request_target", pullRequest("main", "develop"));
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("rejected");
});
