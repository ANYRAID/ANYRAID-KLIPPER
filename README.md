Welcome to the Klipper project!

[![Klipper](docs/img/klipper-logo-small.png)](https://www.klipper3d.org/)

https://www.klipper3d.org/

The Klipper firmware controls 3d-Printers. It combines the power of a
general purpose computer with one or more micro-controllers. See the
[features document](https://www.klipper3d.org/Features.html) for more
information on why you should use the Klipper software.

Start by [installing Klipper software](https://www.klipper3d.org/Installation.html).

Klipper software is Free Software. See the [license](COPYING) or read
the [documentation](https://www.klipper3d.org/Overview.html). We
depend on the generous support from our
[sponsors](https://www.klipper3d.org/Sponsors.html).

ANYRAID 的 Node.js 26 / TypeScript 主机迁移进度、验证门禁和 Moonraker
集成范围见 [迁移说明](docs/Node_Host_Migration.md)。host 运行需要
Node.js 26.9 或更高的 26.x 版本。当前打印入口仍为 Python，新的主机
实现尚未完成硬件验收。

本分支的固件构建现需 Node.js 26（`node` 可在 PATH 中找到，或通过
`make NODE=/绝对路径/node` 指定）。构建生成器不需要安装 npm 依赖；
Kconfig 和其他尚未迁移的工具仍需要 Python。
