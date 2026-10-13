import { expect, it, vi } from "vitest";
import { getEventListeners } from "node:events";
import { withSseHeartbeat } from "../src/server/streaming.js";

it("retains exactly one pending next across heartbeats and handles a late rejection on abort", async () => {
  const controller = new AbortController();
  let calls = 0,
    active = false,
    returned = false;
  let rejectRead!: (error: Error) => void;
  const source: AsyncIterable<string> = {
    [Symbol.asyncIterator]: () => ({
      next: () => {
        calls++;
        if (calls === 1)
          return Promise.resolve({ done: false as const, value: "first" });
        expect(active).toBe(false);
        active = true;
        return new Promise<IteratorResult<string>>((_resolve, reject) => {
          rejectRead = reject;
        });
      },
      return: async () => {
        returned = true;
        return { done: true as const, value: undefined };
      },
    }),
  };
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const stream = withSseHeartbeat(source, controller.signal);
  try {
    expect((await stream.next()).value).toBe("first");
    for (let i = 0; i < 2; i++) {
      const next = stream.next();
      await vi.advanceTimersByTimeAsync(14999);
      expect(calls).toBe(2);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect((await next).value).toBe(": heartbeat\n\n");
    }
    const cancelling = stream.next();
    const rejected = expect(cancelling).rejects.toThrow("Client disconnected");
    controller.abort();
    await rejected;
    rejectRead(new Error("late upstream rejection"));
    await Promise.resolve();
    expect(calls).toBe(2);
    expect(returned).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  } finally {
    controller.abort();
    vi.useRealTimers();
  }
});
