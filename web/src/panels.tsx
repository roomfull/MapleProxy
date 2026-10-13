import { useState } from "react";
import type { Account, Activity, Job, Key, Model, Resource } from "./types.js";

function ResourceState<T>({
  resource,
  emptyText,
}: {
  resource: Resource<T>;
  emptyText: string;
}) {
  if (resource.loading)
    return (
      <div className="empty" role="status">
        <span className="loader" />
        正在读取…
      </div>
    );
  if (resource.error)
    return (
      <div className="empty error-text" role="alert">
        <strong>暂时无法读取</strong>
        <p>{resource.error}</p>
        <small>可点击右上方「刷新」重试。</small>
      </div>
    );
  if (!resource.data.length)
    return (
      <div className="empty">
        <span className="empty-symbol">◇</span>
        <p>{emptyText}</p>
      </div>
    );
  return null;
}
const date = (value: string) =>
  new Date(value).toLocaleString("zh-CN", { hour12: false });
const status: Record<string, string> = {
  connected: "已连接",
  disconnected: "未连接",
  pending: "等待授权",
  error: "连接异常",
  expired: "授权已过期",
  revoked: "授权已撤销",
};
export function Accounts({
  resource,
  busy,
  job,
  onSignIn,
  onRetry,
  onCancel,
  onAction,
}: {
  resource: Resource<Account>;
  busy: string;
  job?: Job;
  onSignIn: (options: Record<string, unknown>) => void;
  onRetry: () => void;
  onCancel: () => void;
  onAction: (
    account: Account,
    kind: "default" | "enabled" | "disconnect",
  ) => void;
}) {
  const [label, setLabel] = useState("");
  const disabled = !!busy || job?.status === "pending";
  const selected = resource.data.find((account) => account.isDefault);
  return (
    <>
      <section className="summary-card">
        <div className="summary-icon">◎</div>
        <div>
          <div className="caption">当前默认账号</div>
          <h2>
            {resource.loading
              ? "正在读取…"
              : resource.error
                ? "状态暂不可用"
                : (selected?.label ?? "尚未选择账号")}
          </h2>
          <p>
            {selected
              ? `${selected.enabled ? "已启用" : "已停用"} · ${selected.sharing ? "已授权共享" : "未授权共享"} · 每条请求开始时固定账号`
              : "连接账号后，手动设为默认即可开始使用。"}
          </p>
        </div>
        <span className="badge neutral">手动选择</span>
      </section>
      <section className="panel">
        <div className="panel-header">
          <div>
            <h2>ChatGPT 账号</h2>
            <p>授权由官方登录页完成，浏览器将自动打开。</p>
          </div>
          <span className="count">{resource.data.length} 个账号</span>
        </div>
        <div className="connect-form">
          <label className="sr-only" htmlFor="account-label">
            新账号备注名称
          </label>
          <input
            id="account-label"
            value={label}
            maxLength={80}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="备注名称（可选）"
            disabled={disabled}
          />
          <button
            className="primary"
            disabled={disabled}
            onClick={() =>
              onSignIn({
                newProfile: true,
                ...(label.trim() ? { label: label.trim() } : {}),
              })
            }
          >
            <span aria-hidden="true">＋</span> Continue with ChatGPT
          </button>
        </div>
        {job && (
          <div
            className={`job ${job.status === "failed" ? "error" : ""}`}
            role="status"
          >
            <div>
              <strong>
                {job.status === "pending"
                  ? "等待你完成浏览器授权…"
                  : job.status === "completed"
                    ? "账号授权完成"
                    : job.status === "cancelled"
                      ? "登录已取消"
                      : "登录未完成"}
              </strong>
              <p>
                {job.status === "pending"
                  ? "在官方登录页选择账号并授权共享。此过程最长等待 5 分钟。"
                  : job.status === "failed"
                    ? `错误代码：${job.code ?? "sign_in_failed"}。检查浏览器后可重新尝试。`
                    : job.status === "cancelled"
                      ? "可以重新发起登录，取消操作不会撤销已连接的账号。"
                      : "账号列表已更新，可手动设置默认账号。"}
              </p>
            </div>
            {job.status === "pending" ? (
              <button disabled={!!busy} onClick={onCancel}>
                取消登录
              </button>
            ) : job.status !== "completed" ? (
              <button disabled={!!busy} onClick={onRetry}>
                重新登录
              </button>
            ) : null}
          </div>
        )}
        <ResourceState
          resource={resource}
          emptyText="还没有连接的账号。使用上方官方登录按钮添加第一个账号。"
        />
        {!resource.loading &&
          !resource.error &&
          resource.data.map((account) => (
            <article className="account-row" key={account.id}>
              <div className="avatar">
                {(account.label || "C").slice(0, 1).toUpperCase()}
              </div>
              <div className="account-info">
                <div className="row-title">
                  <h3>{account.label || "ChatGPT 账号"}</h3>
                  {account.isDefault && (
                    <span className="badge accent">默认</span>
                  )}
                  <span
                    className={`badge ${account.enabled && account.status === "connected" ? "success" : "neutral"}`}
                  >
                    {!account.enabled
                      ? "已停用"
                      : (status[account.status] ?? account.status)}
                  </span>
                </div>
                <p>
                  {account.identity?.email ??
                    account.identity?.name ??
                    "未提供账号身份信息"}
                </p>
                <small>
                  {account.sharing ? "已授权共享" : "未授权共享"} ·{" "}
                  <code>{account.id}</code>
                </small>
                {account.error && (
                  <p className="error-text">
                    连接异常：{account.error.code}，请重新登录或授权。
                  </p>
                )}
              </div>
              <div className="row-actions">
                {!account.isDefault && (
                  <button
                    disabled={
                      !!busy ||
                      !account.enabled ||
                      account.status !== "connected"
                    }
                    onClick={() => onAction(account, "default")}
                  >
                    设为默认
                  </button>
                )}
                <button
                  disabled={!!busy}
                  onClick={() => onAction(account, "enabled")}
                >
                  {account.enabled ? "停用" : "启用"}
                </button>
                <button
                  disabled={disabled}
                  onClick={() =>
                    onSignIn({ profileId: account.id, reconsent: true })
                  }
                >
                  重新授权
                </button>
                <button
                  disabled={!!busy}
                  className="danger quiet"
                  onClick={() => onAction(account, "disconnect")}
                >
                  断开
                </button>
              </div>
            </article>
          ))}
      </section>
      <div className="info-note">
        <strong>关于账号切换</strong>
        <p>
          切换默认账号只影响新请求。停用或断开账号会中止该账号的进行中请求。请求失败后不会自动重试，也不会自动切换其他账号。
        </p>
      </div>
    </>
  );
}
export function Models({
  resource,
  onCopy,
}: {
  resource: Resource<Model>;
  onCopy: (value: string) => void;
}) {
  const [filter, setFilter] = useState("");
  const filtered = resource.data.filter((model) =>
    `${model.id} ${model.displayName}`
      .toLowerCase()
      .includes(filter.toLowerCase()),
  );
  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <h2>模型目录</h2>
          <p>使用模型 ID 配置你的客户端；列表取决于默认账号。</p>
        </div>
        <span className="count">{resource.data.length} 个模型</span>
      </div>
      <div className="filter-bar">
        <label className="sr-only" htmlFor="model-filter">
          搜索模型
        </label>
        <input
          id="model-filter"
          placeholder="搜索名称或模型 ID"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
      </div>
      <ResourceState
        resource={resource}
        emptyText="暂无可用模型。先连接并启用账号，选择默认账号后刷新。"
      />
      {!resource.loading &&
        !resource.error &&
        resource.data.length > 0 &&
        !filtered.length && <div className="empty">没有匹配的模型。</div>}
      <div className="model-grid">
        {!resource.loading &&
          !resource.error &&
          filtered.map((model) => (
            <article className="model-card" key={model.id}>
              <span className="model-symbol">◇</span>
              <h3>{model.displayName}</h3>
              <code>{model.id}</code>
              <button className="quiet" onClick={() => onCopy(model.id)}>
                复制 ID ↗
              </button>
            </article>
          ))}
      </div>
    </section>
  );
}
export function Keys({
  resource,
  busy,
  created,
  model,
  onCreate,
  onRevoke,
  onCopy,
  onDismiss,
}: {
  resource: Resource<Key>;
  busy: string;
  created?: { key: Key; secret: string };
  model?: string;
  onCreate: (name: string) => void;
  onRevoke: (key: Key) => void;
  onCopy: (value: string) => void;
  onDismiss: () => void;
}) {
  const [name, setName] = useState("");
  const base = `${location.origin}/v1`;
  const example = [
    "$secureKey = Read-Host 'MapleProxy 访问密钥' -AsSecureString",
    "$credential = [System.Net.NetworkCredential]::new('', $secureKey)",
    "$headers = @{ Authorization = 'Bearer ' + $credential.Password }",
    `\$body = @{ model = '${(model ?? "MODEL_ID").replaceAll("'", "''")}'; input = '你好' } | ConvertTo-Json`,
    `Invoke-RestMethod -Uri '${base}/responses' -Method Post -Headers $headers -ContentType 'application/json' -Body ([System.Text.Encoding]::UTF8.GetBytes($body))`,
    "Remove-Variable secureKey, credential, headers",
  ].join("\n");
  return (
    <>
      <section className="panel">
        <div className="panel-header">
          <div>
            <h2>客户端访问密钥</h2>
            <p>密钥仅用于推理接口。请为每个客户端使用单独的密钥。</p>
          </div>
          <span className="count">{resource.data.length} 个密钥</span>
        </div>
        <form
          className="connect-form"
          onSubmit={(event) => {
            event.preventDefault();
            onCreate(name);
          }}
        >
          <label className="sr-only" htmlFor="key-name">
            密钥名称
          </label>
          <input
            id="key-name"
            maxLength={80}
            required
            placeholder="密钥名称，例如 Cursor 或本机脚本"
            value={name}
            disabled={!!busy}
            onChange={(event) => setName(event.target.value)}
          />
          <button
            className="primary"
            disabled={!!busy || !name.trim() || !!created}
          >
            {busy === "create-key" ? "创建中…" : "＋ 创建访问密钥"}
          </button>
        </form>
        {created && (
          <div className="secret-card" role="status">
            <div className="row-title">
              <strong>密钥已创建 · 仅显示这一次</strong>
              <span className="badge accent">{created.key.name}</span>
            </div>
            <p>现在复制并安全保存。关闭此提示后无法再次查看完整密钥。</p>
            <div className="secret-value">
              <code>{created.secret}</code>
              <button onClick={() => onCopy(created.secret)} disabled={!!busy}>
                复制密钥
              </button>
            </div>
            <button className="quiet" onClick={onDismiss}>
              我已保存，隐藏密钥
            </button>
          </div>
        )}
        <ResourceState
          resource={resource}
          emptyText="还没有访问密钥。创建后可在兼容 OpenAI API 的客户端中使用。"
        />
        {!resource.loading &&
          !resource.error &&
          resource.data.map((key) => (
            <div className="key-row" key={key.id}>
              <div className="key-icon">⌁</div>
              <div>
                <h3>{key.name}</h3>
                <p>
                  <code>{key.prefix}••••••</code>
                  <span className="separator">·</span>
                  {date(key.createdAt)}
                </p>
              </div>
              <button
                className="danger quiet"
                disabled={!!busy}
                onClick={() => onRevoke(key)}
              >
                撤销
              </button>
            </div>
          ))}
      </section>
      <section className="panel examples">
        <div className="panel-header">
          <div>
            <h2>连接客户端</h2>
            <p>API Base URL 与 API Key 分别填写。管理密码不能作为 API Key。</p>
          </div>
        </div>
        <div className="field-copy">
          <div>
            <label>API Base URL</label>
            <code>{base}</code>
          </div>
          <button onClick={() => onCopy(base)}>复制地址</button>
        </div>
        <div className="example-label">
          <span>Responses 请求示例（PowerShell 5.1 / 7）</span>
          <button className="quiet" onClick={() => onCopy(example)}>
            复制示例
          </button>
        </div>
        <pre>{example}</pre>
        <p className="caption">
          执行后在隐藏提示中输入访问密钥。密钥在 PowerShell
          进程内部加入请求头，不会拼入命令行参数。请使用模型目录中的实际 ID。
        </p>
      </section>
      <div className="info-note">
        <strong>兼容参数说明</strong>
        <p>
          普通不支持参数（如 temperature、top_p、max_tokens）会被过滤，通过
          X-MapleProxy-Ignored-Params 响应头和请求记录列出。max_tokens
          不保证限制输出长度。无法表示的功能会明确报错。单次 JSON 请求最多 32
          MiB，包含所有内联文件的 Base64 与其他字段。
        </p>
      </div>
    </>
  );
}
export function ActivityPanel({ resource }: { resource: Resource<Activity> }) {
  const [filter, setFilter] = useState("all"),
    [search, setSearch] = useState("");
  const rows = resource.data.filter(
    (row) =>
      (filter === "all" || row.result === filter) &&
      `${row.requestId} ${row.localRequestId ?? ""} ${row.upstreamRequestId ?? ""} ${row.model ?? ""} ${row.profileId ?? ""} ${row.code ?? ""} ${row.param ?? ""}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  return (
    <>
      <section className="panel">
        <div className="panel-header">
          <div>
            <h2>最近请求</h2>
            <p>只记录有限诊断元数据，不保存提示词、输出、工具参数值或凭证。</p>
          </div>
          <span className="count">{resource.data.length} / 200</span>
        </div>
        <div className="filter-bar">
          <label className="sr-only" htmlFor="request-filter">
            搜索请求
          </label>
          <input
            id="request-filter"
            placeholder="搜索模型、账号或请求 ID"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <label className="sr-only" htmlFor="result-filter">
            筛选请求结果
          </label>
          <select
            id="result-filter"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          >
            <option value="all">全部结果</option>
            <option value="success">成功</option>
            <option value="incomplete">未完整完成</option>
            <option value="error">失败</option>
            <option value="cancelled">已取消</option>
          </select>
        </div>
        <ResourceState
          resource={resource}
          emptyText="还没有请求记录。使用访问密钥调用推理接口后，记录会出现在这里。"
        />
        {!resource.loading &&
          !resource.error &&
          resource.data.length > 0 &&
          !rows.length && <div className="empty">没有匹配的请求记录。</div>}
        {!resource.loading && !resource.error && rows.length > 0 && (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>时间 / 请求 ID</th>
                  <th>模型 / 账号</th>
                  <th>接口</th>
                  <th>耗时</th>
                  <th>结果</th>
                  <th>诊断详情</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.requestId + row.time}>
                    <td>
                      {date(row.time)}
                      <code className="subline">{row.requestId}</code>
                    </td>
                    <td>
                      {row.model ?? "—"}
                      <code className="subline">{row.profileId ?? "—"}</code>
                    </td>
                    <td>{row.format === "chat" ? "Chat" : "Responses"}</td>
                    <td>{row.durationMs.toLocaleString()} ms</td>
                    <td>
                      <span
                        className={`badge ${row.result === "success" ? "success" : row.result === "error" ? "error" : "neutral"}`}
                      >
                        {row.result === "success"
                          ? "成功"
                          : row.result === "incomplete"
                            ? "未完整完成"
                            : row.result === "error"
                              ? "失败"
                              : "已取消"}
                      </span>
                      {row.code && (
                        <code className="subline error-text">{row.code}</code>
                      )}
                    </td>
                    <td className="ignored">
                      <details>
                        <summary>
                          {row.stage ?? "诊断"}
                          {row.httpStatus !== undefined
                            ? ` · HTTP ${row.httpStatus}`
                            : ""}
                        </summary>
                        <div>
                          本地 ID：
                          <code>{row.localRequestId ?? row.requestId}</code>
                        </div>
                        {row.upstreamRequestId && (
                          <div>
                            上游 ID：<code>{row.upstreamRequestId}</code>
                          </div>
                        )}
                        {row.upstreamCalled !== undefined && (
                          <div>
                            进入上游调用流程：
                            {row.upstreamCalled
                              ? "是（可能在账号或认证检查阶段失败）"
                              : "否"}
                          </div>
                        )}
                        {row.param && (
                          <div>
                            错误路径：<code>{row.param}</code>
                          </div>
                        )}
                        {row.responseStatus && (
                          <div>响应终止：{row.responseStatus}</div>
                        )}
                        {row.incompleteReason && (
                          <div>未完成原因：{row.incompleteReason}</div>
                        )}
                        {!!row.ignored?.length && (
                          <div>忽略参数：{row.ignored.join(", ")}</div>
                        )}
                        {row.diagnostics?.map((entry, i) => (
                          <div key={i}>
                            <code>{entry.path}</code> · {entry.action} ·{" "}
                            {entry.reason}
                          </div>
                        ))}
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <div className="info-note">
        <strong>使用限制与错误</strong>
        <p>
          本地服务不估算配额。如遇使用限制，以实际返回错误为准；可前往{" "}
          <a
            href="https://chatgpt.com/settings/usage"
            target="_blank"
            rel="noreferrer"
          >
            ChatGPT 官方使用情况 ↗
          </a>{" "}
          查看。
        </p>
      </div>
    </>
  );
}
