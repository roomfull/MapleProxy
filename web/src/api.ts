export interface SessionView {
  configured: boolean;
  authenticated: boolean;
  csrfToken?: string;
}
export class ApiClient {
  private csrfToken?: string;
  onExpired?: () => void;
  constructor(
    private readonly fetcher: (
      input: string,
      init: RequestInit,
    ) => Promise<Response> = (input, init) => globalThis.fetch(input, init),
  ) {}
  async session(): Promise<SessionView> {
    const session = await this.request<SessionView>("/session");
    this.csrfToken = session.csrfToken;
    return session;
  }
  async login(password: string): Promise<SessionView> {
    const session = await this.request<SessionView>("/login", "POST", {
      password,
    });
    this.csrfToken = session.csrfToken;
    return session;
  }
  async logout(): Promise<void> {
    await this.request("/logout", "POST");
    this.csrfToken = undefined;
  }
  async request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
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
      if (response.status === 401 && path !== "/login") {
        this.csrfToken = undefined;
        this.onExpired?.();
      }
      throw new Error(data.error?.message ?? `请求失败 (${response.status})`);
    }
    return data as T;
  }
}
