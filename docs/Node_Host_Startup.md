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
字体资源和双 UART 主机启停。测试 UART 对端为模拟 MCU。

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

SIGINT/SIGTERM 取消正在进行的启动，或结束已经就绪的服务。退出先
停止服务与打印所有者，再释放外部依赖。不会为快速退出直接调用
`process.exit()`，也不会因为重复信号跳过清理。已就绪后的正常信号退出返回 0；
启动、运行硬件故障或清理失败返回非零，并在标准错误输出报告失败。
不会自动重连 MCU 或恢复打印。

`PrintController.retire()` 是永久退场接口：它立即拒绝新的打印动作，
关闭状态订阅和设备通知，随后等待已接受动作、实际安全停止及日志
写入完成。普通 `cancel()` 的等待超时不等于底层动作已经结束；即使
该等待已经超时，进程所有者也继续等待真实退场。实际停止或持久化
失败仍会上报，不能将观察超时误写成安全停止成功。

目前 CLI 测试使用真实子进程、PTY、模拟 MCU 和鉴权 HTTP，覆盖双
MCU 启动、SIGINT/SIGTERM 关闭、断连故障、迟到工厂结果和清理失败。
这不替代机器独立停止路径、断电行为及实际打印验收。
