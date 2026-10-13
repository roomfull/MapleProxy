# 验证记录（2026-10-13）

此记录保留 Task 4 实现者与控制器在 Codex 重启前的验证，另记录最终修复者在 2026-10-13 新执行的回归与全套验证。Task 4 的恢复收尾依据移交记录及浏览器报告，没有重跑当时整套测试或浏览器；最终修复全套执行如下单独归属。所有账户、密钥、上游事件均为合成 fixture，生产数据目录未初始化，未使用真实 OpenAI 账户完成 OAuth 或推理。

## 最终修复新执行证据

最终全分支审查发现的 2 Important + 4 Minor 已在同一轮修复。新增测试先在原代码得到 **9 failed / 109 passed（5 files）**，覆盖未知选项、上游 401、非流式请求 ID、显式 native error、延迟取消和两类初始化失败。首次 sandbox 执行额外受到 Windows 临时文件 rename 的 EPERM 限制；正常提权后记录的 RED 是断言失败，不是权限错误。测试文件对原生 ESM 的 mock 准备错误也在有效 RED 前修正。

| 最终修复者执行命令 | 结果 |
| --- | --- |
| `npm run test:unit -- tests/protocol.test.ts tests/web-api.test.ts tests/server.test.ts tests/runtime.test.ts tests/smoke-fixture.test.ts tests/integration.test.ts` | 6 files、132/132 通过。 |
| `npm test` | 13 project files、162/162 通过；DevKit 56 通过、1 平台跳过、0 失败。 |
| `npm run typecheck` | exit 0。 |
| `npm run build` | exit 0，vendor/server/web 均构建。 |

回归新增 HTTP + ApiClient 验证上游 invalid_token/401 保留会话与 CSRF、后续管理操作可用；本地 admin_unauthorized 仍触发失效。两种非流式格式覆盖 failed/incomplete/EOF 与有效/无效/缺失 request ID，header/envelope/activity 一致。真实生产传输使用锁定 SDK 的 UTF-8/SSE decoder，3-byte 分片的显式 event:error 保留 code/message/param/sequence_number；经真实 loopback 双路由确认失败、无正常终止标记，安全 envelope 和日志不含 provider 私密消息。延迟取消用手动触发真实 deadline 回调，不等待五分钟；旧 promise 未结算前返回 409，结算后新 job 为 202。fixture 密码设置或 app 构建失败后，其自建 OS 临时目录均不存在。

未新增浏览器、真实 OAuth 或真实远端推理验收；原浏览器限制和历史 Task 4 首次 integration GREEN 事实保留。审查意见原文保留于忽略的 SDD 工作区，修复仍等待独立 scoped re-review。

## 命令与结果

| 命令 | 已完成结果 |
| --- | --- |
| `npm run test:unit -- tests/integration.test.ts tests/smoke-fixture.test.ts tests/web-api.test.ts` | 最终 14/14 通过：integration 10、smoke fixture 1、web API 3。 |
| `npm test` | 项目 146 项通过；保留的 DevKit 测试 56 项通过、1 项平台条件跳过（在 Windows 环境运行）。 |
| `npm run typecheck` | exit 0。 |
| `npm run build` | exit 0，包含 vendor、服务端和前端构建。 |
| `git diff --check` | 实现验证时 exit 0；文档收尾提交前再次检查。 |
| `.tmp/verify-readme-curl.ts` 验证 harness | README 中的 curl 块在 Windows PowerShell 5.1 执行成功：仅替换 fixture URL 和模型输入；Chat 收到 `[DONE]`，Responses 收到 `response.completed`。认证由环境传入 PowerShell，并通过 stdin config 传给 curl，没有密钥 argv。该验证脚本属于忽略的临时工作区。 |

新增 integration 测试首次运行已通过此前实现，没有制造或声称 integration RED。浏览器发现的默认 `fetch` receiver 错误另有真实回归证据：新增 receiver 测试时 `tests/web-api.test.ts` 为 **1 failed / 2 passed**；改用 `globalThis.fetch` 的箭头包装后 **3 passed**，浏览器重新加载也通过。fixture harness 测试记录其功能通过，不声称未保留的 RED。

## 集成覆盖与边界

`tests/integration.test.ts` 使用官方 OpenAI Node SDK 连接真实 loopback HTTP 网关，并经真实 AccountRuntime 的测试构造注入将固定公开上游地址转向本地 server；不存在生产 mock 参数或可任意转发凭据的 HTTP 配置。临时凭据提供者只供测试。

- 模型目录、Chat 和 Responses 非流式请求均由 SDK 验证；上游断言 `store:false, stream:true`、合成账户认证及忽略参数移除。
- 上游按 3-byte 写入，覆盖 CRLF、JSON、中文及 emoji 的 UTF-8/SSE 分片。
- Chat 流式 function call 保持 `call_id`、补齐最终 arguments、可选 usage，并携带完整 assistant/tool/user 历史完成第二轮。Responses 往返保留 native namespace、完整工具调用和合成 encrypted reasoning item。
- failed、incomplete、提前 EOF 三种终止分别覆盖两条路由：SDK 抛错，partial 可见，但没有完成事件、成功 finish reason、最终 usage 或 `[DONE]`；网关追加的错误 envelope 不泄露合成私密错误详情。原生 Responses terminal payload 按协议保留。
- 背压测试使用真实下游 socket 和受测 synthetic generator，观察 `write:false`、消费暂停后 producer 停止增长，以及断开触发 abort 与 generator finally。它证明网关的 demand 控制；该用例没有声称测量真实远端生产速度。
- SDK 主动取消到真实本地上游 socket 的关闭，且仅一次请求；两个真实 socket 流分别保留 A/B 的请求开始时账户，停用 A 只关闭 A。
- `examples/client.mjs` 以子进程运行，认证仅在进程环境中，分别输出两条路由的预期结果。
- `tests/smoke-fixture.test.ts` 验证合成账户、通过真实推理路由产生 success/error/ignored 活动、seed key 被撤销及正常 close 后 listener 不可访问。

已有 runtime、protocol、server/security 与 upstream 测试提供其他回归覆盖，包括 Windows DPAPI roundtrip；本记录不把 fixture 推理解释为真实账户权限或远端模型接受性的证据。

## 浏览器验收

控制器通过 Codex IAB 使用 `scripts/smoke.ts` 的隔离 OS 临时数据和合成密码/账户/密钥。桌面 **1365×900**、窄屏 **390×844**（滚动条后内容宽 375px）通过 DOM 和截图检查。

| 操作 | 可观察结果 |
| --- | --- |
| 密码登录 / 退出 | 登录进入账户界面；恢复后退出显示空密码输入框、禁用的提交按钮。 |
| 账户选择 / 停用 | 默认 A 切 B 后 banner 更新；停用 B 显示 disabled，重新启用恢复 connected。 |
| 访问密钥 | 创建合成 key 后 show-once 卡片出现；隐藏并刷新后只保留 metadata。 |
| 模型 / 活动 | 显示 `test-model`；success、`rate_limit_exceeded` 和 ignored `temperature` 可见；失败筛选只剩失败记录。 |
| 官方登录入口 | 显示 pending，随后 fixture 明确返回 `fixture_only`；未启动真实授权。 |
| 窄屏布局 | 修复刷新按钮换行和第四个导航被裁剪；重载后四个导航标签可见、按钮不换行、卡片堆叠无重叠、页面无水平溢出。 |

浏览器 key 撤销未确认：浏览器工具自动取消 native confirm，未提供可用 dialog handle；后端撤销有自动测试。OAuth 取消按钮未验证：fixture 失败结束过快。截图保存在忽略工作区 `.tmp/mapleproxy-desktop.jpg`、`.tmp/mapleproxy-mobile.jpg`、`.tmp/mapleproxy-logout.jpg`，不包含真实账户凭据。

两个浏览器 fixture listener 因 Codex 应用崩溃而结束；恢复后控制器确认原端口 63443、61393 均无监听。**这不是一次经验证的正常 shutdown**；harness 正常关闭由独立自动测试验证。用户报告关闭 IAB 会导致 Codex 崩溃，后续遵从用户要求未关闭或操作浏览器。生产 `data/` 未初始化，没有留下运行的 demo server。

## 待验证和已知事项

- 真实 OAuth、远端权限、账户策略以及各模型对工具/多模态/高级字段的实际支持仍待用户自行授权后的 smoke；步骤见 [README](../README.md)。不使用自动测试调用真实 OpenAI。
- Task 3 M1 的安全锁恢复已写入 README：先停止全部 server/setup 写入者，确认数据目录，仅删除遗留 `security.json.lock`，保留账户与 `security.json`。
- Task 3 M2 的历史提前释放已在最终修复中解决：超时显示 sign_in_timeout，取消结算前保留 active，新启动返回 sign_in_busy。历史复现/审查记录保留；本页顶部记录新增回归。
- 最终全分支审查及唯一修复轮已完成，独立 scoped re-review 和最终批准仍由控制器继续，本文不提前宣称审查通过。
