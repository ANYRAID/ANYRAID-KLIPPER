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
配置 update_manager 后可通过鉴权HTTP／RPC读取Web版本、刷新GitHub元数据并实际更新／本地回滚Web客户端；
下载校验、持久文件保留和中断目录一致性恢复已接线；Git应用候选接入实际更新／回滚／显式恢复及managed_services，
恢复公开参数为update_deps：启用enable_node_updates的普通Git应用可强制准备锁定生产依赖，未启用时true返回501；内部名force_dep_update作为公开字段返回400。
普通服务沿维护租约顺序提交，自己的进程重启沿真实响应交接；未知服务结果保留interrupted且不自动重放。
受管服务夹具已补真实ADC室温报告：8.5秒recover准备有采样成功、停采样仍温控过期409；生产安全门槛不变。
该受控场证实夹具失采样缺陷，原CI未记录停止原因，不能宣称历史失败同因已确证，见[验收](host/contracts/update-manager-git-acceptance.json)。
Git Node依赖候选接通隔离npm准备、保旧替换和最新一代回滚，同锁不重装，依赖一致成功后才进入服务；普通应用脚本／原生依赖仍有限制；full当前仅作完整计划能力预检，在任何变更前拒绝未支持计划，见[Web配置](docs/Node_Host_Startup.md#web-客户端更新状态与刷新)和[Git边界](docs/Node_Host_Startup.md#git-纯仓库应用更新候选)。
独立 APT 后端候选已实现查询、刷新、解析、安装与 upgrade，g++等合法尾符号名称按受信Candidate精确版本安装，安装禁止删除其他包，并要求可信持久操作日志；现由系统部署层与PackageKit统一选择并接入公开system路由及连续维护租约，见[APT边界](docs/Node_Host_Startup.md#独立-apt-系统包后端候选)。
产品专用可信代际准备已验证隔离全新TS、C／Rust原生构建及生产依赖安装；固定launcher-v1候选接通显式批准代际的核心HTTP／RPC选择、真实响应后的受管重启交接、新进程耐久确认与最近已确认代际回滚。Klipper／Moonraker为同一次共进程选择，旧profile须显式迁移，完整full协调仍待组合，见[代际激活边界](docs/Node_Host_Startup.md#固定-launcher-与产品代际激活候选)。
可信 `createProcess` 路线现接入默认共享 `systemd_dbus` 所有者：真实
Hello／Subscribe、服务采样、安装身份属性与受限 typed 控制共同借用连接。
设备退役后已提交动作的未知结果持久为 interrupted，包装错误不丢失，
新进程不重放；备份换代先释放首轮真实 socket。默认入口的软件与模拟验证、
其他 provider 的兼容边界见[共享总线验收](host/contracts/system-bus-provider-acceptance.json)
和[启动装配](docs/Node_Host_Startup.md#共享-d-bus-进程所有者)。
可信内部维护租约可连续交接到宿主服务控制，终态归还仍持围栏的租约或保持退役关闭；已接入managed_services与显式准备代际的核心选择；自动准备来源与完整full协调仍待交付。
独立PackageKit候选借用同一总线，具备typed事务、专属Polkit检查及耐久未知结果围栏；现与APT接通系统更新路由与选择，见[内部provider边界](docs/Node_Host_Startup.md#packagekit-内部-provider-候选)。
系统更新优先借用共享PackageKit，仅在变更前初始化不可用时选择APT；公开／自动缓存刷新同样持有维护围栏。
失败或未知结果耐久保留，重开先阻止设备取得，管理接口仍可使用；新增独立权限的人工对账出口，
确认仅解除后续操作围栏，不证明原升级成功。缓存查询失败不会报告“没有更新”，见[系统接线](docs/Node_Host_Startup.md#系统更新选择维护与对账)。
本项目固定使用 `10.0.0.184` 作为 Linux 开发与调试环境。用户明确允许：
“本项目开发实际需要linux环境的情况下，自行使用10.0.0.184”；持续允许
在该机隔离调试及传输本项目所需源码。当前任务专用工作树为
`/home/dek02/.codex/worktrees/supervisor-group-compat/ANYRAID-KLIPPER`；
后续任务继续使用独立任务分支与工作树，不覆盖已有修改。此约定不授权
真实设备／系统电源操作、生产部署或绕过任务→develop→主线的PR流程。

当前Linux两轮普通并发诊断分别保留16／14失败；两入口24次窄解析仅有限未复现。
本轮实际资源观测削弱全局／cgroup耗尽解释，历史11失败／G3仍未解，见
[诊断验收](host/contracts/system-bus-provider-acceptance.json)的currentLinuxExitDiagnostic及交付计划。
独立C memtester普通用户256MiB／一pass、18项无错误，仅为有限阴性观察，不认证环境健康或关闭G3。

保留身份查询候选现为可信 IP／API Key 的 GET /access/user 与 WS access.get_user
返回 username／source／created_on，JWT 继续返回注册用户资料；旧安装原创建时间
从留存源核摘要恢复，轮换／重开保留。新候选1735的隔离回归与窄鉴权预算已验，
同包客户端A4现按下述映射闭合；原42／28预算见[当前验收](host/contracts/system-bus-provider-acceptance.json)的currentCandidateExitValidation，服务重获预算、正常集成与实机仍开放。

同1735包的Mainsail2.19.0可信回环有限场已验证真实chooser上传、打印中reload，
1012断连后通过原生TRY AGAIN显式重连，同job／request及单次start保持、进度增加；
经必要Pause后直接Cancel（默认无确认弹窗），标准printer.restart保持产品进程、
模拟设备generation增加，另一短job完成且旧job仍cancelled。最终场277.702秒、
24张截图和两端清理终态齐全；前四失败分场保留，不称自动重连；本场仅覆盖其有限条目。
见同一验收的mainsailTrustedLifecycleFollowUp；cd91旧包证据归属不变。

同1735包的JWT文件维护现分场验证原生chooser上传／metadata、944字节单选下载、
下载后View3D与844／995不同层路径，以及CodeMirror仅追加注释后Save／Close／重开
和74字节精确回读。原N导航原因未定，N-diag与独立配置专场的部分／成功结果分别保留，
不倒写原失败；后续队列及故障恢复见下段，分场结论各自保留。
见同一验收的mainsailJwtMaintenanceFollowUp；没有产品更改或实际设备操作。

同1735包的JWT队列专场现完成忙时入队、同job／request的原生Pause／Resume和恢复推进；
长任务完成后两次相隔29.191秒的状态保持history1／队列暂停且未续打，随后在产品自有
清台页请求确认、勾选并明确开始不同短任务，最终两条completed／空队列paused。
该唯一场653.001秒、九检查点截图齐全、清理0错；额外扩展／非任务页只观察不操作，
不称私有profile无扩展。见同一验收的mainsailJwtQueueFollowUp；同包A4汇总见下段。

同1735包的JWT外部故障恢复唯一场411.328秒完成：真实joined SIGKILL及离线502，
显式RECOVER新PID后旧任务interrupted，经原生TRY AGAIN／Firmware Restart转为旧cancelled，
重新归位后不同短任务completed，再原生Clear print stats保持两条history并回idle。
原owner保留fault_business_pass_screenshot_missing和三缺图；018独立恢复实图补充视读，
不倒写017。原定义A4九项现由同1735固定Mainsail各独立场覆盖，详见Delivery映射与
同一验收的mainsailJwtFaultRecoveryFollowUp；全A集成／服务重获预算／G3／实机等仍开放。

后续客户端默认仅验 Mainsail；历史 Fluidd 证据和失败保留，用户另行指定时才追加，
不要求每批重复双客户端。

当前已推送头9a62b43b4（实际合成检出989faf643）的host／Build／motion三组CI全部成功；
Node26.12普通5413／5413、协议／Linux MCU及两sanitizer通过，Build两轮各37文件239例、
十项motion各50次fresh通过，不能据此关闭184间歇G3。
同1735原42比较最大1.10412／鉴权最高3.58983微秒<10；原28工厂启动比1.00602，
均按原704基线／原负载与1.5门限一次完成，28是单benchmark进程内28次工厂实例，并非28冷进程。
旧435／13a65f的5402通过和8e2三失败保留；服务重获2.62602>1.5、本机11／16／14失败、
G3、正常develop→master集成、真实设备与完整迁移仍开放。原失败与435见ciFixtureFollowUp，
当前CI及原42／28预算见[现有验收](host/contracts/system-bus-provider-acceptance.json)的currentCandidateExitValidation。

下述为历史cd91包的A4记录，1735有限可信场单独见上文，不合并为同包完整验收。
同包Mainsail2.19.0的A4有限场已验证真实上传、测试printer.cfg仅追加注释后保存／
重开／严格回读，以及忙时入队、暂停／恢复、长任务完成不自动续打、明确清台后
不同短任务完成。清台确认在产品自有/_client/queue页，不冒称Mainsail原生按钮。
原菜单下载canceled、原600秒窄补验工具中断与两次设施定位失败均保留。
后续同包真实单选文件的header Download已完成：Playwright默认所有权failure=null，
实际saveAs为944字节，SHA-256与上传输入一致。最终仅预览场通过真实可见滑块点击
自然取得焦点，再用原生键盘选择844／995；两张实图可辨第一层外框与第二层较小内框。
下载场8312毫秒、隐藏role容器定位失败场17547毫秒、最终预览场12785毫秒均含清理，
各场进程及端口终态已核，旧归档不覆盖。合成输入不代表实际切片器或物理层高证明。
本轮IAB实际不可用，使用已授权共享Playwright＋独立私有Edge、默认sandbox；
仅JWT网关路线。A4仍缺当前包打印中刷新／短暂断连、独立明确取消、标准RESTART
的实页组合及显式可信网络边界记录，不把FIRMWARE_RESTART或历史其他包替代这些项。
证据见[客户端验收](host/contracts/client-recovery-followup-acceptance.json)的mainsailA4FollowUp与mainsailNativeDownloadPreviewFollowUp，历史失败和旧归档不覆盖。

当前同包客户端恢复候选增加单条 `SDCARD_RESET_FILE` 兼容入口，始终复用原生
取消／重置所有者、原请求与代际准入，不自动重启固件、归位或打印。
新锁包cd91f2e3与692个独立发射JS一致，原生及依赖复用；受影响源码／产品／
最低26.9各42项通过，独立JS首41／42及修正文件5／5分次保留。
同一真实gateway＋模拟双MCU的Fluidd1.37.6与Mainsail2.19.0页面各完成一次
外部SIGKILL→明确进程恢复→页面Firmware Restart→旧任务取消→页面归位及
不同新任务完成；Mainsail页面Clear print stats另确认单条新命令及两条历史保留。
原Fluidd Reset路径不可达、工具断页与审批拒绝均独立保留，不改产品状态映射。
预注册27行操作预算两比较0.95302／0.76663倍通过，不能关闭下述服务重获
2.62602倍失败或更广同包客户端／完整预算／实机／正常集成门禁。见
[客户端恢复验收](host/contracts/client-recovery-followup-acceptance.json)。

当前内部服务属性／安装候选接入真实工厂的固定与旧安装消费者：CLI／D-Bus
事实、同一manifest摘要和root证明共同约束安装及fresh Node设备准入，不公开环境内容。
Windows19及类型通过；Linux源码重点22项，独立JS、实际726项产品与
最低26.9源码／产品四层各112项通过；692个生产JS与独立发射一致，原生和依赖明确复用。
预注册冷启动1.06765倍通过；重获优化后仍2.62602倍，超过原1.5门限，
两轮完整56样本和首次失败保留。候选81d019bfb未发布；8e2普通CI三失败与夹具修正
按上述独立记录，435新头CI已过；性能／正常集成及
同包完整客户端／实机门禁均未关闭，详见[服务属性与安装验收](host/contracts/system-bus-provider-acceptance.json)。

前序 none 显式电源候选已通过Windows19项，以及184的Linux源码30＋80项、
独立JS／实际725文件包各110项、最低Node26.9源码／产品各110项和类型检查。
真实loopback HTTP、原SQLite重开、当前/proc身份、guard生命周期及假电源命令
均在隔离夹具验证；691运行时JS与独立发射相等，原生／锁定依赖明确复用。
窄API9比较最高1.0853倍，28次／版冷导入1.0031倍（均1.5阈值），不替代
完整42／28预算。该批已推送PR #68的4d981922；be2十五项CI属于更早记录，
4d已有motion／sanitizer成功，普通CI终态另行核验，不覆盖当前属性消费者；候选仍待本提交CI与正常集成。
历史本机11失败、G3和实机门禁保留，详见[验收](host/contracts/system-bus-provider-acceptance.json)。

Supervisor 分组进程候选现保留完整 `group:name` 与显式控制范围，
Windows Node26.9 新旧23项通过；Linux源103项通过，实际724文件包及独立JS
按初轮失败和补验分别保留证据。全量5354项仍有11失败，G3及集成未关闭。
前序51f583ae CI的唯一配置预期失败已最小修复，原失败保留；
本批证据与未验边界见[交付计划](docs/Node_Host_Delivery_Plan.md)。
旧安装迁移现接入真实 Node 进程工厂：在取得进程资源前只读导入原
LMDB／复用旧 SQLite 身份，保留原 API key、JWT 和原记录数值字节；
旧物理目录以受控别名接线，文本／UFP 模型导入独立发布库并保留源文件。
跨 include／DEFAULT 配置按原解析器保存，恢复记录阻断未知结果重播；
所有配置来源、部署证明和独立 Node marker 均确认后，新进程才取得设备。
配置错误的一次备份回退须先成功释放首轮资源，备份进程仍阻断安装和设备。
本机已通过源码／独立 JS／实际新包／最低 26.9 的受影响 66 文件验证，
独立 JS 的 WAL 夹具补验与历史失败分次保留。标准完整构建 CLI 新编
12 个原生输出，717 文件包的 676 运行时 JS 与严格独立编译逐项相等；
实际旧 API key 的安装后完整 1000 次运动旅程及导入文本／UFP 模拟打印
通过。原五场同包均通过，42 个 AB／BA／AB 预算最高 1.112 倍、鉴权
最高 3.668 微秒，28 次启动中位 1.033 倍；最终最低 26.9 标准类型检查
及源码／包／原生／依赖摘要再核验通过，见
[旧安装验收](host/contracts/legacy-install-lifecycle-acceptance.json)和
[交付计划](docs/Node_Host_Delivery_Plan.md)。上述证据属于普通 UID
隔离文件及模拟 MCU；完整 Moonraker、宏／G3、ARM64
执行、真实特权部署与实机验收仍开放；klippy 仍有 177 个 Python 文件，
其他 Python 与完整替代尚未完成，新头 CI、集成和主线发布须另行完成。

首次新头CI因LMDB测试C夹具行长失败，纯格式补验保留。随后7e5ca444
的Build／motion成功，host在Node26.11.1的5313项中5279通过、34失败：
33项依赖本机临时目录，1项LMDB构建随机路径破坏字节可复现。当前修复
使用平台临时目录和稳定C来源路径，并修正导入取消时未读管道阻塞退出；
原CI失败及本机Rust崩溃保留。新718包的684 JS严格编译逐项相等，
源码／独立JS／实际包／最低26.9各65项及同包完整原key模拟旅程通过；
构建采用CPU0＋jobs1控制条件，应用验收为普通调度，默认稳定性未证。
本候选尚待自身CI与正常集成，见
[移植性与取消验收](host/contracts/legacy-ci-portability-acceptance.json)。
历史[格式补验](host/contracts/legacy-lmdb-fixture-format-followup.json)不覆写。

以下固定布局、编译进程与日志数据均为前序批次记录；其“未执行完整
构建 CLI／旧安装迁移未接入”的范围由本次上述证据更新，历史失败保留。
已有固定 Node 布局现接通真实 SUDO 安装消费者：固定服务与旧env
备份、批准配置原子保存、独立Node版本确认后，经原响应提交与进程
退役请求自重启；新进程重新验证才取得设备。默认polkit／NNP与Python
入口保持，legacy安装迁移／真实特权部署仍开放。四文件最低26.9的
23项、原回归253+245分次、实际编译profile CLI、原42预算及五场同包
模拟打印通过，另安装后新进程的完整同包旅程及28次启动通过；
历史失败保留，704包667运行时JS及独立helper与独立
emit逐项一致，原生指纹核验复用。接线与恢复见
[启动说明](docs/Node_Host_Startup.md#固定-node-安装校验与-sudo-消费者)及
[安装验收](host/contracts/sudo-install-lifecycle-acceptance.json)，本批须自身CI。
标准类型检查与产品构建 API 现通过独立解析／直接平台编译器
所有者运行锁定 TypeScript 7，无临时 shim；取消后等待真实子进程、
管道及自有进程组收口，不能确认时保留暂存与锁。Linux x64／ARM64
启用，实际本机验收为 x64。标准 npm typecheck、构建 API、最低
Node.js26.9 和两版各 13 项相关测试通过，700 文件及依赖摘要
与原包完全一致。未新编原生或执行完整 npm 构建 CLI，旧 execve
异常原因仍未证，见[编译进程证据](host/contracts/typescript-process-owner-acceptance.json)。
前序 a3506c84 的十五项 CI、5214／5214 已成功，见
[该头终态](host/contracts/pr68-a3506c8-terminal.json)；本编译增量须自身 CI。
原生进程现生产应用与打印诊断日志，并将同一文件接到标准下载和
`/server/logs/rollover`。专用私有目录、午夜／手工轮转、两份日期备份、
CLI 选项及强制终止后的轮转恢复见[启动说明](docs/Node_Host_Startup.md)。
源码与独立 JS 各 541 项通过；实际包原 498 项、新增 42 项及
修正临时驱动后单验 CLI 1 项通过，保留原驱动失败；最低 Node.js
26.9 的 50 项通过。原 42 预算、五场完整同包模拟打印及固定
28 次进程启动通过；预算最高 1.263 倍，启动为 1.055 倍，见
[日志生命周期候选](host/contracts/process-log-lifecycle-acceptance.json)。
日志只覆盖实际生命周期／故障枚举，完整组件日志、外部 Klippy 轮转、
完整 Python／宏／实机交付及新头 CI 仍开放。前序 ca8527ee 十五项
CI、5190／5190 已核实，见[前序终态](host/contracts/pr68-ca8527e-terminal.json)。
原异步模板现在复用最后一份完全相同的不可变 JSON 上下文，
每次调用的回调仍独立，整数、浮点、负零及大整数语义保持。
新标准包 140 项、最低 Node.js 26.9 的 140 项通过；原三组
模板预算全部通过，直接 UI 最高 1.375、工厂 UI 最高 1.354。
原 42 项高频预算及三轮完整模拟打印通过。历史 UI／G3／
原生构建稳定性门禁仍开放，见
[上下文复用证据](host/contracts/template-context-cache-acceptance.json)。
欢迎入口 5b77d8fa 的十五项 CI、5182／5182 已通过，见
[精确终态](host/contracts/pr68-5b77d8f-terminal.json)；新的原生增量须自身 CI。
原生应用现接通完整原版 Moonraker 欢迎模板，身份显示、公告、
警告及主机信息来自现有进程所有者；HTML／脚本内容安全编码，
私密模板值不进入页面。HTTP／HTTPS 与前缀根入口共用原容量、
取消及退出规则。三种方式各 490 项、最低 Node.js 26.9 的 18 项、
原 42 项预算及三轮同包模拟旅程通过，补验含 2388 次欢迎页读取。
欢迎入口当时直接 UI 为 1.888 > 1.5，历史门禁未关闭；SUDO 密码流程、日志、
完整 Python／宏和实机交付仍待完成。见
[欢迎入口证据](host/contracts/application-welcome-owner-acceptance.json)。
前序 0b2cc747 十五项 CI、5164／5164 全成功，见
[精确终态](host/contracts/pr68-0b2cc74-terminal.json)；本增量须自身 CI。
原生配置入口现提供 Moonraker 的 GET /server/redirect，复用现有
授权及完整目标 URL 的 CORS／NSS 校验，支持配置前缀、HTTP／HTTPS
和 Unicode；重定向许可不授予 API 或打印身份。等待期间取消或
吊销凭据时不发送 Location。源码／独立 JS／实际包各 334 项、
最低 Node.js 26.9 实际包 17 项、原 42 项预算及同包模拟打印通过。
欢迎页面原模板、日志入口和完整 Python／宏／实机交付仍待完成。
见[重定向证据](host/contracts/application-redirect-owner-acceptance.json)。
前序 8a68d5c 十五项 CI、5147／5147 全成功，见
[精确终态](host/contracts/pr68-8a68d5c-terminal.json)；本增量须自身 CI。
配置的直接 HTTPS 现与 HTTP 共用原网络、身份、文件与退出所有者，
真实 TLS 回执保持协议，证书预检在 MCU／日志之前，冲突回滚。
源码／独立 JS／实际包各 294 项、原 42 项预算及同包 HTTP／HTTPS
模拟打印通过，最低 Node.js 26.9 的 TLS 释放检查通过。前序
fdc4b27e 十五项 CI、5142／5142 成功，本增量须自身检查。见
[直接 TLS 证据](host/contracts/direct-tls-owner-acceptance.json)及
[前序终态](host/contracts/pr68-fdc4b27-terminal.json)。
配置的 `[server] route_prefix` 现作用于已有 HTTP／WS、文件及
标准／OctoPrint 上传；网关支持带前缀私有上游，登录与回执仍使用
固定公共入口。源码／独立 JS／实际包各 258 项、原 42 项预算及
根路径／Unicode 前缀同包模拟旅程通过，658 个运行时 JS 逐项
匹配。前序 5c554954 十五项 CI、5137／5137 成功，本增量须
自身检查。见[路由证据](host/contracts/route-prefix-owner-acceptance.json)、
[启动说明](docs/Node_Host_Startup.md)及
[前序终态](host/contracts/pr68-5c55495-terminal.json)。
可信代理后的标准／OctoPrint 上传回执现沿原信任与 NSS 所有者选择
HTTP(S)：X-Scheme 优先，取最后一项，禁用或未验证代理保持原真实传输协议。
请求 Host 与原编码路径保持，转发主机和令牌不进入 Location。
先拒绝坏凭据，协议等待后再核对身份，暂存前完成；源码、独立 JS、
实际包各 244 项通过，原三组预算最高 1.163 倍，原模拟打印通过。
前序 8ad4edae 十五项 CI、5119／5119 通过；本增量须自身 CI。
见[代理协议证据](host/contracts/proxy-protocol-owner-acceptance.json)和
[前序精确头终态](host/contracts/pr68-8ad4eda-terminal.json)。
可信代理授权现接通 `[server] use_xheaders`（默认 true），选取最后
一项 X-Forwarded-For，X-Real-IP 优先；匿名代理授权须同时信任实际
连接与客户端。未经验证的头不能改变登录计数或短时令牌绑定地址，
畸形声明拒绝，原凭据优先级保持。源码、独立 JS、实际包各 47 项
通过，原三组鉴权／网络最高 1.101 倍，原模拟打印预算通过；原生
与数学输出不变。见[代理授权证据](host/contracts/trusted-proxy-owner-acceptance.json)。
前序 017ab911 十五项 CI、5106／5106 通过，见
[精确头终态](host/contracts/pr68-017ab91-terminal.json)。代理头 b7dbc339
普通 CI 5117／5118，一项模拟 MCU 启动返回 Invalid uptime response；
协议／MCU 构建步骤跳过，原因未证。新增测试失败的有界时钟捕获，
相关产品／诊断 25 项与扩展诊断 6 项通过，启动保护保持。本增量须
自身 CI。离线滤波另有确定性抵消反例，但两版精确求和候选未通过
原编译性能门限，均撤回；保存 G3 输入重算不能解释原异常。
见[原失败与撤回证据](host/contracts/motion-adaptive-sum-rejected.json)。
UI 分阶段调查现保留两版私有探针各 121 项回归及全部交错记录。
同一进程的跨 L3 缓存组交接约 3.9／5.0／3.9／4.9 微秒，高于同
缓存组约 2.4／3.4／2.4／3.3；这不是历史根因证明。工厂 UI 没有
调用消息，下一处设计聚焦减少必要交接，原 1.5 门限不变。首次
全新探针构建的 rustc 内部崩溃仍保留，原生稳定性门槛未关闭。
UI 性能调查新增完整类型的原生结构化消息原型，独立编译与功能
验证通过，但三组直接 UI 为 1.538／1.567／1.536 倍，工厂 UI 为
1.697 倍，未通过原 1.5 门限，未接入。先前两个运行时候选及全部
失败仍保留。新增完整消息元数据容量边界的两项回归；源码、独立
JS、原实际包各 121 项通过，运行时和运动／数学原生输出不变。
完整样本与私密快照反例见
[UI 终态调查](host/contracts/template-ui-terminal-probe-acceptance.json)。
前序 b41e33f3 十五项 CI、5104／5104 通过，见
[精确头终态](host/contracts/pr68-b41e33f-terminal.json)；本记录须自身 CI。
配置 CORS 的数字 Origin 回退现共用原主机名信任／NSS 缓存；跨域
许可与 API 身份独立，强制登录和错误凭据仍拒绝。HTTP／升级等待
纳入原期限、取消、关闭和容量，升级连接 EOF 不留等待。源码、
独立 JS、实际包各 44 项通过，原网络三组最高 1.041 倍，保持 1.5
门限；跨域原模拟打印混合场景通过。见
[CORS 共享所有者证据](host/contracts/cors-trusted-domain-owner-acceptance.json)。
前序 8bd11bdb 十五项 CI、5092／5092 通过，见
[精确头终态](host/contracts/pr68-8bd11bd-terminal.json)；本接线须自身 CI。
驱动电流设置现与原空闲时钟维护共用调度所有者，仅等待已准入的
空闲时钟工作；等待后重新核对权限、身份、状态令牌、型号限制和空闲。
原十秒包含等待，打印／其他维护仍拒绝，物理失败保持原安全停止。
源码、独立 JS、实际包各 50 项通过；原查询三组最高 1.009 倍，
调度就绪查询补充对照最高 1.014 倍，保持 1.5 门限。原模拟打印混合
场景通过，运动／数学原生输出不变。见
[驱动电流调度证据](host/contracts/driver-current-clock-admission-acceptance.json)。
前序 5ee090ca 十五项 CI、5081／5081 通过，见
[精确头终态](host/contracts/pr68-5ee090c-terminal.json)；本修复须自身 CI。
trusted_clients 主机名查询现接入原配置授权与 HTTP／WebSocket；
NSS 查询五秒、独立受控子进程，数字地址仍走同步路径。源码、独立
JS、实际包各 40 项通过；四路原鉴权三组预算最高 1.083 倍，保持
1.5／10 微秒门限。最终包原模拟打印混合场景通过；前一配置包的
初始化 idle 409 具体原因仍跟踪。见
[主机名证据](host/contracts/trusted-client-domains-acceptance.json)。
前序 68aeffa8 十五项 CI／5063 项普通测试通过，本增量须新头 CI。
标准上传目录现接受客户端的根相对 `path="/"`，保留穿越拒绝、
逐级鉴权、原发布／打印／队列与配置写入所有者。源码、独立 JS、
实际包各 118 项通过，三组原上传预算最高 0.995 倍，保持 1.5 门限。
Fluidd 新包页面完成两份真实文件选择上传和打印、队列及同包进程
重建、新确认后的第三份打印、配置注释编辑保存，605 秒关闭。
Mainsail 同包实际页面完成两份普通选择器上传、明确打印第一份、
打印中从文件菜单入队、进程重建后队列／完成历史保留及配置注释保存；
普通上传未自动打印或排队。R42 同包又完成重建后的页面归位、
新清台请求／勾选／提交与第二份完成，身份不同、队列为空，465 秒关闭。
场次 889 秒关闭，浏览器沙箱开启且临时档案已删除。固定地址的
内置浏览器文件选择仍曾长等待，不能把端口固定等同于阻塞已解决。
见[Mainsail 页面证据](host/contracts/mainsail-upload-recovery-acceptance.json)。
见[目录与页面证据](host/contracts/client-upload-path-acceptance.json)及
[上传队列软件证据](host/contracts/upload-queue-intent-acceptance.json)。
运行时头 81e9a21d 十五项 CI、5063／5063 通过，实际合并检出
7ac9a1f9，见[终态](host/contracts/pr68-81e9a21-terminal.json)。
本记录增量须自身新头 CI；故障／实机、全部迁移及正常集成仍开放。

Fluidd G28 已与原空闲时钟维护共用调度所有者，等待后保留权限、
代际、空闲和维护检查，原 120 秒包含等待。源码／独立 JS／实际包
各 39 项通过，三组原准入预算最高 1.384 倍，保持 1.5 门限。
固定端口的新包 R37 页面完成归位、打印、取消、标准固件恢复、
再次归位及另一份任务完成；原取消日志保持，308 秒关闭。
Mainsail R33 历史旅程已通过，Fluidd R34 原三次 409 证据保留，
本修复不以 HTTP 归位替代页面。见
[当前归位调度验收](host/contracts/native-home-clock-admission-acceptance.json)及
[历史恢复证据](host/contracts/client-recovery-followup-acceptance.json)。
前序 887d2713 十五项 CI、4917／4917 通过，本运行时修复须新头 CI。

HTTP 组件 JSON 补齐固定上游标准库后备实现的 UTF-8／16／32 编码，
自动识别字节序与单个 BOM，并无损保留代理字符；文本解码与公共
RPC／运动保护保持原行为。103 个冻结案例及消费者组合在源码、
独立 JS、实际产品包各 242 项通过；六条既有路径三组对照最高
1.093 倍，原 1.5 门限保持。新包 687 项，仅两个编码 JS 有差异，
已核对 75 个原生来源并复用原输出，未宣称重新原生构建。
见[编码验收](host/contracts/http-json-bytes-acceptance.json)。前序
`9591c2e5` 十五项 CI、4811／4811 通过，本编码增量须自身 CI。
清台页面现读取原打印所有者与维护门禁的就绪提示；正在打印或状态未知
时禁用下一份确认，不提示用户取走成品。就绪恢复后仍须重新勾选，
后端继续核对令牌、权限和设备代际。源码／独立 JS 各 70 项通过，
固定三组查询比 1.041～1.064，原队列 50／50／100 ms 预算保持。
新完整包只有三个接线 JS 变化，原生输出一致；同包两份独立确认任务
完成，场次在 603 秒关闭。见[清台就绪证据](host/contracts/queue-readiness-acceptance.json)。
前序 `72c442e3` 十五项 CI、4807／4807 通过，本修复须自身 CI。
客户端标准 `G28` 已接入同代际的受控归位，支持 X／Y／Z 选择；
保留空闲、独占维护、重新鉴权、取消和 120 秒边界。源码、独立 JS
及两客户端使用的完整包各 13 项回归通过；原归位准入三组对照最高
1.190 倍，原生探测预算通过，运动及打印内核字节不变。
固定端口下 Fluidd／Mainsail 均确认归位、打印完成及暂停／恢复；
Mainsail 同包进程重建后队列／历史保留。场次在 543／515 秒关闭。
同一包的 R29／R30 又确认两客户端取消及标准固件恢复；取消沿原安全
停止进入保护状态，须显式重新初始化。原模拟 MCU 的复位／配置计数
确认恢复，Mainsail 的取消历史和请求身份保持。实际浏览器下载的
944／18,785 字节分别与原件 SHA-256 一致；场次在 836／458 秒关闭。
Fluidd 下载工具本次仍等待约 516 秒，固定来源不能保证工具不挂起。
文件选择上传、配置编辑、恢复后再次打印及完整队列仍未计为通过。
已有本会话授权持续适用，见[归位与页面证据](host/contracts/native-home-compatibility-acceptance.json)。
代码头 `d782761f` 十五项 CI、普通 4807／4807 通过；本记录修改须自身检查。
标准摄像头快照探测已接入进程 HTTP 所有者，与公告共享连接资源；
保留四路／1 秒及解压后 8 MiB 边界，读取后丢弃图片流，不缓冲整图，
也不读写共享条件缓存。源码及禁用 TS／外部程序的独立 JS 各 26 项
通过，三组固定桌面对照最高 1.091 倍，原 1.5 门限保持。
模板 UI 的整数直传原型因交错样本失败未采用，原协议和 UI 门槛仍开放。
见[摄像头接线及完整原始记录](host/contracts/webcam-http-owner-acceptance.json)。
前序 `a0c3a4a0` 十五项 CI、普通 4801／4801 通过，本增量须自身检查。
此前代码头 `2bdf89ac` 的十五项 CI 与普通 4801／4801 已通过。
同头完整包已重建、核对 686 项清单并独立安装 18 个锁定生产依赖；
禁止 TS 加载及 PATH 外部程序的冒烟、固定数学输出对照和原模拟
打印混合 API 旅程通过。原模板 UI 预算仍有 2.060／1.506 倍失败，
保持 1.5 门限。Fluidd 页面上传工具跨过期限后返回，无上传请求记录，
场次在 888 秒关闭；未计作页面上传通过。见
[当前整包证据](host/contracts/current-bundle-2bdf-acceptance.json)。
后续本机 Fluidd／Mainsail 浏览器来源固定为 127.0.0.1 的
18430／18434，不再随场次递增；端口占用时不自动换端口或停止他人服务。
HTTP 组件 JSON 现支持超过 i128 的精确整数收发及 304 缓存复用；
超出安全整数范围使用 BigInt，常规数值保持 Number／binary64。
共享解析器沿用私密文件的原始词法与资源限制，不扩展公共 RPC／
运动入口。源码及禁止 TS／外部程序的独立 JS 各 136 项通过，
含 1000 组混合数值案例；六条路径的固定三组桌面预算通过，初版
两项退化完整保留，见[精确 JSON 证据](host/contracts/http-exact-json-acceptance.json)。
前序 `79145759` 十五项 CI、普通 4784／4784 全通过；本增量需自身 CI。
标准服务新增进程拥有的 Node HTTP／HTTPS 客户端，公告使用同一
所有者，关闭时取消并排空请求。支持条件缓存、重试、响应解码、
GitHub 限额、请求包装和有界流式下载；提交前失败或取消保留旧文件。
源码与禁止 TS／外部程序的独立 JS 组合各 43 项通过，下载鉴权及
提交后清理补充的受影响单元各 15 项通过。公告及请求原桌面预算通过，
不代表完整 HTTP 兼容、Python 对照、当前完整包或打印性能验收。
见[HTTP 组件与公告证据](host/contracts/moonraker-http-client-acceptance.json)。
前序路径头 `13859b3e` 十五项 CI、普通 4768／4768 全通过；
本增量须自身规定检查。
MQTT 密码文件及 Klippy 显式路径上下文现支持 NSS 命名用户目录；
Klippy 的有效长链接链、共享模板与空渲染结果按固定上游处理。
MQTT 文件路径保持字面量与内核物理遍历，不进行模板渲染。
源码及禁止 TS／外部程序的独立 JavaScript 各 137 项通过；日常
Klippy 配置基准移除 Python。冷启动 1.325 倍、路径对照最高
1.321 倍及既有配置预算通过，初版冷启动退化与原基线超限均保留。
见[路径消费者证据](host/contracts/moonraker-path-consumers-acceptance.json)。
前序文档头 `bb967405` 的十五项 CI 全通过，本增量须自身 CI。
代码头 `997417d4` 的十五项 CI、普通 4740／4740 已全通过。
固定失败命令的六核心顺序及单批并发对照各六项成功，库／元数据
字节一致；一次固定 CPU 0 的完整当前源码构建成功，已独立安装
锁定依赖。它不证明原编译器失败根因，也未修改默认运行亲和性。
同包 Fluidd 两层预览、控制进程重建后的文件／队列／配置读取通过；
944 字节鉴权 API 下载与原件一致，未计作浏览器下载。
Mainsail 登录和文件列表通过，上传工具等待约 35 分钟返回时场次
已过期，上传／预览／恢复未验证。两场均在 15 分钟内关闭。
当前新包工厂 UI 2.059 倍仍超限；完整客户端旅程与迁移继续开放。
见[构建控制及同包部分验收](host/contracts/native-affinity-client-acceptance.json)。
异步调用消息现将已有类型参数直接写入 64 KiB 有界外壳，取消
第二棵参数树的复制；回复通道、线程、协议及数值标签不变。
源码与关闭 TS／JS 外部子进程的独立 JavaScript 各 183 项通过，
含精确消息容量、转义、i128、负零及双线程回复隔离。
宽参数固定对照的耗时比值 0.819，进程峰值 RSS 没有下降。
小参数 UI 原预算仍有超限；回复槽及整树流式原型已因性能撤回。
单并行完整构建又在 regex-automata 编译器内部索引越界处失败，
不能将单并行新包一次成功推定为稳定性修复。前序 `6f027708`
十五项 CI、普通 4736／4736 全通过，不覆盖本次消息改动。
见[消息边界与全部原型](host/contracts/template-call-envelope-acceptance.json)。
代码头 `fff160bf` 的十五项 CI、普通 4736／4736 全部通过。
一次只将 Cargo 并行度设为 1 的全新原生对照及完整产品打包通过，
新包独立安装锁定生产依赖，禁用 TS 加载及 PATH 程序的冒烟通过。
覆盖工作进程、原生队列、同步／异步／UI 模板及取消；不证明实机。
默认并行捕获仍在 num-bigint 的 LLVM 优化路径 SIGSEGV，两次固定
单命令重放均成功，增大栈未给出区别，根因和并行稳定性继续开放。
新包独立 UI 回调 1.801 倍仍超过原 1.5 门限；原失败不撤销。
见[构建对照与新包证据](host/contracts/native-build-investigation.json)
及[该提交 CI 终态](host/contracts/pr68-fff-terminal.json)。
异步模板候选现直接传递完成文本，共用不可变原生环境和一个进程内
截止计时器；源码与关闭 TS／JavaScript 子进程的编译组合各 179 项
通过，包含并发／排队超时、晚注册全局、取消及 64 KiB 输出。
工厂三条固定预算通过，但独立 UI 回调最终单轮 1.781 倍仍失败；
三组交错对照也保留超限，不宣称性能门槛已关闭。此前默认并行快照
失败，本次为 regex-automata 编译报告异常巨大内存分配并 SIGABRT；
缓存项目编译成功不能覆盖它。见
[异步开销记录](host/contracts/template-completion-acceptance.json)。
门控头 `bdf23246` 的十五项 CI、普通 4732／4732 随后全部通过，见
[该头终态](host/contracts/pr68-bdf-terminal.json)，不覆盖新异步改动或旧失败。
普通原生启动现将配置传感器及进程提供者注册到同一历史字段表，
按控制器确认的任务／暂停状态累计；设备重建保留注册表与连接。
重复预约回滚字段重置，首次终态冻结，退出先等待控制器释放借用。
源码及关闭 TS／外部子进程的独立 JavaScript 组合各 381 项通过，
产品／实际 SIGKILL 恢复组合各 24 项通过。默认／64 字段提交比值
0.958／1.163，查询 1.029／1.038；原生门控每万帧的默认／64 个
未用全局函数比值 1.122／1.275，均通过原 1.5 桌面门限，见
[门控接线记录](host/contracts/native-history-fields-acceptance.json)。
上一日志头 `95353207` 的 CI 为 13／15，普通 4719／4719 通过；
两个源码运动诊断遭原有十秒期限终止，底层原因待查，见
[该头终态](host/contracts/pr68-953-terminal.json)。不放宽期限或 G3 精度预算，
新提交须自身 CI；这不完成全组件、新包、客户端或目标板验收。
原生打印日志现可随预约／终态保存辅助快照，在同一事务中更新任务、
统计及辅助累计值；失败回滚、重启、迁移、隐藏与重试已有回归。
源码及禁用 TS／外部子进程的独立 JavaScript 组合各 274 项通过。
默认与 64 字段压力的提交、启动及普通查询均通过冻结性能门限，
完整历史详情保留全部字段并另计耗时；旧全量解码查询的失败保留。
数据格式升级到第 6 版，旧程序不支持直接读取新格式；日志增量的
范围见[辅助日志记录](host/contracts/native-history-auxiliary-acceptance.json)，
其后的自动接线见上。
共享传感器头 `fb7abf08` 的十五项 CI 和普通 4709／4709 全通过，见
[该头终态](host/contracts/pr68-fb7-terminal.json)，不覆盖上述新日志改动。
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
进程接入头 `5324f5e8` 的十五项 CI、普通 4665／4665 随后全部通过，
见[该头终态](host/contracts/pr68-5324-terminal.json)。MQTT 凭据加载现自动
消费 reader 已绑定的共享私密模板，拒绝竞争渲染器，临时模板始终释放；
凭据来源在公开配置中脱敏。相关源码与关闭 TS／外部子进程的独立
JavaScript 各 24 项通过，三组冻结加载预算通过；日常 MQTT 配置回归
和基准不再启动 Python，见[MQTT 消费证据](host/contracts/mqtt-template-components-acceptance.json)。
凭据消费头 `9aea5294` 的十五项 CI、普通 4684／4684 已全部通过，
见[该头终态](host/contracts/pr68-9aea-terminal.json)。标准加载器和普通产品
启动现按配置拥有 MQTT／传感器；真实消息、鉴权 HTTP、任务历史门控、
设备重建及失败清理的独立 JavaScript 回归共 64 项通过。
冻结的装配启动／1000 消息混合查询比值 1.010／1.024，通过原 1.5
桌面预算，见[配置装配证据](host/contracts/configured-mqtt-components-acceptance.json)。
装配头 `a1e4aed6` 的十五项 CI、普通 4696／4696 全部通过，见
[该头终态](host/contracts/pr68-a1e-terminal.json)。配置传感器现消费同一
共享私密环境，Rust 批量收集帧内结果，成功后再发布；源码与关闭 TS／
外部子进程的独立 JavaScript 各 215 项通过，原生产品源码及编译各 6 项通过。
每批 1 万帧的默认／32／64 个未使用函数比值为 1.092／1.262／1.267，
均通过原 1.5 桌面门限，见
[共享传感器证据](host/contracts/shared-sensor-components-acceptance.json)。
初始回调与共享函数压力超限保留；这不证明任意自定义函数的耗时、
完整模板兼容或打印速度。原生日志自动门控接线进度见上，新产品包
和目标板仍开放，新提交须自身 CI。
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
