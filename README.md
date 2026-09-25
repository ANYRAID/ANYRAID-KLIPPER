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

离线输入整形校准已改为 `node scripts/calibrate_shaper.ts`，旧 Python
脚本已退役。安装 `host` 依赖后可输出完整精度 CSV、拟合报告和
HTML/PDF/图像，无需 NumPy 或 Matplotlib；不自动修改打印机配置。
使用方法见 [共振测量](docs/Measuring_Resonances.md)。

加速度计原始曲线、频率比较及谱图统一使用
`node scripts/graph_accelerometer.ts -o 输出文件 输入.csv`，旧 Python
图表脚本已退役。支持多文件比较、各轴选择及完整精度 CSV/JSON；
需显式指定输出文件，图表计算不会直接控制打印机。

挤出机压力提前示意图使用 `node scripts/graph_extruder.ts -o 输出文件`，
支持交互 HTML、SVG/PDF 和图像输出；旧 Python 入口及测试运行依赖
已退役。该工具采用固定示例运动，不是实际打印机的校准指令。

Node 主机已接通线性打印机自动配置、原生步进与归零组件、持久化打印
控制器和鉴权 Moonraker 服务。设备层采用每 MCU 共享时间轴；版本化
机器配置已接入，机型适配及实机验收仍待完成。运动流、普通空闲、
暂停恢复、归零过程及加热命令等待已接入从 MCU 周期校准及采样驱动的历史回收；精度与
性能对照见迁移说明。

原生主机可通过 `node scripts/product-host.ts --profile /绝对路径/machine.ts`
启动。机器集成模块必须显式提供物理停止、鉴权、文件授权、类型化打印
生命周期及资源清理；进程接管启动、监听与退出，详见
[Node 主机启动说明](docs/Node_Host_Startup.md)。这不会自动切换现有部署。
也可通过 `npm --prefix host run build:product-host` 生成 JavaScript
运行包；原生插件构建、生产依赖安装与机器模块要求见同一启动说明。

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

A64/AR100 的 SRAM 维护入口已改为 `node scripts/flash-ar100.ts`；先运行
`node host/scripts/build-ar100-flash.ts` 构建固定地址的原生映射模块。
支持固件写入、`--bl31`、`--halt` 和单独的 `--reset`，执行前须停止
打印及其他 AR100 管理者。新入口仅允许 Allwinner A64 设备树和真实
`/dev/mem`，写入后读回验证；当前只通过文件映射替身测试，尚未完成
A64 板卡验收，详见[迁移说明](docs/Node_Host_Migration.md)。

Motan 运动数据采集入口已切换为
`node scripts/motan/data_logger.ts /tmp/klippy_uds mylog -s '*'`，保留原
`.json.gz`/`.index.gz` 格式并使用批量压缩；需要 Node.js 26，采集过程
不调用 Python。新采集的初始和增量索引保留状态数字的整数/浮点类型
及 JSON 对象键的源顺序（包括数字形式的键）。
输出文件必须不存在，重复采集请使用新前缀。Motan 后续分析和绘图
尚未全部迁移，性能与剩余范围见迁移说明。

Motan CSV 推荐使用预编译入口以减少启动开销。安装 `host/` 依赖后，
先运行 `npm --prefix host run build:motan`，再执行
`node host/build/motan/scripts/motan/data_export.js capture -c '["trapq(toolhead,x)"]' -o motion.csv`。
修改源码后需要重新构建；请在没有导出任务使用该目录时构建。
调试时仍可直接运行 `node scripts/motan/data_export.ts`，参数相同。
新入口无需 Python，支持取消、完整文件原子替换及文本/布尔/null/BigInt
原始列，以及整数导数、偏差、CoreXY、norm2、平滑、积分和 SOS 计算。
SOS 整数须在 NumPy int64/uint64 范围内。增加 `--preserve-number-types`
可导出列表/字典状态列，使用 Python repr 文本并保留各行历史快照。
旧 CSV 入口暂时保留。使用
`node scripts/motan/data_export.ts --list-datasets` 可直接列出数据集语法，
不需要日志文件。性能与格式边界见迁移说明。

需要保留状态、Stallguard 或相位列的整数/浮点来源时，可显式增加
`--preserve-number-types`。该模式支持这些列及已知浮点
派生结果之间明确整数/浮点混合的偏差、CoreXY、导数和积分等计算。
其余原始传感器列尚未完整保留类型来源，涉及这些列的不明确混合
运算仍会拒绝。
SOS 输入仍受上述整数范围限制；该模式当前不默认启用，详见迁移说明。
