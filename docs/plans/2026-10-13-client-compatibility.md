# MapleProxy 多客户端兼容性实施记录

历史实施记录：2026-10-13；2026-10-14 发布清理移除了私有项目相关材料。

用户已于本次会话批准实施。设计依据为 WorkBuddy 5.7.6 的本地拒绝日志、公开协议的工具历史，以及以下固定来源：

- [CLIProxyAPI 请求转换](https://github.com/router-for-me/CLIProxyAPI/blob/bf9341629ef2300ac9d846a2e80fe2756f63a671/internal/translator/codex/openai/chat-completions/codex_openai_request.go)
- [CLIProxyAPI 响应转换](https://github.com/router-for-me/CLIProxyAPI/blob/bf9341629ef2300ac9d846a2e80fe2756f63a671/internal/translator/codex/openai/chat-completions/codex_openai_response.go)
- [agent2api 转发](https://github.com/aimod-cc/agent2api/blob/e8a9d577983b3e9dcc5290b89cae20b204fcf222/desktop-tauri/src-tauri/server/src/server/core/providers/custom/forward.rs)
- [agent2api Responses 转换](https://github.com/aimod-cc/agent2api/blob/e8a9d577983b3e9dcc5290b89cae20b204fcf222/desktop-tauri/src-tauri/server/src/server/core/protocol/responses_outbound.rs)
- [官方 SIWC 限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [Responses 迁移与 strict 默认值](https://developers.openai.com/api/docs/guides/migrate-to-responses)

## Global Constraints

仅修改 MapleProxy，保留 TypeScript、官方 SIWC 上游、store:false、stream:true、完整历史、function/custom namespace、现有认证、账号选择和本机监听。无新协议入口、CLIProxy 进程、自动重试、全局会话缓存或凭据迁移。诊断只存有限元数据，不存提示词、输出、工具参数值或凭据。未知顶层模型选项维持透传；不能默默丢失消息正文或工具内容。按 TDD 先运行失败测试再实现。每阶段更新兼容性文档。自动样例通过不能记为实际应用验收通过。

## Task 1: 请求清理和能力边界

拆分 normalize.ts 的客户端字段清理与 SIWC 能力规则，保留统一 normalizeRequest 入口和 body/stream/ignoredParams/renderOptions。
增加结构化诊断 {path, action, reason} 与请求级 responseContext（后续工具响应使用）。Chat 消息按已知语义重建，name、startsNewUserRequest、reasoning_content 及未知附加字段过滤并记录路径；未知角色、内容类型及工具类型仍明确拒绝。
已知可选协议字段 null 按未提供处理，空 tools/stop 无作用；不递归清理 JSON Schema、工具 arguments 或业务 JSON。Responses 保留原生结构，仅清理明确已知的客户端元数据，保留 encrypted reasoning、namespace、compaction。
忽略列表增加 stop、seed、frequency_penalty、presence_penalty、logit_bias、top_k、min_p、repeat_penalty；通过 ignoredParams/诊断报告。n>1、实际概率输出、持久会话、不支持媒体和工具仍拒绝。Chat 接受可对应的 reasoning/text；与 reasoning_effort/response_format/verbosity 冲突时报具体路径错误。
测试复现 WorkBuddy 附加字段及合成协议字段、null/default、未知字段透传、JSON null 保真、原生历史保真、拒绝项。旧式 functions/function_call 留给 Task 2。提交源码、测试和文档。

## Task 2: 工具往返和旧式函数接口

Chat 函数 strict 缺省/null 显式 false，布尔值保留；原生 Responses 默认不变。保留合法名称、调用 ID、arguments、顺序及并行结果配对，使用请求上下文恢复客户端名称。支持 tool-only content:null 助手历史；函数空白 arguments 规范为 "{}"，custom input 不变。
缺失、重复或无法唯一配对的工具结果明确报错，不删除调用或编造结果。保留合法 Responses 的 named outputs 和原生本地工具语义。
转换旧 functions、function_call、role:function 到统一工具结构，旧式请求还原 legacy 响应（非流式及流式），与现代字段冲突拒绝。不得全局缓存；补齐第二轮与并行 roundtrip、旧式响应、名称恢复、strict 和不合法历史测试。把 renderOptions 接上响应上下文，兼容已有调用签名。更新兼容性文档并提交。

## Task 3: 响应语义和 SSE 传输

实际收到 reasoning summary 映射 Chat reasoning_content，支持增量和最终补齐且不重复，不主动开启摘要或生成思考文本。工具 index/id/name/arguments 稳定可组装，完整事件补齐不重复。
Chat token 限制 incomplete => finish_reason:length，内容过滤 => content_filter；Responses 原生保留 incomplete。未知 Chat 截断原因明确报错。区分失败，不产生成功结束标记。
首个输出前失败返回 HTTP JSON；开始流后错误帧。流开始后空闲 15 秒发送 SSE 注释心跳，保留背压、取消和总超时；异步迭代器无并发 next、无遗留等待或未处理拒绝。
先加入事件及真实 HTTP 回归（UTF-8 分片、工具增量、usage、reasoning、截断、提前/中途错误、心跳、取消），再实现。接口为 Task 4 提供 incomplete 结果识别。更新文档并提交。

## Task 4: 安全诊断和管理页面

校验前记录安全模型标识，记录失败阶段、HTTP 状态、错误代码、完整参数路径、是否已调用上游、被过滤/转换字段。修复 messages[2].reasoning_content 等数组路径变成 param:null。区分 localRequestId/upstreamRequestId，保留 requestId 兼容性。
管理页展示诊断详情和“未完整完成”状态。最多 200 条内存有限元数据，不泄露提示词、输出、工具参数值、凭据；限制客户端键名长度及诊断数量。失败也保留已有诊断。
测试本地拒绝上游调用为零、完整错误路径、模型/阶段、两种请求 ID、incomplete、UI 显示、隐私及有限容量。更新文档并提交。

## Task 5: 客户端合同回归及发布验证

补齐 WorkBuddy、agent2api 两种模式及标准 SDK 的合同夹具，记录来源版本。合成上游验证正文、工具参数、encrypted reasoning 未丢失；覆盖 tools 第二轮、include_usage、并行结果、非流式 JSON、图片文件及结构化输出。测试明确拒绝项不调用上游。
运行 npm test、npm run typecheck、npm run build。必要修复遵循 TDD。兼容文档明确“支持 / 过滤但不生效 / 明确不支持 / 尚未实际验收”。完成独立代码复核。
由主代理保留上一版 dist 后进行一次服务重启，保持生产认证/账户数据。实际 WorkBuddy 和 agent2api 各做简短对话与只读工具往返，记录版本、协议、请求 ID、结果；不可用应用或需用户操作时如实记录未验收，不以夹具冒充。不修改 agent2api。
