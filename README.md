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

ATSAM、ATSAMD、LPC176x、RP2040/RP2350 和 STM32 的 USB `make flash`
入口已切换为 Node；构建会使用本机 `HOSTCC`（默认 `cc`）生成串口
原生模块，需要对应 Node 26 的开发头文件，可用 `NODE_INCLUDE` 指定。
这些入口仍需各自的 bossac、dfu-util、hid-flash 或 picoboot 工具。
已进入 Katapult 的串口设备可用
`node scripts/flash_usb.ts --katapult -d /dev/serial/by-id/设备 固件.bin`。
刷写前应停止打印主机并确认设备空闲；取消不能撤销已经写入的固件。
串口维护入口会检查可见进程的端口占用并保留独占锁；权限限制和
并发打开仍有检测盲区，该检查不能替代停止打印主机。
当前验证包含模拟协议与 PTY，实际板卡烧录和打印性能仍待验收。

独立 Katapult 工具为 `node scripts/katapult.ts --help`，支持串口/CAN
刷写、状态、定向启动请求和 CAN 查询。CAN 使用前还需运行
`node host/scripts/build-can-query.ts`；示例见
[Bootloaders](docs/Bootloaders.md)。旧 Katapult Python 工具已退役，差分参考保存为固定契约数据。
写入失败不会自动重放或启动未验证的固件，物理板卡验收仍未完成。
