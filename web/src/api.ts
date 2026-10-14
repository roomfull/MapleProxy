import type { Job, SignInRequest } from "./types.js";
export interface SessionView {
  configured: boolean;
  authenticated: boolean;
  csrfToken?: string;
}
export class ApiClient {
  private csrfToken?: string;
  private authGeneration = 0;
  onExpired?: () => void;
  constructor(
    private readonly fetcher: (
      input: string,
      init: RequestInit,
    ) => Promise<Response> = (input, init) => globalThis.fetch(input, init),
  ) {}
  async session(): Promise<SessionView> {
    const generation = this.authGeneration;
    const session = await this.request<SessionView>("/session");
    if (generation === this.authGeneration) this.csrfToken = session.csrfToken;
    return session;
  }
  async login(password: string): Promise<SessionView> {
    const generation = ++this.authGeneration;
    const session = await this.request<SessionView>("/login", "POST", {
      password,
    });
    if (generation === this.authGeneration) this.csrfToken = session.csrfToken;
    return session;
  }
  async logout(): Promise<void> {
    this.authGeneration++;
    // Capture the authenticated headers before clearing transient session state.
    const logout = this.request("/logout", "POST");
    this.csrfToken = undefined;
    await logout;
  }
  async copyKeyToClipboard(
    id: string,
    writeText: (value: string) => Promise<void>,
  ): Promise<void> {
    const { secret } = await this.request<{ secret: string }>(
      `/keys/${encodeURIComponent(id)}/secret`,
      "POST",
    );
    await writeText(secret);
  }
  startSignIn(options: SignInRequest): Promise<Job> {
    return this.request("/sign-in", "POST", options);
  }
  activeSignIn(): Promise<{ job: Job | null }> {
    return this.request("/sign-in/active");
  }
  signInStatus(id: string): Promise<Job> {
    return this.request(`/sign-in/${encodeURIComponent(id)}`);
  }
  submitSignInCallback(id: string, callbackUrl: string): Promise<Job> {
    return this.request(`/sign-in/${encodeURIComponent(id)}/callback`, "POST", {
      callbackUrl,
    });
  }
  cancelSignIn(id: string): Promise<Job> {
    return this.request(`/sign-in/${encodeURIComponent(id)}`, "DELETE");
  }
  async request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const generation = this.authGeneration;
    const headers = new Headers();
    if (body !== undefined) headers.set("content-type", "application/json");
    if (method !== "GET" && this.csrfToken)
      headers.set("x-csrf-token", this.csrfToken);
    const response = await this.fetcher(`/api/admin${path}`, {
      method,
      headers,
      credentials: "same-origin",
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (response.status === 204) return undefined as T;
    const data = await response.json();
    if (!response.ok) {
      if (
        response.status === 401 &&
        data.error?.code === "admin_unauthorized" &&
        path !== "/login" &&
        generation === this.authGeneration
      ) {
        this.csrfToken = undefined;
        this.authGeneration++;
        this.onExpired?.();
      }
      throw new Error(data.error?.message ?? `请求失败 (${response.status})`);
    }
    return data as T;
  }
}
