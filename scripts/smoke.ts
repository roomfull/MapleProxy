// Explicitly test-only: isolated temporary data and synthetic accounts, no provider access.
import { createInterface } from "node:readline";
import { startSmokeFixture } from "./smoke-fixture.js";

const fixture = await startSmokeFixture();
console.log(`Isolated fixture: ${fixture.url}`);
console.log(
  "Commands on stdin: callback / retry / fail (print synthetic callback), rotate (new synthetic link), complete (finish browser-mode job), seed (add safe activity), stop (close and remove temporary data).",
);
const input = createInterface({ input: process.stdin });
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  input.close();
  await fixture.close();
}
input.on("line", (line) => {
  if (line.trim() === "stop") void stop();
  else if (line.trim() === "seed")
    void fixture.seed().catch(() => console.error("Fixture seed failed."));
  else if (["callback", "retry", "fail"].includes(line.trim())) {
    try {
      console.log(
        fixture.callback(
          line.trim() === "retry"
            ? "retry"
            : line.trim() === "fail"
              ? "fail"
              : "success",
        ),
      );
    } catch {
      console.log("Start a synthetic login first.");
    }
  } else if (line.trim() === "rotate") fixture.rotate();
  else if (line.trim() === "complete") fixture.complete();
});
process.once("SIGINT", () => {
  void stop();
});
process.once("SIGTERM", () => {
  void stop();
});
