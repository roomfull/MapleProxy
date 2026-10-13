# 客户端兼容性验证记录（2026-10-14）

本轮 Task 5 的自动证据均来自合成请求、临时账户/密钥、本机 HTTP 上游与真实生产运行时的测试依赖注入。没有从真实客户端捕获完整请求，没有使用真实账户执行本文件所列自动测试。生产服务重启、浏览器验收、独立复核及实际应用往返由主代理记录；未记录结果的项目保持未验收。此前的[2026-10-13 验证记录](verification.md)保留原样。

## 固定来源与夹具边界

| 合同                       | 来源版本 / 证据                                                                                                                                                                                                                                                                                                                                                                                                             | 夹具与限制                                                                                                                                                                 |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WorkBuddy                  | 安装 UI 5.7.6.0；原失败报告标为 5.7.6，字段 `startsNewUserRequest` 返回 unsupported_parameter。                                                                                                                                                                                                                                                                                                                             | 仅该字段有原始失败证据；正文、模型和其他结构均合成，没有完整原始请求捕获。本次 200 只证明该合成合同通过。                                                                  |
| PFM / openJiuwen           | PFM checkout HEAD `564459636efac48df417191f7144413110afb90c`，branch dev；SDK `com.openjiuwen:agent-core-java:0.1.13.post1`；BaseModelClient.java:189–218,296–345。                                                                                                                                                                                                                                                         | 源码导出的 nested function/tool_call_id、reasoning_content、sampling 字段结构；值为合成配置值，未声称是实际默认值。HEAD 不证明工作目录无修改，另固定文件哈希。             |
| PFM raw streaming consumer | OpenAiRawDebugModelClient.java:350,681–692,1160–1260。                                                                                                                                                                                                                                                                                                                                                                      | include_usage 默认 true、choices:[] usage、data 行/[DONE] 和完成后聚合工具。测试只重放这些消费规则，没有运行 Java 客户端。                                                 |
| Agent2API Chat             | [forward.rs](https://github.com/aimod-cc/agent2api/blob/e8a9d577983b3e9dcc5290b89cae20b204fcf222/desktop-tauri/src-tauri/server/src/server/core/providers/custom/forward.rs#L190-L227)，固定 `e8a9d577983b3e9dcc5290b89cae20b204fcf222`。                                                                                                                                                                                   | 合成的是 alias 已改写、内部 `_wb_*` 与跨协议工具已移除后的出站体；未运行 Rust 转换器。                                                                                     |
| Agent2API Responses        | 同 commit 的 [forward.rs:477–512](https://github.com/aimod-cc/agent2api/blob/e8a9d577983b3e9dcc5290b89cae20b204fcf222/desktop-tauri/src-tauri/server/src/server/core/providers/custom/forward.rs#L477-L512) 和 [responses_outbound.rs:54–260](https://github.com/aimod-cc/agent2api/blob/e8a9d577983b3e9dcc5290b89cae20b204fcf222/desktop-tauri/src-tauri/server/src/server/core/protocol/responses_outbound.rs#L54-L260)。 | 合并 instructions、reasoning summary:auto、store:false、强制 stream:true、原生加密 reasoning、空参数转换成 {}、稳定 call_id。安装的 3.0.3 与该源码 commit 对应关系未核实。 |
| 标准 SDK                   | package-lock.json 中 openai-node `7.32.0`。                                                                                                                                                                                                                                                                                                                                                                                 | 既有 integration.test.ts 真正执行官方 JS SDK；上游仍是本机合成 HTTP。没有把重复 SDK 测试作为实际 PFM 消费证据。                                                            |

PFM SDK sources jar SHA-256：`9312B13C0A7ABE4A1A7840D646C9136ADAEC7647D73B49BD6878A0C484322F7A`；RawDebugModelClient.java SHA-256：`C61A61949795A229288A052D6DEE618490DB3E031A4736FFE185516BC1E56FCA`。来源分别为本机 Maven `com/openjiuwen/agent-core-java/0.1.13.post1` sources jar 和 PFM `workbench-core/src/main/java/com/pfm/jiuwen/integration/jiuwen/OpenAiRawDebugModelClient.java`。完整本地读取记录在临时计划资料 `.superpowers/sdd/2026-10-13-client-compatibility/acceptance-prep.md`（不纳入 Git）；仓库保留来源标签、哈希与[合成夹具](../tests/fixtures/client-contracts.ts)。固定 GitHub 源码已由主代理成功只读取得并保存于本地计划 sources 目录；未执行远端代码。

## 本轮自动验证

| 命令                                                                        | 结果                                                                                                                        |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `npx vitest run tests/client-contracts.test.ts tests/smoke-fixture.test.ts` | 2 files，15/15 通过（12 项新客户端合同 + 3 项 QA fixture 生命周期/种子行为）。                                              |
| `npm test`                                                                  | 20 project files，269/269 通过；DevKit 56 通过、1 平台跳过、0 失败，exit 0。                                                |
| `npm run typecheck`                                                         | server/tests/scripts、web、vendor 均通过，exit 0。首次发现新测试中可缺省帧访问，修正后定向合同 12/12 再通过；未改生产行为。 |
| `npm run build`                                                             | vendor/server/web/assets 构建完成，exit 0；未由本子任务重启生产服务。                                                       |

[client-contracts.test.ts](../tests/client-contracts.test.ts) 使用真实下游 loopback HTTP、生产 AccountRuntime/DevKit 和本机 HTTP 上游捕获序列化请求，验证正文、参数、稳定 ID 与原生加密载体。PFM 合成两工具流包含增量、done 和 final 快照，断言参数无重复、单个 finish、唯一 [DONE]、choices:[] usage 最后、正常 chunk usage:null；第二轮按 beta/alpha 逆序返回结果并检查关联。sampling/user/seed/stop 过滤有 header 和 Activity 诊断；测试不把这些参数当作有效生成控制。Agent2API 两种模式分别验证出站 body；Responses 流保持原生事件，MapleProxy 未增加其 own summary:auto。

另有内联图片/文件和 json_schema 的 HTTP 全链路，Schema 与业务 JSON 的嵌套 null 保真，非流式返回合法 JSON。7 类明确拒绝（n:2、logprobs:true、top_logprobs:1、音频、file_id、previous_response_id、file_search）同时断言安全 400 envelope/code/param/本地 ID、runtime 入口次数 0、上游 HTTP 请求数 0。通用工具/custom/legacy、加密 replay、UTF-8 分片、incomplete/失败、心跳/背压/取消/期限使用既有测试补充，不重复宣称新增。

[smoke-fixture.ts](../scripts/smoke-fixture.ts) 仅为测试服务：新建 OS 临时目录、临时密钥及合成账户，种子通过真实 HTTP 写入成功、运行时错误、验证失败和未完整完成四类 Activity，随后撤销临时密钥；不导入生产入口、不增加 HTTP/环境开关、不启动 OAuth。新增 validation 记录展示完整字段路径/诊断与本地 ID；incomplete 记录展示 HTTP 200、max_output_tokens 和不同的本地/上游 ID。关闭服务删除其自建目录，初始化失败清理行为仍通过。TDD RED 先见“仅 error/success 两行”的预期断言失败，随后补 seed 得到 GREEN。

## 实际应用验收矩阵

以下是主代理移交的当前前置状态，不是本子任务重新执行的实际应用结果。短对话、只读工具 invocation、工具结果后的模型回复均须有真实客户端证据和 MapleProxy requestId，才能登记 PASS。仅有工具声明或 gateway curl 不计应用工具往返成功。

| 应用 / 模式                   | 当前状态         | 已知前置条件 / 待补证据                                                                                                                                                                  |
| ----------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WorkBuddy 5.7.6.0             | **尚未实际验收** | 已配置 gpt-6-luna；原始 startsNewUserRequest 失败仍可见。需重启后的真实短对话与只读工具往返，记录协议、模型、requestId 和结果。                                                          |
| PFM / openJiuwen 0.1.13.post1 | **尚未实际验收** | 前端 `http://127.0.0.1:3000/login` 等待用户登录；后端 8081 应用接口需认证。不得把直接请求 MapleProxy 作为 PFM 应用成功。需确认已配置 provider、Chat 模式与只读工具并记录两轮 requestId。 |
| Agent2API 3.0.3 Chat          | **尚未实际验收** | 实际 UI 没有自定义 provider，用户私下填写已有 Maple Key 待完成；需确认模式、模型及真正连接的下游客户端，再记录短对话与工具结果第二轮。                                                   |
| Agent2API 3.0.3 Responses     | **尚未实际验收** | 同上；固定源代码 commit 不证明安装程序版本对应，需独立记录实际协议。工具/加密 continuity 如被使用，应只保存安全结果元数据。                                                              |

本子任务未重启生产服务、未修改 PFM/Agent2API 源码或读取客户端凭据。主代理已保留上一版 dist，负责服务重启、实际浏览器 QA 和独立代码复核；其结果应在下方追加，不能将自动夹具通过改写成应用验收通过。

## 主代理发布与复核补记

主代理在本轮构建后通过真实浏览器访问隔离 smoke fixture `http://localhost:52721` 完成 Activity 页面 QA：DOM 与截图确认 4 行（validation400 / incomplete200 / upstream429 / success）；展开详情可读，验证失败行展示 `messages[0].startsNewUserRequest` 完整路径及未进入运行时，incomplete 行展示 max_output_tokens、temperature 过滤、本地与上游 ID；“未完整完成”筛选只保留 1 行。全页截图保存在本地忽略目录 `.tmp/client-compatibility-diagnostics.jpg`，由主代理查看确认。该浏览器验收使用固定合成密码、临时数据与合成上游，不使用生产数据，不代表上述真实应用通过。

生产重启、独立复核与实际应用证据仍待主代理补记；当前实际应用矩阵未登记 PASS。
