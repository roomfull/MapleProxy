# MapleProxy

面向 Agent 开发与本机测试的轻量反向代理，基于 OpenAI 官方 **Sign in with ChatGPT** 接入机制，将 ChatGPT 账户的模型能力接入自己的 Agent，也可供 WorkBuddy 等支持自定义模型的客户端使用。

**许可范围：MapleProxy 原创代码采用 MIT；内含 DevKit 受非商业许可约束。** 当前完整程序面向个人非商业学习与实验。为企业、雇主或客户业务进行开发测试，即使不收费，也不在 DevKit 现有许可授权范围内。详见 [许可说明](LICENSING.md)。

## 为什么做 MapleProxy

开发 Agent 时，经常需要接入真实模型：调试提示词、验证工具调用、检查多轮上下文，或跑一遍完整的任务流程。Mock 可以验证程序逻辑，但模型会怎样选择工具、如何理解工具结果，以及能否继续完成任务，仍然需要实际调用来确认。

[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) 和 [Sub2API](https://github.com/Wei-Shaw/sub2api) 已经覆盖了更广泛的需求：前者提供多种服务的协议兼容与代理能力，后者还包含配额分发、计费和调度等平台功能。但对于“在本机给正在开发的 Agent 接一个真实模型”这个需求，这些项目的功能范围超出了我需要的部分。我希望有一个更聚焦、少一些配置和维护负担的选择。

2026 年 9 月 28 日，OpenAI 发布了 [Sign in with ChatGPT 官方接入教程](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt)，介绍了通过用户授权，让符合条件的应用使用其 ChatGPT 套餐调用模型的方式。符合条件的用户可以使用已有账户和套餐，无需另行配置 OpenAI API Key。

MapleProxy 就是基于这套机制做的本机反代：登录 ChatGPT，创建一个本地访问密钥，把地址填进 Agent，然后开始调试。项目聚焦个人开发与测试，使用本地 JSON 文件保存数据，无需 Redis 或独立数据库服务。

## 工作原理

```text
自己的 Agent / WorkBuddy / OpenAI SDK
                │
                │ 本地访问密钥 · OpenAI 兼容接口
                ▼
      MapleProxy · 127.0.0.1:8317
                │
                │ Sign in with ChatGPT 授权 · OAuth
                ▼
  https://api.openai.com/v1/responses
```

MapleProxy 使用官方 Sign in with ChatGPT DevKit 完成账户授权，并向公开的 Responses API 转发请求。Chat Completions 请求会转换为 Responses，再把结果转换为客户端需要的格式。上游固定使用 `store:false`、`stream:true`；下游支持流式与非流式响应。

“官方”指 OpenAI 提供的授权与模型调用机制；MapleProxy 是基于该机制构建的独立项目。具体模型、套餐资格、额度和工作区权限以 [OpenAI 官方说明](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)、账户实时模型目录及实际请求结果为准。

## 提供什么

| 能力 | 说明 |
| --- | --- |
| OpenAI 兼容接口 | 提供 `/v1/models`、`/v1/responses`、`/v1/chat/completions` |
| Agent 调试 | 支持文本、多轮历史、function/custom 工具调用与结果回传 |
| 流式输出 | 支持 SSE，也可聚合为非流式响应 |
| 图片与文件输入 | 支持兼容范围内的图片、内联文件及文件 URL；实际支持取决于模型 |
| 中文管理页面 | 管理账户、手动选择默认账户、创建与撤销本地访问密钥 |
| 请求诊断 | 查看最近请求状态、错误代码、参数转换记录及请求 ID |
| 本机凭据存储 | OAuth 凭据使用 Windows DPAPI 加密，下游使用独立的本地访问密钥 |

详细字段支持情况见 [HTTP 兼容性说明](docs/compatibility.md)。

## 快速开始

### 1. 安装并启动

需要原生 Windows、Node.js **22.17.0 或更新版本**、npm，以及系统自带的 Windows PowerShell 5.1（`powershell.exe`，用于 DPAPI）。登录与调用模型需要能够访问 OpenAI 官方服务。

在 PowerShell 中获取源码并运行（已有源码时跳过前两行）：

```powershell
git clone https://github.com/roomfull/MapleProxy.git
cd MapleProxy
npm ci
npm run build
npm run setup
npm start
```

`setup` 会要求设置并确认管理密码，输入时不显示明文。服务启动后，打开 [http://127.0.0.1:8317](http://127.0.0.1:8317)。

### 2. 连接 ChatGPT 账户

1. 使用刚设置的管理密码登录管理页面。
2. 点击 **Continue with ChatGPT**，在浏览器中完成官方授权并允许使用 ChatGPT 套餐。
3. 在管理页面确认默认账户，刷新模型目录。
4. 在“访问密钥”中创建一个供本机 Agent 使用的密钥。

新建访问密钥的完整值会在创建卡片中显示，隐藏卡片后仍可在“访问密钥”列表点击“复制密钥”。复制操作需要有效的管理会话，只有点击时才读取原值并写入剪贴板；重启服务后仍可复制。旧版本创建的仅有摘要的密钥无法恢复完整值，页面会禁用复制并提示新建密钥。管理密码用于登录控制台；本地访问密钥用于调用模型。无需把 ChatGPT OAuth token 填进 Agent。

#### 在另一台设备完成 ChatGPT 授权

1. 在本机控制台点击 **复制链接登录**；已有账号需要更新授权时，点击该账号的 **复制链接重新授权**。
2. 复制当前授权链接，在另一台设备的浏览器打开并完成官方登录与授权。
3. 授权后，另一台设备可能提示无法访问 `127.0.0.1` 回环地址。请从浏览器地址栏复制**完整回调 URL**，保留 `state`、`code`、`client_id` 等全部参数。
4. 返回本机控制台，将地址粘贴到“完整回调 URL”并点击“提交回调”。只有显示“账号授权完成”才表示完成；提交成功后仍需等待交换和身份验证。

手动模式不会自动打开浏览器，总期限为 10 分钟；原来的 **Continue with ChatGPT** 自动打开本机浏览器，总期限为 5 分钟。倒计时基于原任务截止时间，自动重试不会重置期限。若提示“授权链接已更新，请重新复制”，请用新链接重新授权。无效回调可在原输入框纠正；退出管理会话会清除页面里的链接和回调，重新登录或刷新后可恢复服务器仍在等待的任务。

这仍是本机服务：另一台设备只访问官方授权页，不需要访问 MapleProxy 控制台。服务保持 `127.0.0.1` 绑定，不开放远程管理、CORS 或公共回调转发。粘贴的地址只用于验证并提取授权回调，服务器不会请求该 URL；回调数据仅在本次任务中暂存，不写入日志或浏览器持久存储。

### 3. 填入 Agent 的模型配置

| 配置项 | 值 |
| --- | --- |
| 接口类型 | OpenAI 兼容；按客户端选择 Chat Completions 或 Responses |
| Base URL | `http://127.0.0.1:8317/v1` |
| API Key | 在 MapleProxy 管理页面创建的本地访问密钥 |
| Model | MapleProxy 模型目录中的实际模型 ID |

如果客户端要求完整接口地址，则填写 `http://127.0.0.1:8317/v1/chat/completions` 或 `http://127.0.0.1:8317/v1/responses`。

## 接入 WorkBuddy

WorkBuddy 的自定义模型入口支持填写 URL、API Key 和模型名，可按其 [官方模型配置文档](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Model) 接入 MapleProxy：

1. 在 WorkBuddy 的 **设置 → 模型** 中添加模型，选择 **自定义 / Custom**。
2. 填入上表中的 Base URL、本地访问密钥和实际模型 ID。
3. 保存后，在对话中选择该自定义模型。

WorkBuddy 默认会校验并补全 `/chat/completions` 路径。如果开启“自定义协议”，它会直接请求填写的 URL，此时应填写完整地址 `http://127.0.0.1:8317/v1/chat/completions`。

仓库的 [2026-10-14 验证记录](docs/client-compatibility-verification.md) 已记录 WorkBuddy **5.7.6.0** 的真实界面验证：短对话、文件读取工具执行后的继续回复，以及流式输出停止。服务端请求 ID 与客户端行为的日志关联仍待补齐；其他 Agent 的兼容性应按实际请求验证。

## 在自己的 Agent 中使用

使用 OpenAI Node SDK 时，替换 `baseURL` 和 `apiKey` 即可接入受支持的接口。独立客户端项目先运行 `npm install openai`。

```javascript
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: process.env.MAPLEPROXY_API_KEY,
  baseURL: 'http://127.0.0.1:8317/v1',
  maxRetries: 0,
  logLevel: 'off',
});

// 也可以从管理页面选择模型，将其实际 ID 填入配置。
const model = (await client.models.list()).data[0]?.id;
if (!model) throw new Error('当前账户没有可用模型');

const result = await client.chat.completions.create({
  model,
  messages: [{ role: 'user', content: 'Hello, MapleProxy!' }],
});

console.log(result.choices[0]?.message.content);
```

项目自带的 [examples/client.mjs](examples/client.mjs) 会分别调用 Chat Completions 和 Responses。可在项目目录中通过隐藏输入设置临时密钥并运行：

```powershell
$secureKey = Read-Host 'MapleProxy 本地访问密钥' -AsSecureString
$env:MAPLEPROXY_API_KEY = [System.Net.NetworkCredential]::new('', $secureKey).Password
try {
  node examples/client.mjs
} finally {
  Remove-Item Env:MAPLEPROXY_API_KEY -ErrorAction SilentlyContinue
}
```

如果修改了服务端口，为示例客户端设置 `MAPLEPROXY_BASE_URL`。密钥应通过环境变量或客户端的凭据配置传入，不要写入源码。

## 接入时需要知道的边界

- **本机使用**：当前仅支持原生 Windows，服务固定绑定 `127.0.0.1`。Agent 需要在同一台机器上访问该地址；不提供远程部署、公共网关或跨域访问。
- **接口兼容范围**：MapleProxy 提供上述三条路由，并非完整 OpenAI Platform API。Files 上传、Embeddings、音频和图像生成等接口未实现。
- **上下文由 Agent 保存**：每次请求需要带上完整历史。工具由客户端执行，并在后续请求中回传结果；不支持 `previous_response_id`、`conversation` 或 `store:true`。
- **部分参数会被忽略**：`temperature`、`top_p`、`max_tokens`、`max_completion_tokens`、`max_output_tokens`、`stop` 等参数会被移除，通过 `X-MapleProxy-Ignored-Params` 和管理页面诊断报告。它们不会约束实际采样、输出长度或停止位置。
- **账户手动切换**：默认账户切换只影响新请求；停用或断开账户会取消该账户正在执行的请求。没有自动轮换、重试或跨账户回放。
- **流开始不等于任务完成**：HTTP 200 只说明流已开始。Responses 需区分 `response.completed`、`response.incomplete` 与失败；Chat 需检查结束帧和 `finish_reason`，`[DONE]` 也可能伴随 `length` 或 `content_filter`。

遇到接入问题，先查看管理页面的“最近请求”，确认失败阶段、参数路径和错误代码，再查阅 [完整兼容性说明](docs/compatibility.md)。请求记录仅保留最近 200 条内存元数据，重启清空，不保存提示词、模型输出、工具参数值或凭据。不展示剩余额度，可通过页面链接进入官方用量页查看。

## 配置与数据

默认端口为 `8317`，数据目录为安装目录下的 `data`。可以通过环境变量修改：

```powershell
$env:PORT = '8317'
$env:MAPLEPROXY_DATA_DIR = Join-Path $env:LOCALAPPDATA 'MapleProxy'
npm run setup
npm start
```

`setup` 和服务器必须使用同一数据目录。[.env.example](.env.example) 仅供参考，程序不会自动读取 `.env`。服务使用 `Ctrl+C` 停止。

| 数据文件 | 用途 |
| --- | --- |
| `security.json` | 管理密码的 scrypt 盐/哈希、本地访问密钥摘要及新密钥的 DPAPI 加密原值 |
| `chatgpt-auth.json` | 使用 Windows DPAPI CurrentUser 加密的账户凭据 |
| `chatgpt-host.json` | 此安装的主机标识 |

- 忘记管理密码：在相同数据目录配置下运行 `npm run setup -- --reset`。旧管理会话立即失效，已有访问密钥与账户保留。
- 遗失访问密钥：登录管理页面，从列表复制新版本创建的密钥。旧版本仅有摘要的密钥无法恢复原值，请撤销并创建新密钥。
- 备份和恢复：停止所有使用该目录的服务器与 setup 进程后，备份整个数据目录。新密钥原值使用 Windows DPAPI CurrentUser 加密，解密依赖创建时的 Windows 用户及其 DPAPI 环境；迁移用户或机器后可能无法从列表复制，此时应撤销并创建新密钥。OAuth 凭据恢复也依赖原 Windows 用户与 DPAPI 环境。
- 崩溃遗留锁：确认所有使用该数据目录的 server/setup 进程已停止，再删除实际数据目录中的 `security.json.lock` 后重试，保留其他数据文件。
- 账户授权失效：在管理页面重新授权；需要撤销远端访问时，在 ChatGPT 设置中断开应用。

## 开发与验证

`main` 展示稳定版本，开发采用“任务分支 → `develop` → `main`”。每项任务从最新 `develop` 创建短期分支，并向 `develop` 提交 PR；Owner 定期通过发布 PR 将 `develop` 合入 `main`。首次建立 `develop`、评审职责、合并方式和 CI 检查见 [贡献指南](CONTRIBUTING.md)。

开发时在两个终端分别运行 `npm run dev` 和 `npm run dev:web`，前端地址为 `http://127.0.0.1:5173`。

```powershell
npm test
npm run typecheck
npm run build
```

自动测试使用合成账户和本机上游服务，覆盖协议转换、工具多轮往返、流式错误、背压与取消等行为，不调用真实 OpenAI。`npm run smoke` 可启动隔离的浏览器测试服务；它使用临时数据和合成账户，不是生产启动方式。输入 `stop` 可关闭并清理临时数据。

隔离服务密码为 `MapleProxy smoke fixture 2026`。复制链接登录时，`example.invalid` 授权 URL 仅作展示；启动终端输入 `callback` 可打印当前合成成功回调，`retry` 可打印会触发新链接的合成回调，`fail` 可打印失败回调。粘贴后有约两秒的交换阶段；`rotate` 直接更新等待链接，`complete` 完成浏览器模式任务。合成格式为 `http://127.0.0.1:1/auth/callback?state=fixture-attempt-N&code=success&client_id=fixture-client`，`N` 必须与当前链接一致，`code` 也可为 `retry` 或 `fail`。这些控件只存在于独立测试脚本，不会进入生产服务器。真实跨设备 OAuth 仍待用户实际授权验证，见 [验证记录](docs/verification.md)。

真实接入后，建议先发一条短消息，再验证一次“工具调用 → 客户端执行 → 结果回传 → 模型继续回复”，最后测试流式取消，并在管理页面核对请求记录。模型及工具能力以实际账户响应为准。

已有验证证据见 [基础验证记录](docs/verification.md) 与 [客户端兼容性验证记录](docs/client-compatibility-verification.md)。

## 上游与许可

MapleProxy 使用 [OpenAI Sign in with ChatGPT DevKit](https://github.com/openai/sign-in-with-chatgpt-devkit)，保留 commit [`0a36fefeb913055c8c7a1a29b63d82b96b2e841a`](https://github.com/openai/sign-in-with-chatgpt-devkit/commit/0a36fefeb913055c8c7a1a29b63d82b96b2e841a) 的 local SDK、原测试与许可文件。本项目对其所做的修改记录在 [PROVENANCE](vendor/siwc/PROVENANCE.md)。

MapleProxy 独立编写的代码与文档采用 [MIT 许可](LICENSE)。上游 DevKit 及其修改继续使用 [非商业许可](vendor/siwc/LICENSE)，不受根目录 MIT 授权覆盖。完整范围与再分发要求见 [LICENSING](LICENSING.md)；其他运行时依赖见 [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES.md)。

欢迎报告问题和提交改进，开发流程与贡献许可见 [贡献指南](CONTRIBUTING.md)。
