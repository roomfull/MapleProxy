import { useEffect, useState } from "react";
import { ApiClient } from "./api.js";
import type { SessionView } from "./api.js";
import type { Account, Activity, Job, Key, Model, Resource } from "./types.js";
import { Accounts, ActivityPanel, Keys, Models } from "./panels.js";

const api = new ApiClient();
const empty = <T,>(): Resource<T> => ({ data: [], loading: true });
type Tab = "accounts" | "models" | "keys" | "activity";
const tabs: { id: Tab; label: string; mark: string; detail: string }[] = [
  {
    id: "accounts",
    label: "账号连接",
    mark: "◎",
    detail: "通过 ChatGPT 授权，手动选择用于新请求的默认账号。",
  },
  {
    id: "models",
    label: "可用模型",
    mark: "◇",
    detail: "实时读取默认账号可用的模型列表。",
  },
  {
    id: "keys",
    label: "访问密钥",
    mark: "⌁",
    detail: "为本机客户端创建独立密钥，随时撤销访问。",
  },
  {
    id: "activity",
    label: "请求记录",
    mark: "↗",
    detail: "最近 200 条请求的元数据，仅保存在当前服务内存。",
  },
];
export function App() {
  const [session, setSession] = useState<SessionView>();
  const [sessionError, setSessionError] = useState("");
  const [password, setPassword] = useState("");
  const [tab, setTab] = useState<Tab>("accounts");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<{ text: string; error?: boolean }>();
  const [accounts, setAccounts] = useState(empty<Account>);
  const [models, setModels] = useState(empty<Model>);
  const [keys, setKeys] = useState(empty<Key>);
  const [activity, setActivity] = useState(empty<Activity>);
  const [job, setJob] = useState<Job>();
  const [signInOptions, setSignInOptions] = useState<Record<string, unknown>>({
    newProfile: true,
  });
  const [created, setCreated] = useState<{ key: Key; secret: string }>();
  const loadSession = async () => {
    setSessionError("");
    try {
      setSession(await api.session());
    } catch (error) {
      setSessionError((error as Error).message);
    }
  };
  useEffect(() => {
    api.onExpired = () => {
      setSession({ configured: true, authenticated: false });
      setCreated(undefined);
      setNotice({ text: "管理会话已失效，请重新登录。", error: true });
    };
    void loadSession();
    return () => {
      api.onExpired = undefined;
    };
  }, []);
  const refresh = async () => {
    const load = async <T,>(
      path: string,
      field: string,
      setter: React.Dispatch<React.SetStateAction<Resource<T>>>,
    ) => {
      setter((state) => ({ ...state, loading: true, error: undefined }));
      try {
        const data = await api.request<Record<string, T[]>>(path);
        setter({ data: data[field] ?? [], loading: false });
      } catch (error) {
        setter({ data: [], loading: false, error: (error as Error).message });
      }
    };
    await Promise.all([
      load("/accounts", "accounts", setAccounts),
      load("/models", "models", setModels),
      load("/keys", "keys", setKeys),
      load("/requests", "requests", setActivity),
    ]);
  };
  useEffect(() => {
    if (session?.authenticated) void refresh();
  }, [session?.authenticated]);
  useEffect(() => {
    if (job?.status !== "pending" || !session?.authenticated) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const current = await api.request<Job>(`/sign-in/${job.id}`);
        if (stopped) return;
        setJob(current);
        if (current.status === "completed") {
          setNotice({ text: "ChatGPT 账号已连接。" });
          await refresh();
        } else if (current.status === "pending") timer = setTimeout(poll, 1500);
      } catch (error) {
        if (!stopped) {
          setNotice({
            text: `登录状态读取失败：${(error as Error).message}`,
            error: true,
          });
          timer = setTimeout(poll, 3000);
        }
      }
    };
    timer = setTimeout(poll, 1000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [job?.id, job?.status, session?.authenticated]);
  const action = async (name: string, work: () => Promise<void>) => {
    if (busy) return;
    setBusy(name);
    setNotice(undefined);
    try {
      await work();
    } catch (error) {
      setNotice({ text: (error as Error).message, error: true });
    } finally {
      setBusy("");
    }
  };
  const signIn = (options: Record<string, unknown>) =>
    action("sign-in", async () => {
      setSignInOptions(options);
      setJob(await api.request<Job>("/sign-in", "POST", options));
    });
  const accountAction = (
    account: Account,
    kind: "default" | "enabled" | "disconnect",
  ) =>
    action(`${kind}-${account.id}`, async () => {
      if (
        kind === "disconnect" &&
        !window.confirm(
          `断开「${account.label}」？该账号的进行中请求会被中止。`,
        )
      )
        return;
      await api.request(
        `/accounts/${encodeURIComponent(account.id)}${kind === "enabled" ? "" : `/${kind}`}`,
        kind === "enabled" ? "PATCH" : "POST",
        kind === "enabled" ? { enabled: !account.enabled } : undefined,
      );
      setNotice({
        text:
          kind === "default"
            ? "默认账号已切换，下一条请求生效。"
            : kind === "disconnect"
              ? "账号已断开。"
              : account.enabled
                ? "账号已停用，进行中请求已中止。"
                : "账号已启用。",
      });
      await refresh();
    });
  const copy = (value: string) =>
    action("copy", async () => {
      await navigator.clipboard.writeText(value);
      setNotice({ text: "已复制到剪贴板。" });
    });
  const current = tabs.find((item) => item.id === tab)!;
  if (!session?.authenticated)
    return (
      <div className="login-shell">
        <div className="login-brand">
          <span className="logo">M</span>
          <span>MapleProxy</span>
          <span className="local-tag">本机控制台</span>
        </div>
        <main className="login-card">
          <div className="eyebrow">LOCAL WORKSPACE</div>
          <h1>连接你的 AI 工作流</h1>
          <p>
            管理 ChatGPT 账号与客户端访问。
            <br />
            所有连接配置都保存在这台电脑上。
          </p>
          {notice && (
            <div
              role="alert"
              className={`notice ${notice.error ? "error" : ""}`}
            >
              {notice.text}
            </div>
          )}
          {sessionError ? (
            <div className="notice error" role="alert">
              {sessionError}
              <button onClick={() => void loadSession()}>重新连接</button>
            </div>
          ) : !session ? (
            <div className="loading" role="status">
              正在连接本机服务…
            </div>
          ) : !session.configured ? (
            <div className="setup-note">
              <h2>先设置管理密码</h2>
              <p>在项目目录运行以下命令，密码输入会隐藏：</p>
              <pre>npm run setup</pre>
              <p>设置完成后刷新即可登录。</p>
              <button onClick={() => void loadSession()}>
                我已设置，刷新状态
              </button>
            </div>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void action("login", async () => {
                  const result = await api.login(password);
                  setPassword("");
                  setSession(result);
                });
              }}
            >
              <label htmlFor="password">管理密码</label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                disabled={!!busy}
                placeholder="输入本机管理密码"
              />
              <button className="primary wide" disabled={!!busy || !password}>
                {busy === "login" ? "正在登录…" : "进入控制台 →"}
              </button>
              <p className="caption">
                管理会话有效期 12 小时。忘记密码可运行{" "}
                <code>npm run setup -- --reset</code>。
              </p>
            </form>
          )}
        </main>
        <footer className="login-footer">
          仅限本机访问 · 独立访问密钥 · Windows DPAPI 凭证保护
        </footer>
      </div>
    );
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/">
          <span className="logo">M</span>
          <span>
            MapleProxy<small>本机控制台</small>
          </span>
        </a>
        <div className="nav-label">工作空间</div>
        <nav aria-label="主导航">
          {tabs.map((item) => (
            <button
              className={tab === item.id ? "active" : ""}
              onClick={() => setTab(item.id)}
              key={item.id}
            >
              <span aria-hidden="true">{item.mark}</span>
              {item.label}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="local-status">
            <span className="status-dot" />
            本机服务已连接
          </div>
          <p>
            手动选择账号
            <br />
            请求不会自动切换或重试
          </p>
          <a
            href="https://chatgpt.com/settings/usage"
            target="_blank"
            rel="noreferrer"
          >
            查看官方使用情况 ↗
          </a>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <span>
            个人工作空间 <span className="separator">/</span>{" "}
            <strong>{current.label}</strong>
          </span>
          <button
            className="quiet"
            disabled={!!busy}
            onClick={() =>
              void action("logout", async () => {
                await api.logout();
                setSession({ configured: true, authenticated: false });
                setCreated(undefined);
                setJob(undefined);
                setNotice(undefined);
              })
            }
          >
            退出登录
          </button>
        </header>
        <main className="content">
          <div className="page-heading">
            <div>
              <div className="eyebrow">MAPLEPROXY / LOCAL</div>
              <h1>{current.label}</h1>
              <p>{current.detail}</p>
            </div>
            <button
              className="secondary"
              disabled={!!busy}
              onClick={() => void action("refresh", refresh)}
            >
              {busy === "refresh" ? "刷新中…" : "↻ 刷新"}
            </button>
          </div>
          {notice && (
            <div
              className={`notice ${notice.error ? "error" : ""}`}
              role={notice.error ? "alert" : "status"}
            >
              <span>{notice.text}</span>
              <button
                aria-label="关闭提示"
                onClick={() => setNotice(undefined)}
              >
                ×
              </button>
            </div>
          )}
          {tab === "accounts" && (
            <Accounts
              resource={accounts}
              busy={busy}
              job={job}
              onSignIn={signIn}
              onRetry={() => void signIn(signInOptions)}
              onCancel={() =>
                void action("cancel", async () => {
                  setJob(
                    await api.request<Job>(`/sign-in/${job?.id}`, "DELETE"),
                  );
                })
              }
              onAction={accountAction}
            />
          )}
          {tab === "models" && (
            <Models resource={models} onCopy={(value) => void copy(value)} />
          )}
          {tab === "keys" && (
            <Keys
              resource={keys}
              busy={busy}
              created={created}
              model={models.data[0]?.id}
              onDismiss={() => setCreated(undefined)}
              onCopy={(value) => void copy(value)}
              onCreate={(name) =>
                void action("create-key", async () => {
                  setCreated(await api.request("/keys", "POST", { name }));
                  await refresh();
                })
              }
              onRevoke={(key) =>
                void action(`revoke-${key.id}`, async () => {
                  if (
                    !window.confirm(
                      `撤销「${key.name}」？使用它的客户端将无法继续访问。`,
                    )
                  )
                    return;
                  await api.request(`/keys/${key.id}`, "DELETE");
                  if (created?.key.id === key.id) setCreated(undefined);
                  setNotice({ text: "访问密钥已撤销。" });
                  await refresh();
                })
              }
            />
          )}
          {tab === "activity" && <ActivityPanel resource={activity} />}
          <footer className="content-footer">
            MapleProxy · 仅连接官方 Responses 接口<span>本机个人使用</span>
          </footer>
        </main>
      </div>
    </div>
  );
}
