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
集成范围见 [迁移说明](docs/Node_Host_Migration.md)，当前执行顺序与验收出口见
[交付计划](docs/Node_Host_Delivery_Plan.md)。当前适配 ANYRAID Cycnumbris 500
系列，优先完成 Moonraker，其他机型适配后置到最后。host 运行需要
Node.js 26.9 或更高的 26.x 版本。当前打印入口仍为 Python，新的主机
实现尚未完成硬件验收。
共用同步／异步／UI 模板工厂已接入显式标准服务代际，服务关闭取消
活动调用并释放私密资源；相关源码与独立 JavaScript 各 175 项通过。
异步／UI 固定性能预算和当前独立产品构建仍失败，完整模板语言、
默认组件装配与 Python 退役继续开放，见
[共用工厂证据](host/contracts/moonraker-template-factory-acceptance.json)。
配置 `getPath` 已接入共享模板、用户目录及物理符号链接解析；标准服务
的显式模板代际可展开 Klippy 的 `{data_path}` 路径，旧私密文件回退同样
按物理目标选取。相关源码与独立 JavaScript 各 217 项通过，新增 C 查询
的 UBSan／ASan 各 38 项通过，三组配置启动预算通过，见
[配置路径证据](host/contracts/moonraker-config-path-acceptance.json)。
原生产品的进程入口现要求明确的 `dataPath`，普通启动自动加载共享
模板与私密文件，设备重建保留同一代际；重复所有者拒绝并清理。
源码组 156 项通过，独立 JavaScript 组先为 152／156，旧 CLI 夹具
的四项路径失败修正后，受影响的九项源码与 JavaScript 各通过；
其余运行模块摘要不变。冷启动与 200 次查询的编译比值为
1.007／0.993，通过原 1.5 预算，见
[进程组件接入证据](host/contracts/native-process-components-acceptance.json)。
上一配置路径头 `4e886e50` 十五项 CI 全通过，普通 4660／4660，
见[该头终态](host/contracts/pr68-4e8-terminal.json)，不覆盖本轮接入。
配置路径的单独结果不覆盖完整产品装配、新包或目标板打印；上一工厂头
`4592243d` 的十五项 CI 和普通 4624／4624 独立通过，见
[该头终态](host/contracts/pr68-459-terminal.json)，新路径提交须自身检查。
初始运动遥测候选修复已通过源码、独立编译包、原双 MCU 混合旅程
和有限 Mainsail 打印复验；请求速度、打印负载指标与未关闭门槛见
[速度兼容性证据](host/contracts/live-motion-velocity-acceptance.json)。
Rust 模板的缓存路径差异已定位并补上映射，两条缓存路径构建的完整包
清单一致；本机编译器 SIGSEGV 仍未关闭，见
[默认包记录](host/contracts/moonraker-template-default-package.json)。
原生文件通知的候选修复已补齐提交与预览失效顺序，并用实际 Fluidd
重命名、复制及非空目录删除复验，见[预览通知验收](host/contracts/native-file-preview-notification-acceptance.json)。
官方 Mainsail 的受保护接入候选提供原生账号登录与独立浏览器入口，
实际页面上传、下载、打印和受控恢复证据见
[接入验收](host/contracts/protected-client-gateway-acceptance.json)，
装配命令与权限边界见[启动说明](docs/Node_Host_Startup.md#受保护的官方-mainsail-接入候选)。
完整同包客户端、目标板和 G3 门槛仍未关闭。
受保护入口补齐旧 Service Worker 的缓存迁移。最终锁定包的 Mainsail
R9 实际登录、选择上传、摘要一致的下载、文件管理、清台确认队列、
模拟打印历史、断连／进程恢复和配置保存重启已验证；场次含启动
约 4 分 7 秒后关闭。此前失败和两套客户端的完整出口仍分别保留，见
[缓存迁移与有限页面验收](host/contracts/product-client-worker-migration-acceptance.json)。
复用来源凭据迁移候选已通过 R14／R15 同源对照：旧包刷新拒绝，
新包只清理当前来源的客户端令牌，实际模拟打印及明确进程恢复通过；
两场次按期限提前关闭，详见原验收记录的 `credentialMigrationOct11`。
新包仅改变登录资源和启动脚本，状态查询桌面预算通过；自身 CI、
完整本机及硬件门槛仍开放。
锁定包 Mainsail R17 已实际选择上传、显示缩略图和服务器文件的 3D
轨迹，并在明确进程恢复后保留文件；下载等待工具中断，摘要核对未完成。
R16／R17 均在含启动 15 分钟内自动关闭，详见原验收记录的 `previewOct11`。
同包 Fluidd R18 已补齐实际选择上传、两层 0.2／0.4 mm 预览及
下载原字节一致的摘要核对，含启动约 9 分 44 秒后关闭。输入为合成
样本，完整客户端、外部故障恢复、实机与性能门槛继续分别保留。
同包 Mainsail R19 补齐实际选择上传、服务器文件 944／944 字节轨迹
预览及三次原字节一致的下载，含明确进程恢复后的下载；约 6 分 22 秒
关闭并释放端口。浏览器下载事件等待超时，但场次内实际新建文件的
时间、字节与摘要已独立核对；渲染层数和完整外部故障恢复仍未验证。
证据头 `9a7e493c` 十五项 CI 全部通过，见
[该提交终态](host/contracts/pr68-9a7-terminal.json)，不覆盖历史失败。
本轮滤波核预计算优化在原编译、无 JIT 运动诊断中出现数值失配，已
撤回；保存输入的旧、新实现及精确整数求和一致，但首次异常根因未明。
仅保留 48 组冻结 binary64 精度回归及
[拒绝候选与失败现场](host/contracts/motion-filter-kernel-rejected.json)，
不将局部性能预算通过计作 G3 关闭或优化交付。
默认模板数值回归、原生浮点／整数验证和同步私密模板基准现使用
固定摘要的参考数据，日常执行不再启动 Python。保留原 42744 组浮点
舍入、5424 组整数／布尔舍入、1293 组转换及负零；源码与关闭 TS
加载的独立 JavaScript 验证通过，相关回归 64／64、原性能门限通过。
这只退役上述验证入口，见[模板参考退役](host/contracts/template-reference-retirement.json)。
随后五条模板评估／原生传感器消息基准也改用原始固定参考，删除无引用的
Jinja 准备和数值参考助手。源码与关闭 TS 加载的编译验证通过；三条
原生基准满足事先固定的 1.5 倍历史中位预算。初次 Unicode 原语转换
为 2.64 倍参考，JS 模板候选仍不兼容，见
[基准退役与剩余差距](host/contracts/template-benchmark-retirement.json)。
随后实际数字归一化改用固定 64 KiB BMP 查表及原补充平面范围，
不缓存输入或改变词法与舍入。相关 89／89 及无 TS／Python 编译验证
通过，Unicode 原语历史比值降至 1.367，五种原语满足预设 1.5 倍预算；
六组混合输入交错旧／新对照亦通过，见
[Unicode 转换优化](host/contracts/config-numeric-unicode-acceptance.json)。
提交 `430b5fdc` 十五项 CI 全通过，普通 4539／4539，见
[该提交终态](host/contracts/pr68-430b-terminal.json)；新头仍须自身检查。
新增独立异步／UI 模板候选，真实函数调用、取消、UI 私密全局隔离及
数值类型通过源码／编译各 112 项相关回归；独立原生源码快照构建通过。
纯模板满足固定桌面预算，编译函数／UI 路径仍为参考的 1.79／1.85 倍，
不计性能验收通过，也未启用公开接口或替换默认打印入口。见
[异步候选及未关闭门槛](host/contracts/moonraker-template-async-acceptance.json)。
提交 `320c5128` 十五项 CI 全通过，普通 4543／4543，见
[该提交终态](host/contracts/pr68-320c-terminal.json)；新增异步候选须自身 CI。
该异步候选头 `a1222cfc` 的十五项 CI 随后全通过，普通 4566／4566，
见[该提交终态](host/contracts/pr68-a122-terminal.json)。随后按需信号候选
通过源码／编译各 118 项；固定编译基准的回调 1.424 倍通过，UI
1.653 倍仍超原 1.5 门限，整组性能未通过。接口改用 `call.signal`，
晚读取仍保留取消状态；详见[候选证据](host/contracts/moonraker-template-lazy-signal-acceptance.json)。
新候选须自身 CI，完整工厂和装配仍待完成。
随后同步真实函数候选通过源码／独立 JavaScript 各 139 项，14 组
上游冻结调用和原数值用例保持；纯模板、上下文函数、环境函数的
编译比值 0.397／0.964／0.955 满足固定 1.5 倍桌面预算。
旧缓存读取基准 1.250 倍超原 1.2 门限，独立原生快照再次遇到 Rust
SIGSEGV；异步／UI 预算仍失败。该候选继续作为草稿，详见
[同步真实调用与剩余门槛](host/contracts/moonraker-template-sync-functions-acceptance.json)。
按需信号头 `f0fc3169` 的十五项 CI 全通过，普通 4572／4572，见
[该提交终态](host/contracts/pr68-f0fc-terminal.json)；不覆盖上述新改动。
其他传感器差分、完整模板工厂、全面 Python 退役及产品门槛继续开放。
提交 `95984efa` 的普通 CI 4537／4537、主机及固件通过，运动矩阵
有一项触发原 10 秒子进程期限，14／15 通过，见
[该提交终态](host/contracts/pr68-959-terminal.json)。失败现场已封存，
不放宽期限，不以历史成功覆盖该失败；当前候选仍为草稿。
同包 Fluidd R10 的文件、清台队列、暂停恢复、完成记录及进程恢复
亦通过，约 4 分 34 秒后关闭；保留 JWT 刷新兼容性缺项。
最新普通完整回归 4417／4371／46，完整本机门槛仍未通过。
同一最终包的 Fluidd R11 补验配置保存重启、取消后的明确固件恢复
及新作业完成，约 3 分 31 秒后关闭；新来源未发出 JWT 刷新，原
复用来源错误保留，详见[R11 补充证据](host/contracts/product-client-r11-acceptance.json)。
同包 Mainsail R12 补验暂停恢复至完成、取消、明确固件恢复与新打印，
含启动约 4 分 31 秒后关闭，详见[R12 证据](host/contracts/product-client-r12-acceptance.json)。
提交 `080a1b1` 的 15 项候选 CI 全部通过，普通 4533／4533、精确
324 条 sanitizer 和 500 个运动进程见[当前候选终态](host/contracts/pr68-080a-terminal.json)。
完整本机 46 项失败、客户端预览与外部故障恢复、兼容性和 G3 仍开放。
2026-10-10 两次明确授权的同包页面场次已执行并关闭。Fluidd 已验证
实际选择上传、摘要一致的下载、文件管理、模拟打印、断连恢复及配置
保存重启；Mainsail 已验证受保护登录、上传下载和模拟暂停恢复，
取消后仅封存页面 shutdown，恢复与队列等仍待验。夹具补齐授权头及
第二跳来源转发，并装配需清台确认的队列；接口回归通过，修复后的
官方页面尚未复验。原失败、期限、缺项及截图见
[同包页面证据](host/contracts/integrated-client-bundle-readiness.json)。
上述为首批场次范围；恢复及队列的后续验证见
[R5／R6 证据](host/contracts/integrated-client-r5-r6-scenes.json)。
夹具修复 PR #60 已正常合入 develop `3fcc9c63`，修复候选和实际
合并后的五项规定检查分别通过，含普通 4437／4437、协议、Linux MCU、
精确 324 条 sanitizer 命令及固件，见
[合并后终态](host/contracts/develop-3fcc-terminal.json)。完整页面与 G3 仍待验。
私密配置文件所有者 PR #61 已正常合入 develop `48731115`；最新
候选的五项检查及 4473／4473 通过，见[候选终态](host/contracts/pr61-43cf-terminal.json)。
实际合并后的五项规定检查独立通过，含 4473／4473、协议、Linux MCU、
324 条 sanitizer 命令及固件，见[合并后终态](host/contracts/develop-4873-terminal.json)。
上述 CI 属于配置所有者；LDAP 后续实现的检查单独核验。
LDAP 身份任务分支已补齐独立 LDAP／LDAPS 传输，合成目录协议和
桌面延迟预算通过，见[传输证据](host/contracts/native-ldap-transport-acceptance.json)。
标准 `loadAuthorized` 已接入明确配置的 LDAP／LDAPS，拒绝空分组，
私密绑定密码在公开配置副本中脱敏。配置与关闭控制、原失败及当前
源码性能见[标准装配证据](host/contracts/native-ldap-configuration-acceptance.json)。
通用模板、实际用户目录、目标板和全面 Python 退役仍待完成。
同步文本模板候选已为标准 LDAP 启动提供显式 `templateSecrets` 私密文件
依赖；保留 JSON 整数／浮点字面类型、关闭环境并脱敏诊断。冻结上游
参考和桌面预算通过，全量本机检查仍有四项失败；异步函数、UI 环境、
完整任意精度整数及目标板尚未验证，见
[同步模板验收](host/contracts/moonraker-template-sync-acceptance.json)和
[装配说明](docs/Node_Host_Startup.md#同步私密文本模板候选)。
后续两个候选头的普通 CI 均有两项失败，协议及 Linux MCU 被跳过；
网格准入与发布并发顺序的测试修复通过 41 项定向检查和类型检查，
修复头 `59167c9d` 的十五项规定 CI 独立通过，含普通 4528／4528、
协议、Linux MCU、精确 324 条 sanitizer 命令、固件及 500 个运动
诊断，见[修复头终态](host/contracts/pr68-591-terminal.json)。
新建常规 C／Rust 独立锁定包的编译模板／LDAP 30 项及原完整混合
旅程通过；Mainsail R7 页面连接失败，已在期限内关闭，不计页面验收。
更正先前证据文件影响产物清单的判断，构建器未复制这些报告；原始
失败保留。本机常规 Rust 栈完整回归 4528 项中 4519 通过、
9 项失败，编译器及测试进程异常尚未定位，见
[当前候选与修复证据](host/contracts/pr68-64-terminal.json)。
后续默认构建已将模板列为必需插件，从独立 C／Rust 快照生成，绑定
锁文件与工具链，不再需要手工带入已有插件。桌面启动校验及固定模板
预算通过；首次打包回归出现 Rust 编译器 SIGSEGV，16 MiB 线程栈条件
下的有限对照通过，不认定根因修复。原失败、保留包及其软件验收见
[默认模板包记录](host/contracts/moonraker-template-default-package.json)。
LDAP PR #62 已正常合入 develop `6fb19680`，候选头与实际合并后的
全部 15 项检查分别通过，含普通 4499／4499、协议、Linux MCU、
精确 324 条 sanitizer 命令与十组共 500 个进程诊断，见
[候选终态](host/contracts/pr62-e9d98-terminal.json)和
[合并后终态](host/contracts/develop-6fb-terminal.json)。诊断成功不关闭 G3。
受保护入口新增清台确认页面候选，请求确认在旧服务、策略关闭及设备忙
时保持拒绝，操作和独立包证据见[队列页面验收](host/contracts/product-queue-panel-acceptance.json)。
实际页面清台确认已按后续场次验证；完整客户端与当前系列验收仍待完成。
面向用户的未发布变化见 [版本变化](CHANGELOG.md)。

持久元数据失效准入候选避免读队列满时文件已删除却返回恢复故障，
并让失效优先于未开始的重扫。首包冷发布性能失败原样保留，见
[失效准入审查](host/contracts/native-metadata-invalidation-admission.json)。后续候选
并行准备私有回执与内容目录同步，保留公开回执前的双屏障和五次同步；
新组合通过七路原预算及原完整混合软件验收，尚未证明冷发布提速。
PR #58 和公告组合 PR #57 已正常合入 develop；文件修复合并后检查通过，
组合实际合并后的全部 15 项检查也通过，见[集成终态](host/contracts/develop92-build-terminal.json)。
软件结果见[回执准备审查](host/contracts/native-publication-authority-preparation.json)
与[交付计划](docs/Node_Host_Delivery_Plan.md)，实际同包客户端仍待验。

有限滤波边界捕获设施 PR #59 已正常合入 develop `e312c172`，
精确候选头及实际合并后的全部 15 项检查分别通过，原始日志见
[合并后终态](host/contracts/develop-e312-terminal.json)。捕获仅为
诊断准备，历史数值异常、G3、完整客户端和全面 Python 退役仍未完成。

元数据原子版本头候选减少耐久写入成本，同一独立包的磁盘、大图和
重扫完整混合软件验证已通过。新内容准备组合通过七路原性能预算和
原完整混合负载，已正常合入 develop；实际客户端和目标板门槛仍待收口，见
[原子版本头审查](host/contracts/native-metadata-atomic-heads-acceptance.json)与
[内容准备组合验收](host/contracts/content-paired-composition-acceptance.json)。
协议升级和降级副本要求见启动说明，产品尚未发布。

交付按同包软件闭环、Cycnumbris 500 受控试验、完整退役与发布三个
出口推进。上传／移动覆盖 PR #3 的精确头 `12e85c5` 规定 CI 通过，
已自行审查并正常合并为 develop `65067ea9`，合并后规定检查也通过。
固定包验收设施 PR #4 及状态修复 PR #5 已自行审查并正常合入。
develop `03bb4609` 的合并后主机、协议、sanitizer、Linux MCU 和固件
规定检查均通过；历史流内校准、工具链及数值失败仍保留诊断证据。
离线管理 PR #6 的精确头规定检查均通过，已正常合入 `d41052b7`；
合并后主机与固件规定检查均通过。非空目录清理 PR #7 已正常合入
`d1aed43e`，合并后主机与固件规定检查均通过；队列 PR #8 的精确头
全部检查通过，已正常合入 `796e65d9`，合并后规定检查通过。
时钟锚点延期 PR #11 的精确头规定检查通过，已正常合入 `6ad9f595`，
合并后检查仍在运行。当前网络变化通知候选接入该修复，复用同一进程服务和授权分发，
只读服务状态候选亦接入该组合；系统服务控制、目标板及完整客户端出口仍待验。
实页验收发现 Fluidd 打印完成后停留在旧进度，原生状态现补齐真实 MCU
时间字段，新独立包已验证无需重连显示完成及长作业暂停／恢复／完成。
文件预置采用 API，页面上传及全部客户端出口仍待验，范围见
[验收契约](host/contracts/fixed-client-bundle-acceptance.json)、
[状态修复证据](host/contracts/native-toolhead-clock-acceptance.json)和
[交付计划](docs/Node_Host_Delivery_Plan.md)。G3、真实装配及目标板验收未完成。

现有服务、文件／身份／历史、打印状态机及恢复设施继续复用。当前先
收口待集成候选，再按同包客户端、离线管理、队列、当前平台维护和剩余
Moonraker 契约推进；当前系列材料与精度判别按依赖提前准备。
真实运动须满足 G3，默认入口切换须满足完整退役和发布门槛。
当前状态及下一动作只在[交付计划](docs/Node_Host_Delivery_Plan.md)维护；
任务分支经 PR → develop → master 推进，历史成功不替代当前头检查。

原生元数据 Worker 清理候选在超时后保留已转移文件的所有权记录，等待
关闭确认后再完成清理；无法确认时明确报错。扫描期限不变，详细证据见
[清理验收](host/contracts/metadata-worker-close-acceptance.json)。

原生作业队列候选沿用同一进程文件、数据库及打印日志，提供持久管理和
显式启动；PR #8 已正常合入 develop，合并后规定检查通过。新增自动
续打候选由当前任务的持久完成事件触发，逐次校验原授权；暂停、凭据
失效及设备退役会撤销续打，重启不重放。旧过渡宏转换、完整同包客户端
和目标板验收仍待完成。
接口与恢复边界见[启动说明](docs/Node_Host_Startup.md#原生作业队列候选)。

原生服务状态候选将 systemd 采样接入进程所有者，系统信息查询读取缓存，
服务变化通知沿用鉴权；共用进程报告实际共用单元。服务控制、安装回滚及
完整 M4 仍待交付。网络通知 PR #9 当前头运动时序 CI 失败，暂缓合并。

SOS 测试及三个滤波基准现已采用有摘要校验的固定独立数值参考，无需
运行 Python／NumPy／SciPy；高精度与整数逐位检查保留。四项迟到授权
检查亦已对齐既有代际拒绝并验证零副作用。该批本地回归及后续完整远程
CI 通过，历史间歇故障仍未关闭，见[修复验收](host/contracts/ci-reference-lifecycle-acceptance.json)。
随后六项停止、状态及预检的陈旧／竞争断言已修正，独立源码快照的 73 项
相关回归通过，运行算法和期限未变，见[停止与状态验收](host/contracts/ci-stop-state-acceptance.json)。
后续主机及固件完整 CI 已通过；历史数值异常和实机验收仍待收口，
具体源码与兼容范围见交付计划。
原生主机工厂的 `createProcess` 模式已贯通主机循环：设备重建时保留同一
Moonraker 监听器、身份、数据库、文件元数据和作业日志；旧设备释放后仍可
查询文件、下载、上传及读取／管理历史，上传不自动打印。启动／停止失败
仍保持可查询。显式“上传并打印”候选在文件发布、临时文件关闭和上传占用
释放后，重新授权固定文件身份并交给同一耐久打印控制器；启动未获准时
保留上传回执及明确失败原因，不自动重放。默认上传仍只发布文件。
设备断开期间仍拒绝打印；确认物理停止且旧设备清理完成后，进程文件
所有者可继续移动、复制、删除及同名上传覆盖。未确认停止、旧请求及
清理失败保持拒绝。非空目录清理候选沿用同一文件库，逐项授权并保护
活动／暂停身份；耐久决定后的中断须完成校验恢复，集成与实页仍待验。
源码三代模拟设备与独立
编译并发打印已验证。标准 HTTP／RPC RESTART 已接通，源码和独立编译包
验证了同一模拟 MCU 配置复用及配置失败后的显式重试；停止失败拒绝接入。
普通重启回执滚动保留，旧受控记录迁移后保持幂等，达到旧日志容量不阻塞
普通重启。首代配置／设备启动失败也保留授权服务，确认清理后可显式
重试；清理失败拒绝新设备。普通 RESTART 对主／辅 MCU 的持续 shutdown
及 CRC 不匹配保持可查询失败，不隐式复位、不伪报就绪，软件判据已收口。
独立 FIRMWARE_RESTART 已通过同一双 MCU 模型的实际复位、状态清除和配置
重建验收；停止失败不继续复位，进程退出等待清理。恢复日志升级到 v3，
固件重启回执独立保留 64 条；部署与降级副本要求见启动说明。
同包实际前端完整流程仍待封存，受阻时推进上述独立服务契约；物理 MCU
及精度验收仍未完成，边界见
[启动说明](docs/Node_Host_Startup.md#进程服务与设备代际)。

原生 Moonraker 已接入持久 API Key 及可选本地用户／JWT 登录、刷新和退出，
包含 HTTP、WebSocket 与独立编译包验证；完整授权策略和真实机器装配仍待
完成。接入方式与兼容边界见[启动说明](docs/Node_Host_Startup.md#原生-api-key-授权组件初步接入)。
配置服务的 `loadAuthorized` 入口可按配置自动注册授权接口与事件，并管理
授权组件的关闭；重启后复用持久身份。原生打印产品入口已接入配置授权，
模拟 MCU 下同一编译包的登录、上传、打印控制、故障停止与进程重启恢复
已通过；Fluidd、Mainsail 已完成预置文件的页面打印、暂停和恢复模拟验收。
协议客户端的打印中重连、重新鉴权／订阅、设备代际及独立进程恢复亦已
验证。原生 history 组件现按实际注册情况声明，Fluidd 历史菜单及完成
作业显示已验证；最终同包完整页面上传／断连／进程恢复和实机验收仍待
完成，默认入口尚未切换。

Node 主机现支持 AHT、SHT3X 温湿度传感器及 LM75 温度传感器的
I²C 配置、周期采样、组合输入、温控风扇及直接加热反馈。三类传感器
的三类编译产品流程均已通过模拟 MCU 验收。LM75 修正了原实现的
负温度解码；物理硬件验收仍待完成，详见迁移说明。

HTU21D／SHT21／Si70xx 已接入 I²C 配置与温控反馈，完成驱动和
模拟 MCU 回归；HTU21D 独立传感器、Si7021 Hold 模式风扇和 SHT21
No-Hold 加热的编译服务流程通过，物理器件与打印机验收仍待完成。

BME280／BMP280／BMP180 已接入配置和采样，压力与可选湿度进入状态接口；
三条编译服务流程及故障停机验证通过。环境传感器的加热用例仅验证
软件接口，不代表适合实际热床控制。物理器件和打印机验收仍待完成。

本机迁移验证还发现了离线计算进程崩溃和瞬时运动数值失配，单进程
顺序运行也可复现，根因尚未定位。诊断证据见
[运行时与运动数值异常记录](docs/diagnostics/node26-motion-failures.json)；
当前不能据此工作区的成功样本宣称已满足生产稳定性和运动精度要求。

当前执行顺序为候选收口 → 同包客户端文件到打印 → 队列与
维护及完整契约 → 当前系列实机与全面退役 → 其他机型。每批沿用现有
资源所有者，完成受影响回归和同包负载后及时提交集成。
目录文件、图片兼容与同盘性能见
[目录文件验收](host/contracts/native-file-namespace-acceptance.json)，
固件链接对照见[链接验收](host/contracts/stm32-lto-acceptance.json)。
两套固定客户端同包完整流程仍待封存；页面工具受阻不计通过。
历史失败与最新 CI 分开维护，以交付计划和精确候选证据为准，
不在概览重复逐轮日志或用旧失败描述新候选。

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

Delta 已接入原生归零、文件执行、暂停恢复、持久化作业与 Moonraker
服务 API，以及声明式配置的源码／编译包短文件打印模拟验证；探针、
校准和实机打印仍待完成。机械 probe 的配置、连续采样及受控 API 已
通过模拟验证；编译包中正常归零、打印后连续探测亦已通过模拟验收。
BLTouch、Delta 校准和物理探测精度仍待验证。
详细范围与性能数据见[迁移说明](docs/Node_Host_Migration.md)。

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
MAX31856 已接入独立温度源和加热器配置，支持原有热电偶类型、平均采样
和 50Hz 滤波选项；需固件提供 `MAX31856_SIGNED_RANGE=1`。启动时读回
配置并等待转换稳定，约增加 2 秒启动时间；已通过模拟 MCU 下与 TMC
共享硬件／软件 SPI 的编译产品打印、重载和故障停机流程，真实硬件
验收仍待完成。MAX31865 已接入 RTD 配置、独立采样和加热反馈，支持
2/3/4 线，启动增加约 300 ms 的偏置／转换等待并读回配置；编译产品
已通过模拟 MCU 下共享硬件／软件 SPI 的打印、重载和故障停机流程，
真实 RTD 验收待完成。其他数字温度源仍在迁移。

多 Z 机械调平已接入 [z_tilt] 配置和鉴权校准 API，支持探测、分段电机
调整和重试；编译产品已通过模拟 MCU 下非平床校准、恢复同步 Z 运动
及并发负载打印验收。真实调平精度待验收，使用方式与量化限制见
[多 Z 机械校准](docs/Node_Host_Startup.md#多-z-机械校准)。

四 Z 龙门调平也已接入 [quad_gantry_level] 和鉴权校准 API，编译产品
通过模拟 MCU 的非平床调整、四电机同步恢复及负载打印验收；真实
机械精度仍待验收，详见[四 Z 龙门校准](docs/Node_Host_Startup.md#四-z-龙门校准)。

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
配置初始化/更新、`autoconf.h`、最小配置和交互菜单均已迁移到 Node；
默认打印入口及其他尚未迁移的工具仍需要 Python。

头文件入口为 `node scripts/kconfig-genconfig.mjs src/Kconfig`，支持
`KCONFIG_CONFIG`、`KCONFIG_AUTOHEADER` 和 `--header-path`。无需 npm
依赖；输出未变化时保留时间戳，生成失败时保留原输出。Node 编译缓存
可降低重复调用耗时，禁用缓存不影响结果。84 组头文件与旧实现字节一致，
并通过 ATmega2560 实际编译；这不代表整个构建或打印入口已脱离 Python。

最小配置入口为 `node scripts/kconfig-savedefconfig.mjs --kconfig src/Kconfig
--out defconfig`，使用 `KCONFIG_CONFIG` 指定输入。84 组导出与旧实现一致，
重新加载后头文件不变。`make olddefconfig` 使用 Node 完成配置补全，
变更前保留 `.old`，未变更时保持时间戳。直接入口为
`node scripts/kconfig-olddefconfig.mjs src/Kconfig`。从缺失配置及空输出
目录开始，设置 `PYTHON=/nonexistent-python` 仍已完成 AVR 编译。
五个旧 Python Kconfig 文件均已删除；冻结对照的原始版本与哈希见
[来源记录](host/contracts/kconfig-retired-oracle.json)。

`make menuconfig` 现在打开分页编号菜单：输入编号进入菜单或修改选项，
`back` 返回，`search 关键词` 搜索，`all` 显示隐藏项，`help 编号` 查看帮助。
`save [路径]` 保存或另存，`load 路径` 加载，`export 路径` 导出最小配置，
`reset` 恢复默认值，`quit` 退出。未保存修改和覆盖已有文件均会提示确认。
这是新的行式交互界面，不沿用 curses 快捷键。保存检测到外部修改时会拒绝
覆盖；异常退出遗留 `.kconfig-lock` 时，须确认没有保存进程再移除该锁。

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
输出文件必须不存在，重复采集请使用新前缀。Motan 日志读取、分析与
绘图使用下述 Node 入口，旧 `readlog.py`、`analyzers.py` 和
`motan_graph.py` 已退役。部分开发回归仍调用历史 Python 参考，尚需清理。

Motan CSV 和图表均可使用独立编译包，包含 worker、字体、许可证和锁定
依赖。复制到仓库外后运行 `npm ci --omit=dev --include=optional --ignore-scripts`，
即可用 Node 执行 `scripts/motan/motan_graph.js` 和 `data_export.js`，无需
Python 或 TS 运行时。构建会替换目标目录，捕获和输出文件应放在目录外。
具体命令及支持的样式见[调试说明](docs/Debugging.md#motion-analysis-and-data-logging)。

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

MAX31855 独立温度输入与加热反馈已接入 Node 配置装配，要求 MCU 固件
提供 `MAX31855_SIGNED_RANGE=1` 能力。旧固件会被拒绝；当前已通过固件
处理函数、模拟热控、两个编译产品变体和 ATmega2560 固件构建验证。
真实热电偶验收仍待完成；项目 Kconfig 工具链已迁移到 Node。

SD 卡烧录入口 `scripts/flash-sdcard.sh` 已改用 Node.js 26，支持独占串口、
写后哈希校验和重连验证；不再依赖 Python/CFFI。安装、断电状态码和
尚未完成的实机验收见 [SD 卡更新](docs/SDCard_Updates.md)。

文档站点构建已切换 Node.js 26，支持现有七语言导航与搜索，
不再依赖 MkDocs 或 Python。入口和兼容性决策见
[文档构建说明](docs/_klipper3d/README)。

AVR 仿真工具已迁移为 `node scripts/avrsim.ts`，无需 Python/SWIG。
构建、PTY、运行节拍和 VCD 波形导出见
[仿真调试说明](docs/Debugging.md#testing-with-simulavr)。打印主机入口仍独立迁移。

串口抓包离线解码使用 `node scripts/parsedump.ts out/klipper.dict test.serial`，
旧 `klippy/parsedump.py` 已退役；此工具不连接或控制打印机。

MCU 离线调试控制台使用 `node scripts/console.ts --help`，支持受限精确
算术、延时发送、批量发送和内存转储；旧 `klippy/console.py` 已退役。
运行前停止占用设备的打印主机，控制台关闭不等于 MCU 物理停机。

Node 产品装配支持 `hybrid_corexy` 和 `hybrid_corexz`，并已接入
Cartesian X/Y 与混合 Core X 的 `dual_carriage` 配置、原生变换和双轨归零。
当前双小车装配每台小车限一个电机，打印仍为单挤出机；消费级模式接口、
多挤出机及实机验收尚未完成。Cartesian X 双小车已通过编译产品模拟打印、
暂停、重启和故障停机流程；另有一次 Y 跨 MCU 测试停机原因未定位，后续
复验通过不代表问题已修复。不能据此切换生产入口。

双小车受控模式可通过 `/printer/settings/dual_carriage` 查询及切换，
使用状态令牌、空闲独占和几何预检，成功后同步 G-code 坐标。参数与
模拟验收边界见迁移说明的当前交付状态；仍不支持完整多挤出机产品。

多挤出轴的补偿与运动准入已支持逐轴温度、流量和速度检查，配置已
接入独立原生队列及热端。工具切换、独立回抽与压力提前已在原生
G-code 调度中验证，按工具暂停回抽及多热端温度快照也已验证；
逐工具对象取消与服务状态已通过原生模拟验证。
线性配置的多工具文件入口已接通，实际密封文件通过双模拟 MCU 的
加热、工具切换、对象取消、中途及 EOF 暂停恢复和完成关热验证。
第二热端 ADC 故障已验证整组停机、关热和拒绝恢复。
编译后的多工具 HTTP 产品流程已通过模拟验收，覆盖上传、加热、
缺料暂停、工具切换、对象取消、完成关热、重启历史及第二热端故障。
其中发现的极短加速/巡航表示问题已按精确终点与有界偏差约束修正。
实机验收及历史 Node 数值异常仍未关闭；默认生产入口仍为 Python，
不能据此投入实机打印。证据和限制见迁移说明的当前交付状态。

独立温度监测支持 temperature_combined 的最小值、最大值和平均值，
包含配置依赖校验、偏差超限整组停机、状态查询和温度历史。
组合源已接入温控风扇及加热器反馈，通过模拟 PWM 和编译打印服务
验收，包含源故障整组停机。真实加热/散热效果与目标板时序仍待实机
验证。附加湿度、压力和气体聚合及链式状态传递已实现，实际传感器
提供者的迁移和硬件验收仍待完成，详见迁移说明。

原生磁盘 UFP 投递候选已接通显式进程配置、关闭写入发现、耐久领取、
共同模型／PNG 发布和原包清理；两处进程强杀后的同身份恢复与新独立
产品包回归通过。新增完整混合打印负载未通过，候选保持草稿、默认
关闭、不自动打印。运行与未闭合范围见
[磁盘投递说明](docs/Node_Host_Startup.md#原生磁盘-ufp-投递候选)。
共同文件发布后续候选减少重复内容的耐久写入成本，保留完整校验、
失败拒绝及引用保护；本机对照有收益，但完整打印负载仍未通过，见
[性能与失败记录](host/contracts/native-ufp-contention-acceptance.json)。
元数据后续候选复用已经耐久提交的失效记录，避免在重新扫描前重复
写入相同失效状态；旧预览撤销、新扫描代次及有序清理仍保留。局部
性能改善尚不足以通过完整打印门槛，见
[元数据性能审查](host/contracts/native-metadata-invalidation-acceptance.json)。

2026-10-10 后续 R5／R6 有限场次分别在 713／273 秒内关闭，见
[新场次证据](host/contracts/integrated-client-r5-r6-scenes.json)。Mainsail
补齐实际选择上传与摘要一致下载、文件管理、仅保存配置、清台确认
队列、原受保护页面进程恢复，以及模拟取消后的显式设备恢复。
Fluidd 真实选择器上传普通及中文／空格／百分号文件名均返回 201，
页面下载摘要一致，原受保护页面在进程恢复后重连并保留文件。
两套客户端均未自动重放。旧 R2／R4 的 400 未复现，原因未确定，
[旧批次](host/contracts/integrated-client-additional-scenes.json)保持原样。
本批次使用原锁定包，未包含新 LDAP 实现；完整客户端出口、目标板
和 G3 未关闭，未延期或自动重启。

提交 `822e60d6` 的十五项 CI 仍为十四项通过；本次失败改为
Node.js 26.10.0 无 JIT 的编译运动诊断，第 17 个进程完成 14 次
比较后触发原 10 秒期限，见[该提交终态](host/contracts/pr68-822-terminal.json)。
另一执行模式的失败尚未定位根因，未放宽期限或手工重跑覆盖失败。
