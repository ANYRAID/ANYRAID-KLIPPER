# 分支工作流

本文规定 [ANYRAID/ANYRAID-KLIPPER](https://github.com/ANYRAID/ANYRAID-KLIPPER)
的仓库协作流程，适用于本 fork 的开发、上游集成和发布。代码质量与贡献来源要求参见
[上游贡献指南](CONTRIBUTING.md)，许可证见 [COPYING](../COPYING)。
本文是本 fork 的仓库维护说明，入口位于 [README.md](../README.md) 和
[AGENTS.md](../AGENTS.md)，不改变上游 Klipper 用户手册的导航与发布配置。

## 长期分支职责

| 分支 | 职责 | 更新路径 |
| --- | --- | --- |
| `master` | 仅镜像 `Klipper3d/klipper` 的 `master` | 仅接受来自上游的快进同步，保持相同提交历史 |
| `develop` | 开发集成与验证 | 最新 `develop` 派生的任务分支通过 PR 合入 |
| `main` | 默认分支与发布主线 | 完成集成验证的 `develop` 通过 PR 合入 |

普通开发：`develop` → `devac/任务分支` → PR → `develop` → PR → `main`。

上游集成：上游 `master` → 本仓库 `master`；从最新 `develop` 建立
`devac/上游同步任务分支`，在任务分支合并本仓库 `master`、解决差异并测试，
再通过 PR → `develop` → PR → `main`。

上游 `master` 或本仓库 `master` 均不得直接合入 `develop`、`main`。
本地功能、修复、配置和文档提交均不得进入 `master`。不额外创建长期开发或发布分支。

三个长期分支均禁止删除和非快进更新；`develop`、`main` 要求通过 PR 更新并解决审阅讨论。
规则没有绕过入口，也未额外设置必须获得的批准人数。`master` 允许正常快进推送，
用于上游镜像同步；此权限不允许写入定制提交。不得以不可用的权限或检查为由绕过流程。

## 开始普通开发

1. 确认 `origin` 指向本仓库，检查工作区和远程状态，保留已有改动及其他任务工作树。
2. 更新远程引用，从最新 `origin/develop` 建立独立任务分支和工作树。
3. 在任务工作树修改、维护对应文档并完成适用验证。
4. 推送任务分支，向 `develop` 创建 PR，写明变更、验证结果及限制。
5. 合入后检查 `develop` 的集成结果，再创建 `develop` → `main` 的 PR。
   主线检查满足后才能发布；部署或设备操作还需相应授权。

以下命令以新的任务名及不存在的工作树路径为例，在干净的本地克隆中执行：

```sh
git remote -v
git status --short --branch
git fetch origin --prune
git worktree add -b devac/your-task ../ANYRAID-KLIPPER-your-task origin/develop
```

进入新工作树后开展修改。任务分支不得直接向 `main` 提交 PR；也不得直接推送
`develop`、`main` 或在发布检出中开发。目标分支推进或发生冲突时，在任务工作树内
整合最新目标分支、解决冲突并重新执行受影响的检查。

## 同步与集成上游

### 先更新镜像分支

在干净的维护克隆中检查远程地址；`origin` 必须指向本仓库，`upstream` 必须指向
`https://github.com/Klipper3d/klipper.git`。尚无 `upstream` 时先添加该远程；
如果已有地址不同，先查明原因，不能盲目替换。

```sh
git remote -v
git fetch upstream master
git fetch origin --prune
git merge-base --is-ancestor origin/master upstream/master
```

只有祖先检查成功、确认新提交来自上游且是快进更新后，才执行镜像推送：

```sh
git push origin refs/remotes/upstream/master:refs/heads/master
git fetch origin --prune
```

如果上游与本仓库 `master` 分歧、检查失败或推送被拒绝，应停止镜像更新并报告原因；
不得使用强制推送、重置、定制合并提交或绕过规则。镜像更新本身不代表本 fork 已完成集成。

### 在任务工作树处理差异

从刚更新的 `origin/develop` 建立任务分支，不能从 `master` 直接开始本 fork 开发。
以下任务名仅为示例，每轮上游集成使用独立任务分支和工作树：

```sh
git worktree add -b devac/upstream-sync ../ANYRAID-KLIPPER-upstream-sync origin/develop
```

在新任务工作树中先分析变更，再合并本仓库镜像分支：

```sh
git log --oneline HEAD..origin/master
git diff HEAD...origin/master
git merge origin/master
```

分析应覆盖影响范围、已有定制行为、配置及接口兼容性、构建和回归测试要求。
合并时在此任务工作树解决冲突及行为分歧，同步文档并执行受影响的检查。
推送任务分支后创建目标为 `develop` 的 PR，列出上游提交范围、冲突处理、
保留或调整的本地行为、测试证据和未验证事项。

上游同步 PR 合入 `develop` 时使用 merge commit，保留上游提交祖先关系；
`develop` 合入 `main` 时同样使用 merge commit；这两类 PR 不使用 squash 或 rebase，
以保留上游追踪关系，避免后续同步重复处理已经集成的提交和冲突。
普通任务 PR 可使用仓库允许的合并方式。无论采用哪种方式，都不得跳过
任务分支 → PR → `develop` → PR → `main` 的路径。

PR 来源、上游镜像内容及上述合并方式由维护者核对；当前 GitHub 规则强制 PR、
解决审阅讨论、防止强推和分支删除，不会自动校验 PR 来源或特定 PR 的合并方式。

## 验证与交付

- 纯文档变更检查内容、相对链接、空白格式及敏感信息；如果影响可执行示例、
  文档构建或部署说明，再补充对应验证。
- 代码或配置变更按影响范围执行静态检查、构建及回归测试，参考
  [Debugging.md](Debugging.md) 和仓库现有工作流。
- 合并到 `develop` 后确认当前集成提交对应的检查结果；需要 Linux、MCU 或真实设备
  的验证，必须在适用环境和授权范围内完成。只有当前提交已覆盖且没有新增变更时，
  才能复用已有检查结果。
- `develop` → `main` 的 PR 应说明集成范围、适用检查及限制。未运行、排队、失败、
  无检查记录均不得记为通过。文档和 CI 通过不能替代真实打印机验收。
- 无权限、缺少环境或检查不可用时，完成其余可做的工作并报告阻塞，不能绕过 PR 或发布守卫。
- 保留 [COPYING](../COPYING)、上游版权声明及贡献来源；提交前检查敏感信息。
  Git 提交主题和正文使用中文，可保留英文类型、作用域、标识符及专有名称；
  保留上游贡献指南要求的 `Signed-off-by`。向上游贡献时按上游格式另行准备提交。
