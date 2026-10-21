# ANYRAID-KLIPPER 协作约定

适用范围：本仓库全部目录。开始工作前阅读本文件、[README.md](README.md)、
[分支工作流](docs/Branch_Workflow.md)及相关项目文档。

## 分支与工作树

- 本仓库是 [Klipper3d/klipper](https://github.com/Klipper3d/klipper) 的公开分叉，
  保留上游许可证、版权声明和贡献资料。
- `main` 是默认发布分支，`develop` 是开发集成分支，`master` 仅镜像上游 `master`。
  不因任务新增其他长期分支。
- 普通开发从最新 `origin/develop` 建立独立 `devac/` 任务分支和对应工作树，
  经 PR 合入 `develop`，完成集成验证后再经 PR 合入 `main`。
- 上游同步先将上游 `master` 快进同步到本仓库 `master`，再从最新 `origin/develop`
  建立 `devac/` 上游同步任务分支，在任务工作树分析并合并 `origin/master`，
  解决冲突、处理行为分歧、完成测试，再经 PR 依次进入 `develop` 和 `main`。
- 禁止将上游或本仓库 `master` 直接合入 `develop`、`main`；禁止向 `master`
  写入本地定制提交。不得通过强制推送、重置共享分支或直接推送绕过 PR。
- 修改前检查远程、分支和工作区状态，不覆盖已有未提交改动，不操作其他任务的工作树。

## 提交、文档与验证

- Git 提交主题和正文使用中文；类型、作用域、代码标识符和专有名称可保留英文。
  提交前检查信息，沿用上游贡献指南要求的 `Signed-off-by`。
- [上游贡献指南](docs/CONTRIBUTING.md)适用于代码质量、贡献来源和许可证等要求；
  本 fork 的分支流转按[分支工作流](docs/Branch_Workflow.md)执行。
  向 Klipper 上游提交贡献时，遵循上游自身的提交流程和格式。
- 行为、配置、接口或运维流程有实质变化时同步维护对应文档。
  `README.md` 保持概览和入口，详细说明放在 `docs/`。
- 按变更风险完成检查；纯文档变更检查内容、相对链接、格式和敏感信息。
  代码或配置变更还需执行适用的静态检查、构建与回归测试，参考
  [Debugging.md](docs/Debugging.md)。
- PR 中记录实际执行的命令、结果及未完成验证；没有检查记录不等于检查通过。
  本机、CI、静态配置检查不能代替 Linux、MCU 或真实打印机验证。
- 设备连接、加热、运动、刷写及生产部署需要相应明确授权；普通开发或文档工作不包含这些操作。
- 不得将密码、密钥、令牌、含凭据的 URL 或其他敏感信息写入提交、文档和日志。
