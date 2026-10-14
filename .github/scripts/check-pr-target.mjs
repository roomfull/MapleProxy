import { readFile } from "node:fs/promises";

try {
  const eventName = process.env.GITHUB_EVENT_NAME;
  if (eventName === "push" || eventName === "workflow_dispatch") {
    console.log("PR target check not applicable to this event.");
  } else {
    if (eventName !== "pull_request") throw new Error("Unsupported event.");
    const event = JSON.parse(
      await readFile(process.env.GITHUB_EVENT_PATH, "utf8"),
    );
    const base = event.pull_request?.base;
    const head = event.pull_request?.head;
    if (
      ![
        base?.ref,
        head?.ref,
        base?.repo?.full_name,
        head?.repo?.full_name,
      ].every((value) => typeof value === "string" && value.trim().length > 0)
    )
      throw new Error("Incomplete PR metadata.");
    const isRelease =
      base.ref === "main" &&
      head.ref === "develop" &&
      head.repo.full_name.toLowerCase() === base.repo.full_name.toLowerCase();
    if (base.ref !== "develop" && !isRelease)
      throw new Error("Invalid PR target.");
    console.log("PR target allowed.");
  }
} catch {
  console.error(
    "PR target rejected. Target develop for development; main accepts only develop from the same repository. Valid pull_request metadata is required.",
  );
  process.exitCode = 1;
}
