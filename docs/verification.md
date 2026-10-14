# 验证记录（2026-10-14）

## 2026-10-14 跨设备 ChatGPT 登录（Task 2 仪表盘、夹具与文档）

前端按 Task 1 已冻结的 Job/SignInRequest/API 实现复制链接登录与重新授权、按原 expiresAt 倒计时、完整回调提交、纠错、取消、原 options 重试和 active 恢复。回调和授权链接只在前端内存中；退出或本地会话失效同步清空，并通过请求版本及最新轮询序号拒绝旧恢复、POST、状态响应。API 也隔离旧会话的迟到 401/CSRF，防止重新登录后被旧请求覆盖。

| Task 2 新执行的检查 | 结果 |
| --- | --- |
| RED：`npx vitest run tests/web-api.test.ts tests/web-view.test.ts` | 4 failed / 13 passed：缺少 typed sign-in helper、手动入口及 preparing/exchanging 区分。 |
| RED：`npx vitest run tests/web-sign-in.test.ts` | 接口骨架上 8 failed / 1 passed：恢复、重复提交、旧轮询、链接轮换、原参数重试和退出隔离缺失；1 项原有空状态通过不作为 RED。 |
| RED：`npx vitest run tests/web-sign-in-copy.test.ts` | 1 failed：缺少实际 UI 共用的剪贴板拒绝与手动选择 helper。 |
| RED：`npx vitest run tests/web-api.test.ts tests/web-sign-in.test.ts` | 扩展竞态回归 3 failed / 17 passed：旧会话 401 清空新会话、bootstrap 恢复旧 CSRF、重叠旧轮询覆盖更新链接。 |
| RED：`npx vitest run tests/smoke-fixture.test.ts -t 'supports isolated manual'` | 1 failed / 3 skipped：原 fixture 不产生 awaiting_callback。使用提权执行临时文件原子 rename 与真实 loopback；失败来自断言。 |
| GREEN：`npx vitest run tests/web-api.test.ts tests/web-view.test.ts tests/web-sign-in.test.ts tests/web-sign-in-copy.test.ts` | 4 files、30/30 通过。 |
| GREEN：`npx vitest run tests/smoke-fixture.test.ts` | 4/4 通过，真实本机 HTTP 验证无效回调纠错、两秒交换、retry 新链接与不变截止时间、合成账户完成和取消。 |
| `npm run typecheck` / `npm run build` | exit 0，包含 vendor/server/web。 |
| 恢复收尾：Prettier `--check` / `git diff --check` | 14 个 Task 2 脚本、测试及前端文件格式检查通过；差异空白检查 exit 0。仅补充文档，未重跑先前已通过的测试及构建。 |
| 控制器本轮全套验收：`npm test` | 25 files、343/343 Vitest 通过；vendor 56 通过、1 项 Windows 平台跳过。 |
| 控制器本轮全套验收：`npm run typecheck` / `npm run build` | 均 exit 0。 |
| 控制器本轮许可证与 notices 验收 | 许可证检查验证 12 个 artifacts；`npm run notices:generate` exit 0，生成结果无漂移。 |

此 Task 2 自动测试只使用合成账户、回调、密码和临时目录；没有 provider 请求，也没有生产测试开关。剪贴板拒绝通过实际 UI 使用的函数注入拒绝 Promise 验证，成功提示与失败提示互斥；SSR 验证阶段内容和只读 URL。它们不替代浏览器交互测试。

### 跨设备登录浏览器验收（控制器，2026-10-14）

控制器使用 `npm run smoke` 的隔离合成 fixture 完成本轮交互验收，收尾者依据移交证据记录，未重新操作浏览器或重跑上述已通过检查。

| 操作 | 已观察结果 |
| --- | --- |
| 复制授权链接 | 浏览器剪贴板内容与页面当前完整授权 URL 一致。 |
| 剪贴板拒绝后的手动复制 | 隔离构建副本注入 `NotAllowedError` 后，实际点击复制按钮只显示失败回退提示；只读授权文本框获得焦点并全选，Ctrl+C 后浏览器剪贴板与完整链接一致。 |
| 无效回调纠错 | 错误提示可见，原输入保留，可以修改后再次提交。 |
| 刷新 / 退出后重新登录 | 恢复同一任务、同一链接及原截止时间，倒计时继续依据原期限。 |
| 合成 retry 回调 | 生成新链接，输入清空，显示“授权链接已更新，请重新复制”，期限未重置。 |
| 合成成功回调 | 交换完成后显示成功并刷新账号列表。 |
| 既有 B 账号重新授权、取消及重试 | 保留原 profileId 与重新授权选项，重试仍作用于 B。 |
| 原浏览器模式 | Continue with ChatGPT 入口可用，显示原 5 分钟期限。 |
| 桌面 / 窄屏布局及控制台 | 1365×900 与 390×844 无水平溢出；浏览器 console warning/error 为空。 |

截图保存在忽略的可视化目录 `C:/Users/98356/.codex/visualizations/2026/10/14/01a1395b-3c4a-7111-a5d1-5f88738b3921/`，文件为 `remote-login-desktop.jpg`、`remote-login-mobile.jpg`、`remote-login-copy-fallback.jpg`。

剪贴板回退的补充浏览器验收使用忽略目录 `.superpowers/sdd/2026-10-14-remote-chatgpt-login/clipboard-fixture/web/dist` 内的构建副本，只将该副本的授权链接剪贴板调用改为以 `NotAllowedError` 类型 DOMException 拒绝的 Promise；生产源码和构建产物未修改。runner 导入原 smoke fixture 并以隔离目录作为 cwd，监听本机端口 59799。实际点击按钮后只有失败回退提示，没有成功提示；授权文本框 `readOnly=true` 且已聚焦，`selectionStart=0`、`selectionEnd=140` 与 `value.length=140` 一致。随后通过 `ControlOrMeta+c` 手动复制，浏览器剪贴板与完整授权 URL 精确相等。这验证注入拒绝后的真实界面回退和手动复制，未验证原生权限拒绝或操作系统权限弹窗。控制器已恢复端口 50873 的正常隔离 fixture。应用恢复后遵从用户要求，未再关闭内置浏览器或其标签页。

stdin 的 callback/retry/fail 打印当前合成回调，rotate 更新链接，complete 完成浏览器模式，stop 正常关闭隔离服务；具体格式见 [README](../README.md)。

**真实跨设备 OAuth 仍待用户亲自验证**：在另一台设备完成官方授权、复制地址栏完整回环 URL、本机提交并完成身份验证；合成 fixture 通过不证明实际账户权限或远端浏览器行为。下文其他浏览器记录属于此前功能阶段，与本轮跨设备验收分别记录。

## 2026-10-14 持久化密钥复制（Task 2 前端与文档）

本轮在隔离 worktree 使用合成密钥，前端通过 `canCopy` 区分可复制与旧密钥。列表仅在点击后向受保护的 `POST /api/admin/keys/:id/secret` 取回原值并直接交给剪贴板；复制成功提示等待 `writeText` 完成，失败提示可重试。新建卡片与列表均不把原值拼入请求示例。此段保留 Task 2 当时的记录；随后控制器完成的本功能浏览器验收见下文。

| Task 2 检查 | 结果 |
| --- | --- |
| RED：`npm run test:unit -- tests/web-view.test.ts` | 新用例 2 failed / 原有 3 passed；缺少列表复制、旧密钥提示与创建说明。 |
| RED：`npm run test:unit -- tests/web-api.test.ts` | 新用例 2 failed / 原有 4 passed；缺少复制请求与剪贴板操作。 |
| GREEN：`npm run test:unit -- tests/web-view.test.ts tests/web-api.test.ts` | 11/11 通过；之后补充后端拒绝时不写剪贴板的断言。 |
| `npm test` | 21 files、300/300 Vitest 通过；vendor 56 通过、1 项 Windows 平台跳过。 |
| `npm run typecheck` / `npm run build` / `git diff --check` | 均 exit 0；构建包含 web 产物。 |

服务端 Task 1 由控制器验证：默认 DPAPI 存储的真实往返通过；使用合成会话 cookie 与 CSRF、伪造外部 Origin 的原值 POST 返回 403、`Cache-Control: no-store`，未泄露原值。旧密钥没有保存完整值，不可恢复；新密钥跨重启复制依赖原 Windows 用户及其 DPAPI 环境。

### 持久化密钥复制的后续浏览器验收（控制器，2026-10-14）

隔离的 `scripts/smoke.ts` fixture 使用 loopback 端口 64653 和合成数据。控制器创建密钥，隐藏新建卡片后从列表复制，浏览器剪贴板与刚创建的原值一致；刷新、切换标签页及退出后重新登录，列表复制仍得到同一原值。仅在该 fixture 中植入的一条旧版仅存哈希密钥显示禁用复制及“旧密钥未保存完整值，请新建密钥后复制。”。桌面 1365×900 与窄屏 390×844 的截图和 DOM 检查确认两行操作与说明可见，document scrollWidth 分别为 1350 和 375，没有水平溢出。截图位于忽略的可视化目录 `C:/Users/98356/.codex/visualizations/2026/10/14/01a1392d-df76-7792-9384-a3b9b9a0e4e5/`，文件为 `key-copy-desktop.png`、`key-copy-mobile.png`。

控制器临时让构建产物中的 `clipboard.writeText` 抛出 `NotAllowedError`：页面只显示失败提示，没有成功提示，按钮恢复可点；再次尝试仍显示失败。受控延迟剪贴板桩使按钮显示“复制中…”且 `disabled=true`，写入完成前没有成功提示。隐藏浏览器中的延迟原生写入一直未完成，检查状态后已导航离开，因此不声称该原生延迟写入成功，也不声称验证了操作系统权限弹窗。单元测试覆盖等待 `writeText` 完成的语义。额外 live HTTP 检查使用有效管理 cookie/CSRF 加外部 Origin，得到 403、`no-store` 且无原值泄漏；最终定向回归也覆盖这一矩阵。以上证据见忽略工作区 [browser-report](../.superpowers/sdd/2026-10-14-persistent-key-copy/browser-report.md)。

### 持久化密钥复制最终修复验证（2026-10-14）

列表复制失败提示改为“复制失败，请稍后重试。”，不再将所有取回失败归因于剪贴板权限，也不显示服务端异常内容。渲染回归直接断言含“复制中…”的按钮处于禁用状态；原值 POST 回归增加有效 cookie/CSRF 下的外部 Origin，要求 403、`no-store`、响应体无原值。请求钩子保留在 Host/Origin 检查之前设置的 API `no-store`，移除后续重复设置，非 API 路径继续应用 CSP。定向 `npm run test:unit -- tests/server.test.ts tests/security.test.ts tests/web-api.test.ts tests/web-view.test.ts` 为 4 files、53/53 通过；`npm test` 为项目 21 files、300/300 通过，vendor 56 通过、1 项 Windows 平台跳过；`npm run typecheck` 与 `npm run build` 均 exit 0。新增的两个回归断言覆盖此前已实现的行为，首次运行即通过，不声称 RED。

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

未新增浏览器、真实 OAuth 或真实远端推理验收；原浏览器限制和历史 Task 4 首次 integration GREEN 事实保留。最终独立 scoped re-review 已确认提交 `bff7ae8` 中六项原发现全部解决，没有新增 Critical/Important 问题；以下保留非阻塞边界及控制器裁定。

复审发现 Minor N1：若上游 SSE 包含损坏的 JSON，且底层 body cancellation 延迟结算，SDK decoder 的清理等待可能推迟错误返回，最终以总期限的 `request_timeout`/504 结束。受控内存探针在 `timeoutMs=80` 时约 83ms 返回；生产默认总期限为 180 秒。正常原生 `event:error` 经 renderer 处理会及时中止，未观察到错误成功、永久挂起或凭据泄漏。控制器将 N1 作为已知非阻塞限制保留：它需要损坏输入与延迟取消同时出现，有既有总期限约束，不影响已验证的正常错误/取消链路；本轮不再扩展修复范围。升级 SDK decoder 时须连同这条边界复验。

最终审查、修复、复审已完成；原临时审查包按执行流程清理，本文件和 Git 历史保留交付结论与验证证据。

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
- 最终全分支审查、唯一修复轮及独立 scoped re-review 已完成；控制器接受上述有总期限约束的 Minor N1，保留真实授权验收和浏览器检查限制。
