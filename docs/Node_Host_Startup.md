# Node 主机启动与机器集成

原生入口使用 Node.js 26.9 或更高的 26.x 版本：

```sh
node scripts/product-host.ts --help
node scripts/product-host.ts --profile /etc/anyraid/machine.ts
```

`--profile` 必须是本机 `.ts`、`.mts`、`.js` 或 `.mjs` 模块的绝对路径。
帮助和参数错误不会加载机器模块或原生插件。运行主机前仍须安装
`host` 依赖并完成 `npm --prefix host run build:native`，运行环境和
迁移范围见 [迁移说明](Node_Host_Migration.md)。

这是显式机器集成入口。仓库未提供可直接套用到任意打印机的生产
机器模块，也未将默认 Python 服务切换到此命令。下面的声明式配置
可以装配已支持的线性机器；机型适配、目标机部署、其余设备支持和
实机验收仍需继续完成。

自动线性机器装配会检查合并 include 后的每个打印机配置节。尚未迁移的
组件（例如 gcode_macro、temperature_fan、exclude_object）或没有
对应设备的 verify_heater、TMC、endstop_phase、bed_mesh 配置会明确报错，
不会在忽略这些配置后报告就绪。文件机器配置入口在创建适配器、作业
数据库和连接 MCU 前执行此检查；已保存的网床配置仍需对应 [bed_mesh]。
遇到未支持配置时，应完成对应能力迁移和产品操作绑定，不应仅删除配置
来绕过功能缺失。当前检查覆盖配置节及从属关系，完整选项级兼容审计
尚未完成；具体数值、选项和硬件约束继续由各组件校验。
实现清单见 [配置节校验器](../host/src/config/native-printer-sections.ts)，
验证结果见 [配置预检验收](../host/contracts/native-printer-sections-acceptance.json)。

## 独立模拟温度传感器

自动装配支持 `[temperature_sensor chamber]` 这类独立 ADC 温度输入。
配置 `sensor_type`、`sensor_pin`，并按设备设置 `min_temp`、`max_temp`；
支持现有热敏电阻和线性 ADC 转换器；MAX6675 数字 SPI 输入见下文，
其他数字 SPI/I2C 温度源仍待迁移。
默认温度边界与原实现相同，为 -273.15 和 99999999.9 摄氏度。
可选 `gcode_id: C` 将传感器加入 M105 报告，TEMPERATURE_WAIT 可引用
完整传感器名；它不接受加热目标，也不分配 PWM 输出。

对象查询/订阅中的 `temperature_sensor chamber` 返回 temperature、
measured_min_temp、measured_max_temp；同时列入 heaters.available_sensors，
不会列入 available_heaters。显示值按原 Python 规则保留两位小数，
内部转换和等待判断使用完整精度。零温度不更新极值，初始最小/最大值
保持原实现的 99999999/0，负温度不会将初始最大值降到零以下。

ADC 输入具有独占引脚及 OID，沿所属 MCU 时钟采样；启动前订阅，配置
完成后激活。越界、格式错误或超过七秒未收到有效报告会沿既有 ADC
保护链路停止 MCU 组。主机重初始化会重建传感器统计，不重放采样。
本机模拟验收及性能记录见
[独立温度传感器验收](../host/contracts/temperature-sensor-acceptance.json)。

## 主机温度传感器

`[temperature_sensor host]` 可使用 `sensor_type: temperature_host`。
`sensor_path` 默认为 `/sys/class/thermal/thermal_zone0/temp`，也可指定
其他绝对路径的温度文件，内容须为有限十进制毫摄氏度数值。沿用上述
min_temp、max_temp 和可选 gcode_id，不要求 sensor_pin，不分配 MCU ADC。

文件按一秒间隔异步读取，每次最多 128 字节，只允许常规文件（包含
Linux sysfs 温度节点），不会把 FIFO 当作温度源。首次读取成功后才完成
硬件启动。原生状态同时提供 temperature_sensor host 的统计和
temperature_host host 的 temperature，不能有重复的主机温度对象短名。

文件内容错误、越界或读取超过七秒会停止设备并保留最后一次有效温度，
不会像旧读取错误路径那样发布零值或静默停止采样。退出会取消定时器、
等待在途文件读取后关闭句柄；重初始化重新打开文件并清空统计。
受阻的文件系统读取可能延迟句柄回收，不能据此宣称任意文件系统都有
严格的退出延迟上限。本轮使用普通临时文件和模拟 MCU 验收，未验证
目标设备的真实 sysfs 驱动；证据见
[主机温度验收](../host/contracts/host-temperature-acceptance.json)。

## MAX6675 数字温度传感器

原生独立 `[temperature_sensor chamber]` 支持 `sensor_type: MAX6675`。
`sensor_pin` 为片选；硬件 SPI 必须指定 `spi_bus`，软件 SPI 则指定
`spi_software_miso_pin`、`spi_software_mosi_pin` 和 `spi_software_sclk_pin`，
两种配置不能混用。所有引脚必须属于片选所在 MCU；引脚别名、保留引脚、
冲突及固件命令会在提交 MCU 配置前检查。SPI 使用 mode 0，默认 4 MHz，
允许 100 kHz 至 4.3 MHz。总线及引脚应按目标板实际接线配置。

固件按 0.3 秒报告；主机订阅先于 MCU 配置，激活前的有效样本先缓存。
读取保留无符号 12 位、每单位 0.25°C 的原始精度。芯片编码范围为
0 至 1023.75°C，仍须配置适合机器的 min_temp/max_temp；没有任何可表达
温度的范围会被拒绝。固件阈值向允许范围内部取整，上界允许不参与温度
计算的 D0 三态值。与旧 Python 四舍五入阈值有意不同，例如
20.01–20.99°C 只允许 20.25、20.50、20.75°C。格式依据
[Analog Devices MAX6675 手册](https://www.analog.com/media/en/technical-documentation/data-sheets/max6675.pdf)。

热电偶开路、设备位异常、保留位错误、越界、重复或倒退采样、过期或
明显未来采样均停止 MCU 组；首样本或后续报告超过七秒也停止。
MCU 继续配置三次无效报告保护，主机收到故障不等待其累计。
退出解除响应订阅、监测定时器及共享时钟历史租约。通过既有传感器
注册提供 M105、TEMPERATURE_WAIT、对象查询和温度历史，不具有加热目标权限。

此路径也支持 extruder、heater_bed 和 heater_generic 的温度反馈：保留
heater_pin、control、PID/开关参数、verify_heater 和功率设置，按上述方式
配置 MAX6675 的片选和总线。加热器的 min_temp/max_temp 必须位于
0–1023.75°C 内；超出芯片能力的加热量程在 MCU 配置前拒绝。
数字输入与 ADC 复用相同异步温控和输出保护：无新鲜温度不能设非零
目标，初始及默认功率为零，MCU 输出看门狗为三秒，目标归零须确认
代次重置，反馈或传输故障沿整机停止路径处理。热端挤出温度限制、
加热等待、heater_fan/controller_fan 及对象温度/目标/功率均使用统一
加热器状态。独立传感器与加热器反馈同批分配 SPI 资源，可共享总线。

尚未迁移 MAX31855/MAX31856/MAX31865。多个同类传感器可共用 SPI 总线，
现已支持与 TMC 共用总线：必须属于同一 MCU、同一种 SPI 实现且完整
物理接线一致，片选保持独占。硬件总线别名须映射相同控制器；不允许
硬件/软件混用、信号互换或部分重叠，多重使用设置不能绕过这些约束。
全部片选先配置，再启用总线；固件在每次片选前恢复设备模式和速率。
已验证硬件 SPI、现代和旧软件 SPI 的模拟配置，以及硬件/现代软件 SPI
编译产品的打印、重初始化和开路停机；真实 SPI 电气时序、热精度和
目标板验收未完成。证据见 [MAX6675 输入验收](../host/contracts/max6675-acceptance.json)
和[数字加热器反馈验收](../host/contracts/spi-heater-acceptance.json)。
跨 TMC 共享的独立产品验证见[共享 SPI 验收](../host/contracts/shared-spi-acceptance.json)。

## 原生温度历史

原生产品默认提供 GET `/server/temperature_store`，无需 Python Klippy
连接或显式开启 temperatureStore。每秒从原生对象采集一次温度、目标、
功率或速度；独立温度传感器只提供 temperatures 数组。初始就绪快照
作为第一个样本，随后以固定容量保留最近样本。

Moonraker 配置 `[data_store] temperature_store_size` 控制每字段容量，
默认 1200；沿用现有传感器数量和总槽位限制。查询遵循服务鉴权，
`include_monitors=true` 可包含已声明的监测对象。历史舍入仅用于遥测，
不反馈到温控或运动计算。采样查询失败时保留历史并记录运行时错误，
硬件状态仍应从原生主机和设备对象判断。

历史保存在主机进程内存中。原生重初始化在旧服务和依赖关闭成功后，
将已有字段的历史复制给新服务，再追加新代次初始样本。容量缩小时
只保留最近样本；删除的传感器或字段被移除，新增字段从新样本开始。
复制保留已舍入值和负零，不重复舍入；采样器不共享可变缓冲区。
重初始化间隙不补造样本，进程退出后不保留历史。关闭失败不会创建
替代服务。数值参考和基准已经移除 Python 执行依赖，详见
[原生温度历史验收](../host/contracts/native-temperature-history-acceptance.json)和
[重初始化历史交接验收](../host/contracts/temperature-handoff-acceptance.json)。

## 编译后的运行包

在已经安装开发依赖的仓库内，使用目标运行环境对应的 Node.js 26.9+
26.x 生成 JavaScript 主机包；需 C 编译器及对应 Node 头文件：

```sh
npm --prefix host run build:product-host
cd host/build/product-host
node --no-experimental-strip-types scripts/product-install.js --bundle "$PWD"
node --no-experimental-strip-types scripts/product-host.js --profile /etc/anyraid/machine.mjs
```

运行包包含主机 JS、后台 worker/子进程、JSON 数值与 Unicode 契约、
字体及许可证、生产依赖清单与锁文件，以及现有原生插件。依赖需要
单独安装；构建命令不下载依赖，默认从私有源码快照重建 7 个原生插件，
不再复制工作区遗留插件。可在命令末尾通过
`-- /绝对路径/输出目录` 指定构建目录。

运行包自带 product-install.js，源码入口为 scripts/product-install.ts。
安装前后核对产物清单及当前 Node ABI；package.json 和锁文件必须在
清单中。使用当前 Node 执行 npm ci，仅安装生产依赖与可选平台依赖，
禁用生命周期脚本、TS 解析和外部 PATH 程序。默认查找当前 Node 附带
的 npm，也可通过 `--npm /绝对路径/npm-cli.js` 指定 npm CLI。
这不验证清单来源或替代依赖供应链审核。

安装器拒绝已有 node_modules，使用目录锁阻止同一包并发安装；不覆盖
现有运行服务。依赖在锁目录内安装，核对包清单、暂存清单及直接依赖后，
通过同文件系统 rename 发布完整 node_modules。普通失败和取消会等待
npm 子进程退出并删除暂存目录，可直接重试；不会发布半成品依赖。
意外强制终止或断电仍可能留下锁目录，应确认没有安装进程后再清理该锁。
发布后已存在依赖的运行包仍不可原地重装，应准备新的离线运行包。
此命令不安装 Node、不创建账号、不启停服务，
也不替代下述默认服务切换门槛。

`build-info.json` 记录 Node、TypeScript、平台、架构、模块 ABI 及各
产物的 SHA-256。`host/build/native-build-info.json` 进一步记录本次
C 源码/构建脚本、Node 头文件快照和插件输出摘要，以及编译器版本。
相同输入的本机重复构建已验证清单一致；这些记录不是签名，也不覆盖
编译器二进制、系统头文件及 libc 的完整供应链。跨架构、平台或 ABI
使用前必须在目标环境构建并验证。默认不包含实验性 `template.node`。
内部 buildProductHost 的第三参数可显式提供预构建目录供专用测试使用，
该路径不提供默认源码重建保证；CLI 没有跳过重编译的选项。

编译运行时的机器模块应使用 `.mjs`，或明确配置为 ESM 的 `.js`，并从
同一运行包导入类与组件。不得把源码 `.ts` 类实例与编译版混用。
采用 JS 机器模块后，主机及其后台任务无需 TypeScript 运行时解析，
也不调用 Python。仓库中的其他工具和固件辅助程序不因此全部成为
独立部署包的一部分。

输出目录只能存放可重建产物，机器模块、配置、日志和打印数据放在
目录外。构建先写入临时目录，编译或插件校验失败时保留旧包；通过
生成标记识别旧包，并拒绝覆盖无标记目录或并发构建。成功构建会整体
替换旧目录（包括其中另外安装的 node_modules），随后重新安装依赖。
此机制用于离线产物生成，不是运行中服务的更新、断电事务或生产发布
协议；实际切换仍按项目发布和实机验证流程执行。

`npm --prefix host run bench:product-build` 比较源码与编译包的冷启动及
后台任务，逐项核对数学输出。编译产物测试另行禁用 TypeScript 解析
并清空外部程序 PATH，覆盖数值计算、持久化、缩略图、原生步进、PDF
字体资源和双 UART 主机启停。统一产品验收另覆盖编译包的上传、打印、
暂停/恢复、取消及 SIGHUP 后再打印。测试 UART 对端为模拟 MCU。

## systemd 部署入口与默认服务切换

编译包包含只读服务生成工具。在目标 Linux 主机使用最终部署的 Node.js
26.9+ 26.x 执行，先安装运行包生产依赖，再生成待审核的服务文件：

```sh
/opt/node26/bin/node /opt/anyraid/scripts/product-service-unit.js \
  --bundle /opt/anyraid --profile /etc/anyraid/machine.mjs --user printer \
  > /tmp/anyraid-host.service
systemd-analyze verify /tmp/anyraid-host.service
```

源码入口为 `node scripts/product-service-unit.ts`，参数相同。工具核对
build-info.json 的产品、平台、架构及 Node ABI，并计算清单内每个文件
的 SHA-256；这不认证清单的来源，也不验证安装后的第三方依赖或机器
模块行为。机器模块和 Node 可执行文件必须在可替换运行包之外；生成
过程不导入机器模块，不打开 MCU，不安装或操作系统服务。应在审核后
保持包内容不变；此检查不是启动时的防篡改机制。

生成的 ExecStart 使用当前 Node 可执行文件的绝对路径和编译 JS 入口，
禁用 TypeScript 解析。配置路径支持空格、引号、美元符号及百分号；
工作目录固定为 /，机器模块应使用绝对配置路径及基于 import.meta.url
的资源路径。printer 是必须预先建立的普通用户示例，需按实际机型配置
串口/CAN 权限以及日志、数据库和发布文件目录权限；工具不创建账号。

服务设置 Restart=no，故障退出后需要明确诊断和恢复。SIGTERM 先交给
主进程完成停止与资源清理；KillMode=mixed 在 90 秒停止超时后清理剩余
进程。进程退出或 systemd active 状态都不能证明硬件物理停止或就绪；
独立物理停止绑定与固件失联保护仍为机型验收要求。不设置 ExecReload，
不会把普通服务 reload 隐式映射为打印主机重初始化。

**启用此服务会与 klipper.service 和 moonraker.service 互斥，停止这些
标准名称的旧服务。** 自定义服务名称、手工进程及其他 MCU 使用者需在
切换时另行确认。仓库当前未执行安装、启用或默认入口切换。完成下表
门槛并按项目 PR/发布流程获准部署后，才可将审核后的文件安装到
/etc/systemd/system/anyraid-host.service，执行 daemon-reload 和启用操作。
保留旧服务文件、配置和数据备份；回退也须先确认打印已停止。

| 默认入口切换依赖 | 当前证据与剩余工作 |
| --- | --- |
| 不依赖 Python 的主机产物 | 已有独立 JS 包、原生插件源码构建和离线生产依赖安装测试；须在目标平台再验证 |
| 机器配置与板卡适配 | loadNativeProductMachineProfile 已统一文件与元数据装配；仍需真实机型的停止、鉴权及输出生命周期绑定 |
| 服务启动与退出 | 已有生成器、本机 systemd 解析、外置 JS 模块与双模拟 UART 启停验证；尚未运行真实系统服务 |
| 现有安装入口退役 | install-debian.sh 等仍安装 Python；需在目标机型端到端验收后切换，当前未退役 |
| 客户端与完整 Moonraker | 已有标准打印等接口；完整功能及客户端整体验收仍未完成 |
| 速度、精度与恢复 | 已有本机模拟基准；历史数值异常、EPIPE、独立环境与真实打印精度/吞吐/故障验收尚未关闭 |

CoreXY 和 CoreXZ 已通过与 Cartesian 相同的编译产品模拟流程，包括
归零、网床补偿、断料暂停恢复、校准保存与驱动故障停止，详见
[验收记录](../host/contracts/product-core-kinematics-acceptance.json)。
这补齐了配置启动以外的流程证据，不替代耦合电机接线、重复归零和真机打印验收。

## 机器模块契约

### 包含原生文件管理的机器配置

推荐原生产品使用 `loadNativeProductMachineProfile`，它复用下述版本化
机器 JSON 和拓扑校验，统一装配持久文件库、上传/下载、缩略图元数据、
sealed-file 打印源及可选标准客户端打印策略。编译后的机器模块示例：

```js
import {loadNativeProductMachineProfile} from '/opt/anyraid/host/src/runtime/native-product-machine.js';
import {createMachineAdapter} from './board-adapter.mjs';

export function createProductHostProfile(signal) {
  return loadNativeProductMachineProfile('/etc/anyraid/machine.json', {
    filesRoot: '/var/lib/anyraid/files',
    metadataRoot: '/var/lib/anyraid/metadata',
    uploads: {stagingRoot: '/var/lib/anyraid/staging'},
    standardPrint: {nozzle: 200, bed: 60},
    createAdapter: createMachineAdapter,
  }, signal);
}
```

温度只是示例，必须按机型与材料确定。省略 standardPrint 时只保留类型化
打印请求，不猜测 filename-only 请求的温度。提供时检查机器温度上限，
只解析已发布的 `<fileId>.gcode`；上传文件不会因此自动开印或执行宏。
可用 files 和 uploads 配置现有存储与传输配额；两个持久根目录必须是
绝对且互不包含的配置路径，stagingRoot 必须预先存在。

`createAdapter(configuration, signal, maintenanceGate)` 返回
[NativeMachineAdapter](../host/src/runtime/native-product-machine.ts)：逐 MCU
独立 stops、类型化 lifecycle、G-code output、authorizePrintFile、server
与 release。server 必须显式提供 authorize 和 authorizeNotification；
authorizePrintFile 是打印源准入策略，在标准文件解析及实际打开前各自
调用，不替代 RPC 对用户、file_id 和状态控制的授权。适配器不再创建
文件库、上传所有者或 productPrintCompatibility，也不能覆盖这些所有者。
机型仍须提供真实物理停止和附加输出控制，不能将测试中的空回调用于实机。

适配器工厂自行清理返回前的部分失败；成功返回后产品模块接管清理，
即使此时已取消。文件库或元数据装配失败也会关闭已打开的所有者，再
释放适配器。正常退出须先让主机和网络退场，再调用返回的 release；
入口已按此顺序管理。重复 release 共用结果，并保留清理错误。

打印源准入最多 8 个在途操作，关闭先取消并等待在途授权，再释放上传、
文件库及适配器。授权函数必须响应 AbortSignal；不响应的函数会阻止
资源清理完成。即使授权迟到成功，也会重新检查取消和共享准入状态，
不能在关闭后继续打开文件。配置和标准温度策略在装配时复制，不能由
适配器修改配置副本来覆盖机器限制。

下述 `loadProductMachineProfile` 保留为需要自定义存储所有者的底层入口。

### 声明式机器配置

可信机器模块可以使用 `loadProductMachineProfile` 管理配置、打印日志
和资源清理。编译运行包的模块示例：

```js
import {loadProductMachineProfile} from '/opt/anyraid/host/src/runtime/product-machine-profile.js';
import {createMachineBindings} from './board-adapter.mjs';

export function createProductHostProfile(signal) {
  return loadProductMachineProfile('/etc/anyraid/machine.json', createMachineBindings, signal);
}
```

`board-adapter.mjs` 是机型集成实现，不是仓库提供的通用驱动。
JSON 只保存数据，例如以下结构（坐标、速度和温度须按机型确定）：

```json
{
  "version": 1,
  "deviceId": "printer-01",
  "printerConfig": "/etc/anyraid/printer.cfg",
  "moonrakerConfig": "/etc/anyraid/moonraker.conf",
  "journalPath": "/var/lib/anyraid/jobs.db",
  "mcus": {
    "mcu": {"transport": "uart", "rts": true, "leaveBootloader": false}
  },
  "machine": {"enableLeadTime": 0.001, "fanMinimumScheduleTime": 0.001},
  "limits": {"maxNozzle": 300, "maxBed": 130},
  "print": {
    "motorCompletion": "hold",
    "startupHoming": {"mode": "home", "axes": [0, 1, 2]},
    "parking": {
      "parkXY": [0, 0], "retract": 0, "lift": 0,
      "travelSpeed": 10, "liftSpeed": 5, "retractSpeed": 5
    }
  }
}
```

标准机器装配同时声明独立恢复日志路径 journalPath +
.host-recovery.sqlite；例如 /var/lib/anyraid/jobs.db.host-recovery.sqlite。
恢复日志由主机进程所有者打开和关闭，跨设备重新初始化保持同一所有者，
不由单个机器会话释放。备份或迁移时应在主机完全退出后同时保存两类日志。
自定义 ProductHostProfile 可显式提供 recoveryJournal 的 path/deviceId；
未提供时为测试/兼容的内存模式，host/status 的 durable 为 false，不能
将其当作持久化恢复部署。

根节点与每层对象都拒绝未知字段。路径必须为绝对路径，JSON 文件须为
不超过 64 KiB 的 UTF-8 普通文件；非有限数、重复归零轴、负停车距离、
无效速度和超时都会失败。CAN 策略使用 `transport: "can"`、`nodeId`
及 `timeoutMs`；管道策略只有 `transport: "pipe"`。`mcus` 必须精确
覆盖 printer.cfg 中的所有 MCU，传输种类一致，同一 CAN 接口不能重复
分配节点 ID。读取配置和规划阶段不连接传输，也不产生运动许可。

可选字段包括 `deadlines` 的 startMs/pauseMs/resumeMs/stopMs/finishMs，
`hardware` 的 timeoutMs/heaterGcodeIds，以及 `print` 的 bedHeater 和
homingTimeoutMs。省略时沿用各组件的默认值。数值保持 Number 精度，
不进行单位转换或取整；仍由实际运动、温控和硬件装配层校验设备约束。

`createMachineBindings(configuration, signal, maintenanceGate)` 返回：

- `stops`：逐 MCU 的独立物理停止函数 Map，不能依赖同一个主机停止流程。
- `print`：类型化 lifecycle、授权 sealed-file 的 open 和 G-code output。
- `server`：Moonraker 组件、真实信息快照及显式 authorize 等策略。
- `release()`：释放适配器取得的资源；部分创建失败由工厂自行清理。

传给适配器的 configuration 是独立副本，不能通过修改它覆盖已选定的
停车、归零或温度策略。maintenanceGate 与最终打印控制器共用，供
NativePrintUploads 等组件使用；所有组件仍遵循各自的所有权契约。
配置结构、网络监听参数、MCU 覆盖和线性拓扑通过后才调用适配器；
适配器完整性通过后再打开日志。硬件字典及运行状态相关校验仍在连接
和装配阶段执行。Moonraker 在服务装配时重新读取配置，当前不是多个
配置文件的原子快照或热重载机制。

适配器返回后即转移清理责任，包含返回时已取消的情况。装配失败会
关闭适配器和已取得的日志，保留原始错误与清理错误；正常退出在真实
打印退场后清理。release 重复调用复用同一个结果，日志最终关闭。
此入口不提供空的物理停止或默认鉴权，也不恢复历史打印动作。

### 完整手工模块

模块导出 `createProductHostProfile(signal)`，返回
[ProductHostProfile](../host/src/runtime/product-host.ts) 对象。配置模块
是管理员维护的可执行代码，不从打印文件、上传内容或网络地址加载。
模块顶层不得打开设备或申请需要关闭的资源；这些操作放在工厂函数内，
才能在启动取消时履行资源清理契约。

工厂结果必须提供：

- `reader`：打印机 ConfigurationReader。
- `policies`：准确覆盖所有 MCU 的 MCUMachinePolicy；独立物理停止回调
  必须由机器集成实现，不能反向等待同一 MCUGroup 的停止流程。
- `product`：已打开的 PrintJournal、专用 MaintenanceGate、温度上限及
  可选操作时限。日志在整机退出并完成退场前保持打开。
- `options`：Moonraker 配置路径与显式鉴权、线性机器规划参数，以及
  已有 ConfiguredPrintOptions。文件入口必须授权不透明 fileId 并返回
  密封读取器；归零、停车、启动和输出完成通过类型化策略提供。
- `release()`：关闭工厂持有的日志、文件及其他依赖；只在服务和已接受
  的打印动作结束后由主机调用一次。

工厂创建中途失败时，自行关闭已经取得的部分资源，再抛出原始错误及
必要的清理错误。工厂成功返回后，依赖所有权移交给主机；即使返回前
启动已被取消，主机也会接收结果并调用 `release()`。主机不会替机器
补充空的物理停止、默认放行鉴权或任意文件路径访问。

## 就绪、故障与退出

只有完成 MCU 连接、原生硬件装配、持久化状态恢复和 HTTP 监听后，
标准输出才发出一行 JSON：

```json
{"event":"ready","address":{"address":"127.0.0.1","family":"IPv4","port":7125}}
```

地址来自实际监听结果。就绪表示服务已启动，不表示已归零、已加热或
获得打印运动许可；不会自动重放未完成的作业。

原生产品服务的鉴权 `/server/info` 增加 `native_host`，每次请求同步
读取当前主机所有者，字段为：

- `version`：当前状态契约版本 1。
- `group_state`、`hardware_state`：MCU 组与已装配硬件的生命周期状态。
- `mcus`：各 MCU 的 id 与会话 state；不含串口路径或底层故障文本。
- `print_state`、`homed_axes`：当前打印生命周期及已归零轴。
- `closing`、`admission_closed`、`maintenance`：服务退场、永久关闭准入
  和维护占用状态。
- `ready`：MCU 组、所有会话及硬件均 ready，且服务未退场、准入未永久
  关闭，打印状态不是 failed/interrupted。它不授予新打印许可；维护占用、
  当前作业、归零和温度约束仍
  必须分别满足。例如未归零的空闲主机可以 ready，但不能越过归零策略。

这些值不从 HTTP 监听或机器配置中的静态信息推断。物理停止确认还在
等待时，group_state 已变为 stopping，ready 立即为 false。读取失败或
来源数据不合法时返回 503，不返回此前缓存的 ready，也不暴露内部
错误。该扩展沿用 `/server/info` 鉴权，普通 Klippy 模式不添加此字段；
未启用标准客户端适配时，`klippy_connected` 和 `klippy_state` 保持旧
后端字段。启用 productPrintCompatibility 的产品服务将这两个兼容字段
映射到进程内原生后端的连接与状态，并返回 host_type: node，含义不是
存在 Python 进程。已有打印状态通知仍使用 notify_print_state_changed。

原生服务还提供 `/printer/objects/list` 与 `/printer/objects/query`，支持
鉴权 REST 和 JSON-RPC（包括 WebSocket）；字段选择格式沿用 Moonraker：

```text
/printer/objects/query?gcode_move=position,speed&extruder=temperature,target,power
```

JSON-RPC 方法为 `printer.objects.query`，参数示例：

```json
{"objects":{"gcode_move":["position","speed"],"extruder":null}}
```

结果为 `{eventtime, status}`。eventtime 使用与串口相同的主机单调时钟，
单位秒；不是 Unix 时间。null 选择对象全部已实现字段，空数组选择
空对象。未知对象返回 `{}`，显式请求的缺失字段返回 null。每个请求
只读取指定的对象，返回值与源对象隔离，不缓存旧结果或发起设备操作。

目前已绑定：

- `native_host`：上述主机状态。
- `webhooks`：与 printer.info 相同的 state/state_message，不含内部故障文本。
- `gcode_move`：坐标模式、速度倍率、进料速度、挤出倍率、归零偏移、
  指令位置、G-code 位置及轴映射。speed 沿用上游 mm/min；位置不取整。
- `toolhead`：指令位置、归零轴、四分量坐标边界、当前挤出机名称、
  max_velocity 和 max_accel。位置是队列规划位置，不是编码器反馈。
- `heaters`：当前已装配加热器、传感器和监控器列表。
- 各加热器配置节（例如 extruder、heater_bed）：最近平滑温度按 Python
  兼容规则显示两位小数，target 保持原值，power 为最后调度的功率；
  独立停止确认后显示零。查询不会刷新 ADC，数值不是电气反馈。
- 各风扇配置节：speed 为已请求速度；当前没有转速计所有者，rpm 为 null。
- `virtual_sdcard`：progress、is_active、file_position、file_size，来源为
  原生文件执行器。位置和大小以文件原始 UTF-8 字节计，含 CRLF；整批
  命令成功提交后推进，不使用预读偏移。批内暂停可能暂时保留上一批
  进度。is_active 表示文件命令正在运行或等待暂停，不是物理运动反馈。
  EOF 后保留已提交位置；空文件进度为零；取消及新文件打开期间清零。
  这里没有公开底层封存文件的路径，file_path 尚未接线。
- `print_stats`：state、message、info.total_layer、info.current_layer。
  状态来自类型化打印控制器；层数来自同一任务的切片命令。准备、运行、
  暂停过程和收尾映射为 printing；暂停及恢复等待映射为 paused；只有
  完成确认后才报告 complete，取消确认后才报告 cancelled。取消等待
  暂映射 printing，具体过渡状态继续读取 native_host.print_state。
  interrupted/failed 映射 error，消息使用固定公开文本，不暴露内部异常。

原生文件支持 `SET_PRINT_STATS_INFO TOTAL_LAYER=100 CURRENT_LAYER=1`。
层数只作元数据，不触发移动、宏或生命周期操作；命令仍受现有 G-code
就绪与串行准入控制。值为非负安全整数，CURRENT_LAYER 超过总层数时
截到总层数，TOTAL_LAYER=0 清空两项。字段省略和总层数变化沿用 Python
规则。新任务准备取得串行命令所有权后清空层数并绑定 requestId，先前
排队的旧命令不能污染新任务。新任务打开文件或准备
尚未完成绑定期间，状态对象不会返回上一任务的层数。

原生文件支持 `G4 P500`，P 为有限、非负毫秒数，每条最多 3600000。
P 为零或省略时只关闭当前前瞻队列；与 Python 入口一致，S 参数忽略，
因此 `G4 S300` 不表示等待 300 秒。正时长必须能在当前浮点时间轴上表示。
停留作为零速度原生轨迹接入，前后运动在停留边界停止，并保留输入整形和
压力提前的时间窗口。长停留沿用 MCU 时间窗推进与周期校准，不授予归零
权限。暂停保留剩余停留时间和文件后缀，恢复继续执行，取消不再执行后缀。
G4 提交完成仍遵循排队语义；物理完成由 M400 或打印控制器的正常收尾确认。
文件中的 M400 等待期间可暂停，保留未执行的后缀；恢复继续完成原运动。
若流式提交已结束而末尾仍在排空，暂停等待末尾确认后进入静止状态，
不会因为此时没有活动流而误报停机。等待期间取消会停止运动。

原生入口默认支持 G2/G3 圆弧及 G17/G18/G19 平面选择；支持整圆、螺旋轴
及绝对/相对挤出，仍要求 XYZ 使用 G90。与 Python 圆弧入口一致，圆心
用当前平面的 IJ、IK 或 JK 偏移指定，不支持 R 半径格式。默认分段长度
为 1 mm，可用 `[gcode_arcs]` 的 `resolution` 配置正数毫米值。沿用
Python 的分段数量和端点规则，每条最多 100000 段，超限直接拒绝，不能
通过自动加粗分段降低运动精度。每 128 段滚动提交前瞻，暂停保留圆弧
内部尚未完成的线段及文件后缀；恢复继续，取消不执行后缀。所有线段仍
经过普通运动的行程、归零及挤出温度保护，圆弧不获得额外运动权限。

原生入口支持 `M204 S1000`、`M204 P1000 T1500` 和
`SET_VELOCITY_LIMIT VELOCITY=100 ACCEL=1000 SQUARE_CORNER_VELOCITY=5 MINIMUM_CRUISE_RATIO=0.5`。
M204 优先使用 S，否则使用 P/T 较小者；只有 P 或 T 时报告无效命令并
保持原值。速度及加速度为有限正数，方角速度非负，最小匀速比处于
[0,1)，派生计算溢出会拒绝整次更新。无参数 SET_VELOCITY_LIMIT 查询
当前值。更新只作用于后续准入的运动，不修改已排队轨迹，不插入额外
停止边界。归零规划使用新的全局上限，独立 Z 轴及挤出限制仍保留。
暂停或其他原生操作占用期间不允许直接变更限制；恢复保留已准入路径。
参数仅为运行时状态，不自动写回配置；toolhead 对象的 max_velocity、
max_accel、square_corner_velocity、minimum_cruise_ratio 返回当前值。

文件进度达到 1 仅表示命令提交完毕。运动排空、输出停止确认和持久化
完成仍由类型化打印控制器判断；必须结合打印状态确认完成，不能用
file_position 自动续打，也不能用 is_active=false 判断设备已安全停止。

对象目录仅列出实际绑定对象。暂未接线的 toolhead 时间/停顿字段、
挤出机额外字段及 print_stats 的文件名、耗材与时长仍需继续实现，不伪造零值。
查询最多 4096 个对象、16384 个显式字段，响应预算 1 MiB（保守保留
外层编码空间）；超限会拒绝。无效状态来源、时钟倒退或读取失败不
返回部分结果。读取状态不改变 G-code 准入、归零或温控保护。

原生 `printer.objects.subscribe` 使用同样的 objects 参数，返回初始
`{eventtime,status}`，后续通过 `notify_status_update` 的
`[status,eventtime]` 参数发送变化字段。必须配置独立的
`authorizeNotification`；HTTP `/printer/objects/subscribe` 还需通过
既有连接关联接口与 `authorizeSubscriptionConnection` 授权目标
WebSocket。入站请求获准不等于获准接收通知。

每个连接的新订阅替换旧选择，空 objects 解除订阅。null 选择按 Python
规则在首次得到非空状态时固定字段列表；之后新增字段需重新订阅。
原生所有者每 250 毫秒合并读取一次，每个对象只读取一次；无订阅时
停止定时器，不补发遗漏的历史采样。初始响应发送前的变化由既有发送
所有者暂存，并按响应时间过滤，避免旧变化回退新快照。

原生订阅最多 256 个连接，合并显式字段最多 16384，采样继续遵守
查询的 1 MiB 预算。慢客户端沿用网络输出预算和待发送上限；通知
鉴权失败或输出失败断开对应连接。采样来源失败则断开当前全部订阅
连接并停止采样，客户端必须重新连接/订阅，不会继续展示缓存为新状态。
此处断线只管理客户端状态通道，设备安全停止仍由原生设备所有者负责。

SIGINT/SIGTERM 取消正在进行的启动，或结束已经就绪的服务。退出先
停止服务与打印所有者，再释放外部依赖。不会为快速退出直接调用
`process.exit()`，也不会因为重复信号跳过清理。已就绪后的正常信号退出返回 0；
启动或清理失败返回非零，并在标准错误输出报告失败。运行期硬件停止
不再自动退出 API：停机与设备准入保护照常执行，鉴权状态及持久化作业
结果保持可查询，直到 SIGINT/SIGTERM 显式关闭主机。独立物理停止失败
会显示未就绪/失败，随后关闭时仍报告清理错误，不被静默吞掉。
不会自动重连 MCU 或恢复打印。

本机可信控制入口支持 SIGHUP 显式重新初始化。仅在 idle/completed/
cancelled/failed 终态、无待处理设备动作或维护活动且物理停止没有失败时
接受请求；先封闭旧会话准入，等待服务和依赖完整退场，再调用机器工厂
建立新会话。重复请求合并，只有新会话 ready 后才报告 reinitialized。
旧会话清理失败或进程退出不会启动替代会话；重新启动失败会报告错误。
API 监听在此期间关闭并重建，客户端须重新连接，工厂应复用相同持久化
日志路径以保留历史。不会重放旧文件，新作业必须重新归零。
远程控制使用原有鉴权策略，必须单独授权 printer.host.status 与
printer.host.reinitialize。GET /printer/host/status 返回当前 state_token、
available（控制入口可用）、busy、durable、storage_failed；available
不等于硬件可打印，存储错误会使控制入口不可用。
POST /printer/host/reinitialize 接受以下 JSON：

```json
{"version":1,"request_id":"recover-001","state_token":"从主机状态读取的令牌"}
```

HTTP 或 WebSocket JSON-RPC 的方法名为 printer.host.reinitialize；
受理结果中的 accepted:true、operation.state:queued 只表示请求排队。
完整响应交给网络层后才开始退场，不保证客户端已经收到该响应。
交付失败、超过 10 秒未交付或会话提前退出时记录 failed，不执行恢复。
实际执行前再次检查准入，期间出现新的打印/维护活动会导致请求失败。
客户端重连后用 GET /printer/host/status?request_id=recover-001 查询
queued/running/succeeded/failed/interrupted；只有新会话 ready 且成功
回执提交完成后才变为 succeeded。
机器重建失败可能使进程退出，此时不能把失联当成恢复成功。

同 request_id 与原 state_token 重试返回原记录，不再次执行；冲突身份
或旧会话令牌返回 409。未鉴权请求不产生恢复动作。恢复日志保留最多
128 条操作记录、数据库上限 1 MiB；达到容量后拒绝新请求，不自动淘汰
记录，进程重启不会清空持久化容量。历史归档管理仍待完善。

独立 SQLite Worker 使用排他所有权与同步提交：queued 提交后才受理，
running 提交后才调用恢复，succeeded 提交后才报告成功。存储失败返回
503 或保持最后已提交的状态，并设置 storage_failed；不能将 running
视作成功。进程重新打开日志时将 queued/running 转为 interrupted，
旧请求可查询/幂等重试以取得原记录，但绝不自动执行。新进程令牌拒绝
其他旧请求。未知结构、不同设备、损坏或被占用的日志使启动失败，
不重建覆盖原文件。该行为已有 SIGKILL 验证，仍不是实际断电验收。

`PrintController.retire()` 是永久退场接口：它立即拒绝新的打印动作，
关闭状态订阅和设备通知，随后等待已接受动作、实际安全停止及日志
写入完成。普通 `cancel()` 的等待超时不等于底层动作已经结束；即使
该等待已经超时，进程所有者也继续等待真实退场。实际停止或持久化
失败仍会上报，不能将观察超时误写成安全停止成功。

目前 CLI 测试使用真实子进程、PTY、模拟 MCU 和鉴权 HTTP，覆盖双
MCU 启动、SIGINT/SIGTERM 关闭、断连故障、迟到工厂结果和清理失败。
这不替代机器独立停止路径、断电行为及实际打印验收。

配置包含 `[firmware_retraction]` 时，原生入口启用 `G10`、`G11`、
`SET_RETRACTION`、`GET_RETRACTION`，并提供 `firmware_retraction` 对象的
四项实时参数。`retract_length` 和 `unretract_extra_length` 默认 0，
不得为负；`retract_speed` 默认 20、`unretract_speed` 默认 10（mm/s），
两者至少为 1。运行时参数更新不写回配置，成功更新会清除回抽标志。
重复 G10 或 G11 不重复运动；回抽保留当前坐标模式、G-code E 原点、
进给速度及倍率，运动仍受温控、挤出长度和速度保护约束。实现使用
类型化同步运动准入，不创建或覆盖 `_retract_state` 宏状态。

原生入口支持 `M73 P百分比`、`M117 显示文字`、
`SET_DISPLAY_TEXT MSG="显示文字"`，通过 `display_status` 对象提供
`progress` 和 `message` 查询/订阅。M73 的有限数值限幅为 0–100%，
缺少 P 时不更新；R 等剩余时间字段不生成预计完成时间。M117 保留原始
文字大小写，空文字清除消息；SET_DISPLAY_TEXT 缺少 MSG 清除消息，
显式空字符串保留为空字符串。

显示进度不触发完成、取消或任何运动操作。活动任务（包括暂停）保留
最近的 M73 值；任务终态或空闲时，超过最近更新五秒后回退到
virtual_sdcard 文件进度。新任务在串行准备阶段清除旧显示数据。
这里由类型化打印生命周期判断任务是否活动，不提供虚构的 idle_timeout
硬件状态；与 Python 基于 idle_timeout 判断过期的逻辑有所区别。

压力提前配置预检查现在会拒绝启用状态下数值上无法表示的平滑窗口
（例如 `pressure_advance=0.05`、`pressure_advance_smooth_time=1e-200`），
错误发生在原生插件分配之前。系数为零时保留请求的平滑参数，但有效
窗口为零；将来启用时需要重新验证。配置文件仍要求平滑时间大于零，
与命令参数允许零的规则不同。

配置打印入口现已注册 `SET_PRESSURE_ADVANCE`，绑定配置中的实际
挤出机名称和原生发射器 id。打印文件命令经过独占 G-code 调度器，
使用下述连续参数接纳及窗口屏障。Moonraker 挤出机对象保留温度字段，
并通过查询和订阅发布 `pressure_advance`、`smooth_time`。
机器集成可在持有运动所有权时使用 `NativeLinearHomingPort.setPressureAdvance`
提交挤出机绑定 id、`{advance, smoothTime}` 和取消信号；使用
`pressureAdvanceSettings(id)` 读取最后接纳的请求配置。这不是当前
MCU 正在执行的系数。参数验证及复制在接纳前完成，部分失败停止端口，
不会发布未接纳的请求。

原生服务尚无通用 `/printer/gcode/script` 写入入口。暂停会保留文件
检查点及可能仍被持有的 G-code 调度器；外部暂停调参使用鉴权
`POST /printer/print/pressure_advance`（JSON-RPC
`printer.print.pressure_advance`），由打印控制器直接持有暂停事务。
请求示例：

```json
{"version":1,"request_id":"当前打印请求ID","state_token":"查询获得的状态令牌","extruder":"extruder","advance":0.1,"smooth_time":0.04}
```

先从 `/printer/print/status` 读取当前请求及状态令牌，仅确认暂停后
可提交。两个数值字段必须同时提供，挤出机名必须匹配配置。接纳及
完成都更新令牌；调参期间拒绝恢复或第二项调参。过期令牌返回 409，
不会重放请求。响应采用现有打印控制格式，包含 `accepted` 和 `current`；
通过挤出机对象查询实际接纳配置。

客户端断线只终止响应等待；已接纳操作继续由控制器持有，重新连接后
应查询状态和配置，不自动重发旧请求。调参使用 `pauseMs` 超时门限，
失败、超时、取消及主机退出沿现有设备安全停止和迟到操作清理路径。
参数是当前主机的运行态设置，不写回配置文件，也不在重启后重放。

固定窗口更新附着到床网格拆分后的最后前瞻段、已规划源尾端或空闲
边界，不强制刷新前瞻，不改变衔接速度。重复终点请求合并；历史容量
不足时按完整运动段进行背压。不能在当前卷积窗口内保留所需历史时
明确失败，不丢弃参数。未播种的空闲请求会在显式启动或恢复时间确定
后提交，并阻止源所有权提前转交。

制动路径替换通过 `cancelPressureAdvanceAfter` 撤销截止时间之后的
参数；已生成脉冲及截止时间处的更新保留。剩余路径的端点元数据在
恢复时重新定时。原生时间、精度及依赖窗口检查保持有效。

窗口增长、缩小和启用/禁用由端口关闭前瞻至静止、补足边界两侧覆盖，
再执行原生生成/提交屏障。计数器和压缩器保留，不以等待整个机械
运动完成代替生成屏障。同窗口且有效窗口为零时，只保存请求配置；
后续启用仍需窗口屏障，不能调用启动期配置函数代替。

确认暂停后可调参：新请求从恢复路径起生效，覆盖同一挤出机尚未执行
的旧压力请求，保留几何与其他输出事件。参数事务期间禁止恢复；同步
刷新窗口后才完成接纳。同一静止生成边界复用覆盖，连续调参不持续
推迟恢复时间。产品命令注册和 Moonraker 参数状态映射仍需完成。
这些内部接口不改变现有 Python
生产入口，也不代表实机动态压力提前验收完成。数值回归、原始 C
步进对照、性能结果与未解决问题见[迁移说明](Node_Host_Migration.md)。

## 产品流程验收门槛（当前模拟范围通过）

```sh
npm --prefix host run test:product-acceptance
```

此独立命令顺序执行主机流程验收和最小运动复现，属于产品交付必过
门槛。普通单元测试通过不能替代它。当前四项通过；范围仅为下述
模拟设备流程，仍不代表整个产品验收完成。状态记录在
[product-acceptance-status.json](../host/contracts/product-acceptance-status.json)。

流程使用真实 CLI 加载可信测试机器模块，经两个 PTY UART、原生队列
和鉴权 HTTP 启动作业。现已通过三轴归零、打印、暂停、恢复、正常
完成、持久化完成记录、末位置核对、reset、第二作业开始、取消和
取消结果查询。取消不再抢先关闭 HTTP 服务。当前安全停止仍永久结束
该硬件会话，reset 只清理作业终态，不重新授予硬件准入；再次打印被
拒绝且不会打开文件或生成运动。显式重新初始化后，历史取消记录仍可查询，新任务重新归零并完成；
活动打印中的重新初始化会被拒绝。模拟限位和文件授权仅属于测试夹具，
没有证明真实加热、限位、步进硬件或打印质量。

编译包基线和负载两项从新构建的运行包启动独立 Node.js 子进程，禁用 TypeScript
直接加载并清空外部程序 PATH，机器模块仅导入包内 JavaScript 与原生库。
经鉴权 multipart 上传真实 G-code，核对 SHA-256 回执和禁止自动开印，
使用 PublishedPrintFiles.acquire 的 sealed 文件执行完整打印流程。
未经授权上传被拒绝；暂停/恢复与过期令牌拒绝、最终位置、取消、
基线使用 SIGHUP，负载变体使用鉴权 API；历史与文件恢复、新任务重新
归零并完成、SIGTERM 清理均通过。另验证未鉴权、活动打印、独立物理
停止失败、旧会话令牌和重复恢复请求的处理。
MCU 模拟器在父进程，子进程不导入源码测试夹具。编译包请求喷嘴
200°C、热床 60°C：归零后持续室温采样，确认加热 PWM 已通过 UART
发出但文件尚未执行，再输入达到目标的 ADC 报告完成打印；完成后两路
目标温度归零。打印中注入错误 ADC 报告，确认故障、持久化失败记录和
后续开印拒绝。温度和物理停止仍是模拟，不代表真实热响应、断电与
所有故障恢复或实际打印验收。
编译包验收在空 node_modules 下按锁文件独立安装生产依赖，不再链接
工作区依赖，原生插件也从私有源码快照重编译，尚不是全新目标系统安装验收。

负载变体同时运行 4 路状态查询，在每个会话进入 printing 后分批上传
8 个 256 KiB 文件，共 16 个；核对原有完整流程与末位置，不自动打印
压力文件。子进程记录事件循环 P99/最大延迟、CPU、RSS，UART 观测器
按压缩步进间隔和 reset_step_clock 还原首步时刻，拒绝迟到命令。
门槛为事件循环 P99 <50 ms、最大 <100 ms、首步提前量 >0；这只是
低于当前运动预留时间的本机回归门槛，不是硬件实时保证。
配对样本见 product-load-acceptance.json；长时间、高速/多轴、目标板
饱和负载及真实运动时间戳精度仍须另外验收。

最小复现不需要网络/MCU：X=3.78→3.79 mm、加速度 1000、起始与峰值
速度平方 100、末速度平方 80.00000000000007，在打印时间
3.1993729999999587 秒处产生约 2.65e-17 秒匀速段，原生队列拒绝该
不可表达时间段。现在仅对满足精确端点/末速度/最终时刻、加速度不增大
及单坐标 ULP 偏差上界的单侧梯形做表示转换；不满足条件仍拒绝。原生
时间保护不变。恢复路径中极短加速段也采用同一受限转换。

原生文件的持久元数据装配使用
`await NativePrintUploads.open(files, maintenanceGate, {metadataRoot: '/绝对路径/metadata'})`，
将返回值作为 `server.nativeUploads`。`metadataRoot` 必须是服务用户所有的
私有目录（0700），不能是符号链接；工厂初始化失败须释放此前创建的文件
存储。释放顺序为 `await uploads.close()`，然后 `await files.close()`。
`files` 是借用资源，uploads 不会替调用方关闭它。

该模式使用持久扫描意图、快照、选中版本和图片存储。重启后先协调遗留
扫描和已删除文件，再按需恢复元数据；第一次恢复会验证文件完整摘要及
回执身份，不重新解析图片。有效的原缩略图 URL 保持可用；删除或者同 ID
重新发布会撤销旧版本。授权在恢复和图片读取前执行。磁盘写入或失效失败
不得作为成功删除返回；重启协调负责处理已经提交文件删除的中断情况。

缓存最多 128 条、8 MiB 元数据及 16 MiB 图片；持久图片最多 256 MiB，
快照最多 64 MiB。版本表保留失效标记，当前最多容纳 4096 个历史文件名，
这是累计容量而非仅存活文件数；达到容量须报告失败，尚不支持无限期轮转。
同步构造 `new NativePrintUploads(files, gate)` 仍是内存模式，重启会撤销
预览 URL。产品编译验收已使用上述持久工厂；现有 Python 部署不会自动切换。

## 独立依赖安装验收

运行 `npm --prefix host run test:product-install`：每个编译运行场景在新的
目录中执行 `npm ci --omit=dev --include=optional --ignore-scripts --no-audit --no-fund`，
校验 node_modules 和直接生产依赖不是工作区符号链接，且不安装 TypeScript
编译器与实验性模板开发依赖。安装、运行均禁用 TS 解析，清空外部 PATH
和 NODE_PATH；npm 本体由当前 Node.js 执行。可通过 npm_execpath 指定
npm CLI 绝对路径，默认采用当前 Node 安装附带的 npm。

命令不会以共享 node_modules 回退来掩盖缺包。默认遵循 npm 缓存/网络
配置；离线环境先准备完整锁文件包缓存，再设置 npm_config_offline=true
与 npm_config_cache。sharp 所需当前平台可选预编译依赖必须存在；
缺失时测试失败，不启用安装脚本临时源码编译。安装时长仅表示当次缓存
和平台条件，不是网络下载性能或全新系统安装时间。

本门槛覆盖无 Python PATH 的原生源码构建、数学输出对照、后台任务、
SQLite、缩略图、PDF 字体、原生运动及模拟 UART 打印流程。它仍依赖
构建机的编译器、系统头文件和库，不能代替目标板验证、系统服务部署
或实机验收。Node 头文件默认来自当前 Node 安装，可通过 NODE_INCLUDE
指定；CC 可指定 C 编译器。私有源码和头文件快照在构建结束后清理，
编译失败保留原有运行包，不发布部分插件。

## 标准 Moonraker 打印请求适配

机器绑定可显式提供 `server.productPrintCompatibility`，其
`async start(filename, signal)` 仅解析已发布文件并返回
`{fileId, nozzle, bed}`。文件 ID 必须属于同一个打印文件存储；温度是机型
明确选择的准备策略，必须经过控制器的机型上限校验。此钩子不得发起运动、
加热或宏执行，必须响应取消。不配置该选项时仍只接受原有类型化打印请求。

启用后，`POST /printer/print/start` 接受单个 `filename` 参数，
pause/resume/cancel 接受空参数；对应 WebSocket JSON-RPC 方法相同。
成功结果为 `"ok"`，请求形状依据
[Moonraker 打印管理接口](https://moonraker.readthedocs.io/en/latest/external_api/printer/#print-job-management)。
现有版本化 request_id/file_id/温度/有效期及状态令牌请求继续受支持，
不允许混合标准字段和类型化字段。文件路径支持范围取决于已实现的文件
存储；当前原生存储使用列表返回的 `<file_id>.gcode`，不是显示文件名。

适配器生成 `compat-...` 请求标识并持久保留，状态接口可查询该标识。
授权先按原始接口参数执行，再按解析后的 file_id、请求标识与参数执行；
控制请求在授权前绑定当前状态，授权等待期间状态变化则拒绝。开始请求
只允许 idle/completed/cancelled，已完成或取消的任务必须先通过原控制器
清理门槛才能开始下一任务；failed/interrupted 仍要求显式恢复。
暂停、恢复、取消保持原控制器的状态及物理停止约束。

策略与二次授权最多同时保留 4 项，每次准入等待最多 30 秒；断开后尚未
结束的外部策略继续计入容量，但迟到返回不能产生设备操作。已经持久准入
的打印不会因为 HTTP 客户端断开自动取消。标准协议没有客户端幂等键，
不能保证跨完成状态的重复开始请求恰好执行一次；丢失响应应先查询状态，
需要精确重试的产品客户端继续使用类型化 request_id 接口。
这仅补齐打印四接口的适配，不代表完整 Moonraker 或现成客户端整体兼容。

启用标准打印适配的产品服务同时注册 `/printer/info`。身份数据来自当前
进程和实际加载的打印配置：process_id、用户/组 ID、Node 可执行路径、
主机名、CPU、config_file 及集成模块提供的软件版本。python_path 和
log_file 为空字符串，表示没有 Python 解释器及专用 Klippy 日志；
node_path 与 host_type 明确标识原生运行时。身份字段初始化时捕获，
每次请求的状态仍从当前所有者读取。该接口沿用常规 RPC/HTTP 鉴权。

server.info、printer.info 和 webhooks 的就绪映射一致：硬件准备中是
startup，正常已装配主机是 ready，未恢复的 interrupted 作业是 error，
故障、停止或退场是 shutdown。有效原生后端即使硬件故障仍可查询，
因此 klippy_connected 可为 true、klippy_state 为 shutdown；这不授予
打印许可。状态源异常返回 503，不用此前成功快照替代。未启用标准适配
的产品服务不新增 printer.info，也不修改旧连接字段。

标准适配的原生服务还发送 `notify_klippy_ready`、`notify_klippy_shutdown`
和 `notify_klippy_disconnected`。通知由同一份实时主机状态推导，不触发
设备动作，也不重放运动：进入 ready/shutdown 时各发送一次；已观察到
主机后状态源不可用或退场则发送 disconnected。重复采样不重复广播。
恢复可观察性后按新状态继续通知；通知本身不执行设备恢复。

打印状态变化会在安全微任务之后触发检查，另以 250 ms 周期观察独立
硬件变化。观察器只把通知交给已有有界队列，沿用 authorizeNotification、
每客户端容量与超时策略；慢客户端授权不会被设备停止路径等待。关闭
服务首先停止观察器，网络关闭独立进行，不保证网络退场前额外送达最后
一条 disconnected；客户端必须处理 WebSocket 关闭。新连接不补发旧通知，
应先查询 server.info/printer.info 建立初始状态。启动时的 error 状态仍
通过查询及 webhooks 状态对象描述，不伪装成 ready。

原生上传所有者装配后，`print_stats.filename` 返回发布回执对应的规范
`<fileId>.gcode` 路径；空闲或重置后为空，完成及故障状态保留当前作业名。
未装配该所有者时不猜测自定义文件命名。`pause_resume.is_paused` 在暂停
确认后为 true，恢复确认前仍为 true；仅发起暂停时不能声称已暂停。
当前未提供实际累计打印时间或耗材统计，不能从文件进度推算这些字段。

## 原生打印加载已保存网床

声明式产品入口使用 Klipper 配置加载器读取 printer.cfg，包含主文件
SAVE_CONFIG 自动保存区及 include。普通配置按 Klipper 规则覆盖保存区
同名选项；损坏保存区在获取设备适配器前拒绝。Moonraker 配置仍使用
其独立加载器。这不表示原生 SAVE_CONFIG 写入已接通。

线性原生主机现在读取 [bed_mesh] 及版本 1 的 [bed_mesh 名称] 保存数据，
支持显式 BED_MESH_PROFILE LOAD=名称、BED_MESH_CLEAR，以及
BED_MESH_OFFSET X=数值 Y=数值 ZFADE=数值。偏移参数可分别省略，
省略项保持当前值；XY 为绝对查询偏移，ZFADE 为淡出高度偏移。
无活动网床时返回提示，不产生运动。重新 LOAD/CLEAR 清除此前偏移。不自动加载
名为 default 的配置。fade_start、fade_end、fade_target、split_delta_z、
move_check_distance 由现有网床算法使用；配置和保存网格先通过启动预检。
这条入口目前接通保存数据的加载/清除和运行时偏移，未接入探针测量、校准、
PROFILE SAVE/REMOVE 和 SAVE_CONFIG。

切换补偿先排空已接受的旧轨迹并等待 MCU 时间，再更新坐标变换和
G-code 坐标缓存。普通 G-code 使用逻辑坐标；toolhead.position、
归零、暂停停车和返回路径使用补偿后的物理计划坐标。这些都是计划值，
不是实测位置。暂停中拒绝切换补偿；归零重建运动队列后保留已选网床。
控制器重建或进程重启后仍需再次显式加载，不回放旧命令。

保存网床能参与原生打印，不代表本机已校准或全套网床功能已替代；实际
探针、热床形变、Z 精度与速度仍需目标打印机验收。

配置 [bed_mesh] 时，原生对象列表现包含 bed_mesh，可通过
/printer/objects/query?bed_mesh 或对象订阅读取 profile_name、mesh_min、
mesh_max、probed_matrix、mesh_matrix 和 profiles。矩阵保留完整 binary64
值；清除后活动矩阵为 [[]]，保存配置仍保留。普通轮询建议只选择
bed_mesh=profile_name，避免传输不需要的矩阵。

矩阵按需生成并缓存，公共响应独立复制；大网格的名称查询不会生成矩阵。
单矩阵（含行节点）或保存配置集合超过 90000 个结构节点时返回 413，
组合响应仍受通用 100000 节点和 1 MiB 限制，不截断、降采样或改变精度。
因此超大矩阵目前不能通过该对象接口完整取得，需后续完善有界导出流程。

## 原生网床保存维护操作

声明式产品配置提供 `GET /printer/configuration`，返回当前配置会话的
`state_token`、`state`、`profile`、`restart_required` 和 `available`。
保存当前活动网床使用 `POST /printer/configuration/bed_mesh`：

```json
{"version":1,"state_token":"从当前状态读取","profile":"calibrated"}
```

请求使用服务已有鉴权。它只保存当前网床的探测点与插值参数，不接收
客户端传入的任意配置或脚本；活动 XY 偏移不写入保存数据。没有活动
网床、打印中、暂停中、存在未结束设备动作或文件维护活动时拒绝。
`default` 名称保留。探测点采用可往返的完整浮点文本，避免新消费级
维护接口引入六位小数量化；旧兼容保存函数仍默认保持旧格式。

保存复用配置来源校验、备份、文件同步和原子替换。成功返回 `saved`
和 `restart_required: true`，随后禁止新打印。使用既有主机状态令牌和
重初始化接口显式重建服务；旧会话不会直接激活新保存的配置。打印
文件不能通过此接口触发维护，也未注册原生 G-code `SAVE_CONFIG`。

同一会话、同一令牌与名称的成功重试返回相同状态，不重复写入。
重初始化后令牌失效；这不是跨进程持久化维护回执。响应丢失后先读取
配置状态；进程已重启时核对加载后的保存配置，不能自动重放旧请求。
写入失败后返回失败状态并阻止新打印，即使不能确定是否完成替换也
不能继续使用旧运行状态；检查配置和备份后显式重初始化。接口尚不
提供删除配置、探针校准或通用配置编辑。

相同端点可显式传入 `"action":"remove"` 删除自动保存区中的指定网床；
省略 action 保持保存行为。删除不要求活动网床，仍需要同一维护门禁，
并在提交后锁住新打印、等待显式重初始化。最后一个保存节也会实际
提交为空保存区，不再因兼容保存的空集合规则跳过写入。其他保存节
保持原值。若普通配置或 include 中仍定义同名节，则拒绝替换文件，
不会报告虚假的删除成功；应先处理来源冲突再重建会话。
成功重试必须同时匹配令牌、名称和 action；把删除重试改为保存会拒绝。

## 使用探针完成 Z 归零

带普通 GPIO 探针的线性机器可以在 stepper_z 配置
`endstop_pin: probe:z_virtual_endstop`，同时配置 [probe] 的 pin 和
z_offset。删除 stepper_z.position_endstop；Z 触发位置由 z_offset
确定。虚拟引脚本身不能添加 ! 或 ^，电平与上拉配置写在 probe.pin。
Z 必须向下归零，z_offset 必须在 Z 行程范围内。

G28 按 XYZ 顺序执行；单独 G28 Z 前必须已归零 XY。Z 在当前 XY
位置下降；配置下述 safe_z_home 后会先自动定位。Z 归零和后续探测/网床测量共享同一
GPIO 与触发同步资源，附加 Z 电机可共享探针，但不能配置独立限位。
每次归零使用单次触发，回退及二次归零由 homing_retract_dist、
homing_retract_speed、second_homing_speed 控制，不使用 probe.samples。
坐标换算保留触发到完全停止之间的位移，不把停止位置直接写成 z_offset。
归零失败、二次触发没有运动或取消会停止硬件并撤销归零状态。

探针 Z 归零不执行电机端点相位校正；相应 Z 相位统计保持无样本，
显式 endstop_phase stepper_z 配置拒绝。激活/停用宏不支持。

BLTouch 使用 [bltouch] 的 sensor_pin、control_pin 和 z_offset，不能
同时配置 [probe]。sensor_pin 可以带上拉和反相；控制与传感器可位于
不同 MCU。启动阶段自动初始化设备，初始化失败停止硬件；单点、
网床及虚拟 Z 归零共用设备所有者。每次下探先展开，触发后安排收针，
按配置验证收针并刷新运动时间基线。首次触发没有电机位移也拒绝归零。
BLTOUCH_DEBUG/STORE 的消费级维护接口尚未实现；真机电平、针脚方向、
机械等待、触发精度和连续打印仍需目标设备验收。

可配置 [safe_z_home]：home_xy_position 为喷嘴 XY 坐标（不自动减去
探针偏移），speed 默认 50，z_hop 默认 0，z_hop_speed 默认 15，
move_to_previous 默认 false。XY 定位与抬升坐标必须在机器行程内，
z_hop 必须非负；与 homing_override 冲突时拒绝启动。

任何 G28（包括只归零 XY）先按需抬升。Z 未归零时临时以 Z=0
为起点执行受限抬升，过程不授予正式 Z 归零权限。随后归零所选 XY；
请求 Z 归零时必须已有 XY 权限，移动到配置位置后下探，完成后
再次抬升到 z_hop。move_to_previous 只恢复进入定位步骤前的 XY，
保留抬升后的 Z 和挤出位置。物理定位不应用网床补偿；故障或取消
沿归零停机路径撤销权限。目标板抬升方向、可用余量和探针位置仍须实测。

## 单点探针维护操作

配置 `[probe]` 的原生产品服务注册 `GET/POST /printer/calibration/probe`。
GET 返回当前 `state_token`、状态及可用性；POST 只接受
`{"version":1,"state_token":"由 GET 获取"}`，沿现有服务鉴权。
要求打印机空闲或正常完成、XYZ 已归零且无待发运动；在当前 XY 下探，
下限来自 stepper_z.position_min，速度/采样/偏移来自 probe 配置。
不接受任意 G-code、坐标或速度参数。

操作占用维护锁，最长 120 秒；返回原始测量 position、bed_position、
samples、retries 和 attempts，并同步 G-code 坐标缓存。成功会更换令牌，
最近一次成功请求的旧令牌可重复读取相同结果，不再次运动。该回执仅
属于当前进程，重启后旧令牌无效；客户端不能把通信失败当成测量未执行。
失败、取消或超时关闭运动准入，需显式重建主机。服务关闭会取消并等待
在途测量。此接口不自动归零、不移动 XY、不生成网床或保存校准结果。
目前仅完成模拟原生链路验证，未完成实机验收。

## 矩形网床测量、启用与保存

同时配置 `[probe]` 及 `[bed_mesh] mesh_min/mesh_max` 时注册
`GET/POST /printer/calibration/bed_mesh`，请求格式、鉴权、维护互斥、
120 秒截止时间和进程内幂等回执与单点探测一致。测点来自 probe_count
（默认 3,3），支持 mesh_pps、algorithm、bicubic_tension、speed 和
horizontal_move_z。只有保存网床、没有测量范围的配置不注册此接口。
支持 zero_reference_position：网格内按插值结果归零；网格外追加一次
探测并减去参考高度。外部参考点先检查喷嘴行程，无法到达时不开始
网格运动。圆形网床和故障区尚未实现，配置时明确报错，不静默忽略。

POST 在当前已归零状态下执行完整测量，成功后以 `measured` 名称启用
网床并同步 G-code 坐标。响应仅返回测点数量、范围及 persisted:false；
不会自动修改磁盘配置。随后可调用 `/printer/configuration/bed_mesh`
保存当前网床为用户选择的名称，再显式重建主机应用配置。测量中途
失败不发布半张网床，打印准入关闭。两种维护操作共享同一把维护锁。

HTTP 产品模拟已验证九点测量 → 启用 → 幂等重试不重复运动 → 保存 →
重新加载后网床数据一致。此验证包含风扇时间线与持续温度报告；发现
并修复了零位移网格步骤错误排空已停止时间线的问题。实机几何精度、
目标板吞吐、异常掉电恢复及上述未支持网格功能仍待验收。

上述网格流程也已加入编译产品验收：安装独立 JS 运行包后，子进程
使用 PATH=/no-programs 并禁用 TypeScript 类型剥离，先通过独立维护接口
执行归零，再完成九点网格和一个外部参考点、启用、幂等重试、保存、
显式主机重建及矩阵读取一致性检查。随后删除保存的配置并再次重建，
确认删除生效。该测试不注入归零状态，也不调用 Python；模拟 MCU
仍不代表真实探针精度。证据位于 grid-public-acceptance.json 的
compiledRoundTrip 字段。

## 独立归零维护操作

`GET/POST /printer/calibration/home` 使用与探针维护相同的版本号、状态
令牌、鉴权、互斥、120 秒截止时间和幂等回执。固定按机器配置归零
XYZ，不接受轴选择或任意 G-code，也不要求提前启动打印任务。要求
打印机空闲或正常完成、无待发运动；归零失败关闭运动准入并要求
显式主机重建。归零期间打印、单点探测及网格校准均不能占用维护锁。
成功后同步坐标缓存，再通过各校准接口获取令牌并测量。

编译产品验收现已直接调用该接口完成归零，再测量、启用、保存网床
及重建读取；这一维护流程不会打开打印文件或创建虚拟打印任务。

维护接口的 available 是当前只读准入提示：同时考虑关闭状态、维护锁、
打印活动及所有注册的空闲检查。任一检查拒绝或抛错时均返回不可用，
查询本身不占用锁；POST 仍重新执行正式准入，不能依赖旧 GET 结果。
成功回执在释放维护锁后生成，但幂等重放返回的是历史回执，客户端
需要 GET 获取最新可用性。配置保存接口使用相同准入提示。

HTTP 校准中途断线也有产品集成回归：在第二个测点寻位时取消客户端
请求，等待原生停止及维护锁释放，确认全部配置的 MCU 停止适配器
被调用、归零权限撤销、旧网床及磁盘配置未变，并拒绝后续归零和
打印活动。该验证使用模拟串口与停止适配器，不代表实物电机断电或
真实机械制动距离已验收。

### 热端散热风扇

原生产品入口自动装配 `[heater_fan 名称]`，默认关联 extruder，支持
heater 列表、heater_temp、fan_speed 及已有风扇输出配置。目标温度非零、
温度高于阈值或读数失效时请求散热；目标归零后等待降温才关闭。故障
shutdown_speed 默认 1，按 max_power 截断；软件 PWM 仅接受 0/1
故障默认值，分数默认值需硬件 PWM。当前不支持 tachometer_pin。
状态通过 printer.objects 查询对应配置节，speed 表示请求功率，rpm
仍为 null。M106/M107 控制普通打印风扇，不改变热端温控风扇。

无 Python 预编译进程已验证冷机关闭、加热目标启动、打印完成后持续
散热及冷却关闭，并通过模拟 MCU 核对默认值与 PWM 写入。本轮首次
完整验收两条打印流程在重初始化后的运动中发生时间分辨率错误；增加
精确输入诊断后的 4 项验收通过。首次失败尚未定位，不能据重跑成功
认定打印稳定性达标。完整记录见 host/contracts/heater-fan-foundation.json。

### 控制板散热风扇

`[controller_fan 名称]` 已接入原生自动装配。stepper 默认选择所有
已配置电机，heater 默认 extruder；可显式设置空列表或指定有效名称。
任一所选电机启用或所选加热器目标非零时使用 fan_speed；活动停止后
使用 idle_speed，经过 idle_timeout 秒关闭。首次启动未出现活动时
保持关闭。缺少可控使能引脚的常开电机按启用处理。

空闲计时使用单调时钟，从首次观测到活动停止起计时，额外的起转加速
回调不会加快倒计时。默认 idle_timeout=30，idle_speed=fan_speed，
shutdown_speed=0。状态查询和输出限制与其他风扇相同，M106/M107
不控制此风扇。电机状态是主机已调度的使能状态，不是电气反馈。

### 断料开关与类型化暂停

原生产品入口支持 `[filament_switch_sensor 名称]` 的 `switch_pin`（支持
MCU 前缀、上拉和反相）、`debounce_delay`（0–60 秒，默认 0）、
`event_delay`（0–3600 秒，默认 3）及 `pause_on_runout`（默认 true）。
启动后等待 2 秒稳定窗口，状态 `valid` 变为 true 后才有经过消抖的
检测结果；未知状态不能解释为有料。启用自动暂停的传感器在缺料、未确认或关闭
时也拒绝新打印，保持空闲且不预留任务；准备完成后、文件执行前再次
检查，准备期间失去耗材则停止该任务。已接受请求的幂等重试仍返回
原任务结果，不因为传感器后来变化而创建第二个任务。

打印中确认断料会请求现有的类型化暂停，等待已排队运动和暂停动作
完成。重新进料只更新状态，不自动恢复；缺料、输入未确认或已关闭
时拒绝恢复，保持当前暂停。`pause_on_runout: false` 只报告传感器，
不触发暂停或阻止恢复。Moonraker 的同名对象报告 `filament_detected`、
`enabled`、`pause_on_runout`、`valid` 和 `closed`。

非空 `runout_gcode` 和 `insert_gcode` 配置会在连接前报错，需要改为
受控产品操作。`pause_delay` 验证为正数但不用于延迟首次暂停请求；
它在旧实现中用于暂停后执行宏，原生路径直接等待暂停完成。没有接入
传统 QUERY/SET_FILAMENT_SENSOR 文本命令；使用对象查询查看状态。

目前验证使用预编译 Node.js 26 产品和模拟 MCU。实际开关电气逻辑、
抖动时长、耗材行程及目标板上的机械停稳时间仍需真机验收。

### 编码器式堵料检测

原生入口支持 `[filament_motion_sensor 名称]`，必填 `switch_pin` 和
`extruder: extruder`；`detection_length` 必须大于 0，默认 7 mm。
每个电平变化表示一个编码器边沿，每 250 ms 按 MCU 事件时刻的整数
步进历史检查前进距离，包含压力提前，不能用打印文件进度替代。
当前产品只支持单挤出机；不支持非空 runout_gcode / insert_gcode。

超出检测距离后锁定堵料并请求暂停，回抽、坐标重建不自动解除。
检测到新边沿后才允许显式恢复，不自动继续打印。初始历史基线及
2 秒稳定窗口尚未确认时拒绝启动。配置 `pause_on_runout: false`
仅报告状态，不进行暂停或启动/恢复拦截。状态对象同开关传感器，
额外提供 detection_length；编码器静止有料状态是距离余量判断，
不是实际耗材存在的直接测量。

打印中若所需历史已过期或无法覆盖事件时刻，停止设备所有者，不
使用已排队终点猜测。实际检测长度应结合编码器分辨率、耗材路径和
目标板测试确定；本仓库当前证据仅为软件及模拟 MCU 验收。

### 空闲与暂停超时

原生产品支持 `[idle_timeout] timeout`，默认 600 秒，范围为大于 0
且不超过 86400 秒。使用单调时钟轮询，检查间隔至多 1 秒、至少
50 ms；打印准备、运行和受控维护期间不执行空闲清理。任务状态、
坐标、归零状态、电机使能或加热目标变化会重新计时。

普通空闲超时会关闭所有加热，等待运动端口独占权后释放可控电机并
清除归零状态；服务仍可接受新任务，新任务按配置重新归零。始终
通电且没有可控使能的电机无法由软件释放，仍关闭加热，状态对象
`idle_timeout.motors_releasable` 会报告 false。

暂停持续超过同一超时时间时，执行类型化取消并等待停止确认，不保留
可以继续恢复的任务；必须重建服务实例后启动新任务。取消期间的预期
设备停止通知不会将任务短暂改为故障，真正的停止失败仍通过停止结果
报告。所有硬件关闭路径均关闭维护准入，不能依赖清空任务状态绕过。

`idle_timeout` 对象报告 state、printing_time、idle_timeout、expired、
closed 和 motors_releasable。非空 `gcode` 在连接前拒绝，不执行任意
超时宏。

已认证客户端可用 `GET /printer/settings/idle_timeout` 获取当前 timeout、
state_token、available 和 persisted；用同一路径的 POST 临时调整超时：
`{"version":1,"state_token":"查询返回的令牌","timeout":600}`。
成功后返回新令牌并重新开始空闲计时；仅缓存最近一次请求的回执，
相同令牌和数值重试不会再次延长计时，冲突值及过期令牌返回 409。
关闭实例、受控维护或正在执行超时清理时拒绝新的设置。
设置不写入配置文件（persisted 为 false），重建实例恢复配置值并撤销
旧令牌。接口不执行宏，不改变运动参数；打印或暂停时也可调整。

### 驱动电流维护

已认证客户端可通过 `GET /printer/settings/driver_current` 查询
`state_token`、`available`、`persisted=false` 和 `drivers` 列表。
每个驱动包含配置节名 `name` 及量化后的 `run_current`、`hold_current`。
对同一路径 POST JSON，例如：

```json
{"version":1,"state_token":"从 GET 获取","driver":"tmc2209 stepper_x","run_current":0.8,"hold_current":0.3}
```

电流单位为安培；至少提供一项电流，运行电流和保持电流
范围同样受型号上限约束。接口返回的 max_current 为原实现的型号
校验上限：TMC2208/2209/2130 为 2 A，TMC5160 为 10 A；运行电流
范围为 [0,max_current]，保持电流为 (0,max_current]。该上限不是
具体板卡或电机的额定电流。运行电流 0 不代表断电。其他字段和未知
驱动返回 400。

只有打印机空闲、完成或取消且所有设备动作已结束时允许提交。
该操作与打印、归零、调平及其他维护互斥，阻塞或过期令牌返回 409。
取得互斥权后还会等待运动排空，写入确认后才发布状态。更新失败返回
503 并停止硬件，必须重新初始化；接口关闭会取消并等待在途操作结束。

最近一次成功请求可以原样重试，不再次写入；同一旧令牌搭配不同
参数返回 409。后续电流调整（包括打印文件内的 SET_TMC_CURRENT）或
重新初始化会使旧令牌失效。客户端收到响应超时后应先重试原请求，
遇到 409 则重新查询，不自行生成新的重复修改。修改只作用于本次
运行，不保存配置，不自动重新启动打印。

### TMC2130 硬件 SPI 配置

原生主机支持带受控 `enable_pin` 的 TMC2130 步进器。除电流、微步
和驱动字段外，需显式提供 `cs_pin`、`spi_bus`；`spi_speed` 默认
4000000 Hz，SPI mode 固定为 3。MCU 字典须提供该总线的三个
`BUS_PINS_<spi_bus>` 引脚，装配阶段检查它们与步进、加热、片选等
输出是否冲突；缺少元数据会拒绝启动，不猜测总线引脚。

同一 MCU 的多个片选可以共用同一总线。菊花链使用同一 `cs_pin`、
`spi_bus`、`spi_speed` 和 `chain_length`，每个驱动指定唯一的
`chain_position`（1 至链长）。支持 2 至 10 颗链；单颗省略链长和
位置。所有片选先配置为无效，再配置总线；全部 MCU 配置完毕且
电机仍禁用时初始化驱动。原生双沿步进会同步设置 CHOPCONF.dedge。

TMC2130 与 UART 驱动共用电流维护接口和运行期对象查询，但故障位
按型号解释。启动读取 GSTAT，不使用 UART 型号的写入清除策略；
运行期检查过温、短路，并在电机启用且配置电流足够高时检测持续为
零的 CS_ACTUAL。失败进入统一硬件停机。对象中的电流仍是确认后的
量化设定，不是物理测量。

无使能引脚的电机控制和其他尚未支持的
SPI 型号仍待接入；目标板电气、时序及打印质量验收仍待完成。

### TMC2130 软件 SPI

配置 spi_software_miso_pin、spi_software_mosi_pin 和
spi_software_sclk_pin 三项即可采用软件 SPI；三项必须完整且与
cs_pin 位于同一 MCU，此时 spi_bus 不参与总线选择。总线引脚按
物理身份统一占用，不允许与片选、步进、加热或另一组不同接线的
总线重叠。共用同一片选链的所有驱动必须采用相同接线、速率和链长。

新版固件使用 spi_set_sw_bus，pulse_ticks 按原 MCU 实现取
trunc((1 / spi_speed) * CLOCK_FREQ)，不是四舍五入；结果可以为零。
不支持该命令的旧固件使用 spi_set_software_bus 的 rate 参数。
软件 SPI 路径不要求固件提供硬件 spi_set_bus 或 BUS_PINS 元数据。
片选配置顺序、写入确认、故障监测和电流维护与硬件 SPI 相同。

spi_speed 是请求速率；实际频率受 MCU 指令开销影响，零脉冲间隔
也不表示无限频率。模拟协议和打印验证不测量 MCU 软件位操作对
中断负载的影响，目标板时序及打印质量仍须验收。

### TMC5160 型号接入

TMC5160 配置节可采用上述硬件或软件 SPI，总线引脚、片选链和使能
约束相同。该型号使用 GLOBALSCALER 与 IHOLD_IRUN，默认采样电阻
为 0.075 欧姆；电流维护先确认全局缩放，再确认电流位，全部成功
后才发布量化值。重启重新采用配置文件，维护修改不自动持久化。

状态按 TMC5160 字段解析，包含 s2vsa、s2vsb 和 stealth。启动允许
清除锁存的 GSTAT，运行期不重置驱动；过温、短路及通信失败进入
统一停机。TMC2130 专用的 CS_ACTUAL=0 检查不套用到 TMC5160。
型号算法和模拟 MCU 验收不替代具体板卡、MOSFET、电机和散热条件
下的电流、保护与打印精度验收。

### 无传感器归零

原生线性打印主机支持 TMC2209、TMC2130、TMC5160 和 TMC2240 的
`endstop_pin: tmc2209_stepper_x:virtual_endstop` 形式配置，型号前缀
与实际驱动一致。2209 在驱动节配置 `diag_pin`；2130/5160 配置
`diag0_pin` 或 `diag1_pin`，两者同时存在时沿原实现优先使用 DIAG0。
反相与上拉/下拉前缀写在实际 DIAG 引脚，虚拟引脚不允许这些前缀。
实际引脚仍执行 MCU、别名、保留引脚及排他冲突检查。

归零持有独占运动权限，先排空旧运动，再确认驱动模式写入，刷新
运动时间基线后才启动寻零。停止确认后恢复原字段，并为后续运动
刷新基线。写入失败或归零取消沿整机停止路径退出，不在未确认停止
的运动期间尝试恢复。模式转换会增加归零前后的同步开销，普通打印
步进路径不逐步写入这些寄存器。

编译产品的模拟 MCU 验收覆盖 UART、硬件/软件 SPI、TMC5160 的
归零与后续打印流程。触发灵敏度、实际归零精度及目标板长时间打印
仍待实机验证；项目目前仍不作为可直接控制打印机的生产替代入口。

### TMC 相位状态

带原生运动装配的 TMC2208/2209、2130、5160、2240 在 MCU 确认停止并
读回步进计数后读取 MSCNT，按微步与方向计算 mcu_phase_offset。
同步覆盖首次运动初始化、坐标重建与归零停止。两个读数期间由停止
事务持有运动权限，状态查询不会额外读串口或 SPI。

对象查询的 phase_offset_position 使用当前运动坐标映射换算；
硬件关闭或采样未知时返回 null。相位读取失败采用整组停机，阻止
新运动状态生效；目前不采用原实现对禁用电机读取失败的容忍策略。
相位变化不会自动调整坐标，也不代表 endstop_phase 校准已实现。
MSCNT 为驱动内部步进计数，不能据此证明转子实际位置或排除丢步。

### 归零相位坐标修正

原生线性主机读取 `[endstop_phase stepper_x]`（以及 Y/Z 对应节）的
`trigger_phase`、`endstop_accuracy` 与 `endstop_align_zero`。步距和
微步配置从实际 stepper 节读取；TMC 偏移来自已初始化驱动的停止
采样，未知或周期不匹配时拒绝修正并停机。普通 GPIO 驱动偏移为零。

G28 只在最终一轮限位触发确认后应用修正；有回退时使用第二轮的
触发计数。计数通过该次归零的逻辑成员/OID 映射到实际电机，不能
用最后停止的计数代替。修正后的电机坐标经 Cartesian/CoreXY/CoreXZ
逆运动学换算，只更新本次归零轴；新坐标停止重建完成后才授予归零
状态。旧归零结果不能重复应用或用于另一代运动队列。

没有显式 trigger_phase 时，首个成功最终归零观测自动学习相位。
内存观测随主机重建清除，保存采用下述版本化产品接口。

已初始化的 TMC 线性轴即使没有 endstop_phase 配置，也会在最终归零
时累计相位统计；未配置的轴只统计，不会隐式启用坐标修正。
GET /printer/calibration/endstop_phase 返回 state_token、各电机的
samples、last_phase、last_mcu_position 和 calibration 建议值。
计数、累计代价与 MCU 位置使用十进制字符串，避免 JSON 数值丢失
整数精度；没有观测时 calibration 为 null。每次新观测使旧令牌失效。

POST /printer/calibration/endstop_phase 接受
`{version:1,state_token:"预览令牌",stepper:"stepper_y",action:"save"}`。
请求须授权，打印机须空闲且维护入口可用，只能保存主归零电机已有
观测的推荐相位。客户端不能传入任意 phase 值。写入使用现有配置
备份、外部编辑检测和原子保存机制，保留准确度与整步对齐选项。
成功返回 saved_phase、persisted:true、restart_required:true，关闭
新的打印准入，须显式重建主机后生效。相同请求可安全重试，冲突
请求拒绝；新主机不接受旧令牌。保存失败也要求重建与检查配置。

calibration.low/high 是选中圆周窗口内的观测边界；low 大于 high
表示范围跨过相位零点。统计结果按新观测失效并缓存，重复查询不会
重复扫描直方图。建议值和样本数量供校准决策使用，真机归零重复
精度仍须在目标打印机上测量。

XYZ 校准可一次保存：将请求的 stepper 改为
`steppers:["stepper_x","stepper_y","stepper_z"]`，两种字段不能同时出现。
支持 1–3 个不重复的主轴；全部轴都须具有当前版本的观测。任一轴
不满足条件时不产生待保存修改，全部有效时使用一次配置提交并只需
一次主机重建。saved_phases 返回逐轴结果；相同轴集合的重试不依赖
数组顺序，改变轴集合会被判定为冲突。单轴请求继续保留 saved_phase。
GET 中 trigger_phase 是当前运行实例实际使用的触发相位；只统计的
轴为 null。重建后可据此核对保存值，观测样本数则重新从零开始。

### TMC2240 双总线装配

原生主机的 `tmc2240 stepper_x` 配置节以 `uart_pin` 是否存在选择
UART 或 SPI。UART 地址范围为 0–7，共享引脚时必须唯一；SPI 使用
前述硬件/软件总线和片选链配置。两种方式都要求受控 `enable_pin`，
完成寄存器确认写入和启动故障检查后才发布 ready。

电流换算使用 `rref`（默认 12000 Ω，允许 12000–60000 Ω）。启动时
按 run_current 选择 current_range；运行期电流维护保留该档位，
超出当前档位满量程的请求拒绝。GLOBALSCALER 与 IHOLD_IRUN 两次
写入均确认后才发布新电流；任一写入不确定则停止硬件实例。

状态对象包含周期采样的 temperature（摄氏度），启动后首次周期
采样前、温度读取失败或实例关闭时为 null。读取对象快照不产生额外
总线事务。过温、对地/供电短路和运行期 GSTAT 异常仍触发统一停机。
温度查询容错不取消这些电机保护。

无传感器归零使用 `tmc2240_stepper_x:virtual_endstop`，配置
`diag0_pin` 或 `diag1_pin`。driver_sg4_thrs 为 0 时归零关闭静音模式；
非零时启用 StallGuard4 并打开静音模式、清零 TPWMTHRS。
归零结束确认停止后恢复原寄存器值。相位观测和相位校准接口同样适用。
这些能力仍需在目标 TMC2240 板卡上完成电气、温度与重复归零验收。

## 床面倾斜补偿与校准

线性机器可配置 [bed_tilt] 的 x_adjust、y_adjust、z_adjust，缺省为 0。
普通打印按 `Z物理 = Z逻辑 + X*x_adjust + Y*y_adjust + z_adjust`
补偿，读取逻辑位置时反向换算。补偿后的物理路径仍受 Z 行程、速度、
加速度及挤出约束；归零、安全抬升和校准移动使用物理坐标。
[bed_tilt] 与 [bed_mesh] 不能同时占用运动变换。

配置 points（至少三个非共线 XY 点）、horizontal_move_z（默认 5）、
speed（默认 50），并配置 [probe] 或 [bltouch] 后，可使用自动校准。
points 表示喷嘴位置，与原 bed_tilt 的默认语义一致；拟合输入会加上
探针 XY 偏移并减去 Z 偏移。全部目标和搜索范围在移动前校验，旧补偿
不参与测量；全部采样、收针和拟合成功后才发布新系数。失败停止运动、
撤销归零权限并保留旧系数。未配置探针时可使用下述手动测量操作。

1. 归零后 GET `/printer/calibration/bed_tilt` 获取 state_token，再 POST
   `{ "version": 1, "state_token": "…" }`。只使用服务器配置点位；成功
   重试返回原结果，不重复移动。结果含 adjust、samples、persisted=false。
2. GET `/printer/configuration/bed_tilt` 预览当前校准及保存令牌；POST 同样
   的版本化结构保存服务器测得的系数，不接受客户端系数或脚本。
   系数用可往返的完整精度文本保存，不按显示小数位截断。
3. 保存会封闭打印入口，必须按主机重初始化流程重读配置。外部配置已被
   修改时拒绝覆盖；保存失败也要求检查配置并重新初始化。

`/printer/objects/query?bed_tilt` 返回当前 x/y/z、revision 和 calibrated；
后者表示本运行代次是否完成了校准，不表示真机验收通过。

### 无探针手动测量

配置 [bed_tilt] 的校准点后，归零并保持打印机空闲，GET
`/printer/calibration/bed_tilt/manual` 获取 state_token。POST 请求均包含
`version: 1`、当前 `state_token` 和 `action`；每次完成后使用新令牌。

- `start`：依次抬升、前往第一个配置点，等待用户确认喷嘴高度。
- `adjust`：额外传入非零 `delta`，以毫米表示相对 Z 调整，绝对值不超过 5。
  `bisect_up` / `bisect_down` 根据已访问高度折半搜索；
  `previous_up` / `previous_down` 前往相邻历史高度，单次不超过 0.2 mm。
  向目标下降前按原流程抬高至目标上方 0.5 mm，所有移动受机器行程限制。
- `accept`：确认当前接触点并移动到下一点。必须确实下降至少一个可分辨
  步距才可确认；全部点完成后抬升并应用拟合，仍须通过配置保存接口持久化。
- `cancel`：终止会话并停止电机，之后必须重新初始化和归零。

返回状态包含当前点、已确认点、position、lower、upper、unchanged 和 result。
position 根据排空后的整数步进历史重建，是命令位置而非编码器测量。
极小调整没有跨越步距时 unchanged 为 true，不得据此确认喷嘴已经下降。
手动采样使用喷嘴坐标，不加入探针偏移。

会话独占维护权限，期间不能开始打印或另一项校准。相同令牌和相同请求的
最近一次重试返回原回执；冲突或旧令牌返回 409。客户端重新连接可 GET
恢复当前状态，主机重启不会重放运动。等待输入超过五分钟、通信故障或
取消会撤销运动权限；有效校准不会在未完成采样时发布。
单独 Z 限位校准和偏移保存见下文；Delta 多塔等路径尚未迁移，
不能据此删除原 manual_probe.py。

规划数值参考、基准及模拟产品结果见
[手动校准验收](../host/contracts/manual-probe-acceptance.json)。运行
`npm --prefix host run bench:manual-probe` 可复核规划耗时；不代表真实打印速度。

### 独立手动探测

已归零且空闲时，GET `/printer/calibration/manual_probe` 获取状态；POST 使用
上述 version、state_token 和 action 协议。无需配置床面倾斜或探针。
`start` 在当前 XY 和 Z 开始单点搜索，不自动移动；adjust 和历史搜索
沿用上述步距回读、0.5 mm 抬升及行程约束，速度限制为 5 mm/s。
`accept` 要求实际下降至少一个可分辨步距，返回 `result.position` 三维
喷嘴命令位置和 `persisted: false`，不抬升、不修改 Z 偏移或床面拟合。
操作者仍须确认真实接触。启动前 point 为 null，完成后可发起新测量。

会话采用相同权限、维护互斥、重试回执、五分钟超时和停止清理规则。
确认后释放维护权限；取消或故障后须重新初始化及归零。该接口替代
独立 MANUAL_PROBE/TESTZ/ACCEPT 的交互流程，保留受控操作而非执行宏。
[独立手动探测验收](../host/contracts/standalone-manual-probe-acceptance.json)
记录固定数值参考、性能和编译产品验证；尚未完成真实接触与目标板验收。

### Z 限位接触校准

配置了 stepper_z.position_endstop 且未使用 probe:z_virtual_endstop 时，
GET/POST `/printer/calibration/z_endstop` 提供同样的单点 start、adjust、
搜索、accept、cancel 操作。必须已归零且空闲；当前 XY 不变。机器的
position_min 必须允许待测接触位置，操作不会绕过行程限制。

accept 产生候选值：配置 position_endstop 减去喷嘴接触高度。输入及
候选值均须在配置行程内，结果保留完整数值精度，不按显示精度舍入。
测量不会改变当前归零坐标或写文件。GET `/printer/configuration/z_endstop`
查看 candidate 及新的 state_token；POST 仅包含 version: 1 和该令牌，
保存本机接受的候选值。客户端不得提交 position_endstop 数值。

保存通过既有配置会话进行备份和冲突检查；同请求重试返回原回执。
保存后运动准入关闭，须通过主机重初始化操作加载新配置并重新归零。
保存失败也须重初始化并检查配置，不能继续运动。
[Z 限位校准验收](../host/contracts/z-endstop-acceptance.json)包含实际文件
重读及编译产品再次归零证据；不替代真机接触与精度验收。

### 将当前 Z 偏移保存到限位配置

单独 stepper_z 限位配置提供 GET/POST `/printer/configuration/z_offset`。
GET 返回当前坐标模块的 z_offset、配置限位值、拟保存的 position_endstop
及 state_token。偏移来自当前 homing_origin.z（例如打印文件中的
SET_GCODE_OFFSET），本接口不接受客户端数值，也不进行即时移动。

打印机须空闲且已归零，偏移非零，结果处于行程内，配置持久化可用。
POST 仅传 version: 1 和当前 state_token。新限位等于已加载限位减去
当前偏移，保留完整精度。每次有效 Z 偏移改变或状态恢复都会更新版本，
即使数值改走又改回，旧令牌也会失效；失败运动不改变版本。

保存后返回 restart_required，运动准入关闭。重初始化加载新限位并将
临时坐标偏移归零，避免再次施加；同请求重试只返回保存回执。零偏移
不会写文件，越界或配置冲突不会绕过检查。Delta 多塔偏移保存尚未接通。
[偏移保存验收](../host/contracts/z-offset-acceptance.json)记录编译产品闭环
与前后交替性能样本。`npm --prefix host run bench:gcode` 现在读取固定
原 Python 参考，校验 12,000 个状态和 3,500 次移动，不再执行 Python。
不同 CPU 的历史耗时只作参考，不作为目标板速度通过证据。
