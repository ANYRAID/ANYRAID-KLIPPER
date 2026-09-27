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

本机迁移验证还发现了离线计算进程崩溃和瞬时运动数值失配，单进程
顺序运行也可复现，根因尚未定位。诊断证据见
[运行时与运动数值异常记录](docs/diagnostics/node26-motion-failures.json)；
当前不能据此工作区的成功样本宣称已满足生产稳定性和运动精度要求。

日志统计图统一使用 `node scripts/graphstats.ts 日志文件 -o 输出文件`，
支持 MCU 负载、系统资源、频率和温度曲线。旧 Python 入口及回归
运行依赖已退役；安装 host 依赖后可直接导出交互 HTML、PDF 或图像。

离线输入整形校准已改为 `node scripts/calibrate_shaper.ts`，旧 Python
脚本已退役。安装 `host` 依赖后可输出完整精度 CSV、拟合报告和
HTML/PDF/图像，无需 NumPy 或 Matplotlib；不自动修改打印机配置。
使用方法见 [共振测量](docs/Measuring_Resonances.md)。

加速度计原始曲线、频率比较及谱图统一使用
`node scripts/graph_accelerometer.ts -o 输出文件 输入.csv`，旧 Python
图表脚本已退役。支持多文件比较、各轴选择及完整精度 CSV/JSON；
需显式指定输出文件，图表计算不会直接控制打印机。

网床分析与可视化统一使用 `node scripts/graph_mesh.ts`，支持路径动画、
交互三维网床、完整精度报告和远程只读快照。旧 Python 入口已退役；
回归与基准使用固定数值参考，不再运行 Python、NumPy 或 Matplotlib。
使用方式见[网床可视化与分析](docs/Bed_Mesh.md#visualization-and-analysis)。

挤出机压力提前示意图使用 `node scripts/graph_extruder.ts -o 输出文件`，
支持交互 HTML、SVG/PDF 和图像输出；旧 Python 入口及测试运行依赖
已退役。该工具采用固定示例运动，不是实际打印机的校准指令。

输入整形频响和阶跃响应模拟使用 `node scripts/graph_shaper.ts`，
需指定 `-o 输出文件`。六种内置整形器及参数化 MZV 的数值参考已
固定保存，图表、回归及基准不再依赖旧 Python 脚本。

运动速度、加速度及弹簧偏差示例使用 `node scripts/graph_motion.ts`，
支持实验滤波器、加速度阶数和旧整形器选择，需指定 `-o 输出文件`。
旧 Python 入口已退役；这些离线示例不修改打印机配置。

Node 主机已接通线性打印机自动配置、原生步进与归零组件、持久化打印
控制器和鉴权 Moonraker 服务。设备层采用每 MCU 共享时间轴；版本化
机器配置已接入，机型适配及实机验收仍待完成。运动流、普通空闲、
暂停恢复、归零过程及加热命令等待已接入从 MCU 周期校准及采样驱动的历史回收；精度与
性能对照见迁移说明。

TMC2208/2209 UART 和 TMC2130/5160 硬件／软件 SPI 已接入原生配置、
故障监测及类型化电流维护，并通过模拟 MCU 的完整打印验收；
目标板电气、时序和打印质量尚未验收。

独立 MAX6675 SPI 温度输入已接入原生采样、状态、温度历史和故障停机，
硬件及软件 SPI 已通过模拟 MCU 的编译产品打印流程；真实电气及温度
精度尚未验收。MAX6675 也已接入热端、热床和通用加热器反馈，复用
温控和输出保护，并支持与 TMC 共享接线一致的硬件或软件 SPI 总线；
其他数字温度源仍在迁移。

原生主机可通过 `node scripts/product-host.ts --profile /绝对路径/machine.ts`
启动。机器集成模块必须显式提供物理停止、鉴权、文件授权、类型化打印
生命周期及资源清理；进程接管启动、监听与退出，详见
[Node 主机启动说明](docs/Node_Host_Startup.md)。这不会自动切换现有部署。
也可通过 `npm --prefix host run build:product-host` 生成 JavaScript
运行包；原生插件构建、生产依赖安装与机器模块要求见同一启动说明。

`loadNativeProductMachineProfile` 已提供持久文件、上传、元数据和打印源的
统一装配，实际机型仍需提供显式停止、鉴权及输出生命周期适配。编译后
负载打印验收使用同一产品入口；这不代表已完成真实机型适配。

编译包现可用 `scripts/product-service-unit.js` 生成并核验 Node 主机的
systemd 服务文件，详见启动说明。生成不会启用服务；默认 Python 安装
入口及实机迁移门槛仍未退役。

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
旧 `data_export.py` 已退役。CSV 导出的类型、相位、Stallguard、结构化
状态和过滤结果对照，以及编译导出基准，均读取按输入摘要校验的固定
CPython 参考，不再运行旧导出器。其他 Motan 数学/采样对照仍有 Python
依赖；离线小标量 CSV 的冷启动目前仍慢于旧 Python，详见迁移说明。
新入口无需 Python，支持取消、完整文件原子替换及文本/布尔/null/BigInt
原始列，以及整数导数、偏差、CoreXY、norm2、平滑、积分和 SOS 计算。
SOS 整数须在 NumPy int64/uint64 范围内。增加 `--preserve-number-types`
可导出列表/字典状态列，使用 Python repr 文本并保留各行历史快照。
旧 CSV 入口暂时保留。使用
`node scripts/motan/data_export.ts --list-datasets` 可直接列出数据集语法，
不需要日志文件。性能与格式边界见迁移说明。

Motan 浮点派生及类型化标量数学的回归、CSV 对照和 6 组基准已改用
固定 CPython 参考，不再启动 Python；参考按输入及采集文件摘要校验。
其他 Motan 对照仍有 Python 依赖，当前不能在无 Python 环境中运行全套测试。

完整 Motan 分析器的回归和三组分析基准也已改为固定参考，不再调用
Python 或 Git。参考保留 Float64 原始位、采集文件与参数摘要，并覆盖
时间网格、运动学、派生量和滤波；其他底层采样/滤波对照仍待迁移。

需要保留状态、Stallguard 或相位列的整数/浮点来源时，可显式增加
`--preserve-number-types`。该模式支持这些列及已知浮点
派生结果之间明确整数/浮点混合的偏差、CoreXY、导数和积分等计算。
其余原始传感器列尚未完整保留类型来源，涉及这些列的不明确混合
运算仍会拒绝。
SOS 输入仍受上述整数范围限制；该模式当前不默认启用，详见迁移说明。

原生主机配置 `nativeUploads` 后，支持上传文件列表及按不可变文件 ID
下载原始 G-code（含单段续传）。下载使用独立配额的封存快照和分块
传输；主机迁移说明记录了并发打印验证、性能及尚未完成的文件管理范围。
主服务绑定打印控制器后支持鉴权删除；当前打印占用的文件受保护，其他
文件可在打印期间清理，删除会回收存储配额并撤销缓存预览。
配置独立的通知授权后，客户端可通过 WebSocket 接收原生文件创建及删除
事件；断线重连后仍需查询列表重新同步。

原生文件已接入平面目录和切片参数查询，解析在 Worker 中执行并缓存
结果。原生缩略图已接通查询与鉴权下载，图片解码在独立子进程执行；
预览缓存有界且重启后按需重建。统一元数据生命周期仍在迁移中，具体范围和性能记录
见迁移说明。
