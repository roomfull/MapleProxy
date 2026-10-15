import { useEffect, useRef, useState } from "react";
import type { Job } from "./types.js";

export async function copyAuthorizationUrl(
  url: string,
  writeText: (value: string) => Promise<void>,
  select: () => void,
): Promise<string> {
  try {
    await writeText(url);
    return "授权链接已复制。";
  } catch {
    select();
    return "剪贴板不可用，已选中授权链接，请手动复制（Ctrl+C 或长按复制）。";
  }
}

export interface SignInProgressProps {
  job: Job;
  busy: boolean;
  callbackUrl: string;
  error?: string;
  updatedLink?: boolean;
  submitting?: boolean;
  onCallbackChange: (value: string) => void;
  onSubmitCallback: () => void;
  onCancel: () => void;
  onRetry: () => void;
}
export function SignInProgress({
  job,
  busy,
  callbackUrl,
  error,
  updatedLink,
  submitting,
  onCallbackChange,
  onSubmitCallback,
  onCancel,
  onRetry,
}: SignInProgressProps) {
  const [now, setNow] = useState(Date.now);
  const [copyMessage, setCopyMessage] = useState("");
  const copyGeneration = useRef(0);
  const copyPending = useRef(false);
  const urlField = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (job.status !== "pending") return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [job.id, job.status]);
  useEffect(() => {
    copyGeneration.current++;
    copyPending.current = false;
    setCopyMessage("");
    return () => {
      copyGeneration.current++;
    };
  }, [job.id, job.authorizationUrl, job.phase, job.status]);
  const remaining = Math.max(
    0,
    Math.ceil((Date.parse(job.expiresAt) - now) / 1000),
  );
  const pending = job.status === "pending";
  const title = !pending
    ? job.status === "completed"
      ? "账号授权完成"
      : job.status === "cancelled"
        ? "登录已取消"
        : "登录未完成"
    : job.phase === "preparing"
      ? "正在准备授权…"
      : job.phase === "exchanging"
        ? "正在交换授权并验证账号…"
        : job.mode === "manual"
          ? "等待跨设备授权回调…"
          : "等待你完成浏览器授权…";
  const copy = async () => {
    if (copyPending.current || !job.authorizationUrl) return;
    copyPending.current = true;
    const generation = copyGeneration.current;
    const message = await copyAuthorizationUrl(
      job.authorizationUrl,
      (value) => navigator.clipboard.writeText(value),
      () => {
        if (copyGeneration.current === generation) {
          urlField.current?.focus();
          urlField.current?.select();
        }
      },
    );
    if (copyGeneration.current === generation) {
      setCopyMessage(message);
      copyPending.current = false;
    }
  };
  return (
    <div
      className={`job sign-in-progress ${job.status === "failed" ? "error" : ""}`}
    >
      <div className="sign-in-heading">
        <strong role="status">{title}</strong>
        {pending && (
          <span className="badge neutral" aria-label="剩余授权时间">
            {Math.floor(remaining / 60)}:
            {String(remaining % 60).padStart(2, "0")}
          </span>
        )}
      </div>
      {pending ? (
        <p>
          本次登录最多 {job.mode === "manual" ? "10" : "5"}{" "}
          分钟，包含自动重试；剩余时间按原任务截止时间计算。
          {remaining === 0 && "已到截止时间，正在确认任务状态…"}
        </p>
      ) : (
        <p>
          {job.status === "failed"
            ? `错误代码：${job.code ?? "sign_in_failed"}。可重新尝试。`
            : job.status === "cancelled"
              ? "可以重新发起登录，取消操作不会撤销已连接的账号。"
              : "账号列表已更新，可手动设置默认账号。"}
        </p>
      )}
      {pending &&
        job.phase === "awaiting_callback" &&
        (job.mode === "manual" ? (
          <>
            {updatedLink && (
              <p className="link-updated" role="status">
                授权链接已更新，请重新复制
              </p>
            )}
            <label htmlFor="authorization-url">授权链接</label>
            <div className="authorization-copy">
              <textarea
                ref={urlField}
                id="authorization-url"
                readOnly
                value={job.authorizationUrl ?? ""}
                rows={3}
                spellCheck={false}
              />
              <button
                disabled={!job.authorizationUrl || busy}
                onClick={() => void copy()}
              >
                复制授权链接
              </button>
            </div>
            {copyMessage && <p role="status">{copyMessage}</p>}
            <p>
              在另一台设备打开链接并完成官方授权。授权后，该设备可能提示无法访问本机回环地址；请复制浏览器地址栏中的完整回调
              URL（包含所有参数），回到此控制台粘贴并提交。
            </p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                onSubmitCallback();
              }}
            >
              <label htmlFor="callback-url">完整回调 URL</label>
              <textarea
                id="callback-url"
                value={callbackUrl}
                onChange={(event) => onCallbackChange(event.target.value)}
                placeholder="粘贴地址栏中的完整 http://127.0.0.1:…/auth/callback?… 地址"
                rows={3}
                disabled={busy}
                autoComplete="off"
                spellCheck={false}
              />
              <button
                className="primary"
                disabled={busy || !callbackUrl.trim() || remaining === 0}
              >
                {submitting ? "提交中…" : "提交回调"}
              </button>
            </form>
          </>
        ) : (
          <p>在自动打开的官方登录页选择账号并授权共享。</p>
        ))}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <div className="sign-in-actions">
        {pending ? (
          <button disabled={busy} onClick={onCancel}>
            取消登录
          </button>
        ) : job.status !== "completed" ? (
          <button disabled={busy} onClick={onRetry}>
            重新登录
          </button>
        ) : null}
      </div>
    </div>
  );
}
