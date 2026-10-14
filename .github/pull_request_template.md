## 改动目的

说明问题、修改内容；一个 PR 聚焦一项改动。

关联 Issue：无 / #编号

## PR 类型与目标

- [ ] 开发：任务分支（含 Fork）→ 上游 `develop`，Squash and merge，合并后删除任务分支。
- [ ] 发布：同仓库 `develop` → `main`，由 Owner 处理，Create a merge commit。
- [ ] 发布后同步：同仓库 `main` → `develop`，Create a merge commit，保留两个长期分支。

## 验证结果

列出实际运行的命令、结果及未验证范围：

- [ ] `npm ci`
- [ ] `npm test`
- [ ] `npm run typecheck`
- [ ] `npm run build`
- [ ] `node .github/scripts/verify-licenses.mjs`
- [ ] `npm run notices:generate` 后 `git diff --exit-code -- THIRD_PARTY_NOTICES.md` 无差异

GitHub `Windows CI`：待运行 / 运行链接及结果（本地结果不能代替 GitHub 结果）。

## 兼容性影响

说明接口、配置、客户端或许可影响，以及需要更新的文档；无影响请写“无”。真实客户端验收请标明版本、验证范围与未完成项，不附凭据或真实请求正文。

## 评审与合入

- [ ] CI 通过，评审讨论已解决。
- [ ] 至少一位非作者维护者批准；或 Owner 在无人可评审时填写以下豁免理由。

Owner 人工审批豁免理由（仅在适用时填写，不豁免 CI 失败）：

开发 PR 可由 Owner 或有写权限的 Committer / Maintainer 合入；发布 PR 由 Owner 合入。CODEOWNERS 用于请求评审，不要求所有开发 PR 必须由 Owner 批准。以上人工规则属于项目约定；未配置分支保护前不代表已强制执行。

## 发布说明（发布 PR 必填）

列出本次新增、修复、兼容性变化、已知限制及验证结论。发布后由 Owner 以 Merge commit 将 `main` 同步回 `develop`；不重写共享分支历史。
