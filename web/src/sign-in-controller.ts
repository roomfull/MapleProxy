import type { ApiClient } from "./api.js";
import type { Job, SignInRequest } from "./types.js";
export interface SignInState {
  job?: Job;
  callbackUrl: string;
  error?: string;
  updatedLink: boolean;
  submitting: boolean;
  working: boolean;
}
export class SignInController {
  state: SignInState = {
    callbackUrl: "",
    updatedLink: false,
    submitting: false,
    working: false,
  };
  constructor(
    private api: ApiClient,
    private changed: (state: SignInState) => void,
    private completed: () => void = () => {},
  ) {}
  private active = false;
  private epoch = 0;
  private revision = 0;
  private pollSequence = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private lastAuthorizationUrl?: string;
  private update(patch: Partial<SignInState>) {
    this.state = { ...this.state, ...patch };
    this.changed(this.state);
  }
  private valid(epoch: number, revision: number) {
    return this.active && this.epoch === epoch && this.revision === revision;
  }
  private apply(job?: Job) {
    const previous = this.state.job;
    const newJob = previous?.id !== job?.id;
    if (newJob) this.lastAuthorizationUrl = undefined;
    const rotated =
      !!job?.authorizationUrl &&
      !!this.lastAuthorizationUrl &&
      job.authorizationUrl !== this.lastAuthorizationUrl;
    if (job?.authorizationUrl) this.lastAuthorizationUrl = job.authorizationUrl;
    const clear =
      newJob ||
      rotated ||
      job?.phase !== "awaiting_callback" ||
      job.status !== "pending";
    this.update({
      job,
      ...(clear ? { callbackUrl: "", error: undefined } : {}),
      updatedLink:
        job?.status === "pending" &&
        (rotated || (!newJob && this.state.updatedLink)),
    });
    if (job?.status === "completed" && previous?.status !== "completed")
      this.completed();
  }
  async activate() {
    this.active = true;
    const epoch = ++this.epoch,
      revision = ++this.revision;
    // Do not let a new start invalidate recovery before we know the active job.
    this.update({ working: true, error: undefined });
    try {
      const { job } = await this.api.activeSignIn();
      if (!this.valid(epoch, revision)) return;
      this.apply(job ?? undefined);
      this.schedule(epoch, 1000);
    } catch (error) {
      if (this.valid(epoch, revision))
        this.update({
          error: `登录任务恢复失败：${(error as Error).message}。请刷新页面或重新登录后恢复。`,
        });
    } finally {
      if (this.valid(epoch, revision)) this.update({ working: false });
    }
  }
  deactivate() {
    this.active = false;
    this.epoch++;
    this.revision++;
    clearTimeout(this.timer);
    this.lastAuthorizationUrl = undefined;
    this.update({
      job: undefined,
      callbackUrl: "",
      error: undefined,
      updatedLink: false,
      submitting: false,
      working: false,
    });
  }
  private schedule(epoch: number, delay: number) {
    clearTimeout(this.timer);
    if (
      this.active &&
      this.epoch === epoch &&
      this.state.job?.status === "pending"
    )
      this.timer = setTimeout(() => void this.poll(epoch), delay);
  }
  private async poll(epoch: number) {
    const current = this.state.job,
      revision = this.revision;
    if (!this.active || this.epoch !== epoch || current?.status !== "pending")
      return;
    let delay = 1500;
    const sequence = ++this.pollSequence;
    try {
      const job = await this.api.signInStatus(current.id);
      // Snapshot reads during any mutation can predate its server-side acceptance.
      if (
        this.valid(epoch, revision) &&
        sequence === this.pollSequence &&
        !this.state.working
      )
        this.apply(job);
    } catch (error) {
      if (
        this.valid(epoch, revision) &&
        sequence === this.pollSequence &&
        !this.state.working
      )
        this.update({ error: `登录状态读取失败：${(error as Error).message}` });
      delay = 3000;
    } finally {
      // Ignoring a stale response must not stop polling the active task.
      this.schedule(epoch, delay);
    }
  }
  async start(options: SignInRequest) {
    if (
      !this.active ||
      this.state.working ||
      this.state.job?.status === "pending"
    )
      return;
    const epoch = this.epoch,
      revision = ++this.revision;
    clearTimeout(this.timer);
    this.apply(undefined);
    this.update({ working: true, error: undefined });
    try {
      const job = await this.api.startSignIn(options);
      if (this.valid(epoch, revision)) this.apply(job);
    } catch (error) {
      if (this.valid(epoch, revision))
        this.update({ error: (error as Error).message });
    } finally {
      if (this.valid(epoch, revision)) {
        this.revision++;
        this.update({ working: false });
        this.schedule(epoch, 1000);
      }
    }
  }
  async submit() {
    const job = this.state.job;
    if (
      !this.active ||
      this.state.working ||
      !this.state.callbackUrl.trim() ||
      job?.status !== "pending" ||
      job.mode !== "manual" ||
      job.phase !== "awaiting_callback"
    )
      return;
    const epoch = this.epoch,
      revision = ++this.revision;
    this.update({ submitting: true, working: true });
    try {
      const accepted = await this.api.submitSignInCallback(
        job.id,
        this.state.callbackUrl,
      );
      if (this.valid(epoch, revision)) this.apply(accepted);
    } catch (error) {
      if (this.valid(epoch, revision))
        this.update({ error: (error as Error).message });
    } finally {
      // Invalidate reads started while POST was in flight as well as earlier reads.
      if (this.valid(epoch, revision)) {
        this.revision++;
        this.update({ submitting: false, working: false });
        this.schedule(epoch, 1500);
      }
    }
  }
  async cancel() {
    const job = this.state.job;
    if (!this.active || this.state.working || job?.status !== "pending") return;
    const epoch = this.epoch,
      revision = ++this.revision;
    this.update({ working: true, callbackUrl: "", error: undefined });
    try {
      const cancelled = await this.api.cancelSignIn(job.id);
      if (this.valid(epoch, revision)) this.apply(cancelled);
    } catch (error) {
      if (this.valid(epoch, revision))
        this.update({ error: (error as Error).message });
    } finally {
      if (this.valid(epoch, revision)) {
        this.revision++;
        this.update({ working: false });
        this.schedule(epoch, 1000);
      }
    }
  }
  async retry() {
    if (this.state.job && this.state.job.status !== "pending")
      await this.start(this.state.job.options);
  }
  setCallback(value: string) {
    if (
      this.active &&
      !this.state.working &&
      this.state.job?.status === "pending" &&
      this.state.job.phase === "awaiting_callback"
    )
      this.update({ callbackUrl: value });
  }
}
