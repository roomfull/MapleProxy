import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { SecurityStore } from "../src/server/security.js";
import { createApp } from "../src/server/app.js";
import type { AccountRuntime } from "../src/auth/runtime.js";

it("flushes SSE incrementally and aborts upstream when a real HTTP client disconnects", async () => {
  const dir = await mkdtemp(join(tmpdir(), "maple-socket-"));
  const secret = (await new SecurityStore(dir).createKey("socket")).secret;
  let abort!: () => void;
  const aborted = new Promise<void>((resolve) => {
    abort = resolve;
  });
  const runtime = {
    requestResponses: async ({ signal }: { signal: AbortSignal }) => {
      signal.addEventListener("abort", abort, { once: true });
      return {
        status: 200,
        profileId: "a",
        headers: new Headers(),
        events: (async function* () {
          yield {
            type: "response.created",
            response: { id: "r", status: "in_progress" },
          };
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
        })(),
      };
    },
  } as unknown as AccountRuntime;
  const app = await createApp({ runtime, dataDir: dir, port: 0 });
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address() as { port: number };
    const chunk = await new Promise<string>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: address.port,
          path: "/v1/responses",
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${secret}`,
          },
        },
        (response) => {
          response.once("data", (data) => {
            resolve(data.toString());
            response.destroy();
          });
        },
      );
      req.on("error", reject);
      req.end(
        JSON.stringify({ model: "test-model", input: "x", stream: true }),
      );
    });
    expect(chunk).toContain("event: response.created");
    await Promise.race([
      aborted,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("abort timeout")), 2000).unref(),
      ),
    ]);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
