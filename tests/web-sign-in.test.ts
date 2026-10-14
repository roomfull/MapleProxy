import { afterEach, expect, it, vi } from "vitest";
import { ApiClient } from "../web/src/api.js";
import { SignInController } from "../web/src/sign-in-controller.js";
import type { Job } from "../web/src/types.js";
const job = (changes: Partial<Job> = {}): Job => ({
  id: "job1",
  status: "pending",
  createdAt: "2026-10-14T00:00:00Z",
  mode: "manual",
  expiresAt: "2026-10-14T00:10:00Z",
  phase: "awaiting_callback",
  options: { mode: "manual", profileId: "a", reconsent: true },
  authorizationUrl: "https://example.invalid/authorize?state=first",
  ...changes,
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
afterEach(() => {
  vi.useRealTimers();
});
it("restores an active job, keeps invalid callback editable and blocks duplicate submit synchronously", async () => {
  const accepted = deferred<Response>();
  let submits = 0;
  const client = new ApiClient(async (url) => {
    if (url.endsWith("/active")) return Response.json({ job: job() });
    if (url.endsWith("/callback")) {
      submits++;
      return submits === 1
        ? Response.json(
            { error: { message: "回调地址无效，请检查后重试。" } },
            { status: 400 },
          )
        : accepted.promise;
    }
    return Response.json(job());
  });
  const controller = new SignInController(client, () => {});
  await controller.activate();
  expect(controller.state.job).toEqual(job());
  controller.setCallback("wrong URL");
  await controller.submit();
  expect(controller.state.callbackUrl).toBe("wrong URL");
  expect(controller.state.error).toContain("回调地址无效");
  controller.setCallback("corrected URL");
  expect(controller.state.error).toContain("回调地址无效");
  const first = controller.submit();
  const second = controller.submit();
  expect(submits).toBe(2);
  expect(controller.state.submitting).toBe(true);
  accepted.resolve(
    Response.json(job({ phase: "exchanging", authorizationUrl: undefined })),
  );
  await Promise.all([first, second]);
  expect(controller.state.callbackUrl).toBe("");
  expect(controller.state.job?.phase).toBe("exchanging");
  controller.deactivate();
});
it("invalidates polling at both callback start and completion, and keeps ignored polls alive", async () => {
  vi.useFakeTimers();
  const before = deferred<Response>(),
    during = deferred<Response>(),
    callback = deferred<Response>();
  let reads = 0;
  const client = new ApiClient(async (url) => {
    if (url.endsWith("/active")) return Response.json({ job: job() });
    if (url.endsWith("/callback")) return callback.promise;
    reads++;
    return reads === 1
      ? before.promise
      : reads === 2
        ? during.promise
        : Response.json(
            job({ phase: "exchanging", authorizationUrl: undefined }),
          );
  });
  const controller = new SignInController(client, () => {});
  await controller.activate();
  await vi.advanceTimersByTimeAsync(1000);
  controller.setCallback("synthetic callback");
  const submission = controller.submit();
  before.resolve(Response.json(job()));
  await vi.advanceTimersByTimeAsync(1500);
  expect(reads).toBe(2);
  callback.resolve(
    Response.json(job({ phase: "exchanging", authorizationUrl: undefined })),
  );
  await submission;
  during.resolve(Response.json(job()));
  await vi.advanceTimersByTimeAsync(1500);
  expect(controller.state.job?.phase).toBe("exchanging");
  expect(controller.state.job?.authorizationUrl).toBeUndefined();
  expect(reads).toBe(3);
  controller.deactivate();
});
it("an overlapping older status response cannot overwrite a newer rotated link", async () => {
  vi.useFakeTimers();
  const before = deferred<Response>(),
    older = deferred<Response>();
  let reads = 0;
  const client = new ApiClient(async (url) => {
    if (url.endsWith("/active")) return Response.json({ job: job() });
    if (url.endsWith("/callback"))
      return Response.json(
        job({ phase: "exchanging", authorizationUrl: undefined }),
      );
    reads++;
    return reads === 1
      ? before.promise
      : reads === 2
        ? older.promise
        : Response.json(
            job({
              authorizationUrl:
                "https://example.invalid/authorize?state=rotated",
            }),
          );
  });
  const controller = new SignInController(client, () => {});
  await controller.activate();
  await vi.advanceTimersByTimeAsync(1000);
  controller.setCallback("synthetic callback");
  await controller.submit();
  await vi.advanceTimersByTimeAsync(1500); // Second read is newer than submission.
  before.resolve(Response.json(job()));
  await vi.advanceTimersByTimeAsync(1500); // Third read returns rotated URL.
  expect(controller.state.job?.authorizationUrl).toContain("rotated");
  older.resolve(
    Response.json(job({ phase: "exchanging", authorizationUrl: undefined })),
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(controller.state.job?.authorizationUrl).toContain("rotated");
  controller.deactivate();
});
it("clears callback on link rotation and terminal status and retries the original job options", async () => {
  vi.useFakeTimers();
  let reads = 0;
  const calls: RequestInit[] = [];
  const client = new ApiClient(async (url, init) => {
    if (url.endsWith("/active")) return Response.json({ job: job() });
    if (url.endsWith("/sign-in")) {
      calls.push(init);
      return Response.json(job({ id: "job2" }));
    }
    reads++;
    return Response.json(
      reads === 1
        ? job({
            authorizationUrl: "https://example.invalid/authorize?state=second",
          })
        : job({
            status: "failed",
            code: "synthetic",
            authorizationUrl: undefined,
          }),
    );
  });
  const controller = new SignInController(client, () => {});
  await controller.activate();
  controller.setCallback("old callback");
  await vi.advanceTimersByTimeAsync(1000);
  expect(controller.state.updatedLink).toBe(true);
  expect(controller.state.callbackUrl).toBe("");
  controller.setCallback("new callback");
  await vi.advanceTimersByTimeAsync(1500);
  expect(controller.state.callbackUrl).toBe("");
  await controller.retry();
  expect(JSON.parse(calls[0]!.body as string)).toEqual(job().options);
  controller.deactivate();
});
it("ignores late restore after starting a newer job", async () => {
  const restored = deferred<Response>();
  const client = new ApiClient(async (url) =>
    url.endsWith("/active")
      ? restored.promise
      : Response.json(job({ id: "job2" })),
  );
  const controller = new SignInController(client, () => {});
  const recovery = controller.activate();
  await controller.start({ mode: "manual", newProfile: true });
  restored.resolve(Response.json({ job: job() }));
  await recovery;
  expect(controller.state.job?.id).toBe("job2");
  controller.deactivate();
});
it.each(["restore", "start", "submit", "cancel", "poll"])(
  "ignores late %s after logout and can recover on relogin",
  async (operation) => {
    vi.useFakeTimers();
    const late = deferred<Response>();
    let hold = operation === "restore";
    const client = new ApiClient(async (url) => {
      if (hold) return late.promise;
      return Response.json(
        url.endsWith("/active")
          ? { job: operation === "start" ? null : job() }
          : job(),
      );
    });
    const controller = new SignInController(client, () => {});
    const activation = controller.activate();
    if (operation !== "restore") await activation;
    hold = true;
    let pending: Promise<void> | undefined;
    if (operation === "start")
      pending = controller.start({ mode: "manual", newProfile: true });
    if (operation === "submit") {
      controller.setCallback("private synthetic callback");
      pending = controller.submit();
    }
    if (operation === "cancel") pending = controller.cancel();
    if (operation === "poll") await vi.advanceTimersByTimeAsync(1000);
    controller.deactivate();
    late.resolve(
      Response.json(
        operation === "restore" ? { job: job() } : job({ status: "completed" }),
      ),
    );
    await activation;
    await pending;
    expect(controller.state.job).toBeUndefined();
    expect(controller.state.callbackUrl).toBe("");
    hold = false;
    await controller.activate();
    expect(controller.state.job?.id).toBe(
      operation === "start" ? undefined : "job1",
    );
    controller.deactivate();
  },
);
