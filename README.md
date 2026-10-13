# MapleProxy

Windows 本机个人使用的 ChatGPT 账户网关。通过官方 Sign in with ChatGPT DevKit 登录，以独立的本地访问密钥提供 `GET /v1/models`、`POST /v1/responses` 和 `POST /v1/chat/completions`。中文管理页面管理账户、默认账户、访问密钥与最近请求。

上游固定为公开的 `https://api.openai.com/v1/responses`，始终 `store:false, stream:true`，没有使用私有 ChatGPT backend-api。下游可选择流式或非流式；兼容能力和明确拒绝项见 [兼容性说明](docs/compatibility.md)。模型、套餐、工作区策略与实际访问权限以账户实时目录及服务端结果为准。[官方模型与推理文档](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)

**当前验证使用合成账户和本地 upstream fixture；未使用真实 OpenAI 账户完成 OAuth 或推理。** 不展示剩余额度；界面仅链接官方用量页，保留实际限制错误的代码。

## 安装和启动

需要原生 Windows、Node.js **22.17.0 或更新版本**、npm，以及系统自带的 `powershell.exe`（Windows PowerShell 5.1，用于 DPAPI）。真实登录需要浏览器及访问官方认证/推理服务的网络。服务不需要 Redis；数据使用本地 JSON 文件。

在项目目录的 PowerShell 中执行：

```powershell
npm ci
npm run build
npm run setup
npm start
```

`setup` 在终端中隐藏输入并要求确认管理密码，长度 12–1024 字符。然后打开 [http://127.0.0.1:8317](http://127.0.0.1:8317)，用管理密码登录。点击 **Continue with ChatGPT**，完成官方授权；连接账户后刷新模型目录，再在“访问密钥”创建一个供本机客户端使用的密钥。管理密码与访问密钥各有用途，不能互相授权。访问密钥完整值只显示一次，请立即存入自己的凭据管理器。

可选环境配置（`.env.example` 仅供参考，程序**不会自动读取 `.env`**）：

```powershell
$env:PORT = '8317'  # 1–65535；始终绑定 127.0.0.1
$env:MAPLEPROXY_DATA_DIR = Join-Path $env:LOCALAPPDATA 'MapleProxy'
npm run setup
npm start
```

`setup` 和服务器必须使用同一数据目录。默认是本安装目录下的 `data`，与启动时工作目录无关；前端资源也从安装目录的 `web/dist` 读取。服务器 `Ctrl+C` 停止。开发时两个终端分别运行 `npm run dev` 和 `npm run dev:web`，前端地址 `http://127.0.0.1:5173`；开发代理同样检查本机 Host/Origin。

## 接入本机客户端

Base URL 为 `http://127.0.0.1:8317/v1`。模型 ID 使用“模型目录”中的实际 ID，也可从 `/v1/models` 获取。多账户需要手动选择默认账户：切换只影响新请求，停用或断开会取消该账户正在执行的请求。没有自动轮换、重试或跨账户回放。

以下示例先在 PowerShell 中隐藏读取**本地访问密钥**，把它放入当前进程环境。不要在命令行参数、脚本、URL 或日志中写真实密钥，也不要把 OAuth token 交给下游客户端：

```powershell
$secureKey = Read-Host '本地访问密钥' -AsSecureString
$env:MAPLEPROXY_API_KEY = [System.Net.NetworkCredential]::new('', $secureKey).Password
if ($env:MAPLEPROXY_API_KEY -notmatch '^mp_[A-Za-z0-9_-]+$') { throw '访问密钥格式无效' }
```

官方 Node SDK 示例已保存为 [examples/client.mjs](examples/client.mjs)，从环境在 **Node 进程内部**设置认证头，读取模型目录并分别调用两条路由。项目已有 `openai` 依赖；独立客户端项目需自行 `npm install openai`。若服务器修改了端口，先设置 `$env:MAPLEPROXY_BASE_URL = 'http://127.0.0.1:你的端口/v1'`（这是示例客户端配置）。[官方 SDK 用法](https://github.com/openai/openai-node)

```powershell
try {
  node examples/client.mjs
} finally {
  Remove-Item Env:MAPLEPROXY_API_KEY -ErrorAction SilentlyContinue
}
```

核心 SDK 配置：

```javascript
import OpenAI from 'openai';
const client = new OpenAI({
  apiKey: process.env.MAPLEPROXY_API_KEY,
  baseURL: 'http://127.0.0.1:8317/v1',
  maxRetries: 0,
  logLevel: 'off',
});
```

curl 使用 `curl.exe`（避免 Windows PowerShell 的 `curl` 别名）。**认证通过 stdin config 输入**，即便普通 `-H` 使用变量展开，密钥仍会出现在 curl 的进程参数中。重新执行上面的隐藏输入后，在项目目录运行：

```powershell
$model = Read-Host '模型目录中的实际 ID'
$curlConfig = @(
  ('header = "Authorization: Bearer ' + $env:MAPLEPROXY_API_KEY + '"')
  'header = "Content-Type: application/json"'
) -join "`n"
$utf8 = [System.Text.UTF8Encoding]::new($false)
$chatBody = @{ model = $model; messages = @(@{ role = 'user'; content = 'hello' }); stream = $true } | ConvertTo-Json -Depth 8 -Compress
$responsesBody = @{ model = $model; input = 'hello'; stream = $true } | ConvertTo-Json -Depth 8 -Compress
$chatFile = Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetRandomFileName())
$responsesFile = Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetRandomFileName())
try {
  [System.IO.File]::WriteAllText($chatFile, $chatBody, $utf8)
  [System.IO.File]::WriteAllText($responsesFile, $responsesBody, $utf8)
  $curlConfig | curl.exe -q --config - --silent --show-error --fail-with-body --no-buffer --data-binary "@$chatFile" http://127.0.0.1:8317/v1/chat/completions
  $curlConfig | curl.exe -q --config - --silent --show-error --fail-with-body --no-buffer --data-binary "@$responsesFile" http://127.0.0.1:8317/v1/responses
} finally {
  Remove-Item -LiteralPath $chatFile, $responsesFile -ErrorAction SilentlyContinue
  Remove-Item Env:MAPLEPROXY_API_KEY -ErrorAction SilentlyContinue
  $curlConfig = $null
}
```

curl 输出的 `event: error` 表示流失败；HTTP 200 仅代表流开始成功。Chat 只有成功完成后才发送 `[DONE]`；Responses 要确认 `response.completed`。部分输出不能当作完整成功结果。

## 数据和恢复

`data/security.json` 保存管理密码的 scrypt 盐/哈希及访问密钥摘要；`chatgpt-auth.json` 保存用 Windows DPAPI CurrentUser 加密的账户凭据；`chatgpt-host.json` 保存主机标识。管理会话和最近 200 条请求元数据只存在内存，重启会清空。活动记录不保存 prompt、输出或 token。

- 忘记管理密码：在同一数据目录配置下运行 `npm run setup -- --reset`。旧管理会话立即失效，已有访问密钥与账户保留。自动化可用 `npm run setup -- --password-stdin`，将一行密码由安全来源通过 stdin 传入；重置时再加 `--reset`。CLI 没有 password 参数。
- 遗失访问密钥：无法从摘要恢复；登录管理页面，撤销旧密钥并创建新密钥。
- 备份：先停止所有服务器/setup 写入者，再备份整个数据目录。恢复需保持对应 Windows 用户及 DPAPI 环境；复制到其他用户/机器通常不能解密，应重新官方登录。DPAPI 不可用或数据损坏时失败关闭，保留原文件，没有明文降级。仅支持原生 Windows；WSL/Linux/macOS 没有生产凭据提供者。
- `security.json.lock` 崩溃遗留：写入在约 5 秒后失败关闭。**先停止所有使用此数据目录的 server/setup 进程并确认没有写入者**，确认选择的是实际 `MAPLEPROXY_DATA_DIR`（未设置时为安装目录 `data`），然后仅删除该目录下的 `security.json.lock`，保留 `security.json` 与账户文件，再重试。不要在仍有写入进程时删锁，也不要为“修复”锁而删除整个数据目录。
- 认证或账户状态错误：在页面重新授权；远端撤销无法确认时，还应在 ChatGPT 设置中断开应用。浏览器管理会话最长 12 小时，退出或密码重置会失效。

服务仅供本机个人实验使用，绑定 `127.0.0.1`，管理请求检查精确 Host、Origin 和 CSRF。不提供远程部署、HTTPS、CORS、公共网关或配额汇总。访问密钥有权以当前默认账户推理，请只授予可信本机客户端。

## 验证与真实授权 smoke

```powershell
npm run test:unit -- tests/integration.test.ts tests/smoke-fixture.test.ts
npm test
npm run typecheck
npm run build
```

集成测试使用官方 OpenAI Node SDK、自建 loopback upstream、合成加密提供者及临时目录，验证 UTF-8/SSE 分片、工具多轮往返、失败流、背压和取消，不调用真实 OpenAI。[详细验证记录](docs/verification.md)

可用 `npm run smoke` 启动隔离浏览器 fixture；它打印随机本机 URL，合成密码在 [测试脚本](scripts/smoke-fixture.ts) 中明确标记，仅适用于该 fixture。提供两个合成账户、测试模型以及由实际本地推理路由生成的活动记录。输入 `seed` 添加测试记录，输入 `stop` 正常关闭并删除临时数据。它不是生产启动方式，没有生产 mock 参数或测试 HTTP 路由。

用户自行授权真实账户后的 smoke 步骤：

1. 正常 build/setup/start，完成页面官方登录，不手动提取或发送 OAuth token。
2. 读取实际模型目录，创建本地访问密钥，用上述 SDK/curl 发一个最小请求，确认完整终止事件。
3. 用自己允许执行的简单 function/custom 工具完成一轮“调用 → 客户端执行 → 回传结果”，客户端保存完整历史；模型/账户是否接受该工具由实际响应决定。
4. 两账户可各发一轮，确认新请求跟随手动默认选择；取消长流或停用对应账户，检查活动中记录取消/错误。结束后撤销 smoke 密钥。

自动测试和浏览器 fixture 不证明真实 OAuth、远端权限或所有模型支持性。OAuth 超时后立刻重试可能在旧取消操作尚未结束时短暂返回 `connection_busy`，待取消完成再重试；该已知小问题记于验证文档。

## 上游和许可

保留官方 DevKit commit [`0a36fefeb913055c8c7a1a29b63d82b96b2e841a`](https://github.com/openai/sign-in-with-chatgpt-devkit/commit/0a36fefeb913055c8c7a1a29b63d82b96b2e841a) 的 local SDK、原测试、[非商业许可](vendor/siwc/LICENSE) 与 notices，修改见 [PROVENANCE](vendor/siwc/PROVENANCE.md)。这些上游许可仅授予其定义的非商业用途权利。运行时依赖见 [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES.md)。
