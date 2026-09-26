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

## 编译后的运行包

在已经安装开发依赖的仓库内，使用目标运行环境对应的 Node.js 26.9+
26.x 构建原生插件，再生成 JavaScript 主机包：

```sh
npm --prefix host run build:native
npm --prefix host run build:product-host
cd host/build/product-host
npm ci --omit=dev --ignore-scripts
node --no-experimental-strip-types scripts/product-host.js --profile /etc/anyraid/machine.mjs
```

运行包包含主机 JS、后台 worker/子进程、JSON 数值与 Unicode 契约、
字体及许可证、生产依赖清单与锁文件，以及现有原生插件。依赖需要
单独安装；构建命令本身不会下载依赖或重建插件。可在命令末尾通过
`-- /绝对路径/输出目录` 指定构建目录。

`build-info.json` 记录 Node、TypeScript、平台、架构、模块 ABI 及各
产物的 SHA-256。相同输入可生成相同清单；它不是签名，也不能证明
事先存在的原生插件对应哪份源码。跨架构、平台或 ABI 使用前必须
在目标环境重新构建插件并验证。可选的 `template.node` 仅在构建目录
已有时复制，不因此启用实验性模板实现。

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

## 机器模块契约

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
  关闭。它不授予新打印许可；维护占用、当前作业、归零和温度约束仍
  必须分别满足。例如未归零的空闲主机可以 ready，但不能越过归零策略。

这些值不从 HTTP 监听或机器配置中的静态信息推断。物理停止确认还在
等待时，group_state 已变为 stopping，ready 立即为 false。读取失败或
来源数据不合法时返回 503，不返回此前缓存的 ready，也不暴露内部
错误。该扩展沿用 `/server/info` 鉴权，普通 Klippy 模式不添加此字段；
`klippy_connected` 和 `klippy_state` 继续描述 Klippy，不因原生主机
就绪而伪造 Python 连接。已有打印状态通知仍使用 notify_print_state_changed。

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
当前没有远程鉴权重新初始化接口；SIGHUP 是本机进程管理入口。

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
拒绝且不会打开文件或生成运动。显式本机重新初始化后，历史取消记录仍可查询，新任务重新归零并完成；
活动打印中的重新初始化会被拒绝。模拟限位和文件授权仅属于测试夹具，
没有证明真实加热、限位、步进硬件或打印质量。

编译包基线和负载两项从新构建的运行包启动独立 Node.js 子进程，禁用 TypeScript
直接加载并清空外部程序 PATH，机器模块仅导入包内 JavaScript 与原生库。
经鉴权 multipart 上传真实 G-code，核对 SHA-256 回执和禁止自动开印，
使用 PublishedPrintFiles.acquire 的 sealed 文件执行完整打印流程。
未经授权上传被拒绝；暂停/恢复与过期令牌拒绝、最终位置、取消、
SIGHUP 后历史与文件恢复、新任务重新归零并完成、SIGTERM 清理均通过。
MCU 模拟器在父进程，子进程不导入源码测试夹具。编译包请求喷嘴
200°C、热床 60°C：归零后持续室温采样，确认加热 PWM 已通过 UART
发出但文件尚未执行，再输入达到目标的 ADC 报告完成打印；完成后两路
目标温度归零。打印中注入错误 ADC 报告，确认故障、持久化失败记录和
后续开印拒绝。温度和物理停止仍是模拟，不代表真实热响应、断电与
所有故障恢复或实际打印验收。
依赖目录复用本机已安装 node_modules，尚不是全新目标系统安装验收。

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
