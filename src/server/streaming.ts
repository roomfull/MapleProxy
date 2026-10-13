import type { ServerResponse } from "node:http";
import { AppError } from "../shared/errors.js";

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof AppError
    ? signal.reason
    : new Error("Client disconnected");
}

const heartbeatMs = 15_000;
type ReadResult =
  | { kind: "read"; value: IteratorResult<string> }
  | { kind: "error"; error: unknown };

/** One upstream read survives heartbeats; each wait owns and clears its timer/listener. */
async function waitForRead(
  pending: Promise<ReadResult>,
  signal: AbortSignal,
  idleMs?: number,
): Promise<ReadResult | { kind: "heartbeat" }> {
  if (signal.aborted) throw abortError(signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let aborted!: () => void;
  const wake = new Promise<{ kind: "heartbeat" }>((resolve, reject) => {
    aborted = () => reject(abortError(signal));
    signal.addEventListener("abort", aborted, { once: true });
    if (idleMs !== undefined)
      timer = setTimeout(() => resolve({ kind: "heartbeat" }), idleMs);
    if (signal.aborted) aborted();
  });
  try {
    return await Promise.race([pending, wake]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal.removeEventListener("abort", aborted);
  }
}

/** No heartbeat/HTTP commitment until the renderer produces its first frame. */
export async function* withSseHeartbeat(
  source: AsyncIterable<string>,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const iterator = source[Symbol.asyncIterator]();
  let pending: Promise<ReadResult> | undefined, lastOutput: number | undefined;
  try {
    while (true) {
      if (signal.aborted) throw abortError(signal);
      pending ??= Promise.resolve()
        .then(() => iterator.next())
        .then(
          (value) => ({ kind: "read", value }) as const,
          (error) => ({ kind: "error", error }) as const,
        );
      const result = await waitForRead(
        pending,
        signal,
        lastOutput === undefined
          ? undefined
          : Math.max(0, lastOutput + heartbeatMs - Date.now()),
      );
      if (result.kind === "error") throw result.error;
      if (result.kind === "read") {
        pending = undefined;
        if (result.value.done) return;
        lastOutput = Date.now();
        yield result.value.value;
      } else {
        lastOutput = Date.now();
        yield ": heartbeat\n\n";
      }
    }
  } finally {
    // A generator's return queues behind a pending next. The request owner aborts
    // upstream; do not block cancellation waiting for that queued return.
    try {
      void Promise.resolve(iterator.return?.()).catch(() => {});
    } catch {
      /* already closed */
    }
  }
}

export async function writeChunk(
  response: ServerResponse,
  chunk: string,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted || response.destroyed) throw abortError(signal);
  if (response.write(chunk)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      response.off("drain", drained);
      response.off("close", closed);
      response.off("error", failed);
      signal.removeEventListener("abort", closed);
    };
    const drained = () => {
      cleanup();
      resolve();
    };
    const closed = () => {
      cleanup();
      reject(abortError(signal));
    };
    const failed = (error: Error) => {
      cleanup();
      reject(error);
    };
    response.once("drain", drained);
    response.once("close", closed);
    response.once("error", failed);
    signal.addEventListener("abort", closed, { once: true });
    if (signal.aborted || response.destroyed) closed();
  });
}
