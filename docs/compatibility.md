# HTTP 兼容性

本文件描述此版本 MapleProxy 的实现与本地验证边界；上游实际可用性需要真实授权账户确认。政策依据是 [SIWC Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) 与 [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)，核对日期 2026-10-13。MapleProxy 不等同于完整 Platform API。

## 路由和生命周期

| 项目 | 实现 |
| --- | --- |
| `GET /v1/models` | Bearer 本地密钥；从默认账户官方目录中取 `visibility:list`，`slug` 映射 `id`；返回 OpenAI `object:list`。不使用硬编码生产模型列表。 |
| `POST /v1/responses` | 原生受支持的 Responses 请求；下游默认非流式，可 `stream:true`。 |
| `POST /v1/chat/completions` | 将可表示的 Chat 输入转为 Responses，响应转为 Chat 格式；只有单个 choice。 |
| 上游 | 固定公开 `/v1/responses`，`store:false, stream:true`。`store:true` 明确拒绝；下游 `stream:false` 等待完整上游后聚合。 |
| 身份 | 每次请求开始确定账户。手动默认切换影响新请求；停用/退出中止该账户。不会重试、切换备用账户或回放。 |
| 凭据 | 本地 API key 仅授权推理；管理 cookie 仅授权管理。OAuth token 仅在可信服务器进程/Windows DPAPI 保存。 |
| 未实现 API | Files 上传、音频/转录、图像生成、Embeddings、Completions、Assistants、Batch、Responses retrieve/delete/cancel、独立 compact/token-count 端点均不存在（JSON 404）。 |
| 传输 | HTTP/SSE；不提供 WebSocket 会话、跨连接继续、远程 CORS/HTTPS。 |

## 输入和输出

| 能力 | Responses | Chat Completions |
| --- | --- | --- |
| 文本/历史 | 字符串 `input` 转 user 消息数组；支持 user/developer/assistant；system 转 developer；`instructions` 透传。原生历史保留结构，仅过滤 message 的明确客户端元数据 `name`/`startsNewUserRequest`/`reasoning_content`。 | `messages` 中 system 转 developer；支持文本历史与 assistant 内容/拒绝/引用；按协议语义重建消息，过滤 `name`、`startsNewUserRequest`、`reasoning_content` 及未知消息附加字段，并记录完整字段路径。未知角色、内容/工具类型仍拒绝。 |
| 图片输入 | `input_image` 的 URL/data URL；可用 detail 为 auto/low/high/original。 | user 等输入中的 `image_url` 转 `input_image`；assistant media 拒绝。 |
| 文件输入 | `input_file` 的内联 `file_data` 或 `file_url`，保留 filename 等字段。`file_id` 拒绝。 | `file` 映射内联 `input_file`，同样拒绝上传 ID。 |
| Function/custom 工具 | function/custom 平铺定义转换为稳定 namespace；原生 namespace、`additional_tools` 保留。支持 custom text 或 lark/regex grammar；strict 缺省保留原生默认。 | function/custom 定义、调用、工具结果双向映射；保留原始 `call_id` 作为 Chat 工具 ID。function strict 缺省/null 显式转换为 false，布尔值保留。 |
| 工具调用历史 | function/custom call + output 按调用 ID、类型及唯一结果配对；缺失/重复/孤立结果拒绝。显式 namespace、顺序及合法 named function output 保留；named output 对应多个待处理调用时拒绝。原生本地工具历史保留其独立语义。 | 支持 tool-only `content:null` 助手历史；assistant `tool_calls` 与 tool 结果须唯一配对，允许并行结果按客户端顺序回传。函数空白 arguments 规范为 `"{}"`，非空 JSON arguments 及 custom input 保留原字节。 |
| 旧式函数接口 | functions/function_call 为 Chat 专属，不接受。 | `functions`、顶层/助手 `function_call`、`role:function` 转统一工具结构；函数结果按名称唯一配对，缺失/重复/不明确结果拒绝。顶层 functions/tools、function_call/tool_choice 或助手 function_call/tool_calls 同时提供时拒绝。旧请求返回 `message.function_call`/`delta.function_call` 和 finish_reason:function_call；上游并行或 custom 调用无法表示时明确报 unsupported_output。 |
| 本地工具 | shell/local_shell/apply_patch 定义及对应 call/output 历史保留；由客户端执行。 | 非 function/custom 输出不能无损表示时返回 `unsupported_output`；使用 Responses。 |
| Web search | 支持 web_search 与日期/preview 别名、搜索事件/引用；能力取决于模型和账户政策。 | 不接受 `web_search_options`；上游搜索消息的 URL 引用映射为 Chat annotations。 |
| Reasoning | `reasoning` 的 effort/summary/generate_summary 与加密 reasoning 历史保留；effort 的未知字符串由上游判断，非字符串拒绝。 | 接受 `reasoning`；`reasoning_effort` 映射 effort，未知字符串同样交由上游。两种字段同时设置且 effort 不一致时，错误路径为 `reasoning_effort`。不会生成不存在的思考文本，也不能承载加密 reasoning 历史。 |
| 文本格式 | `text.format` 支持 text/json_object/json_schema，`text.verbosity` 支持 low/medium/high。 | 接受 `text`；`response_format` 转 `text.format`，`verbosity` 合并进 text。重复字段等值可合并，不一致时报 `response_format` 或 `verbosity` 路径错误。 |
| 高级原生字段 | `parallel_tool_calls`、`tool_choice`、`prompt_cache_key`、`prompt_cache_options`、`service_tier`、`access_programs`、`context_management` 透传受支持结构；未知模型选项透传，由上游决定。 | 接受可对应字段和未知模型选项；已知原生专属字段使用 Responses。Responses 拒绝已知 Chat 专属 messages/reasoning_effort/response_format/verbosity。 |
| `include` | 接受 web_search_call.results / web_search_call.action.sources / message.input_image.image_url / reasoning.encrypted_content。 | 原生专属 `include` 不接受。 |
| 输出 | 原生完整 final response 和 SSE events 保留（含 reasoning/compaction/本地工具等非文本项）；失败另追加结构化错误。 | text/refusal、function/custom call、URL annotations、finish_reason、usage；reasoning/web_search item 本身不变成文本。其他非文本输出拒绝。 |

代理验证格式并做转换，不能保证任意模型接受所有图片/文件/工具/effort/高级字段。[Responses API schema](https://developers.openai.com/api/reference/resources/responses/methods/create) 是格式参考；SIWC 能力还受专属限制。

## 参数处理

以下普通参数在兼容模式被移除：`temperature`、`top_p`、`max_tokens`、`max_completion_tokens`、`max_output_tokens`、`metadata`、`safety_identifier`、`user`、`stop`、`seed`、`frequency_penalty`、`presence_penalty`、`logit_bias`、`top_k`、`min_p`、`repeat_penalty`。响应通过 `X-MapleProxy-Ignored-Params` 列出名称，管理活动记录保存名称；**max_tokens、stop 等不会限制实际输出长度或终止位置，采样选项也不生效**。客户端应查看此 header，并自行约束需要的生成行为。

已知可选协议字段的 `null` 按未提供处理；空 `tools:[]`/`stop:[]` 无作用。`n:1`（Chat）、`logprobs:false`、`top_logprobs:0`、`background:false` 和 Chat `modalities:["text"]` 是可省略默认值。清理只访问已知协议位置，不递归清理 JSON Schema、函数 arguments、自定义工具 input 或业务 JSON；这些结构内部的 `null` 保留。未知顶层选项的 `null` 同样保留，必填字段的 `null` 仍触发校验错误。

请求规范化结果提供 `{path, action, reason}` 诊断，包含被过滤或转换字段的路径与固定原因，不包含字段值、提示词、输出、工具参数或凭据；后续校验失败也保留已有诊断。`responseContext` 在每个请求内记录工具名称映射及旧式响应模式，接入流式与非流式 renderer，通过定义和完整历史恢复客户端名称；上游缺少 namespace 且同名工具不唯一时拒绝。上下文不会发送上游，没有全局会话缓存；诊断持久化和管理页展示尚待后续阶段。

未知顶层模型选项（包括对象/标量）保持原值透传；JSON 自有键如 `__proto__` 不会改变请求对象原型。未知 effort 字符串保留，类型仍须 string 或 null。此政策不表示任何真实模型支持这些选项；已知路由语义和结构验证优先适用。

语义不受支持时返回 HTTP 400，带 `unsupported_parameter`、`unsupported_input` 或 `unsupported_tool` 等代码：

- 持久状态：`store:true`、`previous_response_id`、`conversation`、`background`、`prompt`；每次请求必须提供完整上下文。
- 其他请求语义：`moderation`、`multi_agent`、`max_tool_calls`、`prompt_cache_retention`、`truncation`、实际请求概率输出的 `top_logprobs`、audio/prediction。
- Chat 多 choice (`n` 仅允许 1)、`logprobs` 仅接受 false、`modalities` 仅接受 `["text"]`；其他值拒绝。
- 输入 audio/video；上传文件引用；服务端 image_generation/file_search/code_interpreter/computer/MCP/connectors/tool_search/programmatic_tool_calling。function/custom 的 defer_loading 或非 direct allowed_callers 同样拒绝。

`tool_choice` 支持 auto/none/required、可对应 named/allowed choices 及原生受支持本地工具/搜索 choice。内部命名规则：

- 平铺工具同名跨请求得到 `_mpf_v1_` 加名称 SHA-256 前 32 个 hex 的 namespace；这一 namespace 前缀保留，调用者不能自建冲突 namespace。
- 真实 native namespace/name 需在 Chat 中表示时，名称编码为 `_mpn_` + canonical base64url(JSON `[namespace,name]`)；下一请求解码恢复。该前缀保留，格式无效/非 canonical 直接拒绝。
- Chat 名称必须符合字母/数字/下划线/连字符且 1–64 字符；编码后超过 64 返回 `unsupported_output`，使用 Responses 可保留长 identity。
- native named choice schema 没有 namespace 选择器，编码 namespace 特定的 Chat named/allowed choice 会拒绝，避免选择不明确的同名工具。

## SSE、错误与界限

| 项目 | 行为 |
| --- | --- |
| 流成功 | Responses 必须收到 `response.completed` 且 status 为 completed。Chat 完成才发送 finish_reason 和 `[DONE]`。 |
| 流失败 | `response.failed` / incomplete / explicit error / 中断 EOF 不会产生成功终止标记或成功 usage chunk；已经开始流时追加 `event:error`，data 为标准 `{error:{message,type,code,param,request_id}}`。客户端需处理流事件，HTTP 200 不代表完成。 |
| 原生终止事件 | Responses 保留原生 failed/incomplete 等事件，包括上游 error payload，再追加 MapleProxy 通用错误 envelope；不把原生事件改写为成功。 |
| 非流式失败 | 返回结构化 HTTP 错误；已获取的上游 request ID 在 header/envelope 中保持。无法聚合 partial 为成功答案。 |
| Chat usage | 非流式从完成对象映射；流式默认不发 usage，只有 `stream_options.include_usage:true` 时普通 chunk 为 usage:null、最后 choices:[] usage chunk；失败时不发最终 usage。 |
| stream options | Chat include_usage 只供下游 renderer，绝不发上游；include_obfuscation 可透传，两者须 boolean；Responses 仅接受 include_obfuscation。 |
| 背压与取消 | 真实 HTTP write 返回 false 时等待 drain；客户端断开中止运行时请求。取消不重放；已输出内容无法收回。 |
| 推理超时 | runtime 默认总期限 180 秒，覆盖 headers 与 SSE body。constructor 可设置正整数 timeoutMs；生产没有环境/HTTP 超时配置。超时返回 request_timeout/504（流开始后按 SSE 错误）。 |
| 其他期限 | DevKit 普通远端 fetch 默认 30 秒；管理 OAuth job deadline 5 分钟。客户端需自行配置适合的请求 timeout。 |
| 管理恢复 | 上游目录 401 保留管理会话/CSRF 并显示资源错误；仅本地 admin_unauthorized 401 使管理会话失效。OAuth 超时任务标记失败，旧取消真正结束前新登录返回 sign_in_busy。 |
| 请求体 | 整个 JSON 最大 32 MiB，超限 413/body_too_large。内联 base64 增加约 33% 体积，还需留其他字段空间；代理上限不保证模型文件上限。 |
| Activity | 最多 200 条内存元数据，无 prompt/output/token；ignored 名称可见，重启清空。 |

本地 function/custom/shell/apply_patch 等的执行权限、沙箱、文件操作和工具结果由下游客户端负责；代理只传递调用与历史，不执行这些工具。[官方 Function calling](https://developers.openai.com/api/docs/guides/function-calling) 描述调用与回传流程。

HTTP 无持久会话，工具多轮应把之前 input、全部相关 output（包含加密 reasoning）、工具结果放回下次 input。不要只保留可读文本，或用 previous_response_id 替代历史。`context_management`/compaction item 是本次请求传递的上下文结构，不会创建网关会话；网关没有独立 compact API。[官方 Conversation state](https://developers.openai.com/api/docs/guides/conversation-state)

## 上游、参考实现与验证边界

使用官方 [Sign in with ChatGPT DevKit](https://github.com/openai/sign-in-with-chatgpt-devkit) commit `0a36fefeb913055c8c7a1a29b63d82b96b2e841a` 的 local package，保留 [LICENSE](../vendor/siwc/LICENSE)（非商业许可）、原始 OAuth 测试与 notices。标记修改覆盖 per-profile 请求/取消、手动 enabled/default、多账户事务、Windows DPAPI 注入、完整 Responses event iterator、fetch 隔离、body lifetime 和安全错误处理；见 [PROVENANCE](../vendor/siwc/PROVENANCE.md)。没有私有 backend-api 依赖。

实现核对了官方 [openai-node streaming example](https://github.com/openai/openai-node/blob/main/examples/stream-to-client-express.ts) 和业内 [CLIProxyAPI Responses translator](https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/translator/openai/openai/responses/openai_openai-responses_request.go)，仅作协议/生命周期参考，没有复制其代码或采用其更广泛能力假设。本地集成证据见 [verification](verification.md)；真实 OAuth、套餐权限、模型接受性仍待用户授权后的真实 smoke。

2026-10-13 请求兼容阶段还核对了固定 commit 的 [CLIProxyAPI Chat 请求转换](https://github.com/router-for-me/CLIProxyAPI/blob/bf9341629ef2300ac9d846a2e80fe2756f63a671/internal/translator/codex/openai/chat-completions/codex_openai_request.go)。新增自动合同测试复现 WorkBuddy/PFM 的附加字段、可选 null/default、原生 reasoning/namespace/compaction 历史和 JSON null 保真。WorkBuddy、PFM/openJiuwen、agent2api 的实际应用往返仍为**尚未实际验收**，合同夹具通过不代表实际应用已验收。

2026-10-14 工具兼容阶段核对 [官方 function calling strict 默认值](https://developers.openai.com/api/docs/guides/function-calling) 和 [openai-node Chat 协议类型](https://github.com/openai/openai-node/blob/main/src/resources/chat/completions/completions.ts)，实现 Chat 非 strict 默认与 legacy function_call 字段。新增合成往返测试覆盖第二轮并行结果、名称恢复、strict、空白函数参数、旧式流式/非流式响应、非法工具历史，以及 HTTP renderer 的请求级上下文隔离；不代表真实客户端或账户已验收。
