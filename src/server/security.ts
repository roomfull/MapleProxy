import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import { AppError } from "../shared/errors.js";
import { JsonStore } from "./store.js";

const derive = promisify(scrypt);
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const random = () => randomBytes(32).toString("base64url");
const equal = (a: string, b: string) => {
  const left = Buffer.from(a, "hex"),
    right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
};
export interface KeyView {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
}
interface SecurityData {
  version: 1;
  revision: string;
  password?: { salt: string; hash: string };
  keys: (KeyView & { hash: string })[];
}
interface Session {
  csrfToken: string;
  expiresAt: number;
  revision: string;
}

export class SecurityStore {
  private readonly store: JsonStore<SecurityData>;
  private readonly sessions = new Map<string, Session>();
  constructor(dataDir: string) {
    this.store = new JsonStore(dataDir, () => ({
      version: 1,
      revision: randomUUID(),
      keys: [],
    }));
  }
  private async read() {
    const data = await this.store.read();
    if (data.version !== 1 || !Array.isArray(data.keys))
      throw new Error("Unsupported security store");
    return data;
  }
  async configured(): Promise<boolean> {
    return !!(await this.read()).password;
  }
  async setPassword(password: string): Promise<void> {
    if (password.length < 12 || password.length > 1024)
      throw new AppError(
        400,
        "invalid_password",
        "密码长度应为 12–1024 个字符。",
      );
    const salt = random(),
      hash = ((await derive(password, salt, 64)) as Buffer).toString("hex");
    await this.store.update((data) => {
      data.password = { salt, hash };
      data.revision = randomUUID();
    });
    this.sessions.clear();
  }
  async verifyPassword(password: string): Promise<boolean> {
    if (password.length > 1024) return false;
    const stored = (await this.read()).password;
    const hash = (
      (await derive(password, stored?.salt ?? "unconfigured", 64)) as Buffer
    ).toString("hex");
    return !!stored && equal(hash, stored.hash);
  }
  async authenticate(
    password: string,
  ): Promise<{ token: string; csrfToken: string } | undefined> {
    if (password.length > 1024) return undefined;
    const data = await this.read();
    const hash = (
      (await derive(
        password,
        data.password?.salt ?? "unconfigured",
        64,
      )) as Buffer
    ).toString("hex");
    if (!data.password || !equal(hash, data.password.hash)) return undefined;
    // Bind to the revision whose password was checked, even if a CLI reset races scrypt.
    return this.createSession(data.revision);
  }
  async createKey(name: string): Promise<{ key: KeyView; secret: string }> {
    if (!name.trim() || name.length > 80)
      throw new AppError(
        400,
        "invalid_name",
        "密钥名称应为 1–80 个字符。",
        "name",
      );
    const secret = `mp_${random()}`,
      key: KeyView = {
        id: randomUUID(),
        name: name.trim(),
        prefix: secret.slice(0, 10),
        createdAt: new Date().toISOString(),
      };
    await this.store.update((data) => {
      if (data.keys.length >= 100)
        throw new AppError(409, "key_limit", "最多可保存 100 个访问密钥。");
      data.keys.push({ ...key, hash: digest(secret) });
    });
    return { key, secret };
  }
  async acceptKey(key: string): Promise<boolean> {
    if (key.length > 128) return false;
    const hash = digest(key);
    return (await this.read()).keys.some((k) => equal(k.hash, hash));
  }
  async listKeys(): Promise<KeyView[]> {
    return (await this.read()).keys.map(({ hash: _hash, ...view }) => view);
  }
  async revokeKey(id: string): Promise<void> {
    await this.store.update((data) => {
      data.keys = data.keys.filter((key) => key.id !== id);
    });
  }
  async createSession(
    revision?: string,
  ): Promise<{ token: string; csrfToken: string }> {
    const now = Date.now();
    for (const [key, value] of this.sessions)
      if (value.expiresAt <= now) this.sessions.delete(key);
    if (this.sessions.size >= 256)
      this.sessions.delete(this.sessions.keys().next().value!);
    const token = random(),
      csrfToken = random();
    this.sessions.set(digest(token), {
      csrfToken,
      expiresAt: now + 12 * 3600_000,
      revision: revision ?? (await this.read()).revision,
    });
    return { token, csrfToken };
  }
  async session(token: string, now = Date.now()): Promise<Session | undefined> {
    const id = digest(token),
      value = this.sessions.get(id);
    if (!value) return undefined;
    if (
      value.expiresAt <= now ||
      value.revision !== (await this.read()).revision
    ) {
      this.sessions.delete(id);
      return undefined;
    }
    return value;
  }
  endSession(token: string): void {
    this.sessions.delete(digest(token));
  }
}

/** Fixed window, memory bounded even when many untrusted Origins are presented. */
export class LoginLimiter {
  private entries = new Map<string, { count: number; expires: number }>();
  check(id: string, now = Date.now()): void {
    for (const [key, item] of this.entries)
      if (item.expires <= now) this.entries.delete(key);
    let item = this.entries.get(id);
    if (!item) {
      if (this.entries.size >= 1000)
        throw new AppError(
          429,
          "login_rate_limit",
          "登录请求过多，请稍后再试。",
        );
      item = { count: 0, expires: now + 15 * 60_000 };
      this.entries.set(id, item);
    }
    if (++item.count > 10)
      throw new AppError(
        429,
        "login_rate_limit",
        "登录请求过多，请 15 分钟后再试。",
      );
  }
}
