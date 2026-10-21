<p align="center">
  <img src="docs/img/anyraid-logo.png" alt="ANYRAID" width="194">
</p>

# ANYRAID-KLIPPER

[English](#english) | [简体中文](#简体中文)

## English

### Overview

ANYRAID-KLIPPER is a public fork of
[Klipper](https://github.com/Klipper3d/klipper), maintained by ANYRAID.
Klipper controls 3D printers by combining a Python host application on a
computer with C firmware on one or more microcontrollers. This repository
contains the host software, MCU firmware, configuration examples, and
technical documentation.

### Documentation and installation

- [Documentation overview](docs/Overview.md)
- [Installation guide](docs/Installation.md)
- [Configuration reference](docs/Config_Reference.md)
- [Configuration examples](config/)

These documents are inherited from upstream Klipper and are provided here
for this repository version. The installation guide describes upstream
installation methods and may refer to upstream repositories or external
tools; it is not an ANYRAID-specific deployment guide. Review the instructions
and configuration for your hardware before installing or flashing firmware.

### Development

`main` is the default release branch, `develop` is the integration branch,
and `master` only mirrors upstream Klipper's `master`. Start from the latest
`develop` in a separate `devac/` task branch and worktree, then submit a PR to
`develop`. After integration validation, changes reach `main` through a PR.
Upstream updates also pass through a task branch and this PR workflow.

See the [branch workflow](docs/Branch_Workflow.md) and
[repository guidelines](AGENTS.md). The
[upstream contribution guide](docs/CONTRIBUTING.md) covers code quality,
contribution provenance, and license requirements; contributions to upstream
Klipper follow upstream's own process.

### Support and feedback

Report issues specific to this fork in
[ANYRAID-KLIPPER Issues](https://github.com/ANYRAID/ANYRAID-KLIPPER/issues).
Include the revision, relevant configuration, logs, and steps to reproduce.
For general Klipper documentation and community support, visit the
[upstream website](https://www.klipper3d.org/) and
[upstream contact guide](https://www.klipper3d.org/Contact.html).

### License and upstream acknowledgements

This fork retains Klipper's [GNU GPLv3 license](COPYING), copyright notices,
and contribution materials. Thanks to the Klipper authors, contributors,
and community. The [upstream sponsorship page](https://www.klipper3d.org/Sponsors.html)
supports the upstream Klipper project.

## 简体中文

### 项目概览

ANYRAID-KLIPPER 是由 ANYRAID 维护的
[Klipper](https://github.com/Klipper3d/klipper) 公开分叉。Klipper 将计算机上
运行的 Python 主机程序与一个或多个微控制器上的 C 固件结合，用于控制 3D 打印机。
本仓库包含主机软件、MCU 固件、配置示例和技术文档。

### 文档与安装

- [文档总览](docs/Overview.md)
- [安装指南](docs/Installation.md)
- [配置参考](docs/Config_Reference.md)
- [配置示例](config/)

这些文档继承自 Klipper 上游，此处链接对应本仓库版本。安装指南介绍上游安装方法，
其中可能引用上游仓库或外部工具，并非 ANYRAID 专用部署教程。安装或刷写固件前，
请根据实际硬件核对说明与配置。

### 开发协作

`main` 是默认发布分支，`develop` 是集成分支，`master` 仅镜像 Klipper 上游的
`master`。从最新 `develop` 建立独立的 `devac/` 任务分支和工作树，随后通过 PR
合入 `develop`；完成集成验证后，再通过 PR 合入 `main`。上游更新同样经过任务
分支和这条 PR 流程。

详见[分支工作流](docs/Branch_Workflow.md)和[仓库协作约定](AGENTS.md)。
[上游贡献指南](docs/CONTRIBUTING.md)规定代码质量、贡献来源和许可证要求；
向 Klipper 上游贡献时遵循上游自身的流程。

### 支持与反馈

与本分叉有关的问题，请提交至
[ANYRAID-KLIPPER Issues](https://github.com/ANYRAID/ANYRAID-KLIPPER/issues)，
并附上版本、相关配置、日志和复现步骤。Klipper 通用文档及社区支持请参见
[上游官网](https://www.klipper3d.org/)和
[上游联系指引](https://www.klipper3d.org/Contact.html)。

### 许可证与上游致谢

本分叉保留 Klipper 的 [GNU GPLv3 许可证](COPYING)、版权声明和贡献资料。
感谢 Klipper 作者、贡献者和社区。[上游赞助页面](https://www.klipper3d.org/Sponsors.html)
用于支持 Klipper 上游项目。
