# 参与 MapleProxy

MapleProxy 聚焦 Windows 本机、个人非商业 Agent 实验。提交功能建议前，请先说明实际接入场景、使用的接口和当前遇到的问题。

## 分支与职责

开发流程为 **任务分支 → develop → main**。`main` 保持默认分支，用于展示稳定版本；`develop` 汇集待发布改动。每项任务创建独立短期分支，合并后删除任务分支，保留 `develop` 和 `main`。

| 角色                   | 职责                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| Contributor            | 从最新 `develop` 创建任务分支，提交聚焦的 PR，补充验证并处理评审意见；外部贡献者通过 Fork 提交。  |
| Committer / Maintainer | 获得写权限后，可评审并合入满足要求的开发 PR 到 `develop`。                                        |
| Owner                  | 负责维护者授权、首次建立 `develop`、稳定版发布和 `develop → main` 的审核与合入；也可处理开发 PR。 |

以上权限和人工评审要求是项目约定。本轮没有配置 GitHub 分支保护或修改远端权限，不能视为已被 GitHub 强制执行。现有 [CODEOWNERS](.github/CODEOWNERS) 用于请求评审，不代表所有开发 PR 都必须由 Owner 批准；新增 Committer 时应同步更新评审归属。

## 首次建立 develop（Owner）

如果上游尚无 `develop`，Owner 在干净工作区确认 `main` 的基线后执行以下步骤一次。这里仅提供操作说明，不会自动创建远端分支。

```powershell
git switch main
git pull --ff-only origin main
git switch -c develop
git push -u origin develop
```

`main` 继续作为默认分支。首次治理文档若在 `develop` 建立前准备，待 Owner 建立 `develop` 后，将该任务分支的 PR 指向它；后续任务均从最新 `develop` 开始。

## 开始一项任务

同仓库开发先同步 `develop`，再创建任务分支，例如：

```powershell
git fetch origin
git switch develop
git pull --ff-only origin develop
git switch -c roomfull/fix-login
```

若本地尚无该分支，首次使用 `git switch --track origin/develop`。人工分支可用 `<用户名>/<任务名>`；代理使用 `codex/<任务名>`。不要在共享的 `develop` 或 `main` 上直接开发或强制推送。

外部贡献者 Fork 仓库后，将自己的 Fork 配为 `origin`，上游配为 `upstream`：

```powershell
git remote add upstream https://github.com/roomfull/MapleProxy.git
git fetch upstream
git switch -c yourname/fix-login upstream/develop
git push -u origin yourname/fix-login
```

随后向 **上游 `develop`** 提交 PR。已配置 `upstream` 时无需再次添加。

## 开发 PR 与评审

- 一个 PR 聚焦一项改动，说明问题、修改内容、关联 Issue（若有）、验证结果和兼容性影响。
- CI 必须通过，评审讨论必须解决，至少一位非作者维护者批准后，由 Owner 或有写权限的 Committer / Maintainer 合入 `develop`。
- Owner 在无人可评审时，可以在 PR 中注明原因并豁免人工审批。该例外不允许跳过失败的 CI，也不自动赋予其他贡献者豁免权。
- 任务分支合入 `develop` 使用 **Squash and merge**，完成后删除任务分支。维护者应先核对 PR 的目标分支。

PR 使用统一的 [模板](.github/pull_request_template.md)。

## 稳定版发布与同步

1. Owner 根据项目进度手动决定发布时间，发起或处理**同仓库 `develop → main`** 的发布 PR。填写发布说明，核对包含的改动、兼容性边界及检查结果。
2. 发布 PR 同样要求 CI 通过、讨论解决及非作者维护者批准；Owner 无人可评审时可写明原因豁免人工审批。由 Owner 使用 **Create a merge commit** 合入 `main`，保留分支之间的合并关系。
3. 发布后，Owner 将 `main → develop` 作为发布同步 PR，完成相同检查和评审后，使用 **Create a merge commit** 合入。同步 PR 是任务分支 Squash 规则的例外；不要用 Squash、rebase 或强推来重写共享分支历史。

`main` 只接受同仓库 `develop` 的发布 PR；来自 Fork、普通任务分支或其他来源的 PR 应改为指向 `develop`。当前阶段的紧急修复仍走任务分支、`develop`、`main`，Owner 可提前发布，不额外建立 hotfix / release 分支体系。

没有定时发布、自动打标签、自动合并或自动部署；是否创建版本标签或 Release 由 Owner 另行决定。

## 本地开发与 CI

需要原生 Windows、Node.js 22.17.0 或更新版本及 npm；CI 使用 Windows runner 和 Node.js 22。提交前运行：

```powershell
npm ci
npm test
npm run typecheck
npm run build
node .github/scripts/verify-licenses.mjs
npm run notices:generate
git diff --exit-code -- THIRD_PARTY_NOTICES.md
```

声明生成后如有合理变化，将更新后的 `THIRD_PARTY_NOTICES.md` 随依赖改动一并提交，再确保重新生成无差异。许可检查会验证两处 DevKit 编译目录及根 `dist` 的 12 份许可、来源与声明文件和源码一致。

开发服务分别使用 `npm run dev` 与 `npm run dev:web`。模拟界面可使用 `npm run smoke`，无需提供真实账户或凭据。安装、授权和接入方式见 [README](README.md)。

[CI 工作流](.github/workflows/ci.yml) 在指向 `develop` / `main` 的 PR、这两个分支的 push 以及手动触发时执行，状态名为 `Windows CI`。PR 目标检查读取事件元数据，验证上述来源规则；push 和手动运行无 PR 目标可检查，其余检查照常执行。工作流使用普通 `pull_request` 事件及只读仓库权限，不需要项目 Secrets，不调用真实模型。

本地通过不代表 GitHub 托管运行已经通过。工作流提交并推送后，需在 GitHub Actions / PR 页面查看实际结果。后续可由 Owner 单独配置分支保护，将 `Windows CI` 设为必需检查，并配置评审与合入权限；本轮未实施这些远端设置。

## Issue 与 Pull Request

- 问题报告请说明操作系统、Node.js 版本、客户端版本、请求接口及最小复现步骤；可附经过脱敏的错误代码和参数路径。
- 不要上传访问密钥、OAuth token、账户数据、真实请求正文、私人截图或完整数据目录。
- 修改协议行为时，更新对应测试与 [兼容性说明](docs/compatibility.md)。测试使用合成数据和本机上游，不依赖维护者的账号、目录或网络服务。
- 提交前运行 `npm test`、`npm run typecheck` 和 `npm run build`；说明实际完成的验证及未验证的范围。
- 保持改动聚焦，避免提交构建产物、依赖目录、IDE 配置或临时文件。

## 贡献许可

请先阅读 [许可范围](LICENSING.md)，仅提交你有权公开和授权的内容。对 MapleProxy 独立代码的贡献采用 MIT；对 `vendor/siwc/` 的修改继续采用 DevKit 原许可，标明修改并更新 `PROVENANCE.md`。新引入的第三方材料须记录来源和适用许可。

## 安全问题

涉及凭据泄漏或可利用漏洞时，不要在公开 Issue 中附上敏感细节。如果仓库启用了 GitHub 私密漏洞报告，请通过 Security 页的 Report a vulnerability 提交；若入口不可用，可以先发不含漏洞细节的联系请求，与维护者确定私密沟通渠道。
