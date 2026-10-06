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
组件（例如 gcode_macro、delayed_gcode、homing_override）或没有
对应设备的 verify_heater、TMC、endstop_phase、bed_mesh 配置会明确报错，
不会在忽略这些配置后报告就绪。文件机器配置入口在创建适配器、作业
数据库和连接 MCU 前执行此检查；已保存的网床配置仍需对应 [bed_mesh]。
遇到未支持配置时，应完成对应能力迁移和产品操作绑定，不应仅删除配置
来绕过功能缺失。当前检查覆盖配置节及从属关系，完整选项级兼容审计
尚未完成；具体数值、选项和硬件约束继续由各组件校验。
实现清单见 [配置节校验器](../host/src/config/native-printer-sections.ts)，
验证结果见 [配置预检验收](../host/contracts/native-printer-sections-acceptance.json)。

## 客户端断连与受控恢复

### 原生作业队列候选

进程模式在 Moonraker 配置加入 `[job_queue]` 后，可使用同一持久数据库、
发布文件库和打印日志管理待打印项目。接口为 `/server/job_queue/status`、
`job`（POST／DELETE）、`jump`、`pause` 和 `start`，REST 与 JSON-RPC
共用鉴权。加入时须整批通过文件存在和打印权限检查；可选字符串
`request_id` 在最近 64 条加入回执内保持幂等，重用身份但改变输入会拒绝。
目录上限 128 项、待处理请求上限 16 项；启动仍执行实际机器准备策略。

项目绑定发布文件的不可变身份；同名替换后须重新加入，不能偷偷打印新
内容。队列启动先持久化启动声明，再把稳定请求身份交给原打印控制器。
打印日志已经接收的请求只收口一次；不确定回执须查询原日志，不能自动
重试。队列暂停只暂停后续调度，不取消正在打印的作业；取消打印仍使用
既有打印控制。设备退役后仍可查看、加入、排序及清空队列，不能启动打印。

重建进程时核对启动声明与权威打印日志，恢复为暂停，不重放打印。
`native_job_queue` 数据库命名空间禁止公共数据库接口读取或改写；关闭队列
也保留该策略。通知采用已授权连接，状态查询在写入时读取完整旧／新目录。
服务退出先排空队列工作，再关闭进程数据库与文件／打印日志所有者。

默认仍为手动队列。自动续打候选须使用进程授权所有者的真实配置入口，
在 `[job_queue]` 显式设置 `automatic_transition=true`；自定义网络鉴权
本身不足以开启。`job_transition_delay` 默认 0.01 秒，是软件事件调度
等待，不是运动时钟或打印精度参数。

显式启动队列，或在当前任务准备／打印／暂停期间加入任务且队列未被
显式暂停时，捕获当次已验证的授权主体和设备代际。后续启动只由该任务
的持久 `completed` 事件触发；每次重新核验原 API Key 代次、JWT 有效期／
撤销或可信客户端策略，再校验文件身份及实际机器准备策略。另一个
WebSocket 登录不能替换原主体。执行授权仅存于进程内，不写入队列目录；
HTTP 返回后任务可继续，但凭据失效、暂停、取消、失败、设备退役或服务
关闭会停止续打。不确定准入回执核对原日志后暂停，不自动重试设备动作。
恢复始终暂停，须重新显式启动；队列暂停仍不取消当前打印。

`load_on_startup=true` 和非空 `job_transition_gcode` 仍明确拒绝，待受控
产品操作 provider 完成，不执行任意旧宏。启动自动加载、旧过渡宏转换、
同包客户端、目标板负载和正常集成仍待验，不能据此关闭完整 M3 或默认
Python 退役门槛。验收范围见[队列契约](../host/contracts/native-job-queue-acceptance.json)。

### 原生设备退役边界

产品服务现在提供 `retirePrinter()`，用于机器集成层单独退役当前设备。
调用同步封住旧代际端点，取消并等待已接收工作，停止订阅和温度采样；
HTTP/WebSocket、鉴权、数据库及进程统计继续运行。重复调用返回同一
Promise。忽略取消的文件策略仍须真正结束，不能把超时或取消当作已排空。
默认 `close()` 继续关闭设备与服务。显式 `serverLifetime: 'process'` 模式
只退役设备，由进程所有者在最终退出时关闭服务器。直接调用产品服务、
未传 existingServer 时，启动失败仍清理该调用创建的服务；产品主机的
createProcess 工厂现预先建立进程服务，首代设备失败借用并保留该监听器。

退役期间 server.info／printer.info 显示 disconnected；没有附着 MCU，
不保留旧 ready 或归零状态。仅 API 清理完成仍标记设备 stopping，由产品
所有者等物理停止及资源清理全部结束后确认 stopped；失败保持 failed。
旧代际打印／对象查询拒绝请求，延迟鉴权不能调用已移除的端点所有者，
旧状态通知不会在退役后发送。温度历史可查询，停止采样不意味着温度测量
已经变为零。此接口是可信集成 API，不是新增的远程重启路由。

释放机器依赖前须完成设备退役；监听器仍运行时，数据库、身份及其他进程
资源须继续保留。旧模式 profile 的 adapter.release 可能还持有这些资源，
不能直接将其全部释放；应使用下文的 `createProcess` 模式拆分生命周期。
旧一次性适配器的设备文件／历史接口在退役后不可用；createProcess 模式
的进程资源继续提供这些服务。标准重启与实际按钮验收边界如下文。
实现、源码网络测试、模拟停止失败及独立编译打印回归见
[退役边界验收](../host/contracts/native-generation-retirement-acceptance.json)。

显式产品集成可在完成旧服务退役及 profile 释放后，将同一服务器作为
`existingServer` 传给 `startConfiguredMachineService`，并指定
`serverLifetime: 'process'`。Moonraker 配置路径、进程配置、回调和数据库
身份必须保持一致；新控制器、门禁、对象与上传层必须空闲且未被占用。
不满足条件时在取得新 MCU 前拒绝。低层 `attachNativePrinter` 等待旧工作
排空及真实停止确认，产品专用路由同步装配后才发布 ready；装配失败保留
监听器及不可用状态，不自动重试或重放作业。

同一 WebSocket 保持连接，但旧设备订阅会清空，客户端须重新订阅。REST／
JSON-RPC 延迟正文仍归属入站时的设备代际，不能在重建后启动新设备。
数据库维护在请求开始时取得当前设备门禁，并保持它到操作结束。
上传层 `close()` 先取消请求和清除暂存；依赖所有者使用 `drain()` 等待
忽略取消的授权实际结束，再释放数据库、文件和 adapter。未结束的策略会
阻止退役完成，不能用超时声明已排空。源码双模拟 MCU 和性能回归见
[绑定接口验证](../host/contracts/native-generation-attachment-acceptance.json)。
`runProductHost` 已在进程模式使用该接口；标准 RESTART 的软件增量如下，
固件重启与实际按钮验收仍待完成。

### 进程服务与设备代际

推荐原生机器模块通过 `createProcess` 明确拆开资源所有权：

```js
import {createNativeProductHostFactory} from '/opt/anyraid/host/src/runtime/native-product-machine.js';
import {createProcessResources, createMachineDeviceAdapter} from './board-adapter.mjs';

export const createProductHostProfile = createNativeProductHostFactory('/etc/anyraid/machine.json', {
  filesRoot: '/var/lib/anyraid/files',
  metadataRoot: '/var/lib/anyraid/metadata',
  uploads: {stagingRoot: '/var/lib/anyraid/staging'},
  standardPrint: {nozzle: 200, bed: 60},
  createProcess: createProcessResources,
  createAdapter: createMachineDeviceAdapter,
});
```

准备温度仍为示例。`createProcess(configuration, signal)` 在有界机器清单
解析之后、打印机配置预检和设备取得之前只调用一次，返回
`NativeProductProcessResources`：`server` 提供持久数据库、
原生授权或显式策略及进程组件配置，`release()` 管理失败启动与最终清理。
创建函数负责返回前的部分失败；成功返回后，即使启动取消，也由工厂清理。
不得在这些回调中依赖已退役的设备。Moonraker 配置在进程首次启动时加载，
设备重建不会重新加载它或改变服务监听配置。

`createAdapter(configuration, signal, gate, processServer)` 每轮返回设备侧
stops、lifecycle、output、authorizePrintFile 和 release；不能再返回 server，
也不能关闭进程数据库。仍须实现真实停止及文件准入，不能套用测试中的
空回调。数据库等托管组件成功传给服务器后由服务器在最终退出时关闭；
进程 release 再释放其他依赖，只有未移交／未关闭的组件才需自行关闭。
release 应幂等，关闭错误不得丢弃。

进程装配提供已打开的 `DatabaseStore` 时，服务信息自动声明 `database`
组件，使 Fluidd 等客户端初始化实际备份列表；设备状态替换不会丢失该
声明。未装配数据库时不额外声明。备份目录仍须由装配者显式设置
`DatabaseStore.open({path, backupDirectory})`，使用独立绝对路径，不能
覆盖活动数据库及其日志；未配置目录的备份请求返回 503。
数据库恢复只在 `server.onDatabaseRestore` 提供完整服务重启所有者时
注册。恢复响应完成后，该所有者须关闭旧服务及全部数据库依赖，再重新
打开数据库和组件；只重建设备不足以恢复。备份、压缩及恢复沿用实际
空闲状态与同一维护门禁，打印或暂停期间拒绝。该声明修复的源码与独立
编译验证通过，实际客户端及正常集成边界见
[数据库发现验收](../host/contracts/database-discovery-acceptance.json)。

工厂声明 `serverLifetime: 'process'`，主机循环以相同服务器绑定新设备，
保持 HTTP/WebSocket、身份、温度历史和文件锁。包装工厂须同时转发这个
属性、bootstrap、resetFirmware、close 及调用的 signal／reload context；遗漏 bootstrap
会失去首代失败的服务出口，不能将进程所有者作为一次性 profile 使用。省略
createProcess 的旧适配器保留原有一次性服务语义，不隐式改变资源归属。

### 原生配置目录

上述 `createNativeProductHostFactory` 的进程模式可显式增加：

```js
configFiles: {
  root: '/etc/anyraid/config',
  maxFileBytes: 4 * 1024 ** 2,
  maxDownloads: 2,
},
```

主打印机配置必须位于该子树。此选项仅接入带 `createProcess` 的工厂；
一次性 `loadNativeProductMachineProfile` 不提供该配置服务。根目录必须
预先存在，工厂不创建或复制配置，不从打印机配置的父目录自动推断公开范围。
配置子树及其父路径由装配者明确选择，数据库、身份与密钥存储不应放入
公开子树；`reserved` 可指定禁止读取的相对文件或目录。

服务实际报告 config 根路径与 `r` 权限，提供 `/server/files/roots`、
`/server/files/list?root=config`、`/server/files/directory?path=config` 及
`GET /server/files/config/<相对路径>`；嵌套 include 文件按实际目录浏览。
目录不读取或展开配置语义，树外 include 不会因此被公开。根及其后代
符号链接拒绝读取；这与固定上游跟随链接的列表语义有明确差异。
Linux 根描述符固定后，目录改名或同名替换不会切换读取范围；配置父路径
属于部署信任边界。列表运行在既有 Worker，下载使用有界不可变快照，
保留原始字节，支持 HEAD、ETag 和单区间 Range；变化中的源返回冲突。
默认每文件 4 MiB、两路下载，分别最多配置到 16 MiB、四路；最终退出
等待实际请求排空后关闭。设备未就绪仍保留授权读取，标准重启和产品
进程重启回归保留同一配置与身份。

Fluidd 1.37.6 与 Mainsail 2.19.0 已实际打开主配置和 include 文件；Mainsail
读取批次显示 read-only；省略 `writable` 仍保持只读。该批次生产包清单指纹为
`7afd8fd10b21a905cd6f9c56124cb5a74bee32486600c7cb5ac85e4ee0ed9e8d`。
并发列表／256 KiB 下载 P99 为 8.17／10.98 ms，状态查询 P99 为 4.36 ms，
最小步进提前量为 87.31 ms。正确性、回收及并发打印检查通过；仍须目标板
测量与实机验收，详情见[配置读取验收](../host/contracts/native-config-files-read-acceptance.json)。

需要保存时，在 `configFiles` 中显式增加允许修改的现有文件，例如
`writable: ['printer.cfg', 'parts/machine.cfg']`；省略的文件仍为 `r`，根报告
`rw`，文件列表按各文件实际能力报告权限。列表不是写入授权凭据。
保存复用 `/server/files/upload` 的 multipart 入口，`root=config`、`path`
为相对目录、`file` 为一个带名称的文件。提供 checksum 时校验新内容摘要；
Mainsail 2.19.0 会提供，Fluidd 1.37.6 的固定上传函数不提供。禁止上传后
自动打印、创建目录或创建尚不存在的文件。上传回执直接提供顶层
`item`／`action`，同时保留既有原生回执格式的 `result` 别名。

强冲突检查可在 multipart 中提交 `If-Match`，使用读取所得的完整 ETag；
受控 JSON／RPC 接口 `/printer/host/config/save`／`printer.host.config.save`
要求 `{version: 1, path, content, expected_sha256}`。其中摘要是当前配置的
SHA-256，不是新内容 checksum；不匹配返回 409。固定客户端尚不提交旧
摘要，只能检查保存过程中的源版本变化，不能保证检测跨编辑会话的旧内容。
外部编辑器不遵守同名写锁时，最终复核到 rename 之间仍存在竞争窗口。

服务一次只接受一个保存、恢复或删除备份；复制输入后授权、取得当前维护门禁，保持它到
提交结束。活动打印、暂停、设备动作、停止未确认、重启或关闭期间拒绝
写入；请求不能从旧设备代际作用到新设备。已确认清理的启动失败允许修复
原路径，标准重启仍须显式执行。错误的 UTF-8 文本配置可保存，以便通过
失败恢复路径修复；NUL、无效 UTF-8、越界、链接和保留路径拒绝。

提交先生成 0600 的精确原字节备份，再同步临时文件、目录并原子替换，
保留目标文件权限和属主。备份名为 `.文件名.save-backup-UUID`，在同一
目录只读可下载。正常情况下每文件保留至多 16 份备份；达到容量后，先
同步新的恢复副本和替换后的源文件，再轮转最旧的可管理备份。只有合法
UUID、当前服务属主、0600 权限、单链接普通文件可被管理；未知前缀条目
计入容量但不自动删除。超过容量或没有可轮转副本时明确拒绝，不能为
继续保存擅自删除未知文件。替换前失败不改变源；替换后同步失败
返回明确的 `phase` 和备份名，不报告成功或自动重试。
错误回执的备份名相对于被修改文件所在目录，嵌套文件须结合请求目录定位。
响应丢失时先读取
当前字节与 ETag 确认结果，不盲目重放。成功后发布标准文件变化通知。

### 配置备份查询、恢复与清理

备份使用下列原生受控接口；这不是完整上游文件管理已完成的声明。

| HTTP | JSON-RPC | 参数与行为 |
| --- | --- | --- |
| GET `/printer/host/config/backups` | `printer.host.config.get_backups` | `path` 为源配置相对路径；返回 `path`、`capacity: 16` 和按时间倒序的 `backups`，条目有 `path`、`size`、`modified` 和只读权限 |
| POST `/printer/host/config/restore` | `printer.host.config.restore` | `{version: 1, path, backup, backup_sha256, expected_sha256}`；先确认选中副本与当前配置两个摘要，恢复精确字节并备份当前版本 |
| DELETE `/printer/host/config/backups` | `printer.host.config.delete_backups` | `{version: 1, path, backup, backup_sha256}`；确认待删副本摘要，至少保留一份可管理恢复副本 |

列表是有界 Worker 元数据快照，不授予修改能力；每个变更都再次检查类型、
属主、链接、路径及版本。备份必须属于源文件的同一目录和命名前缀，源
文件仍须在 `writable` 白名单中。通过已有配置下载接口读取当前文件与
所选备份，分别使用 ETag 去掉双引号后的 SHA-256；列表不伪造内容摘要。
未授权、摘要冲突、越界、链接、打印中、停止未确认、旧设备请求、重启
或关闭中的变更明确拒绝。

恢复使用有界不可变快照，保存当前版本后原子替换源；返回 `restoredFrom`、
`backup`、`rotatedBackup`（未轮转时为 null）、`applied: false`、
`restartRequired: true` 和未自动打印标志。成功路径均相对 config 根；满
容量恢复可能轮转刚选中的旧副本，但快照字节已消费、当前版本的新备份
保留。设备不会隐式应用配置，仍需显式标准重启。确认清理的启动失败
可使用同一服务恢复；恢复后、重启前仍不报告 ready。

删除与保存共用写锁及维护门禁。删除后目录同步失败返回 500，
`phase: 'removed'`；保存／轮转后的不确定结果保留替换阶段和恢复副本，
不报告成功或发布成功通知。先重新查询实际文件与摘要，不能盲目重试。
异常中断留下超过 16 份可管理副本时，可先用上述删除接口清理后再保存；
未知条目仍须核实归属，不借此接口任意删除。最终关闭等待所有已受理的
备份授权与变更真实结束，取消不等于外部策略已经排空。

源码 91 项、两种授权模式的编译恢复及独立编译并发打印验收通过，包清单
指纹为 `e83b2f347f85fc1d8406cada4dae171a5ad53313f8f53db00ab9846056993e79`。
861 次并发备份查询 P99 为 5.77 ms，状态查询 P99 为 4.49 ms，最小步进
提前量为 80.90 ms。本机 ext 文件系统上 256 KiB 满容量保存／恢复的
8 次测量中位数为 10.24／10.99 ms，可运行
`node host/bench/native-config-backups.ts [临时目录的父目录]` 重跑。结果
不证明目标板、旧 Python 整机性能或物理断电耐久；固定前端尚未新增备份
管理按钮，完整 A4 和 G1 仍未通过，见[备份管理验收](../host/contracts/native-config-backups-acceptance.json)。

固定客户端保存后使用的 `RESTART`／`FIRMWARE_RESTART` 脚本现映射到
既有标准重启所有者和持久回执；其他脚本继续明确拒绝。这不是任意宏入口。
配置保存不隐式重新加载 Moonraker 的监听、授权或数据库配置；这类文件
应保留只读，直到相应进程重启／组件重载契约完成。

此前页面保存增量包指纹为
`789cc188957c7475c2e53d280725ab7cd5413f5be5cb09517ec297ef2b798e07`。
Fluidd 的 JWT 场景和 Mainsail 的显式可信回环场景均在实际页面保存后
重启并重新读取成功；Mainsail 另保存错误配置、观察启动失败，在原服务
页面修复后显式恢复。源回归 77 项、两种授权模式的编译恢复及独立编译
并发打印通过。状态查询 P99 4.34 ms、最小步进提前量 81.06 ms；
保存微基准使用 tmpfs，256 KiB、2 次预热和 8 次测量，中位数 1.91 ms、
最大 4.32 ms，不是目标板存储或断电耐久证明。可重跑
`node host/bench/native-config-save.ts`；固定客户端与编译负载命令沿用
本文件客户端验收部分。完整 A4、完整 Moonraker、精度与实机门槛保持未通过；
详情见[配置保存验收](../host/contracts/native-config-files-save-acceptance.json)。

该模式还持有同一文件元数据层和权威作业日志 Worker。设备 profile 借用
日志与元数据，释放时不能关闭它们；新代际的日志路径和设备身份不得改变。
只有旧打印控制器永久退役、操作和写入实际排空并确认停止后，才允许新
控制器接管日志。打印控制器停止失败保留日志控制权；产品停止失败禁止
重新绑定设备。旧控制器不能再修改历史或添加观察者。服务器退出先排空
进程文件工作，工厂再关闭日志及其他依赖。

旧 profile 已释放、新设备尚未就绪期间，文件列表、目录、元数据、缩略图、
下载和历史接口继续通过原身份使用，原 WebSocket 继续接收文件／历史事件。
普通授权上传只发布不可变文件，不加热或开始打印；在线上传绑定接纳时的设备
门禁和取消信号，设备退役会取消它。查询与下载属于进程，可以跨设备交接
继续；迟到的进程授权须在最终退出前实际排空，数据库不能提前关闭。

打印仍要求可用设备。文件删除、移动、复制及覆盖在设备在线时继续使用
同一打印控制器，保护活动／暂停和未确认停止的文件。设备离线后，只有
服务确认物理停止、设备租约释放且依赖清理成功，进程文件所有者才准入
这些操作；离线修改未结束时不能接入新设备，同一文件的并发修改也拒绝。
清理失败在本进程锁存，不能以租约释放推断停止成功。晚到的旧代际正文
仍返回 503；在退役后新受理的请求按离线准入重新检查，不能跨授权等待
作用于新设备。权限、不可变身份、耐久和文件通知沿用原事务；只有显式
`print=true` 且当前代际的打印准入通过才开始打印，不自动重放上传意图。
文件／目录移动、复制覆盖、上传覆盖和删除的持久提交事件，等待该次
文件提交及元数据失效处理终结后，再交给既有授权通知通道。客户端按
通知立即读取新元数据时，新生成的预览不会再被同一次操作的迟到失效
撤销。设备委托使用同一进程边界；授权等待尚未通过的请求不进入该边界，
取消订阅或进程关闭后不补发迟到事件。元数据失败仍保留原查询／恢复
规则和失败响应，不能把通知解释为整个操作成功，也不自动重放请求。
历史删除仅隐藏已结束记录，原幂等回执不删除；统计重置仍受日志校验。
非空目录 `DELETE /server/files/directory`／`server.files.delete_directory`
候选接受 `force=true`，并按固定上游接受布尔值及大小写不敏感的
`true/false` 字符串。gcodes 根不可删除；非递归删除非空目录仍为 409。
递归路径在在线或确认离线的同一所有者下，先授权全部目录和不可变文件
身份，再锁定活动成员；授权期间新增成员使计划过期，零删除返回 409。
活动／暂停作业或维护占用拒绝，未确认退役和迟到代际拒绝。
私有文件库先保留完整命名空间摘要和删除决定，随后删除回执、提交目录
索引并收回无引用内容；共享内容和已获取的密封读取不失效。决定发布后
的取消不能留下半个目录；故障锁存并在重新打开时校验恢复。坏摘要、
改变的存活身份或遗漏成员拒绝恢复，不能先清理临时文件掩盖损坏。
只发一条根 `delete_dir` 事件，不启动打印。精确头集成和实页仍待验，
不能称为完整 Moonraker 文件管理替代。
源码实际主机、独立编译断开窗口及并发打印证据见
[断开窗口资源验收](../host/contracts/native-process-offline-resources-acceptance.json)。

设备重建失败立即结束该恢复请求并记录持久失败回执，监听器继续可查询
且不 ready，不自动重试或重放打印。已确认清理后的配置／启动失败可显式
RESTART；停止或清理未确认时拒绝新设备，仍需显式退出并处理故障。
SIGTERM／SIGINT
先结束设备及在途工作，再关闭服务器、工厂和主机控制器；最终关闭只发生
一次。源码三代交接、HTTP 故障回执、取消与独立编译并发打印证据见
[进程服务验收](../host/contracts/native-process-server-acceptance.json)。

### 进程文件库与设备代际

`createNativeProductHostFactory(machinePath, options)` 可直接作为机器模块的
`createProductHostProfile` 导出；参数沿用原生装配的文件路径、限额、准备
温度和真实 `createAdapter`。配置预检通过后才打开文件库，进程持有同一个
目录句柄、锁和已恢复的文件目录。每个设备代际借用文件库，创建自己的
操作层和门禁；createProcess 模式借用进程元数据，旧代际释放后才允许创建
下一代际。省略 createProcess 的旧模式仍使用每代际的上传／元数据层。

`runProductHost` 在最终设备／profile 退役后调用工厂的 `close()`，包括启动
和清理失败路径；错误保留并继续关闭主机控制器。profile 的 `release()`
排空文件准入、关闭上传层及 adapter 后释放借用，不能关闭进程文件库。
包装工厂时须转发 `close()` 和存在的 `serverLifetime`；单独使用工厂时由调用者先释放 profile，再
关闭工厂。存储路径不能跨代改变，文件限额在工厂创建时固定。

底层 `NativeProductFileResources` 支持显式借用；同时只允许一代际，关闭
时拒绝新借用并等待旧借用结束。迟到授权仍须真正排空；清理失败不会被
转写成成功。原有 `loadNativeProductMachineProfile` 保留一次性所有权。

实际产品入口的双 MCU 模拟重初始化、独立编译 JWT／并发打印回归及
文件交接性能见[进程文件库验收](../host/contracts/native-process-files-acceptance.json)。
该文件库证据属于旧主机流程；保留监听器、数据库与身份的新模式见上节。
createProcess 模式已通过设备退役窗口的文件／历史连续服务验证；标准
RESTART 已接通，完整恢复批次尚未完成。

### 标准主机 RESTART 软件增量

createProcess 模式提供授权 POST /printer/restart 与 WebSocket RPC
printer.restart，无参数。响应为 `ok`，表示持久化 queued 回执已受理；
完整响应交给网络层后才重载，并不表示设备已经 ready。
GET /printer/host/status 返回 restart_available 和 restart_operation；
只在新设备 ready 且回执提交后报告 succeeded。原 reinitialize 的版本／
请求 ID／状态令牌和静止准入语义继续保留。

主机重新读取配置、排空并释放旧设备，再打开新会话。标准 RESTART 强制
UART leaveBootloader=false，复用 MCU 的现有 CRC 配置，不执行固件 reset。
原生工厂与进程 adapter 收到可选
`{reason: 'initial' | 'reinitialize' | 'restart' | 'firmware_restart'}`；
包装工厂须转发这个第二参数。adapter 不得将普通 restart 转换成固件复位。
配置 CRC 不匹配或 MCU shutdown 不会被主机重载自动修复；需要显式
FIRMWARE_RESTART。停止失败与部分启动清理失败拒绝新设备接入。
安全清理后的这些失败分别暴露 mcu_configuration_mismatch、mcu_shutdown，
并附带 firmware_restart_required=true；该字段说明当前固件不能接受期望配置，
不代表当前机器具有 reset 能力或复位已成功。恢复原 CRC 对应配置后可显式
RESTART 复用原 MCU；持续 shutdown 不会因此消失。主／辅 MCU 的连续
HTTP／RPC 失败均保留原连接和查询，不发送 reset 或虚假 ready 通知，见
[普通重启固件故障验收](../host/contracts/native-standard-restart-fault-acceptance.json)。

允许取消活动作业后重载；忽略取消的已受理动作仍必须真正结束，日志
保留取消结果，不重放文件。维护期间拒绝重载。queued 时的第二个标准
请求返回 409；已 running 且同代际的重复请求返回同一次受理结果。旧入站
请求不能作用于新设备；安全退役后的配置失败可修复配置并显式重试，
不会自动重试。WebSocket 保留，设备订阅清空后需要重新订阅。

普通重启回执与受控重初始化分开计数：前者最多保留 64 条，只淘汰最早
插入且已结束的记录；淘汰与新 queued 受理在同一持久事务中提交，失败
一起回滚，queued／running 不被淘汰。后者保留最多 128 条幂等记录，
不会被普通重启挤出。GET /printer/host/status 的 recovery_history 显示
三类保留数量与上限；restart_operation 在重新打开日志后恢复最近一条
有类型的普通回执，未完成操作转为 interrupted，仍不自动执行。

已淘汰普通回执的查询返回 operation:null；新受控请求禁止使用 restart-
及 firmware-restart- 前缀，保留的三类记录不能互相冒充，避免将过期标准
ID 重新解释为新操作。系统控制候选将格式升级为 v4：v1 原子迁移并将所有原记录视作受控
类型，v2／v3 原子迁移并完整保留原 kind、身份和顺序；均不按名称
猜测；即使旧 128 条全部占满，普通重启仍可使用独立保留容量。旧包不能
打开 v4 日志；部署前应在停止日志所有者后保留可恢复副本，降级需要对应
旧格式副本，不删除新日志来绕过检查。未知格式、结构、损坏或不同设备
的日志拒绝迁移。容量／迁移及编译产品证据见
[恢复回执保留验收](../host/contracts/native-recovery-retention-acceptance.json)。

当前边界：机器清单、Moonraker／授权配置或进程持久资源无法建立时，
不能承诺查询服务，也不补充默认放行策略。首代设备失败的出口见下节。
额外参数返回 400（固定上游路由忽略额外参数），旧一次性工厂拒绝标准重载。
`ok`、ready 与成功回执分别表示不同阶段，不能混用。
实际 Fluidd／Mainsail 按钮和物理 MCU 尚未验收。软件证据见
[标准主机重启增量](../host/contracts/native-standard-restart-acceptance.json)。

### 显式 FIRMWARE_RESTART 软件路径

createProcess 原生工厂已接入授权 POST /printer/firmware_restart 和
WebSocket printer.firmware_restart，无参数。`ok` 仅表示 queued 回执受理；
GET /printer/host/status 的 firmware_restart_operation 分别显示 queued、
running、succeeded 或 failed。firmware_restart_available 表示当前主机
拥有显式复位策略；实际 MCU 字典、维护占用、停止与配置仍须核验。
就绪设备的任一 MCU 缺少 reset 时，在退役前返回 503。没有该工厂策略的
旧入口也返回 503。断开阶段先受理持久回执，再探测全部 MCU；不支持时
回执 failed，不报告 ready，也不先复位支持的其他 MCU。

主机先取消并排空活动作业，确认旧输出停止、旧会话和 adapter 释放，再
取得新 adapter 的停止确认。随后打开全部独占诊断会话，预检全部字典中的
reset，逐台调用 resetOffline；UART 不执行 bootloader 启动序列。
ACK 或 starting 仅作为送达／重启观察。再次连接查询 get_config，要求
is_config=0、crc=0、is_shutdown=0；关闭诊断所有者后，产品配置握手再次
要求 MCU 未配置，再创建新运动／热控对象并报告就绪。任何阶段均不自动
归零、加热或重放打印。诊断阶段有 15 秒取消期限；实际停止确认必须排空，
不能因观察超时或进程退出而丢弃它。

安全清理后的复位／配置失败保持原服务和失败回执，可显式重试；旧停止、
新诊断停止或清理无法确认时暴露 cleanup_unconfirmed，禁止两种重启。
进程退出等待已发送复位的停止确认，不再复位后续 MCU，不接入新设备。
resetFirmware 是工厂提供的独立路径，包装工厂不能遗漏或用普通重载冒充。
目前支持字典中的 reset 命令，其他板卡复位方式须单独实现和验收。

固件重启回执有 kind=firmware_restart，独立滚动保留 64 条，既不挤出普通
重启 64 条，也不挤出受控幂等记录 128 条；任一种 queued／running 时只
允许一个持久操作。相同种类、同代际的 running 请求复用原回执，不同种类
返回 409。进程崩溃后未完成回执转 interrupted，不执行 reset 重放。
源码覆盖 ACK／starting、主／辅 MCU 故障、能力缺失、停止失败、部分复位
无效、作业取消和退出竞争。编译产品对同一双 MCU 分别执行两次真实模型
复位并重建，保留监听器、身份、连接、文件和历史，验证资源回收及并发打印。
这封存 A3 软件判据；实际 Fluidd／Mainsail 按钮及物理 MCU 仍待验收。
证据见[固件重启验收](../host/contracts/native-firmware-restart-acceptance.json)。

### 首代设备启动失败与显式恢复

`runProductHost` 先调用进程工厂 bootstrap，初始化真实进程文件、权威作业
日志与恢复日志、鉴权和 Moonraker 监听器，再读取 printer.cfg 并创建设备。
服务未绑定设备时没有 PrintController、运动对象或模拟 MCU，不启动设备
生命周期采样。打印与运动对象不可用；授权文件查询、下载、上传与历史
管理可用。完成已取得设备的停止／清理并确认离线准入后，可修改文件；
未确认停止时删除／覆盖仍拒绝，上传不自动打印，旧作业不自动重放。

首次配置、adapter 或 MCU 启动失败后，服务保留原身份和连接；完成已取得
资源的停止／清理后才提供显式 RESTART。server.info.native_host 中
ready=false、closing=true、admission_closed=true、mcus=[]；可选的
startup_failure 为 device_startup_failed、cleanup_unconfirmed、mcu_shutdown
或 mcu_configuration_mismatch，不包含异常文本、路径或凭据。仅已识别的 MCU
配置／固件异常使用后两种分类；普通错误文本不能冒充固件故障。
清理未确认优先暴露 cleanup_unconfirmed，硬件状态 failed，restart_available=false，
不会凭空声称物理停止。修复设备配置后，HTTP／RPC 标准 RESTART 绑定真实
新设备并发送一次就绪通知；迟到正文和旧授权不能进入新代际。

运行中不能改变 deviceId、日志路径、打印机配置路径或 Moonraker 配置路径；
修复相同路径下的设备配置可以重试，进程身份变化在取得 adapter 前拒绝。
首次 adapter 忽略取消时，SIGTERM 仍等待它返回并真正释放，然后关闭服务
数据库和工厂资源，不把取消当作已清理。源码与独立编译证据见
[首代失败恢复验收](../host/contracts/native-process-bootstrap-acceptance.json)。

### 客户端连接与重新初始化

WebSocket 重连后需重新识别／鉴权并调用 `printer.objects.subscribe`；
新订阅返回完整当前快照，后续通知是增量，不重放断连期间的事件。
客户端连接与打印作业生命周期独立：重连不重新开始文件，也不改变作业
请求身份。JWT 和显式可信回环模式均通过独立编译产品的协议回归。

原生 `/printer/host/reinitialize` 使用版本、请求 ID 和主机状态令牌，
响应发出后才切换设备代际。createProcess 模式保留原连接，客户端仍须在
新设备就绪后重新订阅；旧一次性服务模式关闭连接，须重连并重新订阅。
回归验证了新代际 standby、未暂停状态和历史保留。此接口不等同于
标准 Klippy `restart`／`firmware_restart`，实际前端按钮衔接仍待完成。
实际 Mainsail 2.19.0 已验证打印中刷新后继续至完成且历史不重复；原生
重新初始化后需点击 TRY AGAIN 才恢复 Standby，本轮没有自动重连通过
证据。该页面记录属于旧包：当前标准 `/printer/restart` 已接入软件产品，
`/printer/firmware_restart` 已接入独立复位路径，两个按钮在上一候选包的
两套页面均已验证。当前候选包新增 history 组件发现修正；其完整页面
断连／进程恢复及上传仍待完成。不同版本证据分别保留，读取客户端记录
的 currentEvidence 及相应历史字段；实机恢复须单独验收。

## 实时运动状态

原生 `toolhead.estimated_print_time` 由当前设备代际的共享 MCU 时间
映射读取，单位为秒。它可在空闲和作业完成后持续更新，供客户端正确
刷新合并的状态；端口停止／退役或时钟不可用时返回 null，设备未绑定时
仍沿用对象查询拒绝。查询不刷新采样、预约时钟、修改校准或授权运动，
也不表示真实打印准入或编码器测量。证据与本机性能范围见
[状态时间修复验收](../host/contracts/native-toolhead-clock-acceptance.json)。

原生产品的 `motion_report` 提供 `live_position`、`live_velocity` 与
`live_extruder_velocity`，通过原有对象查询／订阅和鉴权路径发布。
运动时使用同步 MCU 时间读取当前 C trapq 的轨迹阶段；排空完成后使用
已确认的源轨迹停止位置，速度为零。活动挤出轴随工具选择变化，回抽速度
保留负号。队列退役、停止或没有可用历史时返回 null，不读取已释放资源。

这些值是请求轨迹，单位为 mm 和 mm/s，不是编码器测量，也不含输入整形
或压力提前对电机步进的修正。暂停停靠时实时坐标是停车位置，`toolhead`
规划坐标仍可能保留待恢复的打印位置；不能把两者混用。当前不提供
`motion_report` 的队列导出接口与关机诊断日志，不能称完整组件迁移。
固定数值、生命周期、客户端和性能证据见
[实时运动状态验收](../host/contracts/native-motion-report-acceptance.json)。

可用 `node host/bench/product-motion-report-ab.ts /tmp/anyraid-motion-report-ab`
顺序复验同产物 ABBA 查询负载。A 仅从重复查询中移除 `motion_report`，
B 保持默认完整查询，生产功能不关闭；每轮核对产物摘要并保存原始日志。
当前四轮没有一致的尾延迟升高，但样本不足以保证严格无回退；这是桌面
查询成本对照，不是 Python、目标板或真实打印速度对照。

## 原生摄像头管理

提供数据库的配置服务会启用 `/server/webcams/list`、`/server/webcams/item`
和 `/server/webcams/test`，适用现有 HTTP／WebSocket 授权规则。
`[webcam 名称]` 配置至少提供 `stream_url`；配置来源不可通过接口修改。
接口创建的摄像头持久化到 `webcams` 命名空间，支持按 UID／名称查询、
修改和删除；写入成功后发送 `notify_webcams_changed`。原始数据库接口
不能绕过管理接口修改该命名空间。关闭等待已接受写入，并终止快照探测。

快照探测限制为 1 秒、8 MiB 和最多 4 个并发请求，相对地址目前基于
`http://127.0.0.1`。上游公网地址变化、DNS／本地监听地址转换和原实例
UUID 迁移尚未闭合；不要把当前管理接口视为完整摄像头组件兼容。
本地 HTTP 快照测试不代表真实摄像头验收。实现、边界与并发打印回归见
[摄像头验收记录](../host/contracts/native-webcams-acceptance.json)。

## 运动时钟维护的脉冲边界

运动与回零共用的周期校准先校验整个 MCU 的步进器，再同步发布映射。
若原生预校验发现新锚点恰好等于已有脉冲时钟，并且没有落后于已提交
时钟，返回 `ERR_CLOCK_CALIBRATION_ANCHOR_PULSE`。运行时保持旧映射，
将此次维护记为未更新，按现有 0.25 秒节奏重试；下一次规划从已经生成
的前缀之后开始。成功后的间隔仍为一秒，不改变源覆盖、10 ms 生成上限
或步进压缩的取整和重叠保护，也不重置或重新提交已有脉冲。

其他重叠返回 `ERR_CLOCK_CALIBRATION_OVERLAP` 并继续传播；执行阶段的
失败不能使用延期路径。异常附带 `calibrationBoundary`，其中候选、最新
及已提交时钟为十进制字符串，包含生成时间、未取整候选时钟及执行阶段。
`stepAccounting` 是原生求解器的累计估算，不能作为物理脉冲计数。
这仅覆盖已证实的锚点反例，不能解释所有历史间歇故障或替代 G3／实机验收。

## Delta 自动装配开发入口

`planDeltaPrinter(reader, policy)` 生成硬件布局、运动描述、初始队列和
三塔归零分组。`connectConfiguredDeltaPrinter` 获取 MCU 连接、捕获
时钟、配置硬件并装配文件打印；已连接的 MCU 可使用
`startClockedDeltaPrinter`。`connectDeltaProductPrinter` 再装配持久化作业、耗材与空闲策略；
`startConfiguredDeltaProductService` 接入授权的 Moonraker 状态与受控
操作服务。以上为机器集成层 API；`product-host` 的声明式机型选择
已有 Delta 模拟产品证据，不能仅替换配置就启动现有部署。

连接前检查每个配置节，识别 A/B/C 塔、附加塔电机及相应 TMC 所有权。
机械探针、BLTouch 及受控 Delta 校准已有软件接入；尚未支持的配置节
及原始宏继续明确拒绝。
预检失败不打开设备；后续启动失败关闭已获取的 MCU 和输出所有者。
成功启动保持未归零状态，实际归零由打印启动策略或受控操作执行。
当前证据仅为模拟 MCU，不能据此跳过实机运动精度和打印验收。

### 校准故障的本地诊断

产品服务返回的 `calibrationDiagnostic()` 供进程内可信所有者读取；
`registerNativeDeltaCalibration` 返回的关闭函数也带有 `diagnostic()`。
失败记录包含 action、stage、原始 cause 和已取得的数值 input；stage
区分 capture、measure、synchronize、fit、validate、save、publish。
input 每次读取均复制，读取者不能改变候选或失败输入。
未取得测量数据的失败没有 input。此接口未注册 HTTP／RPC 路由，
远程仍收到原有 503；失败继续撤销运动权限并要求重新初始化。

BLTouch 模拟回归失败时保留最多 32 个线级时钟观测；
`BLTOUCH_CLOCK_DIAGNOSTIC=1` 可同时打印成功样本的时钟观测。
这是开发夹具的诊断开关，不改变触发注入、停止时序、生产日志或查询响应。
校准未收敛仍由 Worker 拒绝，降低残差不构成接受候选的充分条件。
证据与适用范围见[校准故障诊断验收](../host/contracts/delta-calibration-failure-acceptance.json)。

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

## STM32 固件的 LTO 链接

STM32／N32 固件在最终链接时显式使用 `-fuse-linker-plugin`，编译阶段仍
保留原 fat LTO 对象及命令声明提取。工具链须具备 GCC LTO 插件和支持
插件的链接器；[GCC 10 文档](https://gcc.gnu.org/onlinedocs/gcc-10.3.0/gcc/Optimize-Options.html)
列明 GNU ld 2.21+ 或 gold 的要求。关闭插件时，CI 的 GCC 10.3.1 会在
优化前的链接中因小 ROM 超限退出；不能通过扩大 ROM 或忽略链接错误修复。
最终固件继续使用原配置／链接脚本的硬限制和编译器属性检查。

当前同版本工具链下的 19 项现有配置构建、52 个关键函数的归一化指令对照
和收紧 ROM 的拒绝负例见[链接修复验收](../host/contracts/stm32-lto-acceptance.json)。
这些本地结果不证明物理芯片容量／bootloader 映射、目标时序或打印验收；
正式固件仍须按当前系列实际板卡配置构建并通过规定门槛。

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

在创建板卡适配器和切换服务前，可先检查版本化机器 JSON 及其引用的
打印机、Moonraker 配置：

```sh
/opt/node26/bin/node --no-experimental-strip-types \
  /opt/anyraid/scripts/product-preflight.js --machine /etc/anyraid/machine.json
```

源码入口是 `node scripts/product-preflight.ts --machine /绝对路径/machine.json`。
它与实际启动共用配置、include／自动保存、网络绑定、MCU 策略和线性
拓扑检查，失败返回非零退出码。成功输出 `state: topology_validated`
及组件、MCU、运动电机和加热器清单；不输出配置值或认证信息。
该命令不加载机器 JS 模块、不创建打印日志、不打开 MCU。
`hardwareValidated` 和 `allOptionsValidated` 均为 false：完整引脚资源、
依赖 MCU 字典的选项、真实输出和物理停止仍需启动与目标板验收。
检查成功不授予打印权限，也不能作为启用服务的充分依据。

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

### 系统控制的授权准备

候选系统控制需要管理员显式装配 `LinuxMachineControl`；读取服务状态
不授予操作权限。对于专用打印设备的非 root 服务账号，可以从同一份
本地 JSON 描述生成配对单元和待审查的站点 polkit 规则：

```json
{
  "ownUnit": "anyraid-host.service",
  "allowedUnits": ["crowsnest.service", "klipper.service"],
  "deviceUnits": ["klipper.service"]
}
```

ownUnit 加 allowedUnits 最多 64 个规范服务名，deviceUnits 必须是其
子集。描述文件最多 64 KiB，只接受普通文件，拒绝符号链接、FIFO、
设备、非法 UTF-8 和未知字段。Linux O_PATH 先固定 inode 而不打开
设备进行 I/O，确认类型后经 /proc/self/fd 读取同一个普通文件；缺少
procfs 时明确失败，不降级为按原路径读取。描述是管理员数据，不
接受 HTTP 请求输入。
机器模块必须从同一份可信描述构造能力；生成器不导入模块，不能证明
模块采用了这份配置。必须审核模块与实际部署配置是否相符。

```sh
/opt/node26/bin/node /opt/anyraid/scripts/product-service-unit.js \
  --bundle /opt/anyraid --profile /etc/anyraid/machine.mjs --user printer \
  --machine-control /etc/anyraid/control.json > "$TMPDIR/anyraid-host.service"
/opt/node26/bin/node /opt/anyraid/scripts/product-service-unit.js \
  --bundle /opt/anyraid --profile /etc/anyraid/machine.mjs --user printer \
  --machine-control /etc/anyraid/control.json --polkit > "$TMPDIR/49-anyraid-control.rules"
systemd-analyze verify "$TMPDIR/anyraid-host.service"
```

Node 路径按最终部署位置替换；TMPDIR 应为已存在、由操作者控制的
准备目录。单元文件名必须等于 ownUnit；若沿用旧标准服务名称，
生成器从 Conflicts 中排除自身，切换仍受下方门槛约束。此选项加入
NoNewPrivileges=yes；规则同时核对专用账号、内核识别的 system_unit
与 no_new_privileges=true，缺失属性时拒绝，不退回仅按用户名放行。
服务自身只允许 restart，显式外部单元允许 start／stop／restart；不
授予管理单元文件、daemon-reload、环境变量或任意临时单元的权限。
另允许 login1 的基本 reboot／power-off 及 systemctl 正常 PID1 回退
所用的 reboot.target／poweroff.target 的 start，拒绝 login1 的
ignore-inhibit／multiple-sessions 等动作。target 准入不是独立阻止器
策略，也不约束已被攻陷的服务主体通过其他调用使用这项电源权限。

规则为管理员审核的专用站点配置，使用 ES5、不调用外部程序、不缓存
YES_KEEP；不自动安装，不适合直接作为通用发行版权限包。专用账号
不应与其他服务或登录用途共用；现有更早执行的规则可能先行返回，
管理员须检查规则顺序和已有授权，不能把单个生成规则视为完整权限
证明。属性与规则语义依据 [polkit 手册](https://polkit.pages.freedesktop.org/polkit/polkit.8.html)，
unit／verb 及电源回退依据 [systemd v255 授权源码](https://github.com/systemd/systemd/blob/v255/src/core/dbus-util.c)
和 [systemctl 源码](https://github.com/systemd/systemd/blob/v255/src/systemctl/systemctl-start-special.c)。

本机只有解析器及 Node VM 的规则检查，PID1 是 codex；没有执行真实
systemd／polkit 授权。管理员安装到 systemd 和 polkit 的系统目录、
属性可用性、准入与拒绝、会话／阻止器、实际服务状态及回滚，仍须在
目标系统按本项目发布门槛验收。禁止把生成成功当作安装、切换或 G3
通过。使用本机准备目录进行 17 项回归和独立编译入口验证的证据见
[系统控制验收](../host/contracts/native-machine-control-acceptance.json)。

### 停止与默认切换门槛

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
只解析文件列表返回的已发布路径，并绑定原不可变 fileId；上传文件不会因此自动开印或执行宏。
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

createProcess 产品主机在鉴权及进程资源就绪、实际监听完成后先输出
`{"event":"listening","address":{...}}`，只报告服务可访问。只有完成 MCU
连接、原生硬件装配和持久化状态恢复后，才输出设备就绪 JSON：

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
- `startup_failure`：仅在设备断开且启动失败时出现的有界分类，不含故障文本。
- `firmware_restart_required`：仅在 mcu_shutdown／mcu_configuration_mismatch
  分类时为 true；其他状态省略，不表示复位能力或操作成功。
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

### 准备阶段暂停

标准 `/printer/print/pause` 和带当前 request_id／state_token 的原生控制
可在 preparing 阶段登记暂停；权限、状态代际检查沿用原产品入口。
`/printer/print/status` 的 `pause_pending` 表示请求仍等待准备确认，
此时 `print_stats.state` 继续为 printing，不能显示为已停止。准备动作
仍按原 startMs 完成归零／加热和确认，不并行调用文件暂停或重放准备。
若请求已越过文件启动检查点，等待该启动确认后进入原文件暂停流程。

在执行文件前保持的作业状态为 paused，`paused_before_file=true`，
文件进度仍为零。原封存文件、热控与日志所有者保持占用，日志仍为
reserved，未写 started；所有普通活动文件保护继续生效。显式 resume
重新检查当前授权、状态代际和产品联锁，按原 resumeMs 启动同一文件，
写入一次 started；不重放准备，也不建立另一打印状态机。准备期的
总时长和已接收挤出统计不因登记暂停而重置。

请求断连只停止等待回执，已受理的保持仍生效；恢复需要新的显式授权。
取消、故障和设备退役均沿用原停止所有者、截止时间及迟到动作清理。
此保持不代表无热量／无准备运动，不能用来代替急停。进程重启仍由
权威日志恢复为 interrupted，不自动恢复或重放文件。当前证据属于
模拟 MCU 软件验收；真实机型与 G3 门禁独立保留。

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
旧一次性模式在此期间关闭并重建 API，客户端须重新连接；createProcess
模式保留监听器与连接。工厂应复用相同持久化日志路径以保留历史。不会
重放旧文件，新作业必须重新归零。
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
旧一次性模式的机器重建失败可能使进程退出。createProcess 模式保留服务；
确认安全退役后的配置失败允许显式标准 RESTART 重试。停止或清理失败
拒绝重试，不以旧设备的 stopped 快照推定部分新设备已安全清理。

同 request_id 与原 state_token 重试返回原记录，不再次执行；冲突身份
或旧会话令牌返回 409。未鉴权请求不产生恢复动作。受控重初始化日志保留最多
128 条幂等操作记录、数据库总上限 1 MiB；达到受控容量后拒绝新的受控
请求，不自动淘汰这类记录，进程重启不会清空容量。普通 RESTART 的
独立 64 条滚动保留策略见上文，不被受控容量阻塞。受控历史归档仍待完善。

满容量回执的桌面基准可运行 `npm --prefix host run bench:host-recovery-retention`。
该基准使用空重载 handler，分别测量持久受理、完成与状态读取，不代表
MCU 重载或目标板时序；真实设备准入仍按交付计划执行。

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
存储。释放顺序为 `await uploads.drain()`，然后 `await files.close()`。
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
存储；当前原生存储使用列表返回的规范相对路径，包括目录内的真实文件名。
旧的显式 file_id 且未提供 path 的上传仍保留 `<file_id>.gcode` 地址。

适配器生成 `compat-...` 请求标识并持久保留，状态接口可查询该标识。
授权先按原始接口参数执行，再按解析后的 file_id、请求标识与参数执行；
控制请求在授权前绑定当前状态，授权等待期间状态变化则拒绝。开始请求
只允许 idle/completed/cancelled，已完成或取消的任务必须先通过原控制器
清理门槛才能开始下一任务；failed/interrupted 仍要求显式恢复。
暂停、恢复、取消保持原控制器的状态及物理停止约束。

原生控制器因共享维护所有者拒绝操作时，候选在原 HTTP／WebSocket
409 错误及原通用消息中补充 `data.reason`。`maintenance_active` 表示
原准入检查时维护正在占用，`admission_closed` 表示原准入已关闭，
`activity_capacity` 表示原 65,536 项活动上限，`producer_busy` 是其他
维护所有者冲突。原因来自实际错误实例，不按消息字符串、客户端字段
或事后状态猜测；不输出底层异常文本或堆栈。身份、授权、400／410／499
及其他 409 沿用原响应。仅该原因字段不能证明整个请求未产生设备效果，
仍须查询请求／设备状态；不能自动重试或重放动作。被初始维护准入拒绝
的开始请求不创建预约，维护结束后必须由用户显式提交新的请求。

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
可见路径；空闲或重置后为空，完成及故障状态保留当前作业名。
未装配该所有者时不猜测自定义文件命名。`pause_resume.is_paused` 在暂停
确认后为 true，恢复确认前仍为 true；仅发起暂停时不能声称已暂停。
原生线性产品的 `filament_used` 来自已接受运动的有符号 G-code 挤出量，
不是编码器测量。`print_duration` 从首次净正挤出开始，排除已确认暂停
和恢复准备；`total_duration` 包含准备与暂停。文件流首次启动和停车
返回后的恢复均在运动生命周期确认后、文件命令准入前启用统计，避免
等待外层启动回执时漏计文件前缀。失败、取消与完成冻结终态统计；
缺少可恢复记录时保留未知值，不从文件进度推算。

### 原生 G-code 目录与上传

上传、删除、移动、复制及目录修改共享默认 2 个修改席位，配置范围仍为
1–4。目录、列表与缩略图读取继续纳入关闭／排空所有权，但不消耗修改
席位；下载和外部授权沿用独立预算。真正达到修改容量时仍返回 429，
有容量的活动／暂停文件删除继续由打印保护返回 409。

进程文件库可以跨设备重建保留；带设备准入的上传暂存任务同时由原设备
等待清理完成。关闭设备或退役其代次会取消上传，移除暂存并释放维护活动
后才能释放原设备。捕获旧代次的迟到请求仍返回 503，不能落入新设备；
进程只读查询及已有下载不随设备关闭。修改席位仍只由进程上传所有者计数。

`POST /server/files/directory` 创建目录，`GET` 列出直接子项，`DELETE`
只删除空目录；对应 RPC 为 `server.files.post_directory`、
`server.files.get_directory` 和 `server.files.delete_directory`。
path 使用 `gcodes/相对目录`，先创建父目录；根目录不可删除。
目录通知在耐久提交后发送，沿用用户授权与有界通知队列。落盘失败返回
500 和 `error.data.phase`：`before-replace` 或 `replaced`；后者要求恢复
文件库，不能把失败视为未修改并直接重试。HTTP 和 RPC 均保留此信息。

`POST /server/files/upload` 使用 multipart 的 root=gcodes、path=相对目录
和带名称的 file。常规客户端无需提供 file_id，上传回执、列表、元数据、
下载、缩略图及标准开始打印使用同一可见路径；内部仍以独立不可变 ID
绑定内容摘要和打印作业。显式 file_id 且省略 path 的旧请求保留原 ID 地址；
显式空 path 则使用根目录的实际文件名。URL 路径逐段编码，允许中文、
空格和百分号；JSON 查询传入未编码的规范相对路径。下载只解码一次。
拒绝绝对路径、空段、`.`／`..`、反斜线、控制字符及保留目录，限制
32 段、单段 255 UTF-8 字节、总长 1,024 字节；回执另受原 2,048 字节限额。
命名空间与私有 blob／回执目录分离，可见名字不会作为真实存储路径打开。

显式 `print=true` 支持标准“上传并打印”候选。文件发布后先关闭临时源、
删除暂存目录并释放文件／设备／进程上传占用，再使用入站时捕获的打印
API。沿用既有机器温度策略和 30 秒准入期限，重新授权 `printer.print.start`
并比对不可变文件 ID；同名路径的替换不能改换待打印内容。旧设备退役、
权限失效、当前作业占用或文件变化均不启动第二个任务，也不自动入队。
回执提供 `print_started`、`print_queued` 与 `print_request_id`；其中
`print_started=true` 表示耐久准入成功，不代表准备、物理运动或整件打印
已完成。启动失败保留已发布文件及 `print_error`，不撤销发布、不重试。
普通上传省略该字段或提交空、`false`、`0` 时仍不启动。
丢失回执时应查询文件、当前打印状态与历史，不重发带打印标志的上传；
当前设备就绪时可用 `/printer/print/status?request_id=...` 核对耐久记录，
准入前拒绝可能没有该记录。现有 HTTP 200 和 result 别名保持；官方 201
及 Location 回执差额仍未收口，不据本批声称全部文件契约兼容。
行为断言、固定字节输入与性能原样本见[上传启动验收](../host/contracts/upload-print-intent-acceptance.json)。
原版只读工作树可由 `ANYRAID_UPLOAD_BASELINE` 指定，用 Node.js 26 执行
`node host/bench/upload-print-intent.ts`；基准先核对三个原模块摘要，保留
5 次预热、11 次交替配对测量。范围仅为桌面上传／耐久准入，未执行运动。

标准上传同名文件时使用新 ID 替换可见路径，退役旧 ID，返回及通知仍为
`create_file`，不带 `source_item`，也不自动打印。新显式 ID 可用于覆盖，
重复已有 ID 仍返回 409；目录不存在返回 404。覆盖须有入站时捕获的设备打印所有者或经确认的离线所有者；
活动／暂停目标和停止未确认的目标受保护。离线新文件
上传继续可用。确认停止与清理后，进程文件所有者可准入覆盖，未确认时
返回 503；新设备接入或准入变化时不会继续原离线决定。删除文件沿用活动
作业保护，删除后撤销路径与预览，已持有的不可变读取快照保持原字节。
目录与命名回执、原缩略图 URL 可在进程恢复后使用。目录最多 1,024 个，
元数据清单不超过 2 MiB；文件、上传、快照与响应限额仍沿用已有配置。
上传／移动覆盖已有本机增量，独立编译打印、新头 CI／PR 与完整页面仍待验，
见[覆盖证据](../host/contracts/native-overwrite-acceptance.json)。自动创建上传父目录、
UFP、上传后受控打印的正常集成和完整客户端／目标验收尚未闭合，完整 Moonraker 目标仍保留这些差异。API 验收不代替
固定 Fluidd／Mainsail 页面流程或实机性能。命令和结果见
[目录文件验收](../host/contracts/native-file-namespace-acceptance.json)。

`POST /server/files/move` 和 RPC `server.files.move` 已接入单文件移动／
重命名，参数为 `source`、`dest`，均使用 `gcodes/相对路径`。目标是已有
目录时保留源路径的末级名称；`dest=gcodes` 移至根目录。目标父目录须
已存在，同路径操作不改写回执。成功返回 `action=move_file`、目标
`item` 及原路径 `source_item`，并在耐久提交后发送同结构的文件通知。
打印 ID、内容摘要、字节及已取得的读取快照保持不变；新路径可重新读取
元数据、缩略图、下载和选择打印，旧路径及旧预览撤销。

请求先授权原始源／目标，再授权解析后的源／目标、文件 ID 和内容摘要。
活动／暂停及未确认停止的文件受同一打印控制器保护，返回 403；修改
同一文件期间不可启动它，其他文件可在打印中移动。授权延迟期间变化
的源或目标会重新检查，不覆盖新文件。设备代际退役会取消未提交请求；
设备断开时，确认停止、旧租约释放与清理成功后可由进程文件所有者移动；
其他断开状态及晚到旧代际请求返回 503。离线修改与新设备接入互斥。

无覆盖的单文件事务只原子替换一个私有回执，目录同步完成后发布路径索引及
通知。替换前取消／失败保留原路径；替换后取消仍完成耐久提交。
提交失败返回 500 和 `error.data.phase`，`replaced` 表示已替换但耐久
不确定，后续读取／修改被隔离，重启从完整回执恢复，不能当作未修改
直接重试。已有文件目标现可覆盖：保留源 ID／内容／时间，退役旧目标 ID，
同时授权并保护两个身份。已有目录内的同名文件按解析后的目标处理。
覆盖事务先写有界 `.namespace-replace.json` 耐久决定，再安装并同步新回执，
之后移除旧身份。决定前失败保留旧目标；决定后取消仍继续完成，写入不确定
时拒绝后续读写直至 reopen；恢复验证完整身份成员及内容引用，不重复通知。
覆盖失败的 `error.data.phase` 为 `before-intent` 或 `intent-published`；后者
不能当作未修改直接重试。当前独立编译覆盖验收已通过，见
[覆盖证据](../host/contracts/native-overwrite-acceptance.json)；其他根、完整客户端及实机仍待闭合。此软件增量
不代表固定客户端页面或目标板已验收。
当前历史显示名仍按打印 ID 的当前可见路径解析；固定上游的原始文件名
快照语义留在作业契约中核验。源码、故障回归、编译负载和本机存储性能见
[单文件移动验收](../host/contracts/native-single-file-move-acceptance.json)。

含文件目录也可使用同一 `server.files.move`，成功返回 `action=move_dir`
及目录目标／来源；已有目标目录时追加源末级名称，不合并冲突目录，
目标父目录须存在。禁止移入自身／子目录；展开后路径超限返回 400。
目录与每个成员源／目标分别授权，全部成员 ID 同步准入；活动／暂停或
未确认停止的任一成员阻止整个移动，其他目录仍可在打印期间整理。
授权等待期间新增／变更成员拒绝旧请求，不能暗中带走未批准的文件。

私有 `.namespace-move.json`（最多 48 MiB）记录多回执及目录索引的
耐久决定。意图发布前取消保留旧路径；发布后继续完成整个操作。失败
返回 500 和 `error.data.phase=before-intent` 或 `intent-published`；后者
须恢复，不能当作未提交直接重试。重开先验证完整来源、旧／新回执、
目录及全部内容引用，再完成同一决定；验证失败保留证据及临时文件。
磁盘不足或 IO 故障也可能阻止恢复，此时保留意图且拒绝启动。

事务期间缓存列表返回完整旧命名空间，耐久完成后一次切换并发送一条
`move_dir` 通知；下载／打印准入仍通过事务屏障。新旧成员元数据和预览
随提交更新，已封存读取快照保持原字节。现有文件、目录及容量限额保留，
预留意图和暂存回执／索引容量；实际断电、万文件耐久事务、固定客户端
及目标板性能仍待验。来源与软件证据见
[目录移动验收](../host/contracts/native-directory-move-acceptance.json)。

`POST /server/files/copy` 和 RPC `server.files.copy` 使用同一命名空间，
参数为 `source`／`dest`，均采用 `gcodes/相对路径`。文件复制到已有目录
时追加源末级名称；新文件返回 `create_file`，覆盖文件返回 `modify_file`。
目录复制要求目标尚不存在，保留空子目录并创建缺失祖先，返回 `create_dir`；
禁止复制到自身／子目录。复制生成新 ID，内容摘要和源保持不变，更新时间
保留；通知无 `source_item`。覆盖后旧目标元数据／预览撤销，封存读取快照
保持原字节。源、解析后目标、全部成员、新目录及覆盖目标分别授权。

活动源允许复制，活动／暂停目标或维护保护返回 403；晚到旧代际请求
返回 503。确认物理停止及完整清理后的离线复制使用同一进程文件所有者，
尚未确认时拒绝。私有 `.namespace-copy.json`（最多 48 MiB）
在修改回执前封存决定，预留日志、回执及目录索引容量；失败返回 500 和
`error.data.phase=before-intent`／`intent-published`。后者要求验证完整内容、
来源与成员后恢复同一决定，不能直接重试。事务期间列表保持完整旧快照，
完成后一次切换并发布通知。软件回归、同包并发打印和本机 ext 性能见
[复制验收](../host/contracts/native-copy-acceptance.json)，不代替客户端、
目标板／旧 Python 对照、物理断电或完整 Moonraker 验收。

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

停止读回在每个 MCU 确认 trsync 停止后，通过同一受控队列读取一次
`get_uptime` 的完整整数时刻，再读取限位和步进位置。生产者保持排他，
已停止计数在该时刻与后续读回之间不变；不以可回退的主机时钟估计
证明触发顺序。共享 MCU 的独立限位串行占用 uptime 响应路由。
未来触发、实际时刻倒退／溢出、断连和超时均拒绝，不钳制映射时刻。
软件反例、原性能预算和独立编译负载见
[时钟读回验收](../host/contracts/homing-clock-observation-acceptance.json)；
不代表远程间歇故障已关闭或目标硬件精度已验收。

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

## 多 Z 机械校准

Cartesian／CoreXY 机器配置至少两个独立 Z 电机和 [probe]／[bltouch] 后，
可使用 [z_tilt]。z_positions 按 stepper_z、stepper_z1、stepper_z2 等数字
顺序列出各电机 XY 支点；points 是至少两个喷嘴 XY 探测点。共线测量
仅允许可观测的相对电机方向。不得与 [bed_tilt] 同时配置。

可配置 speed（默认 50 mm/s）、horizontal_move_z（默认 5 mm）、retries
（0..30，默认 0）、retry_tolerance（0..1 mm，默认 0）。原生新增
max_adjust（每轮最大相对电机调整量，默认 5 mm，必须大于 0）；各轮
仍受 Z 行程限制。抬升／调整速度使用探针 lift_speed。点位、支点数量、
探针偏移与几何在启动时校验。配置不授予归零权限。

归零并保持空闲后 GET `/printer/calibration/z_tilt`，再 POST
`{"version":1,"state_token":"返回的令牌"}`。接口要求鉴权及维护独占，
不接受客户端脚本、点位或电机参数；完成请求的重复提交返回同一结果，
不再次移动。成功后同步 G-code 坐标，结果包含 passes、samples、
measured_range、tolerance_satisfied、adjustments、final_z 和 persisted=false。
measured_range 是最后一轮调整前的测量范围；retries=0 只执行一轮，
不能把成功等同于达到容差。接口总期限为 120 秒，超时或失败需重新初始化。

`/printer/objects/query?z_tilt` 返回 applied；释放电机或故障停机清除此
标志。机械调整清除旧网床补偿，需要重新测量网床。每段仍按实际步距
量化，不能保证整个调整误差小于半步；模拟验收不证明真实床面精度。

## 四 Z 龙门校准

[quad_gantry_level] 使用四个独立 Z 电机，按 stepper_z、stepper_z1 等
数字顺序对应前左、后左、后右、前右。gantry_corners 指定前左和后右
两个龙门支点 XY；points 按相同顺序指定四个喷嘴探测点，前后两排
各自必须等 Y，左右和前后不能重合或倒序。拟合会应用探针偏移。
该配置要求 [probe]／[bltouch]，不支持 CoreXZ，也不能与 [z_tilt]
或 [bed_tilt] 同时启用。

speed 默认 50 mm/s，horizontal_move_z 默认 5 mm，retries 默认 0，
retry_tolerance 默认 0 mm；重试范围与多 Z 校准一致。max_adjust 默认
4 mm，限制每轮实际相对电机行程（最大修正减最小修正），比旧 Python
仅检查最大正修正更严格。行程、探测点位和几何在启动时检查。

归零并保持空闲后 GET `/printer/calibration/quad_gantry_level`，再 POST
`{"version":1,"state_token":"返回的令牌"}`。鉴权、维护锁、重复请求、
120 秒期限、失败重初始化及返回字段与多 Z 校准相同。对象查询
`/printer/objects/query?quad_gantry_level` 返回 applied。此标志表示本
运行代次完成了流程；不等于调整后的床面已重新测量或真机验收通过。
校准清除旧网床补偿，电机关闭会清除 applied；逐段步距量化限制仍适用。

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

### 空闲 Z 偏移调整

GET/POST `/printer/calibration/z_offset` 提供无需任意 G-code 的校准操作。
GET 返回当前 z_offset、命令位置、行程边界、available 和 state_token。
POST 传 `{version: 1, state_token, adjust: -0.025}`；adjust 单位为毫米，
必须非零且绝对值不超过 0.1，每次移动速度固定为 5 mm/s。

仅允许已归零且空闲或打印完成的机器。请求获得维护独占后，通过同一
G-code 调度器排空运动，执行 SET_GCODE_OFFSET 的 Z_ADJUST/MOVE 语义，
再等待运动排空才返回。只改变 Z 偏移及 Z 位置，保持逻辑 G-code 位置和
挤出状态；网床/倾斜补偿与最终运动约束仍由原生运动端口执行。

状态令牌绑定坐标偏移版本、命令位置和打印状态代次；相同请求的最近
回执可重取，不再次移动。其他运动或偏移变化后不能重放旧请求。
调整不自动保存；有独立 Z 限位的机器可使用下述配置保存接口。
取消、执行失败或 30 秒超时会关闭运动准入并请求停机，需要重新初始化
及归零。关闭服务会取消并等待进行中的调整完成回收。

打印中及暂停中拒绝调整。暂停保留的轨迹和恢复位置尚无同步重定位协议，
因此本接口不提供在线首层微调；该能力仍属于后续迁移范围。
[调整验收](../host/contracts/z-adjustment-acceptance.json)覆盖编译产品的
打印后调整、重复请求、保存和重初始化，以及并发打印负载指标。

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

## 温控风扇设置

原生配置支持 `[temperature_fan chamber]` 的 `watermark` 或 `pid`
控制，必须配置 `min_temp`、`max_temp`、输出 `pin` 和温度源。
`target_temp` 默认不高于 40°C，`min_speed` 默认 0.3，`max_speed`
默认 1；最小速度不得大于最大速度。目标不大于零时关闭控制输出。
输出仍受 `max_power`、`off_below` 和启动加速设置约束。

鉴权后 GET `/printer/settings/temperature_fan` 列出风扇设置；加上
`name=temperature_fan%20chamber` 查询单项。POST 传完整配置节名 `name`、
`version: 1`、GET 返回的 `state_token`，以及 `target`、`min_speed`、
`max_speed` 中至少一项。数值整组校验，省略字段保留原值。响应中的
`applies_to: next_temperature_sample` 表示控制设置已接受，输出在下一次
有效采样后调度，不代表引脚已经改变；通过对象查询观察温度、目标和速度。

最近一次相同令牌与相同请求可重试并取得原回执；更旧请求、冲突重试、
重载前令牌均拒绝。其他修改即使改回原值，也会使旧令牌失效。
维护及停止期间拒绝修改。设置不持久化，重载恢复配置文件值。
目前 ADC 跨 MCU、主机文件和 HTTP 流程通过模拟验收；ADC 与 MAX6675
水印风扇也通过编译产品并发打印负载、重载和故障停机验收。
其他 SPI 型号风扇组合及真机验收仍待完成，不能将模拟输出包当作实际
引脚、风量或冷却效果的证明。

### 歪斜补偿产品操作

配置声明 `[skew_correction]`；具名节 `[skew_correction 名称]` 必须
包含有限的 `xy_skew`、`xz_skew`、`yz_skew`。存储配置不会自动启用。

鉴权 GET `/printer/settings/skew` 返回当前系数、配置名称和状态令牌。
POST 传 `version:1`、`state_token`，以及以下操作之一：

- `action:load` 与 `profile`：加载存储系数。
- `action:measure` 与 `measurements`：完整指定 `xy`、`xz`、`yz`，
  每项为 `[AC,BD,AD]` 测量长度，或 `null` 表示关闭该平面。
- `action:clear`：清除活动补偿。

操作只在空闲时接收，排空旧运动后同步 G-code 坐标；暂停期间拒绝修改。
重复成功请求使用原令牌和相同参数可取得原回执，不重复应用。
运行时设置不持久化，服务重建后归零。

持久化使用 GET `/printer/configuration/skew` 获取独立令牌，再 POST
`version:1`、`state_token`、`action:save` 和 `profile`。保存服务端
当前系数，不接受客户端系数；成功后需重新初始化再加载该配置。
`action:remove` 仅删除自动保存区域的配置，普通配置或 include 中
仍有同名节时拒绝。文件外部修改导致保存失败，不覆盖外部变更。
保存成功或失败后当前服务均要求重新初始化。HTTP 保存、服务重建、
精确读回和删除流程已有模拟硬件验收；真实打印机验收尚未完成。

### 探针辅助调平螺丝

`[screws_tilt_adjust]` 支持连续编号的 `screw1` 至 `screw99`（至少
三个 XY 点）、对应 `_name`、`screw_thread`、`speed` 和
`horizontal_move_z`。螺纹支持 `CW-M3` 至 `CW-M6` 及对应 `CCW`。
自动模式必须有探针，所有点与抬升高度须在物理行程内。

鉴权 GET `/printer/calibration/screws_tilt` 获取状态令牌；POST 使用
`version:1`、`state_token`，可加 `direction:CW|CCW` 和
`maximum_deviation`（毫米，零表示零容差）。机器必须空闲且 XYZ
已归零，接口采用服务端点位，不接收客户端运动坐标。

返回 `result` 包含 `base`（从零开始的基准点索引）、`names`、
`samples`、`thread` 和各点 `results`。`sign` 是旋钮方向，`adjust`
以完整圈数和分钟表示，60 分钟为一圈；`turns` 保留未格式化圈数。
偏差超过阈值时 `error:true`，应按建议调整并以新令牌重新测量。
相同成功请求重试只返回原回执，不重新移动。测量不会自动调电机或
修改床面补偿；探测失败或取消要求重新初始化后再操作。

无探针配置可使用 `/printer/calibration/screws_tilt/manual`。GET 获取
状态，POST 带 `version:1`、`state_token` 和 `action`；先 `start`，
再以 `adjust` 加 `delta`（相对 Z 毫米值）或 `bisect_up/down` 调整，
接触确认用 `accept`。每次使用最新令牌，全部点确认后返回调整建议。
start 可带 direction:CW|CCW 和 maximum_deviation，参数固定至会话
结束；省略旋向时使用第一螺丝基准，零阈值表示零容差。中途不可改参。
`cancel` 或交互超时会停止并要求重新初始化。配置无探针时不注册
自动探测接口；手动流程不自动修改补偿或保存配置。

已配置螺丝校准的服务还发布 `screws_tilt_adjust` 对象。通过
`/printer/objects/query?screws_tilt_adjust` 查询 `state`、`error`、
`max_deviation` 和按 `screw1` 等编号组织的 `results`。新测量开始
立即清除上一轮建议；失败或取消返回 failed 且无结果。服务重建从
idle 开始，不将上一次服务的建议当作当前测量。

### 床面螺丝粗调与精调

`[bed_screws]` 配置至少三个连续编号的 `screw1` 等 XY 坐标，可加
`_name` 和 `_fine_adjust` 精调坐标。`horizontal_move_z` 为横移安全
高度，`probe_height` 为手动调整时喷嘴高度；前者必须高于后者，所有
点位和高度须在物理行程内。`speed` 控制横移，`probe_speed` 控制升降。

鉴权 GET `/printer/calibration/bed_screws` 获取令牌。POST 使用
`version:1`、`state_token` 与 `action`：`start` 开始，`accept`
确认无需显著调整，`adjusted` 表示本点做过显著调整并要求重新确认
其他点，`cancel` 停止。粗调完成后自动进入已配置的精调点。
会话要求空闲且 XYZ 已归零，并在等待用户期间独占运动；同一成功
请求重试不移动。完成后抬升喷嘴，取消、超时或失败要求重新初始化。
这是一项用户手动旋转螺丝的引导，不会自动调整电机或保存补偿。

## 服务启动前的编译包校验

重新生成的 systemd 单元使用 ExecStartPre，在加载机器模块前检查编译包
清单 SHA-256 和运行时 ABI；失败时 systemd 不执行主入口。可单独运行：

```sh
node --no-experimental-strip-types scripts/product-service-unit.js --verify-bundle /opt/anyraid/product-host
```

该命令不导入机器配置、不打开硬件。已有服务单元须重新生成并按部署
流程安装后才包含此检查；直接运行 product-host 不会自动执行它。
清单用于本地产物完整性校验，不是签名认证；部署期间仍须避免在校验
和启动之间修改文件。默认 Python 服务尚未切换。

## 原生 API Key 授权组件（初步接入）

配置服务可用 `ConfiguredMoonraker.loadAuthorized(configPath, options)`
自动装配本地授权；options 提供已打开的 database、真实 information 和
`authorization: {issuer: 'http://打印机主机名:7125'}`。此入口自动创建授权
所有者、注册接口与事件，并读取配置文件（含 include）的下列策略：

```ini
[authorization]
login_timeout: 90
force_logins: false
enable_api_key: true
max_login_attempts: 5
default_source: moonraker
```

省略 max_login_attempts 表示不限失败次数。稳定 issuer 由产品配置提供，
不会从临时监听端口推导。未知 default_source 警告后回退到 moonraker；
trusted_clients 已支持显式数字 IP／CIDR；cors_domains 支持下述受限模式。
LDAP、域名信任和其他尚未实现的授权规则会在装配前明确报错。此入口不能同时传入外部入站、通知或订阅鉴权回调。

loadAuthorized 不监听；成功后调用 server.start()。首次凭据可从本地
`server.authorization.localApiKey()` 获取，不能写入日志。装配构造完成后，
服务持有数据库及授权组件；授权初始化或监听失败会清理它们，调用者需
重新打开数据库后重试。配置校验失败发生在所有权转移前。正常关闭先等待
网络与授权工作结束，再关闭数据库，无需手工关闭授权组件。
`loadNativeProductMachineProfile` 的机器适配器现可在 server 中提供
`database` 与 `authorization: {issuer}`，产品服务会自动采用此入口。
此模式不传 authorize、authorizeNotification 或 authorizeSubscriptionConnection；
与外部授权回调混用会拒绝。策略在产品装配及 MCU 连接前检查，关闭后的
数据库不能复用；每个服务代际须重新打开数据库。适配器 release 应幂等
关闭数据库，覆盖尚未转移给服务的失败路径；适配器工厂自身的部分获取
失败仍由工厂负责清理。物理停止、文件准入及输出生命周期仍必须提供。
首次身份应通过可信本地配置流程预置；不得公开 API Key 或增加未鉴权的
远程初始化入口。这不是默认部署切换或实机验收。

原生授权沿用固定 Moonraker 的图片 GET 非必需鉴权语义：当前有效的
托管 PNG／JPG 缩略图可由浏览器无令牌读取，force_logins 不阻止图片显示。
提供错误凭据仍拒绝；签名有效但过期的 access JWT 在此图片 GET 路径
允许读取，退出／删除身份后的 JWT 仍拒绝。匿名调用仍须通过当前元数据
及源文件绑定检查，源已删除返回 404；UUID 不授予 G-code 访问权限。
HEAD、普通文件下载、元数据、修改、RPC 和通知保持原鉴权；外部自定义
鉴权回调继续决定是否允许。此软件契约及并发打印验证见
[目录文件验收](../host/contracts/native-file-namespace-acceptance.json)，
两套实际客户端同包完整流程仍待完成。

`host/test/product-native-authorization.test.ts` 验证原生产品的策略拒绝、
混合回调拒绝、数据库清理，以及模拟 MCU 服务两次启动间的用户登录、
JWT 状态访问与退出撤销。41 项相关回归通过。Node 26.9.0 桌面启动基准
（3 次预热、11 次保留样本）中，
显式服务／产品管理服务／原生授权服务中位数为 413.629／414.277／417.451 ms，
P95 为 417.253／417.933／427.444 ms。原生授权包括首次身份持久化，
不含数据库打开；该列是观测数据，既有门限只比较前两列且已通过。
该测试不含打印、并发 API 或物理硬件，不能推导打印速度结论。

独立编译产品另已通过原生授权空载、原生授权负载及回调授权负载三种
模拟 MCU 场景，覆盖登录、上传／元数据、加热打印、缺料暂停／恢复、
取消、历史、服务重载和 ADC 故障停止。原生授权场景进一步验证进程
退出后重启，身份、文件与历史保留；故障作业保持 interrupted，拒绝直接
恢复且不重放运动，人工取消后退出登录撤销 JWT。首次凭据在测试父进程
本地预置，产品子进程只加载编译 JavaScript 和独立安装的生产依赖。

并发负载含状态、历史与目录查询、16 次 256 KiB 文件上传及对应下载、
元数据、缩略图和删除，另校验 WebSocket 通知。原生授权状态查询 P99
为 4.449 ms，回调授权对照为 2.692 ms；三组最小步进提前量为
86.802／86.446／85.988 ms，均大于零，事件循环既有门限通过。
每种场景仅一条完整观测，打印耗时含测试调度与暂停；不是 Python 对照
或目标板速度证明。证据、产物清单哈希与复现命令见
[编译产品授权验收](../host/contracts/product-native-authorization-acceptance.json)。
测试使用模拟板卡与空物理输出适配器，真实前端客户端及实机仍待验收。

需要已有外部组件所有者时，可继续使用以下手工接入方式。

机器适配器可用 `ApiKeyAuthorization` 替代固定测试密钥回调。组件通过
已有 DatabaseStore Worker 持久化随机密钥，使用禁止公开访问的
`native_authorization` 命名空间；需保证一个数据库只有一个活动授权
所有者。创建顺序为：打开数据库 → `ApiKeyAuthorization.open(database)`
→ 将 `auth.networkOptions` 传给 ConfiguredMoonraker →
`auth.register(server.endpoints, server)` → 启动服务。第二个参数接通授权
事件广播；省略它仅注册接口。关闭时先等待网络请求退场，
再关闭授权所有者和数据库；如果数据库由配置服务持有，不重复转移所有权。

`localApiKey()` 仅供本地配置凭据，不写入日志或诊断报告。实际客户端
使用 X-Api-Key；WebSocket 可在 server.connection.identify 中提交 api_key。
GET／POST /access/api_key 分别读取和轮换密钥，均要求已认证身份。
轮换持久化完成后使旧密钥及旧 WebSocket 认证失效；写入失败使授权关闭，
损坏数据不会静默重置。

启用本地用户时使用
`ApiKeyAuthorization.open(database, {issuer: 'http://打印机主机名:7125'})`，
issuer 必须为完整 HTTP(S) origin，跨重启保持一致；不要使用示例地址上线。
可选 loginTimeoutDays 默认为 90，forceLogins 默认为 false。手工接入时
直接传这些参数；配置文件绑定使用上面的 loadAuthorized。未显式配置
trusted_clients 时，forceLogins=false 也不授予匿名访问；未传用户选项
时保持仅 API Key 模式。

可选 maxLoginAttempts 为正整数，默认不限制失败次数；配置后按真实连接
地址累计登录失败，同一地址的并发登录串行判断。达到阈值前成功登录会
清零，达到阈值后须重启服务才清零，与固定上游的内存计数一致。取消请求
不计入失败。最多保留 4096 个地址、32 个待处理登录，超限返回 429；
不通过淘汰失败记录绕过阈值。当前忽略 X-Forwarded-For 等转发地址，
代理后多个客户端会共用代理地址计数，可信代理策略仍待接入。
enableApiKey 默认为 true，设为 false 禁用 API Key 网络准入；关闭前须
已有可用的本地用户，不能把仍可读取的本地密钥当作网络准入已启用。

启用后支持 /access/user 的创建、查询与删除，/access/users/list、
/access/login、/access/logout、/access/refresh_jwt 和 /access/user/password。
首次创建用户需要本地配置的 API Key，后续可用已认证用户。用户数据存入
禁止公开访问的 native_users 命名空间，密码使用异步 PBKDF2-SHA256，
JWT 使用 Ed25519 签名，访问令牌有效期一小时。
HTTP 接受 Bearer、X-Access-Token 和 access_token 查询参数；优先使用请求头，
避免令牌出现在 URL 记录。WebSocket 可使用 access.login 或 identify 的
access_token，创建用户不会切换当前连接身份。退出／删除持久化后撤销
该用户令牌和连接授权，重启后仍生效；修改密码按上游语义保留已有令牌。
HTTP 订阅必须与目标 WebSocket 属于同一用户名。

GET /access/oneshot_token 要求已认证身份，返回 20 字节随机值编码的
32 字符 Base32 令牌。通过 URL 的 token 参数使用，按单调时钟在 5 秒
后失效；首次消费即删除，地址不匹配也作废。最多同时保存 1024 个，
超限返回 429。令牌绑定真实连接地址及当前用户／密钥，退出、删除或
密钥轮换后不能再准入。同一 HTTP 请求内的多次授权共享已准入身份，
另一个请求不能重用令牌；WebSocket 在首次授权流量时消费并保持连接身份。
尚不支持表单正文中的 token，也尚未改为升级握手时消费。

当前限定 128 用户、32 个排队写操作、1024 个缓存令牌；用户名上限为
256 字节，非空密码上限为 4096 字节。写入失败使用户授权关闭，需排查
存储后重启。已认证 WebSocket 按固定上游语义保持连接身份，不因访问
令牌过期中断；HTTP 和新连接仍须使用有效令牌。刷新接口返回新令牌，
不切换已建立连接的身份。退出、删除和重新认证失败仍会撤销相应连接权限。

配置事件广播后，用户创建、删除和退出分别发出 notify_user_created、
notify_user_deleted、notify_user_logged_out，参数为包含 username 的单项
数组。仅已提交的变更才发事件，并等待响应交接后发布；请求在持久化
期间断开也不抹去已提交事件。被撤销的会话可收到对应的退出／删除事件，
不能继续接收普通状态通知。待处理事件上限 128；eventStatus 提供待处理、
已发布及送达／拒绝／失败等计数。事件不做持久重放，断线重连须重新查询。

LDAP、域名信任／代理委托、CORS、完整配置及请求兼容性、上游用户表导入
仍待完成。此组件尚非默认机器部署。
67 项不同测试通过，含独立编译包的配置授权、策略生效及重启；
JWT 缓存验证约 0.205 微秒，首次验签约 111.618 微秒。200 次本机顺序
配置授权入口的 JWT HTTP 状态请求 P99 为 1.465 ms；手工接入路径同轮
为 3.057 ms、WebSocket 为 0.256 ms。样本来自独立顺序运行，不作为
两种入口速度差异的结论。50 次一次性令牌状态请求最大耗时为 0.795 ms，令牌生成加消费约
2.918 微秒。API Key CPU 基准为 1.902 微秒／请求，原初步实现为 1.777 微秒，
均在开发预算内，不据此声称无性能回退。上述结果不代表目标板或并发打印
验收。证据见[授权组件清单](../host/contracts/moonraker-authorization.json)。

## 实际客户端交互验收

手工验收入口为 `host/acceptance/client-probe.ts`，使用 PTY／模拟 MCU、
临时数据库和本地用户，绑定 127.0.0.1，退出删除临时数据，15 分钟自动
停止。探针父进程从源码运行，产品运行于独立编译子进程；这是编译包的
客户端契约验收，不是实机验收。
使用已解压的官方前端发布目录（不从此脚本下载或执行外部命令）：

```sh
node host/acceptance/client-probe.ts /absolute/path/to/frontend 18326
```

打开输出的本地地址；一次性夹具用户信息见脚本中的 bootstrap。夹具启动
时通过原生 API 预置 client-sample.gcode（千段短直线与挤出运动），这不代表
页面上传已验收。探针会构建并独立安装编译包依赖，在禁用 TS 加载和外部
PATH 工具的子进程中运行产品；PTY、限位与温度模拟留在父进程。
限位事件遵循 MCU 时钟，加热器输出 PWM 后 ADC 切换为固定热态值；
这只是软件流程模拟，不是物理升温／冷却模型。现采用 createProcess 工厂，
在所有设备代际保留原模拟 MCU、数据库、文件和历史。RESTART 复用有效
固件配置；FIRMWARE_RESTART 通过产品策略复位原 MCU 并重建配置。ADC 与
加热活动按当前设备所有者观察，普通重启可读取此前保留的传感器配置；
停止确认后暂停模拟输入，下一次实际 ready 才恢复，不清零停止计数。
只能在无物理设备接入的开发环境使用。标准编译产品流程仍使用既有
`product-compiled-journey.test.ts`。

### 固定同一编译包验收

客户端探针与编译打印旅程支持复用已构建、独立安装生产依赖的包。先用
`node host/scripts/build-product-host.ts /absolute/retained-product` 构建，再用
`node /absolute/retained-product/scripts/product-install.js --bundle /absolute/retained-product`
安装生产依赖。在封存时记录身份：

```sh
ANYRAID_ACCEPTANCE_BUNDLE=/absolute/retained-product node --input-type=module -e '
import {inspectAcceptanceBundle} from "./host/test/helpers/acceptance-bundle.ts";
console.log(JSON.stringify(await inspectAcceptanceBundle(process.env.ANYRAID_ACCEPTANCE_BUNDLE)));
'
```

后续每次验收使用封存的两个摘要；不要每次重新计算期望值来接受已改变的包。
三项环境变量必须一起提供：

```sh
export ANYRAID_ACCEPTANCE_BUNDLE=/absolute/retained-product
export ANYRAID_ACCEPTANCE_MANIFEST_SHA256=封存的manifestSha256
export ANYRAID_ACCEPTANCE_DEPENDENCIES_SHA256=封存的dependenciesSha256
export TMPDIR=/absolute/acceptance-temporary-data
node host/acceptance/client-probe.ts /absolute/path/to/frontend 18326
node --test --test-isolation=none --test-concurrency=1 host/acceptance/client-probe.test.ts
node --test --test-isolation=none --test-name-pattern='^namespace=true nativeAuthorization=true apiLoad=true load=false spi=false ' host/acceptance/product-compiled-journey.test.ts
```

TMPDIR 须为已存在、位于包外的测试数据目录；本机约定使用
`/home/dek02/.cache/codex/tmp`。同时校验实际目录，避免符号链接造成
夹具数据和清理路径与保留包重叠。缺变量、摘要不符、Node ABI 不符、
源码依赖链接、锁定版本不符或开发依赖混入均直接拒绝；不会自动重建。
启动及进程退出时重新核验保留包，产品进程和父进程的包／依赖身份分列。
三项变量均未设置时，保留原来的新建包与独立安装流程。

复用校验发生在测试监督进程的启动／退出边界，不加入运动规划、打印、
订阅或文件请求的热路径。该设施减少反复构建，不能把协议验收或模拟
MCU 的负载结果解释成实际页面、目标板或精度验收。验证范围见
[固定包验收记录](../host/contracts/fixed-client-bundle-acceptance.json)。

探针打印 `CLIENT_PARENT` 父进程 PID。仅向已确认属于本轮本地探针的父
进程发送 SIGUSR2 可关闭当前 WebSocket，验证客户端重新连接及订阅；
SIGUSR1 可等待当前产品子进程正常退出后，复用原编译包、持久数据和
原 MCU 模型启动新的产品进程。原身份、文件、历史须保留，不重放作业。
设备 ready 发布和恢复回执完成是两个边界。继续重启或修改配置前，须查询
`/printer/host/status`，确认对应回执为预期终态且 `busy=false`；设备 ready
不能替代转换所有者释放。夹具在原有期限内等待此条件，不重试被拒绝的修改。
这些信号只属于测试监督进程，不是产品 API 或物理 MCU 操作；正常进程
恢复不能作为强杀、断电或实机恢复证据。SIGINT／SIGTERM 结束整轮探针。

历史 Fluidd 1.37.6 验收通过登录、就绪页面和 gcodes 根目录工具启用；原生上传
现接受一次性 token 查询参数，并返回 item/action 及既有不可变文件回执。
HTTP 回归验证上传与重放拒绝；修复后页面上传受文件选择器工具失败影响，
尚未确认。历史 Mainsail 2.19.0 在强制用户授权下停留初始化；未关闭鉴权。
配置根目录仍有缺口，新增原生系统信息接口尚待实际客户端复验，
不能宣称完整客户端兼容。发布包哈希、测试与性能边界见
[客户端验收记录](../host/contracts/fluidd-client-acceptance.json)。

原生产品服务现默认启用 `/server/gcode_store`，记录真实分派器响应，
并通过现有通知鉴权发送 `notify_gcode_response`。条数遵循
`[data_store] gcode_store_size`（默认 1000），字节上限默认 8 MiB，
可由服务所有者的 `gcodeStore.maxBytes` 配置。设条数为 0 关闭历史保留，
不关闭即时通知。查询仍须身份准入；此接口不执行 G-code。
记录仅在当前服务代际内保留，重初始化会清空；跨代保留仍待实现。
验证与开销见[原生控制台验收](../host/contracts/native-gcode-output-acceptance.json)。

原生产品现提供 `GET /printer/gcode/help`／`printer.gcode.help`。返回
已注册且有描述的命令字典，描述只说明当前原生实现支持的范围；例如
未配置舵机时不列出 SET_SERVO。查询不代表命令当前可执行，原有就绪、
运动和授权门槛仍生效，远程任意 G-code 执行接口没有因此开放。
扩展命令可在注册时提供 description，返回的字典修改不会改变分派器。
验证见[命令帮助验收](../host/contracts/native-gcode-help-acceptance.json)。

原生产品默认启用 `/machine/proc_stats`／`machine.proc_stats`。每轮异步
采样完成一秒后启动下一轮，不允许重叠采样；HTTP/JSON-RPC 查询只复制
最近采样，不在每次请求重新读取系统文件。进程 CPU 与内存对应整个
Node 产品进程，包含集成的打印与 Moonraker 工作；百分比允许超过 100。

保留 30 条历史，内存单位 kB，CPU 温度为 °C；不存在或不可读时使用
null／空集合，不伪造正常温度。网络计数器超出 JS 安全整数范围时省略
对应接口，计数器回绕或重置后的带宽从零重新建立基线。CPU 使用 BigInt
差分，避免长期累计值损失精度。单个输入文件限制 1 MiB。

已认证连接接收 `notify_proc_stat_update`。同时检测到 vcgencmd 与
/dev/vcio 时每十轮检查降频，子进程限定一秒和 1 KiB 输出；状态变化
发送 `notify_cpu_throttled`。未检测到设备时状态为 null，读取失败保留
上游的未知标志。该适配尚未进行 Raspberry Pi 实测，不能作为硬件健康
保证。采样关闭会撤销定时器并等待正在进行的读取退出。
证据与未完成契约见[进程统计验收](../host/contracts/native-proc-stats-acceptance.json)。

原生产品提供 `/machine/system_info`／`machine.system_info`。首次异步读取
完成后才监听，之后每十秒刷新，查询返回隔离的缓存快照。CPU、内存、
发行版和 SD 信息来自固定 Linux 文件；可用时调用固定参数的 ip 与
systemd-detect-virt，限定一秒和 1 MiB 输出。配置文本仅解析，不作为
shell 脚本执行。虚拟化检测不可用时明确返回 unknown。

字段 `runtime` 报告 Node 名称与版本，不伪造旧 `python` 运行时字段。
原生产品进程默认接入只读服务采样：每两秒以固定 argv 调用 systemctl，
每个命令限定一秒和 1 MiB，最多 64 个允许单元。成功查询报告
`provider: systemd_cli`；不可用时保留完整上次结果，首次不可用如实报告
`none`。HTTP／RPC 查询只读缓存，不启动子进程。初次和重复结果不通知，
变化后发送逐服务 `notify_service_state_changed`，沿用真实通知鉴权和容量限制。
关闭取消并等待在途查询；设备代次重建保留服务所有者及缓存。

默认范围为 klipper／moonraker 完整匹配的数字实例、anyraid-node-product-host
及内核 cgroup 确认的当前进程单元；可信进程选项 `systemServices.allowedUnits`
可追加显式单元，不接受请求参数扩大范围。当前拒绝别名单元重映射。
原生 Klipper 与 Moonraker 共用进程时，两个 instance_ids 都来自实际共用单元；
未知实例仍为空字符串，不能推测为已安装的独立服务。采用外部 Klippy 的
独立实例识别、moonraker.asvc 的受控安装兼容仍待接入。

这是服务状态出口；系统控制候选的显式接入见下节，权限配置、安装验证与回滚
仍待完成。已有产品 RESTART／FIRMWARE_RESTART 是设备代次操作，不能
冒充系统单元重启。系统单元自重启必须接通真实停止与响应交接后才准入。
网络变化在后续
有效采样检测到变化时，通过实际授权分发发送 `notify_net_state_changed`，
载荷为完整网络快照；初始采样不通知。只记录 UP 接口，读取失败或损坏
保留最后有效网络／CAN 状态；有效空结果才清空网络。观察器失败不回滚
已提交快照，关闭等待已取得的工作退出。设备重建保留进程采样所有者，
查询继续读取缓存而不执行系统命令。其他发行版数据源回退及目标 SD/CAN 硬件验证仍待完成。详情与性能见
[系统信息验收](../host/contracts/native-system-information-acceptance.json)。
服务状态增量、失败门禁与各项测量见
[服务状态验收](../host/contracts/native-service-state-acceptance.json)。

### 原生系统控制候选

可信 `createProcess` 可显式返回 `machineControl: new LinuxMachineControl(...)`，
选项为实际 `ownUnit`、`allowedUnits` 和其中持有设备的 `deviceUnits`。
单位必须使用规范 `.service` 名称；最多 64 个，请求不能增加范围。
只读 `systemServices` 不创建此权限。包装工厂须转发 `machineControl`
getter 与 `close`，退出取消并等待子进程回收。当前没有目标机型安装配置，
不能从历史包推测本机单位、权限或硬件归属。

授权 HTTP POST／WebSocket RPC 支持以下标准端点：

| 端点 | 参数 | 语义 |
| --- | --- | --- |
| `/machine/services/start`、`stop`、`restart` | 仅 `{service: "crowsnest"}` 形式的无后缀允许名 | 当前进程自己的单元仅支持 restart；其他允许单元支持三种动作 |
| `/server/restart` | 无参数 | 重启真实当前进程单元 |
| `/machine/reboot`、`/machine/shutdown` | 无参数 | 请求系统重启／关机；容器中拒绝 |

响应 `"ok"` 只表示 durable queued 回执已受理，不代表目标服务已达到状态。
同一进程的 `/printer/host/status` 返回 `machine_control.available_kinds`
及每类最新 `operations`；可按 `request_id` 查询回执。响应未交接则不执行，
queued 冲突；只有同代际、同动作、同服务的 running 请求合并为原操作。
无显式能力返回 503，范围拒绝 403；忙碌或身份／单位条件不满足拒绝。
异步命令失败保留 failed 回执与可查询服务，不隐式重试。

每次 OS 请求重验内核 cgroup 身份、规范单位及 loaded 状态。固定
systemctl 参数无 shell、sudo、交互授权或任意脚本；两秒／64 KiB 上限。
使用 `--no-block`，仅确认作业提交且等待命令子进程 close。外部无设备服务
可与打印并行；设备单位、自己重启与电源动作先同步撤销生产者，完成旧代
真实停止及所有清理后才提交 OS 命令。停止失败没有 OS 副作用。
提交后保留退役 API；显式 RESTART 接入前验证允许的其他设备单位
inactive／failed 且 MainPID=0，不把 stop 作业受理当停止证明。
这些检查不提供对任意外部启动者的全局排他锁。

候选日志 v4 增加六类各 64 条独立回执（总计 640）；服务身份为不可变字段。
一个共享 pending 槽；只淘汰同类终态记录，淘汰与准入同事务提交。
SIGKILL 或重开后的 queued／running 变 interrupted，不重新执行 OS 动作。
持久写入采用独占 worker、WAL／EXTRA（3），每次提交同步日志后才确认，
不使用 NORMAL／OFF。身份和完整性在改变持久日志模式前验证。
主数据库仍限制 1 MiB；自动检查点按实际页尺寸换算为 256 KiB 页帧，
日志重用限制为 256 KiB。这两项是检查点／重用阈值，单个事务可能暂时
超过，不能称作硬空间配额。4 KiB／64 KiB 页尺寸、满容量最大字段及
600 次滚动提交各自验证 WAL 低于 2 MiB；目标存储仍须验证。
正常关闭后的主文件备份已验证；未正常退出时，必须在进程退出后完整
保存主文件与存在的 `-wal`，不得丢弃日志或复制运行中的主文件。
回退旧 schema 软件须使用升级前完整停机备份，不能直接把 v4 日志交给
旧版本；目标环境的实际回滚仍待验收。
高频计数只在耐久提交确认后更新，状态查询不扫描全部历史。

目前已有软件停止／权限拒绝／子进程回收／崩溃回执证据；模拟 OS 命令不算
实际 systemd 安装或目标板验收。WAL 编译包的桌面持久准入和默认混合场景
已通过原门槛，原失败保留；旧头完整 CI 的 Delta 终态坐标断言仍未解释。完整检查、
目标权限安装、停止后的日志副本及恢复旧包回滚仍待完成。候选不得切换默认
Python 入口。源码、产物、成功与失败指纹见
[系统控制验收](../host/contracts/native-machine-control-acceptance.json)。

交互夹具收到某 MCU 的停止确认后，不再向它的 PTY 发送 ADC 数据。
准备阶段取消可能使设备需要重新初始化；状态应如实保留，不为了通过
UI 测试清除停止状态。夹具取消后的可用性回归可执行：

```sh
node --test --test-isolation=none host/acceptance/client-probe.test.ts
```

该回归使用临时静态页面和模拟 MCU，验证同包打印、暂停恢复、完成、
原生受控重新初始化、普通重启后的完整加热打印、固件重启、原 WebSocket
与身份持续有效、原 MCU 的复位／配置次数，以及准备阶段取消后 15 秒
接口存活及清理。新增连接中断和独立产品进程重启验证：原 JWT、文件与
完整历史保持，新进程不重放打印，原 MCU 配置不被伪造重建；history
组件发现亦跨代保留。两种授权模式的编译回归均通过；加上配置服务与
历史接口的相关检查，本批为 19 个用例，不代表完整客户端或迁移完成率。
IPC 通道在无工作时不保持子进程存活；退出超时会停止本轮测试子进程。
上一生产包清单指纹为 `d33afd9f44f421dace822d0edc2f984d9ab9e0c180677c0a67668a5d96269683`。
Fluidd 1.37.6 与 Mainsail 2.19.0 实际页面均验证预置作业的打印、暂停、
刷新后恢复、取消、标准 RESTART／FIRMWARE_RESTART 自动就绪及文件保留。
Fluidd 查询到完成／取消的持久历史和两种成功回执；Mainsail 另验证普通
重启后再次加热打印到 Complete。三代原 MCU 的复位次数为 0／0／1，
配置完成次数为 1／1／2；没有以新模拟器冒充复位。

文件仍由 API 预置；页面文件选择器已能建立，但 setFiles 未完成，日志中
没有页面上传请求，相关服务按 15 分钟期限正常退出。这属于工具阻塞，
不证明上传端点失败，也不计作页面上传通过。当时的配置根目录、准备阶段控制
显示及其他外围差异仍记录为未完成；实际页面完整历史／断连与进程恢复、
页面上传和实机验收仍待完成，A4 不封存。当前记录位于
[客户端验收记录](../host/contracts/fluidd-client-acceptance.json)。

上一 history 发现修正批次的生产包清单指纹为
`e4d0e9198f2fd227f7f4e17511b57ae7a8a65fe71d1984f1cac36bef12b277f3`。
`server.info.components` 按实际原生或旧后端 history 注册声明组件；没有
注册则不声明，避免历史接口存在而客户端隐藏入口。Fluidd 1.37.6 当前
包实际历史页已显示完成作业及统计；尚未重复验证其余完整页面路径。
当前包另通过一次授权／上传／订阅／历史并发模拟打印：状态查询 P99
3.487 ms，历史查询 P99 9.606 ms，最小步进提前量 79.261 ms。前两项是
观测值；现有桌面硬判据包含步进提前量大于零、事件循环 P99 小于 50 ms
及最大延迟小于 100 ms，不作为目标板时序预算或旧／新整机性能对照。
证据读取 `historyDiscoveryProcessAcceptance`，A4 仍未封存。

### 显式数字地址信任与 Mainsail 联调

原生授权支持 trusted_clients 中的 IPv4、IPv6 和 CIDR，手工装配对应
trustedClients 数组。默认列表为空，没有内置信任网段。CIDR 必须是网络
地址；带主机位的网段、无效地址、域名及区域标识会明确拒绝。IPv4 映射
IPv6 地址可匹配对应 IPv4 规则。最多支持 1024 条配置，运行时不进行 DNS。

匹配真实 socket 地址且未提供错误凭据时，请求可取得 _TRUSTED_USER_
身份。force_logins=true 且至少存在一个本地用户时禁用此准入；已有可信
WebSocket 和一次性令牌再次使用时也重新检查。access.info.trusted 报告
地址规则是否匹配，login_required 单独报告强制登录状态。

当前没有实现代理委托；带 Forwarded、X-Forwarded-For 或 X-Real-IP 的
请求不能单凭网络信任获得权限，仍可使用有效 JWT／API Key。不得在
公共代理后仅配置代理的地址并据此声称支持可信代理。域名、CORS 与完整
上游代理语义继续保留迁移待办。

Mainsail 2.19.0 固定版本初始化不发送登录凭据。仅用于隔离本机模拟
设备的验收可以运行以下入口，选项只写入本轮临时配置，监听地址仍为
127.0.0.1，不改变任何现有服务：

~~~sh
node host/acceptance/client-probe.ts /absolute/path/to/mainsail 18334 --trusted-loopback
~~~

历史检查曾停在 server.webcams.list；该组件现已实现，当前固定客户端
已能进入 Standby 和作业页面。页面上传等未完成项仍阻止完整流程声明。
默认探针仍
使用凭据模式，Fluidd 的登录验收入口不变。


## 元数据 Worker 的关闭确认候选

扫描超时立即拒绝请求、取消全部已准入工作并封闭实例，原扫描期限不变。
`close()` 保留同一 Promise，已转移句柄的请求记录须等 Worker 回执确认
`source.close()` 完成后才释放。关闭消息按原串行队列处理，覆盖尚未开始
解析的源文件；正常关闭宽限为一秒，其后尝试强制终止。宽限不是扫描
期限的扩展，也不是原生线程终止的总时间保证。若仍缺关闭回执，`close()`
明确失败，不把 Worker 退出当成源文件释放证明，不用原始 fd 号盲目关闭。

必要对照可设置 `ANYRAID_METADATA_BASELINE` 为原实现仓库的绝对路径后，
运行 `node host/bench/metadata-worker-close.ts`。基准核验原源码摘要，沿用
原四种字节输入、5 次预热与 11 次保留样本，检查字段一致性；桌面对照
不替代目标板或混合打印性能。原远程句柄泄漏尚未本机复现，来源、回归、
编译包及性能样本见[清理验收](../host/contracts/metadata-worker-close-acceptance.json)。

## 原生 Moonraker 跨域访问配置

在上述原生授权入口的 `[authorization]` 中配置浏览器来源：

```ini
cors_domains:
  https://fluidd.example.com
  https://*.example.com
```

配置只允许浏览器跨域读取和 WebSocket 升级，API Key／JWT、接口与
通知授权仍独立执行；CORS 通配符不会授予打印权限。预检允许 Authorization、
X-Api-Key 和 X-Access-Token。允许来源的鉴权错误携带 CORS 响应头；
未允许来源拒绝，默认无 Origin 的既有客户端行为沿用。

沿用固定上游的点／星号转换、完整首匹配、顶级域通配符和末尾斜杠
警告后忽略规则；有有效模式时支持已有数字 trusted_clients 的 IP 回退，
不会解析域名或扩大信任。保留现有网络边界，只接受规范 HTTP(S) Origin。
最多 128 个模式，每项最多 1024 字符；匹配使用锁定的 re2-wasm 1.0.2。
Python 特有的反向引用、前后查找等不受支持，装配时拒绝，不静默转换。
这项限制是当前兼容差额，不能宣称全部 Python 正则兼容。

`npm run bench:moonraker-cors-policy` 计量原大小与满容量规则；
编译包混合打印验收可设置 `ANYRAID_BENCH_CORS_ORIGIN=https://fluidd.example.com`，
沿用全部原负载、运动精度与性能判据。实际 Fluidd／Mainsail 页面、目标板
和物理打印仍须单独验收，不以 HTTP 协议测试替代。

语义来源为[固定 Moonraker 授权源码](https://github.com/Arksine/moonraker/blob/1cfb0c41e468645951a371621f06d32777b6107c/moonraker/components/authorization.py)；
匹配引擎与正则限制见[RE2 WASM 项目](https://github.com/google/re2-wasm)。

组合上传候选在 `6dd2ec15` 基线上通过 123 项相关回归及独立编译
12 项关键检查；额外装配网关的 `f76efc7d` 固定包已实际验证
Mainsail 2.19.0 文件选择、显式启动、单作业完成和历史，预览解码
32×32。该页面包包含尚未集成的候选，不能转记为 develop 或实机
通过；完整客户端、目标性能和 G3 仍待验。详细边界保留于
[组合上传验收契约](../host/contracts/upload-print-intent-acceptance.json)。

### 受保护的官方 Mainsail 接入候选

固定官方 Mainsail 2.19.0 的连接初始化不提交本项目的原生用户凭据。
可选的 `product-client` 入口提供产品登录页，复用原生 Moonraker 用户及
JWT 授权，不新增打印、文件、历史或运动所有者。默认入口仍为 Python。
登录成功后打开 `/_client/control`，其 iframe 在 `/` 加载原版 Mainsail；
官方导航路径返回相同的安装版 index，避免子路径出现空白页面。
登录、退出、API 和控制台导航始终访问网络；官方 Service Worker 原字节
由边界包装器加载，不能以缓存前端页面替代会话或 API 响应。

编译包包含 `scripts/product-client.js`。它作为独立的受监督进程运行，
只监听 127.0.0.1，并要求显式固定的私有原生 Moonraker 回环监听地址：

```sh
node /installed/product/scripts/product-client.js \
  --origin https://printer.example.com \
  --upstream http://127.0.0.1:7125 \
  --assets /installed/mainsail-2.19.0 --port 8080
```

外部 HTTPS 由现有 TLS 代理提供，保留准确的 Host；代理应将该站点的
全部 HTTP／WebSocket 路径转发至此入口，并支持 Upgrade。原生监听器
保持私有、启用本项目原生用户授权；禁止把打印文件／配置可写目录用作
`--assets`。前端资源须来自受信安装目录。本候选未自动安装 systemd、
TLS 或权限规则，不构成生产安装验收。仅本机开发可以显式使用
`--origin http://127.0.0.1:8080 --loopback-http`；公网 HTTP 会被拒绝。

浏览器只持有随机、HttpOnly、SameSite=Strict 的会话句柄；HTTPS 使用
Secure Cookie。用户 JWT／刷新凭据只驻留网关内存，会话最多 24 小时，
请求不能用自身身份头覆盖会话身份。原生授权决定账号、权限及操作准入；
网关不重试修改请求或重放作业。网关重启会要求重新登录，不自动恢复
打印。退出先调用原生注销，再清除本地会话和连接；原生注销失败时仍
清除本地句柄，但不会声称服务器凭据已经撤销。关闭网关不注销其他
客户端。默认上限为 128 会话、50 个 WebSocket、256 个活动请求；
WebSocket 单帧 1 MiB、全局发送缓冲 8 MiB，有界请求与流式回压保留。

独立 JavaScript 包验证命令为
`node --test host/test/product-client-gateway-compiled.test.ts`；
必要网络对照为 `node host/bench/product-client-gateway.ts`。每份样本保持
原网络基准的 200 REST、200 HTTP JSON-RPC、500 WebSocket 及 16 并发
320 次负载，3 次预热、至少 11 份保留样本。桌面同进程对照有可测 HTTP
代理开销；不能解释成目标板、TLS、混合打印或零退化通过。受保护页面、
原始失败及数值见[接入验收](../host/contracts/protected-client-gateway-acceptance.json)。
完整同包 Fluidd／Mainsail、进程崩溃恢复、目标板、G3 和全面 Python
退役仍待完成。
