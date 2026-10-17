# Node 主机启动与机器集成

## Linux 开发与调试环境

本项目固定使用 `10.0.0.184`。用户明确允许“本项目开发实际需要linux环境的情况下，
自行使用10.0.0.184”，持续允许在该机传输项目源码和隔离调试。
当前 none／Supervisor 任务隔离目录为
`/home/dek02/.codex/worktrees/supervisor-group-compat/ANYRAID-KLIPPER`。
每项工作先核对分支、未提交状态及覆盖前哈希；后续任务新建独立工作树，
保留旧任务修改。普通用户执行，无系统安装或权限变更；需要实际系统／
设备操作、部署或发布时仍按对应流程与授权范围处理。电源验收只允许
受控 PATH 内的假可执行文件，Node 使用绝对路径，设备使用模拟 MCU。

## 客户端验收范围

今后客户端默认以 Mainsail 为唯一验收客户端，不要求每批重复 Fluidd。历史 Fluidd 证据与失败保留，但不作为后续必需的双客户端门禁；只有用户另行指定 Fluidd 时才追加。

## 异步热时钟查询的限定行为（2026-10-16）

温度查询继续检查host时间单调性及控制print基线，但不推进该print基线；start／setTarget／保护tick仍推进。
这避免高频查询将合法估计修正误判为控制时间回退；跨控制tick回退仍保守拒绝，HeaterPWM heartbeat未改。
ADC样本递增、陈旧判断、5秒保护tick停滞、HeaterCheck和3秒输出截止保持。
Node26.12定向11文件95／95、受影响ASAN两文件36／36及标准类型检查通过；两组复用原native输出，非fresh build。
原类型检查缺输入失败另留。getter固定对比的主中位数7.647→7.403 ns／次，保留批次P95为7.692→22.116；
每批值是百万次调用平均，不是单次请求P95；无专用门限，不据此认定加速或完成全部性能验收。
[证据](../host/contracts/thermal-query-clock-evidence.tar.gz)包含固定语义反例及首次结果；它不还原6cc原ASAN失败四值，
也不把1735旧包或旧CI验证归给本改动。范围及残余边界见[交付计划](Node_Host_Delivery_Plan.md)。

## 当前固定包的启动预算边界（2026-10-16）

1735的原42比较和原28工厂启动已保留704基线、原负载／门限完成；28在单benchmark进程内，
不含模块导入、夹具准备和清理，不获取设备或证明硬件就绪。9a62精确头CI与本次证据见
[现有验收](../host/contracts/system-bus-provider-acceptance.json)的currentCandidateExitValidation；
服务重获2.62602超限、G3、正常集成及实机边界保留。后续435及旧预算待验段为当时历史快照。

## 1735 JWT外部故障恢复与A4有限出口（2026-10-16）

同173565dc／0b53079c和固定Mainsail2.19.0的隔离流程要求外部进程退出已join后，
才能显式恢复进程；旧任务保持interrupted，经页面Firmware Restart明确取消，重新归位后
才开始不同新任务。页面Clear print stats只重置当前状态，不删除旧cancelled／新completed历史。
会话代际与每个产品内部设备代际分别记录；离线API不可用不能推断数据库为空。

当前原定义A4九项已按同包独立场映射闭合有限客户端出口，详见[Delivery当前映射](Node_Host_Delivery_Plan.md)
及[客户端验收](../host/contracts/client-recovery-followup-acceptance.json)的mainsailJwtFaultRecoveryFollowUp。
原owner的fault_business_pass_screenshot_missing与三缺图保留；017恢复检查点缺图由无间隔业务的
018独立实图补充视读，不倒写原回执。完整A集成／预算／G3／实机／Python及宏等门禁仍独立开放。
本批按本地提交流程收口，未推送／合并／部署。

## 1735 JWT队列与暂停恢复有限出口（2026-10-16）

同173565dc／0b53079c、Mainsail2.19.0与184双PTY，唯一队列场653.001秒完成。
必要chooser仅长短固定打印输入；实际long printing后忙时加入短文件，原生Pause／Resume
各一次且同job000001／request保持，恢复后进度继续增加。长自然completed后，两状态相隔
29.191秒仍history1、queue paused／head短、transition null，尚无清台POST或自动续打。

清台归产品自有/_client/queue主文档：实际POST request_confirmation后仍只有旧completed，
再原生勾选checkbox并点击明确确认，第二次POST仅transition_token字段形状及摘要留存。
短job000002／不同queue-request完成，Mainsail显示短文件Complete；最终恰两条completed、
队列空且paused。完整业务／检查点时间严格单调，产品PID／startTicks和device generation1保持，
没有cancel／restart／fault。关键七图已视读，九检查点截图齐；另三次非关键截图超时保留。

本场独立780／870／900秒边界、清理0错，两端守卫无残留且端口空闲；没有失败重跑。
专用私有Edge profile仍出现扩展及非任务页，仅观察必要路径／元数据，不选择、点击或读取
其DOM；不能称无扩展环境，也不据此归因旧N导航异常。数值状态与随后截图采集时刻不同，
不强求画面百分比等于先前快照。证据见[客户端验收](../host/contracts/client-recovery-followup-acceptance.json)
的mainsailJwtQueueFollowUp；故障恢复与A4汇总见上段，正常集成及其余门禁仍开放。

## 1735 JWT文件维护分场出口（2026-10-16）

固定173565dc／0b53079c与Mainsail2.19.0，继续184双PTY和真实JWT登录。
原N场214.969秒完成chooser两文件、metadata及944字节原生下载／saveAs哈希一致，
View3D仍停在/files，缺完整页／frame／错误观察，原因未定；配置未改，不计整场通过。
N-diag场438.950秒保持先下载再View3D，在同p1/f2进入/viewer，自然键盘到844／995，
两图可见不同层路径，喷头遮挡局部；不能倒推原N根因或称产品已修复。
该场因设施误认Monaco而未改配置，仍为部分完成。

独立配置专场144.146秒按固定CodeMirror DOM／工具栏SVG及源码顺序选择Save图标
（save(null)，禁止Save & Restart）。自然焦点与文末追加唯一既定ASCII注释后，
Save／Close／重新打开和磁盘严格回读通过：原28字节变74字节，SHA为d4b30bcca95a…；
关闭与重开两张必需截图已视读。三场各1次实际WS握手，JWT cookie存在符合网关契约，
无原始Authorization／API key／access-token头或凭据query。

三场独立780／870／900秒边界均未延长，清理0错、两端守卫无残留、端口空闲；
原N缺4张截图，N-diag与配置场各缺1张login-submitted，原件／regex启动前失败均保留。
该文件维护分场没有产品更改或打印／队列／设备／重启／进程故障操作；其后队列补验见上段，
故障恢复与A4汇总见上段。证据见[客户端验收](../host/contracts/client-recovery-followup-acceptance.json)
的mainsailJwtMaintenanceFollowUp；历史cd91和原可信回环场归属不变。

## 1735可信回环Mainsail有限旅程（2026-10-16）

固定173565dc／0b53079c包与Mainsail2.19.0，在184双PTY模拟MCU、独立实际产品子进程
上完成真实chooser上传两份合成文件。无凭据GET /access/user返回_TRUSTED_USER_三字段；
浏览器HTTP与三次实际WS握手均未带凭据。打印中reload、probe父进程SIGUSR2造成1012关闭
后，使用页面TRY AGAIN显式重连；四检查点始终同job／request、start总数1、进度非倒退。
这不是自动重连通过；固定客户端clean关闭分支停止重试，源码与发包JS证据保留。

默认UI须先Pause才显示Cancel，页面直接提交printer.print.cancel，无确认弹窗；
长job000001耐久cancelled后，页面标准printer.restart令模拟设备generation由1增至2，
产品PID／startTicks保持。重新home后明确另一短job000002 completed，旧job仍cancelled，
总start2、cancel1、标准restart1，无固件重启或旧任务重放。最终场277.702秒、24张截图齐全，
Windows5／Linux3个已登记PID均不存在、两watchdog remaining为空。

原once／fix1的观察与定位失败、fix2已发一次长start后的截图超时、fix3过早重连断言均
独立保留；fix3错误标签ws-reconnected不改原件，实际DOM／截图为Connection failed。
本批IAB不可用，使用已授权共享Playwright与专用私有Edge默认sandbox；没有真实设备操作。
本1735可信场未重测下载／双层预览／SIGKILL，其余A4条目按上文分场汇总；完整预算和物理门禁不关；
见[客户端验收](../host/contracts/client-recovery-followup-acceptance.json)的mainsailTrustedLifecycleFollowUp。

## 历史cd91包同包Mainsail A4有限补验

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
证据见[客户端验收](../host/contracts/client-recovery-followup-acceptance.json)的mainsailA4FollowUp与mainsailNativeDownloadPreviewFollowUp，历史失败和旧归档不覆盖。

## 历史435已提交头CI终态与Mainsail同包边界（2026-10-15）

此前已推送头435938218（实际合成检出13a65f031）的三组CI已全部成功。
Node26.12普通测试5402／5402、零失败／取消／跳过；原三项安装进程测试通过，
该轮实际cgroup为system.slice/hosted-compute-agent.service且夹具名称一致。
协议36624字节／661帧／10002时钟比较和Linux MCU步骤成功；Build两轮各37文件239例，
十项motion各50次零失败，ASAN／UBSAN各153根TAP汇总1234通过、零失败。
8e2原5398／5401三失败和184两版各30项候选补验原样保留；旧轮未记录cgroup，
不能将新轮观测倒推为旧轮根因实证。正常集成、服务重获2.62602超原1.5、
历史本机11失败／G3与实机等独立门禁仍开放。
附加诊断读取失败只记固定类别，不改变原bootstrap结果；不记录key／环境内容。
原生、依赖和生产源码均未改；两份30项本身仅为候选有限补验，后续435整仓5402项通过另记。
记录见[现有验收](../host/contracts/system-bus-provider-acceptance.json)的ciFixtureFollowUp。
服务重获2.62602倍超1.5、历史11失败／G3、完整42／28、真实特权部署和实机仍开放。

## 同包客户端外部故障恢复（2026-10-15，未发布）

单条无参数 `SDCARD_RESET_FILE` 复用canonical取消／重置与持久journal。
命令捕获原native generation signal和request_id/state_token；活动／暂停／
中断／失败任务先等安全取消ACK与同一请求cancelled，再取该请求新token重置。
完成／已取消直接重置；无任务idle仍检查原代有效且没有pending／关闭状态。
新请求竞争、授权拒绝、取消失败、退役或超时不跨代重试，不自动执行
Firmware Restart、G28或新打印。命令参数和多命令脚本均拒绝；允许命令前后空白。

锁定cd91f2e3产品与692独立JS一致，原生84输入／12输出及依赖核验后复用。
Linux受影响源码42项、实际产品42项、最低26.9源码／产品各42项通过；严格
独立JS首41／42因旧测试子进程硬编码.ts被hook拒绝，按现有模式修正后仅该
文件5／5补验，保留首失败。最终全仓Windows TS7类型检查通过。API／工具
层两条恢复路线分别有真实gateway／SQLite／模拟MCU证明，不替代页面验收。

同包Fluidd1.37.6场358.427秒、Mainsail2.19.0场614.838秒均在各自900秒内：
真实选择上传与页面归位／长作业，监督仅杀一次精确拥有child，旧close／IPC／
模拟器join后明确启动同地址新进程；同一页面明确重连，点击可见Firmware Restart，
持久成功后旧任务cancelled、新状态idle且未归位，再页面归位和不同短任务完成。
Mainsail完成卡Clear print stats实际发送单条SDCARD_RESET_FILE，idle且历史仍2条。
前Fluidd Reset-first控件隐藏仅证明该路径不可达，不否定Firmware Restart；
该原场工具context丢失／新登录和正常收尾取消不能记成UI恢复通过。
Mainsail有Connection failed及SIGKILL证据，未捕获离线502；两次自动审批拒绝
保留，具体模拟短打印收到直接用户许可后继续原对话框。整个私有浏览器profile、
认证库和会话响应均不进入证据包；业务事件仅限允许路由，无鉴权headers。

预注册27行包含3warmup＋每变体8正式，原输入与1.5门槛不变；canonical候选／
基线0.95302倍、script／候选canonical0.76663倍通过。此为隔离完整操作延迟，
不代表打印速度／物理精度，不关闭服务重获2.62602倍超限、G3、历史11失败、
完整42／28、真实特权部署、ARM64、实机及当前候选CI／正常集成门禁。原始记录见
[现有客户端验收](../host/contracts/client-recovery-followup-acceptance.json)的externalResetFollowUp。

## 内部服务属性与安装准入（2026-10-15，未发布）

真实进程工厂从同一 machine provider 借用内部 `serviceInfo` 所有者，
固定安装与旧安装消费者直接使用它；不增加公开 service_info 或环境内容接口。
D-Bus 保留 typed argv 与全部 EnvironmentFiles；CLI 保留完整显示字符串，
不从显示引号反推 argv；Supervisor 仅返回原 program 属性，不能伪造 systemd
身份或自动改写其安装；none 自动服务安装明确不可用。已有显式可信
`serviceIdentity` 和外部部署能力继续走其原边界。

安装来源、目标声明和 fresh 进程分三阶段核对。旧 unit 的 ExecStart 仍写
Python、实际进程已运行 Node 时，来源身份使用当前 PID/startTicks、服务归属、
原 unit 字节及批准 manifest 联证，不把声明当成正在运行的可执行体。
目标阶段还核对实际 `/proc/self/cmdline` 的 NUL 参数边界、真实 executable、
当前账号、固定 Node unit/profile/bundle/config 摘要与 root 公共证明。
`/proc` 参数本身可变，不能独立授予部署权限。新的 transition 记录放在原
恢复 journal；同一 PID/startTicks 重建对象仍不能冒充 fresh 进程。旧成功
journal 没有 transition 时，仍须通过实际目标和完整既有字节证明，不补造历史字段。

安装副作用及每次真正 createAdapter 前异步刷新属性；设备准入还重新确认
磁盘 unit/candidate 摘要，不能用未 daemon-reload 的旧 show 输出掩盖文件变更。
CLI 先校验全部 cgroup hierarchy，再比较最深服务归属；仅有效且没有服务归属
时查询当前 PID 的唯一首标题。已成功验证的 unit 仅可作路由提示：完整 cgroup
不变时当次 status(PID) 与 show(hint) 并发，两结果须一致；错误、失配或取消撤销
提示及旧证明，并等待两 child 实际退出。没有 TTL 或准入证明缓存。
CLI 的 `show <数字>` 是 job 查询，不能替代 PID 服务发现。

systemd v256 的 [show 实现](https://github.com/systemd/systemd/blob/v256/src/systemctl/systemctl-show.c#L1273)
用空格拼接 argv，两个不同参数数组可有相同显示；因此 CLI 显示仅为事实。
[数字参数分支](https://github.com/systemd/systemd/blob/v256/src/systemctl/systemctl-show.c#L2153)
区分 show 的 job 与 status 的 PID。属性和环境路径均不作为 shell 指令或任意文件读取授权。

Windows最终19项与类型通过；Linux并发版源码重点22项、独立JS／实际产品／
最低26.9源码和产品四层11文件各112项通过，fail/cancel/skip/todo均零。
726项产品清单另计build-info，692个生产JS（host/src685＋辅助7）与独立发射
逐SHA一致；原生84来源／12输出及锁定依赖核验后复用，本批未新编原生或npm安装。
初轮真实进程15／13／2及修正15／15、两版产品107／105／2与依赖类身份修正后
各23／23均分次保留，不改成首次全绿。真实root-owned后端／sudoers／PAM／setpriv
happy path仍待管理员目标环境验收；当前只是普通UID helper隔离root与固定假命令。

预注册文件SHA为a8159cb8…（原文件字节口径，非紧凑JSON摘要），28／版ABBA不变。
首轮冷启动1.09625倍、重获4.08607倍；仅一次有界计时后实施并发，必要重测冷启动
1.06765倍通过，重获2.62602倍仍超1.5，保留两份完整56行，不追加次数求绿。
该范围不替代完整42／28预算、实机精度或G3。原始失败、包身份与新归档见
[现有共享总线验收的serviceInfoFollowUp](../host/contracts/system-bus-provider-acceptance.json)。

## none 显式电源候选（2026-10-15，未发布）

配置 `provider:none` 自身不授予系统控制权限，默认保留空服务目录和零命令。
可信进程工厂另声明 `machineProvider.nonePower.allowedActions`，仅允许
`reboot`／`shutdown`，并从其真实资源所有者返回 `machineDeviceGuard`。
guard 必须有有效 `assertDeviceAvailable`，缺失／畸形／与既有控制冲突
均拒绝；函数不进入 JSON 配置克隆。工厂保留原 release 的 this，先等待
控制器在途操作收口再释放资源。guard 仅借用，控制器不调用其 close。
这不替代实际 transport 原子独占，也不是任意外部 release 竞态的独立 lease。

新控制器从实际 `/proc/self/stat` 核对当前 PID 和 startTicks，无 systemd
unit 身份要求。仅电源调用使用固定名字／参数和启动 PATH 快照，不使用
shell／交互 sudo。可执行 systemctl 存在时仍优先选它，即使当前进程
未受其托管；缺失或不可执行时选择 bare reboot／poweroff／halt。
固定上游探测传 F_OK；这里额外要求 X_OK，不能声称完全相同。
容器标记／cgroup／PID1 schedule 无法证明时阻断。实际 child close
确认成功后不因晚取消撤销 ack；已启动后失败／取消保留 unknown 收据。
none 服务／server restart 不可用503在耐久准入前拒绝；其他 provider
权限范围拒绝仍403。旧 none.control 的显式 systemd 身份边界保留。

显式 installation 仍是固定 `.service`／data/systemd 部署契约；部署摘要、
物理路径、安装 journal 和 fresh 进程证明继续强制，不能借 none 绕过。
Windows Node26.9新8项＋原控制／API11项19／19和锁定TS7类型通过；
两次首次类型失败保留。新增8文件的历史SCP因旧授权范围不足被拒，收到
项目184长期调试授权后正常审批传输成功，覆盖前与落地SHA全部一致。
Linux26.11.1标准类型通过，源码首轮5文件30／30及旧8文件80／80分次通过；
独立JS和实际产品13文件各110／110。最低26.9标准类型及源码／产品各110／110，
fail／cancel／skip／todo均为零，原configured-server14项每轮实际执行。
这些包含真实loopback HTTP、默认/proc当前进程身份和原SQLite按request_id重开，
三种假systemctl选择分支、guard拒绝／缺失／畸形／冲突、release接收者、
close等待和unknown不重放均验证。设备为模拟MCU，PATH仅含四个假电源程序。

标准buildProductHost API新发射725项清单（build-info本身另计），其中691个
JS＝host/src684＋辅助7，与严格独立TS7发射逐SHA相等；测试父子禁止TS加载。
原生12输出来自前序受控产品，84来源输入及输出摘要对当前逐项一致后复用，
本批没有重建原生。生产依赖从原锁定独立安装按字节复制，新旧依赖摘要相等，
不声称本批重新npm安装。运行时、版本、构建和依赖摘要见既有验收及新none归档。

预注册同机Node26.9窄handler9比较最高1.08523倍；其实际产品API处理链使用
即时注入准入，不含HTTP／SQLite／退役／CLI。默认工厂模块冷导入每版28个
新进程，190.198860→190.773607ms，1.00302倍，沿用1.5门限；不代替完整
原42／28预算或完整服务启动。四个真实fake CLI child close为22.025–24.800ms，
仅绝对成本，不是打印速度。111生产输入＋package/lock对be2逐字节一致，
不代表新运动运行时或物理精度。原11失败／G3／集成和实机仍开放。
原准备脚本SyntaxError与性能启动保护等待错误保留，均未启动失败测试／采样。
该批当时终态Node残留为零、源码8项未变；后续已提交并推送4d981922，
其motion／sanitizer成功只属于该头，普通CI终态另行核验，不覆盖本节上方当前属性增量。

## Supervisor 分组进程候选（2026-10-15）

`supervisord_cli` 现在按完整 `group:name` 读取和控制进程，状态目录、
PID 身份、固定参数、设备退役、API 和恢复 journal 使用同一个原名。
只读目录默认可识别分组内的 moonraker／klipper；这不授予写权限。
可信工厂通过 `machineProvider.supervisorControl` 声明 `ownProcess`、
`allowedProcesses` 和 `deviceProcesses`，例如：

```ts
machineProvider: {supervisorControl: {
  ownProcess: 'farm:moonraker',
  allowedProcesses: ['farm:klipper', 'other:crowsnest'],
  deviceProcesses: ['farm:klipper']
}}
```

原 `control` 的 flat `.service` 描述符继续兼容；两种描述符不能同时
使用，也不能覆盖调用方已有 `machineControl`。systemd 描述符仍拒组名。
自身进程只允许 restart；`group:klipper` 自动要求设备退役，取得设备前
核对每个允许的设备进程都已停止且 PID 为零。不同组的同名进程不合并。
空段、多重冒号、星号和重复名称拒绝；Supervisor 裸 `all` 是批量目标，
不能出现在可信目录中，`group:all` 是精确进程，systemd `all.service`
不受影响。已启动的 CLI 控制若失败或取消而结果未知，收口子进程后
记录 interrupted；包装清理错误仍保留，新进程不自动重放。

Windows Node26.9 新12项与旧控制／API11项单次23／23、全仓锁定
Windows TS7类型检查通过。真实隔离Node CLI子进程的失败／取消包装
已测；分组请求的新证据是 EndpointRegistry／JSON-RPC 处理链，不是
真实 supervisor 守护进程验收。用户明确授权11文件传入184隔离工作树，
Linux Node26.11.1标准类型检查与源103／103通过，含原configured-server
14项HTTP／WS和新Supervisor12项。新724文件产品独立安装锁定生产依赖，
690个JS（host/src683＋辅助7）与独立TS7发射逐文件SHA相等，12原生输出
按当前84输入新编；编译使用CPU0／Cargo jobs1，不证明默认并发稳定。
独立JS初轮71／57通过／14失败，补缺资产及pty.c后仅失败三文件48／48；
实际包初轮65／62通过／3失败，补原产品scripts辅助路径后三文件41／41。
两轮原失败及精确夹具收口保留，不合并写成一次103全绿。实际包初轮
configured14与Supervisor12通过，父进程及后代禁止TS加载。全量npm test
5354／5343通过／11失败：8新编产品／原生构建相关、宿主提前退出未知、
source-brake明确SIGSEGV、thumbnail断连503未知；G3及集成门禁保留。
Windows原符号链接／SIGKILL、Linux来源及ELF导入失败亦保留。
窄 API 处理层9组比较最高1.133倍、沿用1.5阈值，不替代原42／28
性能预算。详细范围与失败见[共享总线及后续验收](../host/contracts/system-bus-provider-acceptance.json)。

## 共享 D-Bus 进程所有者

标准 Node `createProcess` 工厂实际解析 `[machine] provider`，默认
`systemd_dbus`；`shutdown_action` 只接受大小写归一后的 `poweroff`／`halt`。
可信 `machineProvider` 装配声明 Unix socket 与可写 unit 范围，配置值本身
不授予系统控制权限。显式自定义 source／控制能力冲突拒绝，不覆盖借入能力。
共享连接仅由进程工厂关闭：控制 facade、服务状态、安装消费者借用同一总线；
设备退役及服务清理完成后再释放连接，配置备份换代先等待旧 socket 真正 close。

连接只使用固定 Unix／EXTERNAL、显式 Hello 和真实 systemd Subscribe；
收到成功回复前不得认为握手或订阅已就绪。方法调用绑定核验过的 unique
owner，信号核验 sender／path；连接、owner、状态证明分代，服务正常状态
信号不能抹去同一 owner 的成功 job 回复。换代／断线撤销旧证明；读取缓存
只供展示，控制及设备准入重新取实际属性。订阅去重且有界，重连重新订阅。
安装身份证明单独按相关 unit 的结构性属性失效；无关服务和 ActiveState
变化不永久阻断 ready，MainPID／FragmentPath／owner 等变化仍同步阻断。

提交后的取消、超时和断线表示结果未知，持久收据为 `interrupted`；真实
宿主退役路径包装 AggregateError 仍保留该状态及额外清理失败，新进程不重放。
只有发送前已确证 logind 接口缺失才走原受控 CLI power fallback，未知结果
不 fallback。Polkit pid／uint64 start-time 查询只是诊断，不能作为缓存权限。

实际私有 dbus-daemon、模拟服务／MCU、源码／独立 JS／新产品包与最低
Node 26.9 的结果由最终验收 JSON 记录；原网络／运动预算采用隔离夹具，
默认 D-Bus 进程启动另有实际私有 daemon＋授权 HTTP 测量，不混称硬件。
标准新包受控 CPU0／Cargo jobs1 构建，应用普通多核调度，默认 Rust 编译
并发稳定性仍开放。dbus-native 0.16.1 精确锁定，新增依赖及许可证已核验。

范围边界：上述默认入口是可信 `createProcess` 路线；直接配置 server 的
自定义读源仍由调用方装配。CLI／supervisor 查询和 typed 控制具备基础兼容，
supervisor 安装属性消费，以及 none 的上游 503 与无 systemd
托管 power 语义仍待补齐。安装读取提供 User／Group／ExecStart 等属性，
尚未用其自动推导全部旧安装声明；真实 polkit／sudo／服务管理和 ARM64／
目标板／实机未授权且未执行。新候选仍须自身 CI、正常集成和发布门禁。

详细结果和原始失败见[共享总线验收](../host/contracts/system-bus-provider-acceptance.json)。

## 旧安装迁移的可信工厂装配

LMDB 导出子进程在失败／取消时先终止、关闭尚未消费的 stdout／stderr，
再等待实际 close；只收到 exit 不代表管道已收口。SQLite 和持有目录
无论清理或观察回调失败都继续关闭；未知 stage／journal 保留供核对，
不终止持有 helper 的 Worker 来假装清理完成。正常导入仍验证完整 trailer、
真实退出状态、源摘要和事务收据。构建使用稳定相对 C 来源路径及显式 cwd，
保留 LMDB assert 的源码诊断，避免随机快照路径进入产物摘要。
本次软件验收的控制构建和普通调度边界、原失败及可追踪原始证据见
[移植性与取消验收](../host/contracts/legacy-ci-portability-acceptance.json)。

此候选接通 `createNativeProductHostFactory` 的 `createProcess` 路线。
`legacyDatabase` 明确旧 SQLite 目标、LMDB 源、停写确认及原身份 issuer，
在任何进程 DB／日志／文件打开前执行只读导入。`createProcess` 必须消费
第三参数 `opened.database`，不能另开空库掩盖旧身份。常规 JSON API 的数值
预算保持；原持久 record 与 unsafe integer 词法保留不等于公开 API 任意精度。

`legacyPaths` 的 dataPath 和各 physical directory 必须与实际清单、DB、
配置 owner 一致。别名发布前检查已占用／损坏路径；资源仍用物理目录，
默认日志改用独立私有 `node-private-logs`，旧 logs 保留。`legacyGcodes`
明确停写源与独立 recoveryRoot，源、恢复、发布目录不得重叠。支持 `.gcode`
`.g` `.gco` `.nc`／UFP 模型、受限 PNG 与源时间；原树保留。硬链接、符号
链接、未知文件、来源变更及容量超限拒绝，不自动删除旧树或清 journal。

实际 `installation` 原 SUDO queue 执行 service/config/version 顺序，原密码
在内存及受限 stdin 传递，HTTP 配置对继承密码副本脱敏。多来源配置候选
由原解析器重读：批准目标删项、其他 DEFAULT 继承值物化保留、所有来源
摘要确认。未知保存结果阻断重播；成功后仍须旧进程退役，新进程验证部署
只读证明、配置／paths／gcodes 摘要和独立 Node marker 后才能取得设备。
原 install_version 缺失补 1，既有版本保留原 force 语义，不能据其直接 ready。

validate_config=false 保留原来源 bytes 和 gcode_path，但 Node 证明仍强制。
validate_service=false 须额外可信 `externalService` 验证实际 unit／部署摘要并
提供 `requestRestart`；没有证明 blocked，不制造 root 许可或调用 root install。
非法 boolean 属于 ConfigurationError，不吞成运营 blocked。journal 损坏、
源变化、部署证明不一致属于 blocked，不伪装配置错误触发备份。

`legacyConfiguration.backupFile` 是调用方批准的最近有效配置。主配置解析或
真实组件构造／初始化发生 ConfigurationError 时只尝试一次；先成功关闭
首代已转移能力，保持其他 server／caller owner，清理错误不回退。组件回退
须 `installation.reopenBackend` 返回与旧后端不同的新实例；旧密码和 closed
后端不可复用。持久 alias／SQLite／模型成果从 journal 恢复，配置换代重新
保留私密 secrets 和 TLS 路径；主备私密路径均禁止标准 HTTP 文件读写。
backup 只提供恢复查询，安装和设备保持 blocked。普通错误、server 初始化／
运行阶段错误及第二次配置错误都不再回退，关闭失败必须按实际错误处理。

本机标准 CLI 新编完整 12 原生输出的 717 文件包已核验；受影响 66 文件在
源码、独立 JS（WAL URL 分次补验）、实际包和最低 26.9 验证，实际原 key
安装后完整旅程和文本／UFP 模拟打印通过。部署／系统证明是普通 UID 隔离
文件和注入受限执行器，真实 root/PAM/systemd 与 MCU 硬件尚未执行；完整
Moonraker／Python／宏／实机交付未完成。详细失败与范围见
[本批交付记录](Node_Host_Delivery_Plan.md#当前旧安装迁移候选2026-10-14未发布)和
[旧安装生命周期验收](../host/contracts/legacy-install-lifecycle-acceptance.json)。

以下固定布局说明是前序单文件／既有 SQLite 批次的受限路线。
旧布局及 LMDB／include 限制由上节的显式迁移能力扩展，不自动改变默认
Python 入口、polkit／NNP 或授予真实特权部署权限。

## 固定 Node 安装校验与 SUDO 消费者

此可信装配在已有固定 Node 布局上接通真实安装消费者：等待密码、
校验凭据、消费进程 FIFO、替换固定服务、保存批准的配置删项、确认
版本并经原 `afterResponse`／进程退役所有者请求自重启。它不是完整
上游 InstallValidator 迁移，也不改变默认 Python 入口、默认 polkit
或已有 machine-control 单元的 `NoNewPrivileges=yes`。SUDO 模式必须
由管理员显式批准；内核 `NoNewPrivs` 非零时直接拒绝，不自动改策略。
仅 Linux x64／arm64 启用，本机实际证据为 x64。

准入要求同一 `dataPath` 下现有 `config/moonraker.conf`、
`database/moonraker-sql.db`、`logs`、`gcodes` 和 `systemd`，工厂机器
清单必须指向该主配置，显式配置写入 allowlist 包含它。数据库必须
是正在选用的既有 SQLite，不能先创建空库掩盖旧安装。上游已经使用
SQLite／namespace_store 和 record codec；保留的 `data.mdb` 可以是
已完成转换后的备份，不因此拒绝，不自动转换／删除它。这里只核对
安装相关 record 和现有存储身份，没有遍历所有表或证明全库整数精度。
该前序固定布局路线拒绝旧 `file_manager.gcode_path`、LMDB 转换与旧目录迁移；
本批显式迁移路线见[旧安装装配](#旧安装迁移的可信工厂装配)。

配置在日志、数据库及其他进程资源打开后校验，因此绝不移动这些
路径。只删除主文件拥有且等于现有默认路径的 database/config/log/
secrets/TLS 路径别名，以及明确支持的旧 debug 选项。涉及 DEFAULT
继承、target section 跨 include 或不同路径时阻断；候选按原解析器
重新解析，要求只批准的选项消失，其余值及文件归属保持。已加载
source 与磁盘身份再次核验，维护租约与已有 writer 互斥，原单文件
备份／原子保存复用；设备 detached 不等于所有文件未打开。

GET `/machine/sudo/info?check_access=true` 与 POST
`/machine/sudo/password {"password":"..."}` 复用原身份、前缀、CORS、
HTTP(S)、容量与取消所有者。欢迎页 flags／公告来自实际队列，成功
确认后移除公告。密码只在内存保存和独立快照中，经 sudo stdin
写入有界一行，不进 argv／日志／回执；关闭和换代擦除 Buffer 引用。
`sudo_password` 敏感模板禁用调试 sink，公开 config/settings/original
对所有 section 的继承副本脱敏，后续 publish 同样处理。Buffer 擦除
不承诺 JavaScript／V8 的所有历史字符串副本都被物理清零。
原 authorization 严格选项名单保持：DEFAULT 密码继承到
`[authorization]` 的布局仍拒绝启动，不能据脱敏测试声称支持该布局。

队列上限 16，操作上限 4；密码消费串行，访问探测使用独立快照。
HTTP 密码请求在 probe 前后、每个消费者前及重启前复核授权，安装
副作用前的关键节点再次核验并使用新 identity；启动时 status 只读
验证没有 HTTP 用户授权上下文。失败消费者
保留；已经成功消费者不会重播，重启需求保持到显式恢复，即使另一
消费者失败、授权撤销或响应 handoff 丢失。版本仅全步骤确认后写
`moonraker.validate_install.node_layout`，保留原 `install_version`，
不把固定布局版本冒充 legacy migration 完成。

安装成功仍为 `restart_required`，旧进程不能取得设备；请求自重启
只确认 `systemctl --no-block restart -- <固定单元>` 已提交，不声称
新服务 ready。下一真实进程同时核对 root 公共证明、实际 unit/profile/
bundle/config 摘要、本地 version-confirmed journal 和 DB marker，
才放行设备，不依赖缓存 sudo timestamp 或再次提交密码。安装等待
期间仅专用自重启桥接；ready 后保留原显式 MachineControlPort 的
标准 server.restart／已批准操作。需要这些长期控制时必须装配原
可信端口；本固定 helper 不授予通用 service/reboot/shutdown 权限。

### 受信 profile 与管理员审核出口

沿下文“进程服务与设备代际”的板级适配器装配即可接入。以下为
固定布局的完整装配外壳；`board-adapter.mjs` 仍须提供该机型真实
设备停止／文件准入及既有进程资源，不能采用验收夹具的空回调：

```js
import {readFile} from 'node:fs/promises';
import {createNativeProductHostFactory} from '/opt/anyraid/host/src/runtime/native-product-machine.js';
import {createTrustedSudoBackend} from '/opt/anyraid/host/src/moonraker/sudo-backend.js';
import {createProcessResources, createMachineDeviceAdapter} from './board-adapter.mjs';

const dataPath = '/var/lib/anyraid';
const manifestPath = '/etc/anyraid-install/approved.json';
const approved = JSON.parse(await readFile(manifestPath, 'utf8'));
const backend = await createTrustedSudoBackend({
  mode: 'trusted-sudo', sudo: '/usr/bin/sudo',
  node: '/opt/anyraid-runtime/node',
  helper: '/usr/local/libexec/anyraid-install-helper.mjs',
  manifest: manifestPath,
});
export const createProductHostProfile = createNativeProductHostFactory('/etc/anyraid/machine.json', {
  dataPath, filesRoot: dataPath + '/gcodes', metadataRoot: dataPath + '/metadata',
  uploads: {stagingRoot: dataPath + '/staging'},
  configFiles: {root: dataPath + '/config', writable: ['moonraker.conf', 'printer.cfg']},
  standardPrint: {nozzle: 200, bed: 60},
  installation: {backend, options: {
    dataPath, configRoot: dataPath + '/config', configFile: dataPath + '/config/moonraker.conf',
    databasePath: dataPath + '/database/moonraker-sql.db',
    logsRoot: dataPath + '/logs', gcodesRoot: dataPath + '/gcodes',
    unit: approved.unit, candidateSha256: approved.candidateSha256,
    recoveryPath: dataPath + '/systemd/node-install.json',
  }},
  async createProcess(configuration, signal) {
    const resources = await createProcessResources(configuration, signal);
    if (resources.server.database?.storagePaths.path !== dataPath + '/database/moonraker-sql.db'
        || !resources.machineControl) {
      await resources.release();
      throw new Error('必须使用既有 SQLite 和明确的常规机器控制端口');
    }
    return resources;
  },
  createAdapter: createMachineDeviceAdapter,
});
```

profile 是普通服务用户运行的受信模块，放在 bundle 外并由管理员
绑定摘要；机器清单的 moonrakerConfig／printerConfig 与这些目录
一致。profile 不含密码。现有设备适配、权限和退役规则仍须完成。
如 profile 准备在接线前失败，装配者负责关闭已经创建的 backend。
本批实际编译 profile CLI 用隔离目录验证此组合接口与生产后端的
不可信路径拒绝；没有在真实 root happy path 上执行以上部署配置。

只读候选生成请求含固定字段，不接受任意 unit 字节／命令：

```json
{"schema":1,"unit":"anyraid.service","user":"printer","node":"/opt/anyraid-runtime/node","bundle":"/opt/anyraid","profile":"/etc/anyraid/machine.mjs","dataPath":"/var/lib/anyraid"}
```

已有目标 `/etc/systemd/system/anyraid.service` 必须可读。普通用户执行：

```sh
/opt/anyraid-runtime/node --no-experimental-strip-types \
  /opt/anyraid/scripts/product-install-helper.js --prepare /absolute/request.json \
  > /absolute/approved-candidate.json
```

该命令只读主配置绑定所用 profile、bundle 清单和旧 unit，输出前后
摘要，不导入 profile、不执行安装、不自动确认发布来源。管理员
另行审核包来源、锁定机器／账号／profile、既有 unit 摘要和
`fixedInstallUnit` 重生成的固定候选；复制独立 helper.js 为 bundle
外的 `.mjs`、准备 approved manifest 及明确 sudo 规则属于真实部署，
本批未执行。manifest 无秘密，可 root-owned 0644 供服务用户读取；
helper／Node／sudo／manifest 及其全部祖先须 root-owned、无 group/world
写入且无符号链接，runtime/helper 必须在 root 启动前已受保护。
只有入口内部检查不能补救已经替换的 root 程序。helper 仅导入 Node
内建模块，不从服务可写 bundle/profile 加载 root 代码。root 读取
可写 profile/build-info/旧 env 时使用固定 setpriv 清除 supplementary
groups 并以服务 uid/gid 有界读取，避免 root 跟随用户路径读取秘密。
实际 setpriv/root 隔离效果仍须管理员在目标系统验收。

新内部属性消费者从受信 backend 取得同一 approved manifest 的只读声明和
SHA-256；新安装调用必须传给独立 helper 第三个参数 `expectedManifestSha256`。
helper 只读取一次 manifest 字节，先验证严格 64 位小写十六进制摘要再解析，
同一快照用于后续执行；声明读取后替换 manifest 在任何命令／写入前拒绝。
旧两参数 helper 调用仍兼容，但新消费者不降级省略摘要。

项目不自动生成或安装 sudoers。管理员原先精确匹配两参数 argv 的策略须与
独立 helper 同时审核更新：仍固定 Node/helper/manifest 路径及 probe/install/restart
操作，额外精确匹配该份批准 manifest 的摘要字面量；不要改成任意参数或路径通配。
`status` 继续使用普通用户可读的固定公共证明，不扩大 root 操作／路径白名单。
manifest 更新需重新审核摘要及策略，旧策略拒绝属于显式部署诊断。

helper 清除 NODE_OPTIONS／NODE_PATH／LD_* 等注入环境，固定绝对
可执行文件和规范 unit 字段，非 root User，正确转义；不允许 HTTP
提供命令、shell、写入目标、manifest 或任意 unit 内容。生产包独立
helper 由管理员按产品 build-info 文件摘要独立核对来源后复制；
approved.json 不含 helper SHA，root-owned 检查只验证路径权限，
不能解释为批准清单已绑定其字节。不以 `.ts` strip-types 作为 root
入口。`--trusted-sudo` 只生成显式候选，与 `--polkit` 互斥，不安装
策略；它不能绕过已运行进程的 NNP。默认 machineControl descriptor
生成的 NNP／polkit 方案继续保持。

### 恢复与取消边界

root 私有 `/var/lib/anyraid-install/<unit>/receipt.json` 在任何备份／
unit replace／daemon-reload 副作用前耐久写 unknown，原 unit 和 env
分别备份；新的 Node unit 不引用旧 env，不制造无人读取的新 env，
这是与上游 Python env 更新的明确差异。普通服务用户的本地 journal
不能证明 root 副作用；独立 root-owned 只读公共 attestation 仅公布
摘要，不包含密码、旧 env 或备份。任一步未知结果、配置提交失败或
版本 journal 未确认都保持 blocked，不自动重播或放行设备。
跨进程 O_EXCL owner.lock 排他；stale lock 不自动删除，须管理员
核对进程／unit／回执并明确恢复。无法确认 root 子组收口时保留锁。

取消通过关闭 sudo stdin 请求受信 helper 合作收口；helper 始终有
自身 60 秒 deadline，负责其 root 子组终止与实际 close。普通用户
不能假定可 SIGKILL 已提权组／sudo 新 session。deadline 是取消触发
点，不保证 kernel D-state 的物理退出；真实 sudo/PAM/PTY EOF转发、
不可读进程状态、目标权限及 root 服务安装仍是未执行门禁。未知
副作用不会因 child 已结束就被解释为回滚。进程关闭等待在途密码／
安装工作，再关闭公告、配置 lease、鉴权、数据库；cleanup 错误保留。

前序固定 Node 消费者当时未接入 force_validation／validate_service／
validate_config、配置备份回退、旧布局 pre-open／LMDB 导入和全库原字节验证；
本次的实际接入与限制见[旧安装装配](#旧安装迁移的可信工厂装配)。
完整历史服务/env兼容仍不以本候选的固定 unit／注入执行器证据泛称完成。完整 Moonraker/Python/宏、
历史 UI/G3、ARM64、目标板／真实打印／发布门禁未关闭。软件范围与
分次失败、产品身份及原预算见
[安装生命周期验收](../host/contracts/sudo-install-lifecycle-acceptance.json)。

本机软件验收分开记账：源码扩展22／23后仅修CORS驱动补1／1，
最低26.9四文件23／23；原回归首次253 pass／9装配fail后，只补七文件
245／245。最终标准npm typecheck26.9 exit0，23编译输入冻结。标准
构建API复用核验过的75／11原生指纹，704包667运行时JS加独立helper
与独立emit668项一致；实际编译profile CLI首次／fresh退出0，生产
路径拒绝例exit1。该前序未执行完整构建CLI或新原生构建；
本次717包完整CLI及12原生新编见本页旧安装段。

原42预算均通过，最大1.130倍、auth最高3.516微秒；原五场同包模拟
打印分别59.931／59.967／61.360／64.021／60.329秒、全部exit0。第六场
真实安装后fresh ready接原1000moves／并发API／两代恢复／ADC／退出，
修备份列表驱动后62.534秒、状态P99 8.908毫秒、最小提前量79.425毫秒。
首轮备份列表遗漏失败保留，补验唯一规范备份的旧字节和匿名401／
授权200；没有删备份或过滤任意隐藏文件。原28启动median337.416→
334.067毫秒，ratio0.990；基线启动未开启安装，第六场覆盖安装交接。
上述均为普通UID／模拟MCU与注入固定执行器，不是特权或硬件验收。

## 原生进程诊断日志

`createNativeProductHostFactory` 的 `createProcess` 模式现在创建一份
`ProcessLogs` 所有者，跨设备重建保留，最终在设备、服务、数据库和
工厂资源收口后排空并关闭。`dataPath/logs/moonraker.log` 与
`dataPath/logs/klippy.log` 是默认生产文件；真实 bootstrap、监听、
设备加载／就绪／退役、故障通知与最终退出写入这两份文件。
`printer.info.log_file` 和两个标准下载地址指向这些真实文件。
日志仅记录有界枚举及恢复原因，不记录密码、完整配置、命令参数、
请求内容或任意异常 cause。这仍缺完整组件 DEBUG／异常堆栈流。

生产目录必须专用、由当前服务用户持有且权限为 0700。默认目录会
创建；显式目录须事先存在。进程借用已有 `sealed-file.node` 的
非阻塞目录 flock，同一目录两个文件只锁一次；第二个写入进程拒绝，
SIGKILL 后内核释放锁，不通过 PID／时间猜测清理活锁。
目录及物理路径在 MCU 获取前与文件库、元数据、配置、私密文件、
TLS、授权数据库及备份、作业／恢复日志和磁盘投递目录隔离。
最终文件符号链接、非受控硬链接及两个生产别名同一物理文件拒绝。

可信原生工厂可设置 `logging: {applicationFile, printerFile,
disableFile, structured, verbose}`。原 `applicationLogFile`／
`printerLogFile` 继续只是只读借用绑定，不能由下载声明升级为写入
所有者；同一个别名同时声明写入与借用会拒绝。`disableFile` 只禁用
新应用生产文件，原生打印日志仍可生产；明确借用的下载不授予轮转。
标准配置服务器仍自行装配下载，不能用另一套下载回调替换所有者。

```sh
node scripts/product-host.ts --profile /absolute/machine.ts \
  --logfile /absolute/private-logs/moonraker.log --structured-logging
node scripts/product-host.ts --profile /absolute/machine.ts --nologfile
```

`-l/--logfile`、`-n/--nologfile`、`-s/--structured-logging`、
`-v/--verbose` 支持原 `MOONRAKER_LOG_PATH`、
`MOONRAKER_DISABLE_FILE_LOG`、`MOONRAKER_STRUCTURED_LOGGING`、
`MOONRAKER_VERBOSE_LOGGING` 默认项。布尔值只接受忽略大小写的
`y/yes/true`；命令行日志路径覆盖环境，禁用优先，最后才验证路径。
路径支持既有用户目录展开，随后转为绝对路径。CLI 配置须由工厂的
`configureLogging` 能力接收；旧手工工厂缺少该能力会明确拒绝。
CLI 与工厂两套显式 logging 声明拒绝竞争所有权。
`--verbose` 当前只向 stderr 输出实际生命周期记录，尚不等于原版
全部 DEBUG 消费者；stdout 保留机器可读 ready/listening 协议。
原版 -d/-c/-u/-g/-o 等整体 Moonraker CLI 尚未接入此机器模块入口。

文件采用普通文本或固定 JSON 行文件头／记录。独立 Worker 执行
串行文件 I/O；日志操作最多 256 项、正文共 1 MiB、单条 64 KiB，
手工轮转等待最多两项。队列满、ENOSPC、权限或 Worker 故障锁存
通用错误码，停止新日志准入，stderr 明确报告，最终关闭返回失败。
这些错误及外部日志回调抛错不跳过原设备停止和其他资源清理。
启动握手与退出排空各十秒，超时触发 Worker 终止并等待真实退出、
回收 fd／目录锁；不能把十秒说成不可中断系统 I/O 的物理结束保证。

午夜轮转在下一次日志记录时触发，首次期限取实际文件修改时间；
文件名为 `.YYYY-MM-DD`，最多保留两份。POST `/server/logs/rollover`
或 RPC `server.logs.rollover` 沿原身份、HTTP(S)、前缀、取消、容量和
退出所有者工作；`application` 为 moonraker／klipper，不提供时尝试
两者并返回 `{rolled_over, failed}`。实际操作前再次鉴权；打印中可
轮转文件，不执行设备动作。外部 Klippy 或只读借用没有可写轮转
能力时返回明确 failed，不停止／启动系统服务或伪造成功。

轮转先准备完整新文件头，再为旧 inode 建立日期备份，原子替换
公开文件名。已打开的下载保持旧 inode／初始长度，新下载读取新
文件；下载仍限两活动读取、1 GiB 文件和 64 KiB 块，复用原鉴权、
HTTP(S)／前缀／CORS／期限／断连。GET／HEAD 范围及标准日期条件
保持，DELETE405、无 ETag、绝对受保护来源和容量为既有明确差异；
完整原 StaticFileHandler 路径／头兼容仍待完成。

专用目录内本日志的日期备份和 `.rotate-UUIDv4` 为所有者保留的
命名空间。重开在 flock 内只识别 current 与恰好一份日期备份同
dev/ino 的双链接中间态并回滚；暂存清理还要求常规文件、当前 uid、
单链接及 0600。未知文件不清理，异常暂存或其他硬链接拒绝。
SIGKILL 恢复仅证明锁和轮转命名空间可重开；这是异步诊断流，
不保证未排空记录零丢失或断电耐久，不代替权威 SQLite 打印日志。

源码与独立 JS 各 541／541 已通过。两处轮转发布边界的强制终止、
内核锁竞争、只读绑定、实际 CLI、撤销／取消、失败重开及风险降低
清理均有软件证据。实际标准新包原 498 项、新增 42 项和修正临时
guard 后单验 CLI 1 项分别通过，保留原 42／43 驱动失败；最低
Node.js26.9 四文件 50／50 通过。标准 builder 未改，精确编译子进程
用固定 --import 选择官方后备方式；兼容 shim 不进入产品，原默认
execve 启动超时原因仍未知。原生输出核验复用，未重新原生构建。
原 42 预算全部通过（最高 1.263 倍／鉴权 3.768 微秒），五场同包
完整模拟打印通过，新增场完成两代四次打印中真实文件轮转。实际
进程启动固定 28 次、3 次热身／11 组样本，中位 336.227→354.844
毫秒、1.055 倍，原 1.5 倍门限保持；指标包含进程依赖、恢复和
HTTP 监听，排除模块导入／夹具准备／清理，不等于 MCU 就绪。
新头 CI、完整组件日志、外部 Klippy 控制及目标板／实机保持待验，见
[候选证据](../host/contracts/process-log-lifecycle-acceptance.json)。
没有新开浏览器或实机场次，固定 Fluidd18430／Mainsail18434 来源保持。

原生异步模板每个句柄最多保留最后一个相同 JSON 字符串及其
不可变解析值；仍限 65536 UTF8 字节／64 句柄，关闭即释放。
回调、环境和渲染输出不进入此缓存；两条异步工作线程、原容量、
期限、取消和数值解析保持。新标准包从独立空 Rust 输出构建，
75 来源／2810 Node 头／11 输出核验，697 项包仅原生模板及
构建回执变化。140 项及最低 Node.js26.9 同样 140 项通过，
原三组模板预算、42 高频预算及 HTTP／HTTPS 前缀／欢迎负载
三轮打印通过。历史 UI／G3／SIGKILL／ICE 不以本次成功关闭；
详见[上下文复用证据](../host/contracts/template-context-cache-acceptance.json)。
浏览器仍固定 Fluidd18430／探针18428、Mainsail18434／探针18432，
冲突停止，不换来源；本增量没有新增浏览器或实机场次。

原生配置应用现提供完整原版 Moonraker 欢迎页：无前缀时为 /，
有前缀时为其根地址和尾斜杠形式，例如 /scope、/scope/；
对应 API／WS 不新增根别名。HTTP／HTTPS 共用完整原模板和
进程数据。公开页面显示鉴权结果；坏凭据显示 False，不授予
API 身份。页面不返回 CORS 许可，其他 API 的来源规则保持。

欢迎内容共享原私密工厂的 UI 环境，不继承私密值；无私密
工厂时使用受限 UI-only 执行器，不读取猜测的 secrets 路径。
原始模板随标准包携带，启动核对摘要，MCU／日志前校验；
HTML、脚本值和链接安全编码，原请求／字节／输出／期限和
退出边界保持。状态、公告、网络及服务取现有所有者，页面
不运行系统命令或发起打印。

当前原生 polkit 控制没有交互式 sudo 密码请求队列，页面不
发起密码请求；原窗口保留，但 SUDO／密码后端仍待接通。
本增量未输入密码、增加权限或操作真实设备。

三种方式各 490 项、Node.js 26.9 实际包 18 项及原 42 项预算
通过，同包三轮模拟旅程通过，新增轮次含 2388 次欢迎读取。
直接 UI 仍 1.888 > 1.5，候选不能因此视为完整 UI／打印交付。
见[完整欢迎证据](../host/contracts/application-welcome-owner-acceptance.json)。
本机浏览器来源仍固定 Fluidd18430／探针18428、Mainsail18434／
探针18432，冲突停止，不换端口；本增量未新开浏览器场次。
以下保留前序启动说明及其当时范围。

原生 loadAuthorized／原生产品入口现提供 GET /server/redirect，
开启 route_prefix 时在该前缀下访问；它使用原身份所有者的可选
校验，错误 API Key／JWT 仍拒绝。该入口不会授予后续 API 或
打印权限。配置 cors_domains 为实际客户端所需目标，例如：

```ini
[authorization]
cors_domains:
  https://fluidd.example.com
```

```sh
curl --get --data-urlencode 'url=https://fluidd.example.com' \
  http://127.0.0.1:7125/server/redirect
```

查询中的最后一个 url 优先于 JSON GET 请求体；完整目标通过
原 CORS 后返回 302，匹配时仅去掉尾斜杠，Location 保持原目标
并编码 Unicode。来源 Origin 单独检查；未授权目标／缺少原
授权组件返回 400，不能用外部回调替代所有者。目标解析仅允许
规范绝对 HTTP(S)，禁止用户信息、控制符／反斜杠与归一化歧义，
原始及编码目标均限 4096 字节；这些为明确加固差别。

原请求容量、字节、期限、取消及退出规则保持；NSS 借用原
授权缓存，等待后身份再核验，取消／吊销不能发出迟到重定向。
HTTP／HTTPS 共用该入口和配置前缀。源码／独立 JS／实际包
各 334 项、最低 Node.js 26.9 实际包 17 项、原 42 项预算和
同包模拟打印通过；新路径 CPU 观察没有旧成功基线。见
[重定向证据](../host/contracts/application-redirect-owner-acceptance.json)。
本增量未新开浏览器或实机场次；Fluidd18430／探针18428、
Mainsail18434／探针18432保持，冲突停止、不换来源。
以下保留前序启动说明及其当时的验证范围。

### 配置直接 HTTPS

HTTP 与 HTTPS 使用同一应用及身份所有者。缺省 HTTP 7125、
ssl_port 为 7130；两者使用同一 host，仍须显式配置 127.0.0.1
用于本机验收。原可信应用 dataPath 下的 certs/moonraker.cert 与
certs/moonraker.key 各自优先；应用不自动生成证书或创建该目录。
旧显式路径继续支持、记录弃用提示，例如：

```ini
[server]
host: 127.0.0.1
port: 7125
ssl_port: 7130
ssl_certificate_path: /installed/printer-certs/moonraker.cert
ssl_key_path: /installed/printer-certs/moonraker.key
route_prefix: /host/printer.v1
```

路径按原物理 expanduser／resolve 语义处理，建议使用绝对路径。
示例需要使用者已提供并维护的有效证书／密钥；不要使用临时测试
密钥。证书最多 256 KiB、密钥最多 64 KiB，必须是常规文件；
证书不匹配、无效显式材料或相同的非零端口拒绝。最低 TLS1.2，
握手十秒内完成；显式缺一、原子双监听启动等为明确加固差别。
默认材料不存在时只开 HTTP，部分默认材料会给出不含内容的警告。

配置／证书预检在 MCU 与日志获取前执行；失败不连接硬件或
借用调用方打印门禁。任一监听失败回滚已经打开的监听，退出
同时取消 HTTP／WS、原请求及尚未握手的 TLS 连接，不回落到
另一端口或不安全的监听。PEM 内容不进入信息接口、错误或证据；
原配置接口仍保留使用者配置的文件名。

实际 HTTPS 的地址由 ready／listening 的 address.secure 提供，
非空规范前缀仍由 address.routePrefix 提供。示例的直接 API
基址为 https://127.0.0.1:7130/host/printer.v1；客户端必须信任
证书并校验主机名。API 凭据仍必需，TLS 不赋予打印权限。

本机 Fluidd／Mainsail 浏览器仍复用 18430／18434，不新增 HTTPS
浏览器来源；网关私有上游继续原环回 HTTP，公共 HTTPS 可由既有
代理提供。本轮是实际 Node HTTPS／WSS 和模拟 MCU 验证，未把
临时 CA 写入系统或浏览器，也未进行直接浏览器 HTTPS／实机验收。
详细原始样本、包身份、失败及范围见
[直接 TLS 证据](../host/contracts/direct-tls-owner-acceptance.json)。

### 配置路由前缀与固定客户端入口

配置键为 `[server] route_prefix`，不是 `url_prefix`。例如：

```ini
[server]
host: 127.0.0.1
port: 7125
route_prefix: /host/printer.v1
```

此时已有 API 基址为 `http://127.0.0.1:7125/host/printer.v1`，
WebSocket 使用相同前缀；根路径 API 返回 404。重复斜杠折叠、
组件编码；明确空值及点／点点组件拒绝，原始值最多 1024 字节、
规范值最多 4096 字节。缺省不增加前缀。字面路径边界避免前缀
中的点被当作正则通配符，与上游存在明确加固差别。

非空规范前缀在产品 ready／listening 的 address.routePrefix 中
提供，装配客户端时把它附加到私有上游；Unicode 使用该编码值，
不要再次编码。网关的 `--upstream` 可以明确指定
`http://127.0.0.1:7125/host/printer.v1`。登录、刷新、身份核验、
HTTP／WS 和上传回执共用该上游，浏览器来源与登录 cookie 仍在
固定公共根入口。只接受无查询／片段／用户信息的规范环回 HTTP
上游；公共 HTTPS 仍由现有 TLS 代理提供。安全匹配的上游文件
Location 转换为公共地址，客户端转发主机／协议头移除。

本机 Fluidd 仍为 127.0.0.1:18430（探针 18428），Mainsail 为
18434（探针 18432）。确认旧场次退出后复用，冲突停止、不换
端口或停止其他服务；每场含启动最多十五分钟，到期关闭。内部
私有上游端口可动态分配，不改变浏览器来源。

源码／独立 JS／实际包各 258 项通过；原 42 项预算保持并通过，
原网关及 Unicode 前缀同负载对照和根路径／前缀同包完整模拟旅程
通过。详细身份、原失败、样本及边界见
[路由前缀证据](../host/contracts/route-prefix-owner-acceptance.json)。
已有接口加前缀不等于全部上游处理器、客户端或硬件
验收完成。以下保留前序接线及其原包验证范围。

可信代理授权已接入原信任所有者与配置生命周期。server 的
use_xheaders 默认 true，可明确 false；真实 TCP 地址保持，最后
一项 X-Forwarded-For 作为候选，X-Real-IP 优先。RFC Forwarded 不
参与此地址选择。匿名授权必须实际代理与选中客户端各自可信，错误
API Key／JWT 不回落网络身份；强制登录、过期和吊销继续生效。

地址只在原 IncomingMessage 中捕获一次，保持不可变，不改 socket
或跨 keepalive 请求继承。NSS 借用原名单、缓存、期限和退出边界；
等待后重新核对原身份与当前策略。未经验证代理的头不能改登录计数
或短时令牌地址；畸形声明不能回落匿名代理身份。与上游 Tornado 的
未验证／畸形头行为存在明确的安全加固差别，不宣称逐位等价。
首次代理查询在消费 token 之前完成，原五秒生命周期、一次消费
保持。通知／订阅和捕获的打印权限使用同一地址所有者，不重新解析
可变头；取消或关闭后的晚结果拒绝，实际打印权限还核对当前政策。

源码、独立编译 JS、禁止 TS／任意程序的实际包各 47／47，类型
和空白通过。标准包 691 项，只变更四个 JS；75 个原生来源与原
输出逐摘要复用，18 个独立生产依赖保持摘要，不宣称全新原生编译。
复制依赖时曾出现指向旧包的链接，独立性校验拒绝；修正保留原
相对链接后通过。沙箱 EPERM、夹具／类型／配置回执和预算驱动
格式错误都保留，未写成产品通过。

原鉴权四路径与网络六项预定三组 AB／BA／AB 共 30 项最高
1.101 倍，原输入与 1.5／10 微秒预算保持。新代理数值／NSS 缓存
成功路径约 0.715／1.109 微秒，首次真实 NSS 约 23.9 ms；没有旧
成功路径对照。原 namespace／nativeAuthorization／apiLoad 模拟
打印单场通过。首组预算与该场重叠，其余两组在场次终态后执行，
保留全部样本，不宣称隔离或历史原因。预算驱动修正仅读取原网络
结果对象，首组不重测。见[完整代理证据](../host/contracts/trusted-proxy-owner-acceptance.json)。

前序 017ab911 的十五项 CI 与 5106／5106 已成功，实际合并检出
d73063db，见[精确头终态](../host/contracts/pr68-017ab91-terminal.json)。
本增量须自身检查与正常集成。UI、原生构建、G3 精度、全部 Python／
Moonraker／消费者与宏、客户端完整故障及 Cycnumbris 500 实机保持
开放；其他机型最后。以下保留前序调查及其原包身份。

原生交接的分阶段对照已补齐：原输出和五个原输入案例保持，每个
500 次／两预热七样本，两版探针各预定三组 original／off／on
交错，共 18 个进程、90 个案例组；各版 52,500 条带原生时间的
记录和 36 次过程观察封存。两版私有组件回归各 121／121，通过
不等于完整产品或性能预算验收。仓库运行时与运动／数学源码不变。

直接 UI 的消息准备约 0.5 微秒。CPU 只读扩展发现同一进程第一组
UI 中，同 L3 缓存组的排队／调用／回复／完成交接中位数为
2.47／3.43／2.45／3.34 微秒，跨 L3 为 3.85／5.021／3.86／4.91
微秒；原工厂 UI 只有 i+1，没有调用消息。此关联支持下一处设计
聚焦减少必要交接，不能认定历史失败根因。所有慢样本和相同逻辑
CPU 的长尾保留；没有绑定 CPU、调整优先级／频率或改预算。

探针的全新构建在 napi-derive-backend 发生 rustc 内部崩溃：元数据
索引长度 31、访问 16777236。二十份对应依赖产物与前序字节相同，
不足以确定全部依赖或内存原因。保留失败 target 和原日志；复制已
验证依赖目录后的独立目标仍重编译依赖，随后通过；CPU 增量只重
编译组件后通过。这不是首次全新构建通过，原生稳定性门槛仍开放。
初次组件回归因沙箱拒绝 127.0.0.1 监听中止，同一套件在已授权
有限本机范围通过；原 EPERM 日志保留。

分布采用带时钟／锁的私有探针，取记录位于单次计时之后，不能
替换原批次中位数预算。记录 CPU 与时间存在极小观察间隔，过程
分类无并行不证明整机安静。原 1.5 门限、UI 全部失败和 G3 精度
要求保持。见[分阶段及 L3 对照](../host/contracts/template-ui-terminal-probe-acceptance.json)
中的 nativePhaseProfile 与[全部原始证据](../host/contracts/template-native-phase-evidence.json.gz)。

以下保留前序完整消息与终态候选的调查：

完整类型的原生结构化消息对照已独立编译验证；它沿原 tagged 类型
树传递调用，保留精确数字字符串和原 JS 解码器。原 JSON 外壳的
转义与完整元数据仍由有界计数器遍历，64 KiB 上限保持；不能将它
描述为完全移除编码。独立原型 119 项、组合终态／代际原型 120 项，
额外容量边界 2 项通过。这是私有组件原型，不是完整产品验收。

预定三组原预算对照仍有直接 UI 1.538／1.567／1.536 倍、工厂 UI
1.697 倍失败，原 500 次／两预热七样本、冻结参考及 1.5 门限保持。
24 次进程观察未发现已分类编译／测试并行，不证明整机安静或历史
根因。候选未接入；不足以支持移除 JSON 文本传输即可解决 UI 预算。

仅保留两项完整消息元数据回归：最大 u32 渲染编号与第 64 次调用
计入同一 64 KiB 边界；精确边界成功。一字节更大在第 10 次调用
元数据增长时拒绝，不触发第十次回调；此前九次有效作用没有回滚。
源码、独立 JS、禁止 TS／外部程序的原产品包各 121／121，类型和
空白通过。仓库运行时、原生和运动／数学源码未改变，原产品包身份
不变。新增 120 项源／二进制／样本证据，先前 263 项归档保留；见
[UI 调查证据](../host/contracts/template-ui-terminal-probe-acceptance.json)。

前序 b41e33f3 十五项 CI、5104／5104 通过，实际合并检出 45a68579，
见[精确头终态](../host/contracts/pr68-b41e33f-terminal.json)。这不是合入
develop 的证明，不覆盖本增量；本头须独立 CI。下一判别分开原生
排队、消息准备、Node 交接、回复唤醒及完成交接；不重复已拒绝的
ReplySlot／Condvar 方案。UI／G3／全 Python／Moonraker／宏和
Cycnumbris 500 完整交付仍开放，其他机型最后。

以下保留前序两候选调查的原始范围和结论：

前序直接处理原 UI 模板预算，未把其他模块通过当成该门槛关闭。
当前接受冻结包的原脚本仍复现工厂异步 1.678／UI 2.057 倍失败，
输入、期望输出、500 次／两预热七样本及原 1.5 门限不变。

第一候选只减少一次终态 Promise 等待，保留原双线程、32 帧／64
调用、期限、取消与数值协议。首轮六项通过，但预定三组交错中
直接 UI 回调为 1.598 倍，未通过。第二候选进一步以原私密绑定的
存在性检查代际，不无谓取出私密快照；旧包固定反例在八次 UI 渲染
期间额外读取八次私密值（11／期望 3），证明这一类开销。候选
源码、独立 JS、实际包各 120 项通过，仍有回调 1.683／UI 1.856 倍
性能失败，不据功能回归通过采纳运行时优化。

先前采样没有核实并行类型检查的终态，因此新增一次有判别力的
负载控制：三组对照在每个进程前后记录无已分类编译／测试并行，
仍出现 UI 1.526 倍失败。另一个有限对照主动启动同一类型检查，
四段测量前后均实际观测到编译进程。两组均保留，不把相关性当成
历史失败根因，不使用安静结果覆盖原失败，也不调高门限。

两个原型现已撤回；运行时源码与原 69d58486 相同，原生／数学
输出不变，原包仅用于回归，没有重新原生编译或新增打印验收。
仅保留两项原行为回归：完成信号观察者重入取消／关闭不能覆盖已
发布结果，同步原生准入失败仍返回拒绝的 Promise 且不占住帧容量。
恢复后源码、独立 JS、禁止 TS／外部程序的原实际包各 119／119，
类型与空白通过。263 项完整证据含候选源、冻结包、原型失败和
过程观察；见[UI 终态调查](../host/contracts/template-ui-terminal-probe-acceptance.json)。

前序 69d58486 十五项 CI、5102／5102 通过，实际合并检出 31a8f544，
见[精确头终态](../host/contracts/pr68-69d5848-terminal.json)。本回归与
证据增量须自身 CI。下一判别聚焦原生调用／回复／完成的跨线程
交接成本，保留 UI 原失败和打印精度边界。完整 Python／Moonraker／
消费级宏、原生构建稳定性／G3／Cycnumbris 500 与正常集成仍开放，
其他机型最后；以下记录保留各自原包身份。

配置 CORS 的数字 Origin 回退现借用原授权所有者的主机名／NSS
名单、缓存与退出边界，不另外建立解析器或活动名称缓存。非空规则
未匹配的规范数字 Origin 上查询；Origin 中的主机名不直接查 DNS，
原 IPv6 括号排除和 Python 专有正则兼容差额保持。跨域许可不授予
RPC／打印身份，强制登录、错误 API Key／JWT 仍返回 401。

HTTP 和升级在查询前纳入原请求所有者；原期限包含等待，关闭、
客户端断开或升级 EOF 取消原信号。待完成升级也占用原连接与请求
容量，晚结果不能打开连接或执行接口。先复现旧预检 403／期望 204，
随后扩展测试发现升级 EOF 未及时释放等待；实际修复 EOF 监听后
同一输入通过。失败、沙箱及归档准备诊断均保留，没有放宽断言。

源码、独立 JavaScript、实际安装包各 44／44，完整类型及空白检查
通过。原网络脚本 200 HTTP／500 WS／30 次启动关闭、三预热十一
样本未改，三组 AB／BA／AB 的十八项对照最高 1.041 倍，保持 1.5
门限；其无 Origin／惰性鉴权负载不冒充 DNS 开销。新共享缓存路径
十万次查询、三预热五样本约 2.510 微秒／次，实际 NSS 冷查约 25.8
毫秒，没有旧成功路径耗时对照，也不代表目标板吞吐。

新冻结包 690 项、独立离线安装 18 个锁定依赖，仅五个接线 JS 不同；
核对 75 个原生来源及输出后复用，数学／打印内核不变，未重新原生
编译。原 namespace／nativeAuthorization／apiLoad 模拟混合场景使用
既有 CORS Origin 选项通过，状态 P99 8.363 毫秒、步进最小提前量
89.552 毫秒，原输入、断言与期限保持。它使用字面来源规则，不是
打印中阻塞 DNS、完整矩阵或实际客户端证据。见
[CORS 共享所有者与完整记录](../host/contracts/cors-trusted-domain-owner-acceptance.json)。

前序 8bd11bdb 十五项 CI、5092／5092 通过，真实合并检出 68b96856，
见[精确头终态](../host/contracts/pr68-8bd11bd-terminal.json)。本接线
须自身新头 CI；完整 Moonraker／全部 Python／消费级宏、可信代理／
完整正则、原 UI／原生构建／G3／Cycnumbris 500 与正常集成仍开放。
其他机型最后，以下记录保留其原包身份。

驱动电流设置现复用原 GCodeDispatch.runAdmissionExclusive 与维护
门禁，只允许跟随已准入的空闲时钟工作。普通脚本／打印／其他维护
不能成为延迟设置的等待队列。进入同一所有者后重新鉴权并核对原
用户名、代际寿命、状态令牌、驱动型号最大电流和机器空闲；随后才
取得维护门禁及开始写入。原十秒包含排队和鉴权。准入前拒绝／取消
不停止其他工作，实际写入失败保持门禁失效、硬件关闭和安全停止。
请求字段在等待前冻结；并发重复拒绝，已完成的精确重试仍不重放。

真实调度／维护门禁的可控时钟夹具在旧代码确定返回 idle 409；修复
覆盖时钟交接、期间打印／权限／身份／版本／型号变化、取消／关闭、
十秒期限、挂起鉴权、晚权限、不可变参数及写入失败。相关源码、
独立 JS、禁止 TS／外部程序的实际包各 50／50，通过完整类型检查。
这证明空闲时钟竞争这一类问题；前一主机名包的瞬态 409 仍保留，
不能断言每次历史拒绝均由它造成。

原四驱动／2000 次查询、两预热七样本未改，冻结前后包三组
AB／BA／AB 最高 1.009 倍；实际调度就绪查询补充对照最高 1.014 倍，
保持 1.5 门限。历史基准摘要不同源于九月 f308f112 增加 max_current，
本增量未修改原脚本；原历史记录与差异均保留。没有旧的成功时钟
等待路径，故不编造等待耗时对照。桌面查询不代表目标板吞吐。

新冻结包 690 项，独立离线安装 18 个锁定依赖；仅驱动电流与产品
接线两个 JS 不同。核对全部 75 个原生来源及原输出，数学／打印
内核字节不变，未重新原生编译。原 namespace／nativeAuthorization／
apiLoad 模拟打印混合场景通过，状态 P99 4.219 毫秒、最小步进
提前量 88.67 毫秒，原输入、期限和断言不改；不是完整矩阵或实机。
见[驱动电流调度与完整记录](../host/contracts/driver-current-clock-admission-acceptance.json)。

前序 5ee090ca 十五项 CI、5081／5081 通过，真实合并检出 3b691d33，
见[精确头终态](../host/contracts/pr68-5ee090c-terminal.json)。本修复
须自身新头 CI。全部 Python／完整 Moonraker／消费级宏、原 UI／
原生构建稳定性／G3／Cycnumbris 500 与正常集成仍开放，其他机型最后。

以下主机名与页面记录保留原包身份。

trusted_clients 的主机名现经系统 NSS 查询接入原授权所有者，包括
HTTP／WebSocket、通知／订阅、access.info 及实际配置装配。数字 IP／
CIDR 仍同步匹配，明确主机名精确匹配并缓存 84,000 秒；错误凭据、
强制登录和未实现的代理委托不能借此取得权限。查询后的准入仍重新
检查原身份、当前策略及请求寿命，没有新增身份别名。

查询在受控 Node 子进程执行，不调用 Python 或共享 libuv 名称线程。
五秒包含启动；最多四子进程、十六待查地址、4096 缓存地址。取消、
超时及关闭终止并排空原子进程；一名调用者取消不影响同址其他调用者，
关闭后的晚结果不能重新授权。仅 NSS addon 从私有 C／Node 头快照
重编，74 个未改原生来源及数学／打印输出按原摘要复用。新包 690 项，
独立离线安装原锁定 18 个依赖；不宣称重新完整原生构建。

源码、独立 JS、实际包各 40 项通过，ASan／UBSan 各 4 项及类型检查
通过。四条原鉴权负载不改，三组 AB／BA／AB 对照最高 1.083 倍，
保持原 1.5 与 10 微秒门限；新缓存域名路径约 0.542 微秒。实际阻塞
NSS 子进程时，文件写入／事件循环 P99 为 0.574／0.497 毫秒，
保持 50 毫秒。最终包原鉴权／文件／模拟打印混合场景通过，原输入、
提前量和事件循环断言不改；不代表目标板吞吐或物理运动精度。

前一配置包的初始化驱动电流请求出现 idle 409；原失败保留，基线
及最终冻结包的同一场景通过，具体瞬态原因尚未证实，继续跟踪，
不将它写成已修复或据此放宽空闲保护。真实配置装配曾绕过异步
名称入口，已修正为同一原所有者的网络入口。见
[主机名接线与完整证据](../host/contracts/trusted-client-domains-acceptance.json)。

前序 68aeffa8 十五项 CI、5063／5063 通过，实际合并检出 7586b98c，
见[精确头终态](../host/contracts/pr68-68aeffa-terminal.json)。本运行时
增量须自身完整 CI。完整 Moonraker／Python 退役／消费级宏、可信
代理及完整 CORS／配置、原 UI／原生构建／G3／Cycnumbris 500 和
正常集成仍开放；默认 Python 不切换，其他机型最后。

以下目录与客户端记录保留其原软件包身份。

标准 multipart 的上传目录现相对所选根处理，支持客户端的 `path="/"`
及首尾分隔符；内部空段、路径穿越、受保护名称和字面百分号的原
规则保持，目录仍逐级鉴权。G-code／UFP 复用原发布、打印和队列，
配置上传复用原限定写入、备份和只读规则，不修改运动或原生代码。

源码、独立 JS、实际安装包各 118 项通过。原 4／16 MiB 上传负载、
两预热七样本、三组 AB／BA／AB 对照最高 0.995 倍，保持 1.5 门限。
新包 688 项、独立离线安装 18 个锁定依赖，核对 75 个原生来源并
复用未改输出；仅上传 JS 改变，不宣称重新原生构建或打印尾延迟。

Fluidd R38 实际文件选择立即返回，服务收到 `path="/"` 后 HTTP 400，
定位为产品路径拒绝；161 秒关闭，不据此解释此前所有工具长等待。
R39 新包在同一固定 18430／探针 18428 完成两份新文件的真实选择
上传及打印，18,785／944 字节与原件一致；从文件菜单明确入队后，
同包产品进程正常重建，原队列／文件／完成历史保持且暂停、不重放。
重新页面归位及新清台确认后第三份任务完成，请求身份不同。
实际配置编辑器保存了仅新增注释的 printer.cfg，58 字节已精确核对。
场次 605 秒关闭，两监督进程退出 0，四固定端口无遗留。

打印中 Fluidd 禁用“上传并打印”，该次文件选择等待没有事件，不计
忙碌页面入队通过；编辑器原生输入上下文的定位失败和成功浏览器
键盘路径均保留。只读 API 作佐证，无 API 上传／配置写入替代。
Mainsail R40 使用同一固定 18434／探针 18432，内置浏览器文件选择
调用仍长等待，工具回报 3573 秒，场次 889 秒已关闭，无上传请求；
原因未定，不归因于权限拒绝。按已授权浏览器后备路径，R41 使用
已安装 Chrome／Playwright、独立临时档案且启用浏览器沙箱，没有
调整安全设置。真实普通选择器上传两份新文件，18,785／944 字节
与原件一致，上传后没有任务或队列；页面明确打印第一份并完成，
打印中从文件菜单把另一份入队，忙碌页面禁用清台确认。同包产品
进程正常重建后完成历史、文件及暂停队列身份保持，不自动重放。
实际编辑器保存仅增加注释的 58 字节 printer.cfg，摘要与原件核对。
R41 重建后的重新归位／新确认未完成第二份打印；下方 R42 补齐。
首次归位尚未确认结束时的两个上传 409 及过期前未完成动作保留。
R41 场次 889 秒关闭，两个监督子进程退出 0；浏览器 886 秒关闭，
沙箱开启、临时档案删除。无过期重启。只读 API 佐证真实页面，
不替代上传、配置写入或打印操作。见
[Mainsail 同包证据](../host/contracts/mainsail-upload-recovery-acceptance.json)。

R42 沿同一锁定包及固定端口补齐上述恢复续打缺项：两份真实选择器
普通上传后没有自动打印／排队；页面明确完成第一份，打印中从文件
菜单加入另一份。进程正常重建后原完成历史、文件及暂停队列身份
保持。页面重新归位，请求新的清台确认并重新勾选／提交，第二份
打印完成，两个请求身份不同、队列为空。实际 History 页面显示
两份成功作业。R42 在 465 秒内主动关闭，两监督子进程退出 0；
浏览器 461 秒关闭，沙箱开启、临时档案删除，无过期重启。
浏览器回调仅捕获确认请求的回执，提交后立即返回控制台；原产品
日志两个 start=200 及两个耐久完成作业共同佐证，不伪造浏览器回执。
同包模拟证据不代表 SIGKILL／故障、物理精度、目标吞吐或完整迁移。

SIGKILL／故障旅程、完整客户端与硬件仍开放。
见[目录修复与实际页面证据](../host/contracts/client-upload-path-acceptance.json)。

前序队列头 3d9f439a 十五项 CI、5060／5060 通过，真实合并检出
`d23d11b3`，见[终态](../host/contracts/pr68-3d9f439-terminal.json)。
运行时头 81e9a21d 十五项 CI、5063／5063 通过，实际合并检出
7ac9a1f9，见[精确头终态](../host/contracts/pr68-81e9a21-terminal.json)。
本记录增量须自身新头 CI；全部 Python、完整 Moonraker／消费级宏、
原 UI／原生构建／G3／Cycnumbris 500 及正常集成仍开放，其他机型最后。

以下为前序上传队列候选的锁定记录；其“须自身 CI”由上方精确头
终态补齐，完整客户端缺项按本轮实际通过范围逐项更新。

明确的上传打印意图现接入原持久队列。`[file_manager]` 的
`queue_gcode_uploads=true` 必须同时装配 `[job_queue]`，缺省关闭。
标准上传与 OctoPrint 上传／选择在设备忙碌或新请求到来时已离线的
情况下，可以将刚发布的不可变文件加入同一队列；普通上传不排队。
逐次核验原网络身份、队列及打印权限，入队前后核对文件身份。
已进入打印控制器后的异常或丢失回执不回落排队，避免重复打印。
上传与选择绑定原设备代际；离线准入不能启动后来恢复的代际。

队列重建保持暂停及原文件／任务身份，不自动重放。启用操作确认
策略时，自动续打仍等待实际完成后的新清台确认。相关源码、独立
JavaScript 及实际产品包各 225 项通过；三组既有队列及新增不可变
文件准入预算通过，保留原 1.5 与 50／50／100 ms 门限。
仅本机模拟软件证据，未覆盖目标板打印吞吐、运动精度或完整页面。
见[上传队列验收](../host/contracts/upload-queue-intent-acceptance.json)。

前序 ff5b29be 十五项 CI、5044／5044 通过，真实合并检出 8e5b0f1c，
见[精确头终态](../host/contracts/pr68-ff5b29-terminal.json)。本队列修复
须自身新头 CI；全量 Python、完整 Moonraker／消费级宏、完整客户端、
原 UI／原生构建／G3／Cycnumbris 500 和正常集成仍开放，其他机型最后。

候选配置：

```ini
[file_manager]
queue_gcode_uploads=true

[job_queue]
job_transition_policy=operator_confirmation
```

入队回执含 `print_queued=true` 和 `print_request_id`；发布成功而打印／
队列被拒绝时保留文件，并返回明确 `print_error`，调用者先查询原任务
状态，不自动重试打印。设备动作开始后的准备失败仍属于原任务。

以下为前序切片器兼容的锁定记录；其中上传队列软件缺项由上方证据
补齐，Cura 插件页面和完整客户端旅程继续开放。

可选 OctoPrint 切片器兼容入口已接入当前 Node 产品。配置
`[octoprint_compat]` 后，9 个静态状态／命令接口与文件选择接口
仅开放 HTTP，沿原网络鉴权直接返回上游 JSON，选择但不打印返回
204。API Key 身份仍由原授权所有者核验，兼容元数据中的 _api／
admin 标签不授予任何权限。动态路径只解码一次，不能通过请求体
或查询覆盖；打印与命令再次经过原控制入口及设备代际检查。

`/api/files/local` 是原 NativePrintUploads 的别名，复用流式容量、
私有暂存、校验、UFP 解析、不可变发布和任务日志。Location 指向
`/api/files/moonraker/gcodes/…`，选择及明确 print 意图复用原打印
策略，不能上传配置文件。enable_ufp=false 同时关闭能力声明并
在发布前拒绝 UFP。单纯 select 不启动动作；上传后打印拒绝仍保留
文件和显式失败回执，不重放。上传后自动排队的完整兼容尚待补齐；
选择文件的队列回落仅适用于已装配且明确启用的原队列。

状态从当前机器所有者读取；断线仍显示上次温度并明确 Offline／
Error。温度使用原 binary64 十进制舍入实现，未修改运动数学。命令
保持固定上游的顺序与运行失败兼容行为，鉴权、取消和代际失效
继续传播；支持的动作与宏以原控制入口为准，不据此宣称全部脚本
或消费级宏已交付。握手复用不可变版本响应与已解析 Promise，
仍逐请求核验取消和组件关闭，其他状态始终动态读取。

一次性冻结实际固定上游 106 个响应案例，日常回归与新增基准只用
Node。源码、禁止 TS／外部程序的独立 JS、实际安装产品包均完成
受影响的 156 项原回归。三组固定响应对照最高 0.825 倍，原 1.5
门限保持；现有实际 HTTP／WebSocket／启动路径最高 1.065 倍。
早期握手 1.607／1.509 超限和准备失败全部保留。最终网络接线
字节保持，上次网络基准没有装配此可选组件，不冒充启用后的测量。
详细原始失败与性能门限见
[切片器兼容验收](../host/contracts/octoprint-compat-acceptance.json)。
新包 688 项、18 个锁定生产依赖，核对 75 个原生来源并复用原输出；
相对归位包仅五个 JS 不同。该证据不覆盖 Cura 插件页面、实机、
原生重新构建、全部 Moonraker 或全部 Python 退役。

归位修复头 5c934240 十五项 CI、4925／4925 通过，真实合并检出
eca53e86，见[终态](../host/contracts/pr68-5c934-terminal.json)。
本切片器增量须自身新头 CI；177 个 Python 文件、默认入口、完整
客户端／宏／队列、原 UI／构建／G3／目标板和正常集成继续开放。

候选配置示例：

```ini
[octoprint_compat]
enable_ufp=true
flip_h=false
flip_v=false
rotate_90=false
stream_url=/webcam/?action=stream
webcam_enabled=true
```

切片器使用原授权所有者提供的 API Key，发送 X-Api-Key 请求头；
不要将密钥写入地址或 Git 配置文件。可用原 Node 26 执行
`node host/bench/octoprint-compat.mjs` 检查冻结的响应预算。


以下为前序候选的锁定记录；其“须自身 CI”不替代上方精确头终态。


归位二次授权现在与原120秒期限、请求取消及代际退役共同受控；授权用户名变化时拒绝执行。未开始物理动作时释放调度准入，不触发安全停止；迟到授权不能启动归位。外部授权 Promise 本身仍不可强制取消或 join。固定反例、首轮 Windows 环境失败、home22项通过及 Linux12项／标准类型检查见[归位契约](../host/contracts/native-home-clock-admission-acceptance.json)的 reauthorizationFollowUp；不据此声明新锁包、页面或目标板延迟已验证。

Fluidd 页面 G28 的空闲时钟竞争已修复。诊断 R35 捕获真实脚本
G28 与 portBusy，R36 确认是后台 clock 阶段；其首个页面 G28 没有
失败，不将采样诊断包计作产品或性能通过。归位现只跟随原调度
所有者的空闲维护，等待后重新核对权限、令牌、代际、机器空闲及
维护门禁。原 120 秒期限包含等待；尚未启动物理动作的准入拒绝
不停止其他所有者，启动后失败仍沿原安全停止，不修改运动数学。

源码、禁止 TS／外部程序的独立 JS、实际完整包各 39 项回归通过。
原 500 次负载、两预热／七样本的三组交错对照最高 1.384 倍，
保持 1.5 门限；原 10000 指令精确输出基准中 Node 中位 21.65 ms，
Python 38.25 ms，事件循环 P99 1.426 ms。该基准仍使用 Python
参考，不能据此声明所有 Python 已退役或目标板打印性能通过。

新包 687 项、独立离线安装 18 个锁定生产依赖，只三个接线 JS
变化；核对 75 个原生来源并复用原输出，没有重新原生编译。固定
Fluidd 18430／探测 18428 的 R37 实际页面完成初次归位、打印、
取消、标准 Firmware Restart、再次页面归位及另一份任务完成，
无 HTTP 归位替代、无归位 409。原两个模拟 MCU 各复位一次／
配置两次，旧取消身份及累计时长保持、不自动重放；308 秒关闭，
两个监督子进程退出 0，无延长或过期重启。文件仍由 API 种入，
不计作文件选择上传；不计作层计数、实机或完整客户端验收。

原始反例、准备／初版失败、完整样本及页面截图见
[归位调度验收](../host/contracts/native-home-clock-admission-acceptance.json)。
前序记录头 887d2713 的十五项 CI、4917／4917 通过，真实合并
检出 ec965b44，见[终态](../host/contracts/pr68-887d-terminal.json)；
本运行时修复须自身新头 CI。全部 Python、完整 Moonraker／消费级宏、
文件上传／配置编辑／完整队列、原 UI／构建／G3／目标系列门槛及
develop → master 出口仍开放，其他机型最后。

以下为前序锁定包的历史记录；R34 页面归位失败保持原证据，
上方 R37 新包有限旅程已补齐该缺项。

同一 `067310d9` 独立 687 项包的 R33 已补齐 Mainsail 页面取消、
标准 Firmware Restart、重新归位及另一份任务完成；两个原模拟 MCU
各复位一次／配置两次，旧取消任务身份和时长保持，不自动重放。
场次在 417 秒关闭。Fluidd R34 取消和标准恢复确认，但页面 G28
初次及恢复后两次均返回 409。只读诊断显示当前归位准入可用，
同场标准 HTTP G28 成功后，页面新短任务完成；它不能代替页面
归位成功，Fluidd 完整恢复旅程仍开放。R34 在 786 秒关闭。
两场所有监督子进程均退出 0，无延长或过期重启，固定来源保持。
见[恢复后续原始证据](../host/contracts/client-recovery-followup-acceptance.json)。
当前代码头十五项 CI、4917／4917 已通过；记录修改须自身检查。

当前模拟客户端取消使用原协调安全停止；官方页面可进入 shutdown，
提示需要重新初始化。使用标准 Firmware Restart，等待状态恢复
ready，再重新归位后准备下一份任务；普通 RESTART 不用于清除
已停止 MCU 的状态。R29／R30 实际页面确认取消与标准固件恢复，
两个原模拟 MCU 的复位／配置计数证实重新初始化，Mainsail 的取消
任务和原请求身份仍保留，不自动重新开始。R29／R30 当时没有验收
恢复后再次打印；上方 R33／R34 分别记录后续通过范围和归位拒绝。
同包两客户端浏览器下载已与原件逐字节核对，固定来源 18430／18434
保持；文件选择上传和配置编辑仍待验。详见
[同包后续证据](../host/contracts/native-home-compatibility-acceptance.json)。
该代码头 `d782761f` 十五项 CI 和普通 4807／4807 已通过，本记录
不代替实机、运动精度、原 UI／构建或默认入口切换门槛。

内部 `httpClient.probe(url, options)` 排空解压后的流并检查容量，只返回
2xx 可达结果，不保存图片或使用／修改条件缓存；正常 HTTP 请求的
响应字节与缓存行为保持。标准摄像头借用同一进程实例；关闭摄像头
取消其探测并排空，不能关闭借用资源，服务退出才关闭进程客户端。
独立摄像头实例自建客户端并在退出关闭。保留四请求、1 秒、8 MiB
边界，源码／独立 JS 26 项及原 1.5 桌面对照通过，见
[摄像头接线](../host/contracts/webcam-http-owner-acceptance.json)。
该闭包不是包含本增量的新完整包；前序整包证据仍绑定下述 `2bdf89ac`。
UI 整数直传原型因交错预算失败未采用，模板 ABI／协议保持原实现。

当前 `2bdf89ac` 完整包已重建并独立安装锁定生产依赖，686 个清单
文件及原生来源／输出核对；源码与编译的固定频谱、整形结果一致。
禁用 TS 加载／PATH 外部程序的冒烟与原鉴权文件／队列／模拟打印
混合旅程通过。原模板 UI 两项仍为 2.060／1.506 倍，原 1.5 门限
保持。R22 Fluidd 登录／列表通过，上传工具约 105 分钟返回时场次
早已于 888 秒关闭，没有上传请求记录，不推断为权限或产品错误。
同头十五项 CI、普通 4801／4801 通过；参见
[当前整包记录](../host/contracts/current-bundle-2bdf-acceptance.json)及
[精确 CI 终态](../host/contracts/pr68-2bdf-terminal.json)。
这不覆盖完整客户端、默认构建稳定性、G3 或目标板验收。

内部 HTTP 的 `json()` 返回可包含 BigInt 的组件值；请求对象／数组
同样支持 BigInt 数值 token，不转换为字符串或舍入 Number。
默认整数容量 4096 位，响应可显式传入 `integerDigits`。普通整数
保持 Number，浮点保持 binary64；负零及缓存原字节保持。
该类型不等于公共 RPC `Json`，不得据此把 BigInt 自动转为 Number
或授予运动指令权限；公共解析／验证保护未改。私密文件继续保存
原始模板词法与不可变代际。源码／独立 JS 各 136 项及原桌面预算
通过，初版退化保留，见[精确 JSON 记录](../host/contracts/http-exact-json-acceptance.json)。

### Web 客户端更新状态与刷新

配置可启用进程所有的 update_manager；须有进程数据库，目录为实际独立 Web 安装：

```ini
[update_manager]
enable_system_updates: false
enable_auto_refresh: false

[update_manager mainsail]
type: web
path: ~/mainsail
repo: mainsail-crew/mainsail
channel: stable
```

本阶段支持 stable／beta；dev 明确告警并回落stable。优先严格读取release_info.json；
文件损坏不回退，仅缺文件时读取.version及已知Mainsail／Fluidd manifest。路径须可写、
无Git祖先，不能与进程配置／数据库／备份路径重叠；私有事务目录同样不能重叠这些路径。
GET /machine/update/status（RPC machine.update.status）返回缓存、共享GitHub限额和version_info；
refresh=true可要求刷新，仍受60秒节流及忙态约束。POST /machine/update/refresh接受可选name，
启动未完成或打印／安装忙时503，其余串行刷新；成功持久化后延迟200ms广播notify_update_refreshed。
两入口沿既有鉴权，GET不请求网络或启动子进程。首次刷新在监听启动后，退出取消并等待I/O，
不在打印设备代际切换时重建，也不关闭借用的共享资源。

POST /machine/update/client 与 RPC machine.update.client 接受必填 name，实际下载并更新指定Web客户端；
POST /machine/update/rollback 与 RPC machine.update.rollback 使用本地保留的前一目录回滚，成功返回 ok。
这是相对固定上游重新下载旧版的可靠性改进：回滚也以当前 persistent_files 覆盖候选，不倒退更新后的用户设置。
persistent_files 仅允许不同的顶层文件／目录名，禁止 .version／release_info.json；嵌套配置明确报错。
旧用户内容覆盖发行包同名项；普通包目录0755、文件0644，保留文件／目录保留原普通权限位，特殊位不复制。
需要进程用户写入安装父目录及同父目录私有 .anyraid-web-* 控制目录；控制目录0700，使用内核目录锁排除竞争进程。

下载上限128MiB，逐项核声明size、若GitHub提供则核sha256摘要、ZIP成员CRC和候选版本／仓库元数据；
没有摘要时仍执行长度、CRC及元数据检查，不将其表述为签名或可信来源证明。不支持加密、穿越、重复／冲突路径、
符号链接或特殊文件。解压／复制使用异步有界I/O；最多10000项、单文件128MiB、解压总量512MiB，持久文件复制同样有界。
元数据在持久文件覆盖后再次验证。安装／回滚期间持有当前维护门禁，阻止新打印；发布前重新鉴权并复核当前门禁、
打印所有者及安装／父目录身份，旧设备代际或撤销身份不能迟到切换。明确native退休且排空、硬件／组状态均stopped时
允许离线Web更新；未知或陈旧的外部Klippy断连状态保守拒绝，尚非上游全部离线兼容。

先保留旧目录，再以两次rename切换；这不是全程原子操作，中间安装路径可能短暂缺位。
耐久intent、目录身份和目录fsync支持重开判定：旧目录尚在则取消准备，旧目录已移走而新目录未发布则恢复旧目录，
新目录已发布则确认备份。恢复自身可重复；身份不匹配时拒绝并要求检查，绝不按名称盲删用户安装。
进入两rename提交阶段后关闭等待一致性收尾，再释放门禁；新设备附着也等待本次维护结束。此前取消下载会排空I/O。
进程被强杀于intent写入之前可能留下私有准备目录／下载文件；它们不自动重放或按名称盲删，需离线核对后清理。
notify_update_response 含 message／application／proc_id／complete；更新／回滚完成持久缓存后发完成事件，并延迟发送notify_update_refreshed。

moonraker／klipper状态目前为上游BaseDeploy的{}，指定refresh为无动作；不表示核心可更新。
moonraker／klipper／system／full／upgrade五类动作仍明确501，无部署效果；公开recover仅供下述Git候选，
Web恢复仍仅为中断目录事务一致性恢复。完整Git、ZIP／executable provider、系统包与Node核心自更新仍待完成，
核心自更新不得照搬Python venv／pip。本机与184定向测试不代表生产部署、掉电文件系统或真实设备验收。
具体记录见[Web更新验收](../host/contracts/update-manager-web-acceptance.json)。

### Git 纯仓库应用更新候选

Git应用接入现有update_manager，默认Git频道为dev，primary_branch为master。下例显式关闭服务重启及依赖更新：

```ini
[update_manager my-client]
type: git_repo
path: ~/my-client
origin: https://example.org/owner/my-client.git
is_system_service: false
enable_node_updates: false
channel: dev
primary_branch: master
```

GET状态只读内存缓存；显式刷新使用真实Git读取branch、remote、hash、dirty／detached／diverged、
版本和commits_behind，fetch失败保留last_error且不推进成功刷新时间。stable／beta按固定上游标签创建顺序、
包含关系及GitVersion比较选择目标；pinned_commit至少8位，只向包含当前提交的固定提交前进，不自动降级。
正常更新拒绝任意tracked／untracked改动、detached或diverged，须显式recover才能执行破坏性恢复。

client与rollback接受必填name，适用Git应用；rollback持久保存commit／branch／version。
recover接受name与可选hard／update_deps布尔；HTTP查询可用true／false，其他类型400。
公开参数按固定上游使用update_deps；内部名force_dep_update作为未知公开字段返回400。
soft恢复优先pin／当前提交祖先，否则primary远端，并先有界备份原目录；hard克隆新候选、验证后保留原目录替换，
不删除历史Git恢复备份。启用enable_node_updates时update_deps=true执行真实强制依赖准备；未启用时仍501且无仓库动作。损坏旧config的hard恢复仅用先前可信目录身份，
不运行旧仓库Git；未完成事务重开报告interrupted，必须显式恢复，不自动重放。

安装目录、父目录及.git身份受保护，安装／控制目录不能与其他Web／Git应用或进程配置／数据库／备份重叠。
Linux内核目录锁按仓库规范路径区分所有者；取消等待Git及其子进程退出，关闭先排空更新再关闭数据库。
所有Git命令使用argv与有界输出／超时，禁用hooks、外部filter、credential helper及不安全配置，不公开原始stderr／凭据。
目前仅支持无用户名密码、query或fragment的HTTPS源；SSH、file源、moved_origin、Python环境、安装脚本、系统依赖等明确拒绝。
worktree／submodule仅读本地元数据，不fetch或mutation；主仓库有非空.git/worktrees或.git/modules时拒绝hard替换。

is_system_service默认true，未指定managed_services时托管自身服务；设为false使默认列表为空，显式空managed_services关闭服务动作。
managed_services仅允许应用自身名称、klipper、moonraker，按此固定顺序去重，服务名须通过实际MachineControlPort许可。
Git更新／回滚／显式恢复在仓库动作后沿可信ProductHostControl顺序提交服务动作；Node共进程的klipper／moonraker
合并为一次最后执行的server_restart，并在service_progress记录别名映射。普通服务等待现有OS job submission终态，
不证明服务ready；自己进程重启必须等待真实HTTP／RPC响应交接，响应返回时任务仍可处于忙态，不能据此认定更新成功。

更新同时持有进程与当前设备维护租约，控制动作同步转移同一租约，普通终态归还后再提交下一服务。设备退役后
由持续持有的进程维护所有者承接余下动作，配置写入和attachNativePrinter仍受围栏约束。离线控制保留原设备代际signal作为请求身份，
维护动作取消另绑存活进程signal；旧代际请求不能借用该维护signal绕过身份核对。queued控制记录落盘后，
先持久关联更新事务及request_id，才允许任何OS dispatch。关联写入挂起时超时／关闭立即拒绝admission并永久取消dispatch；
已受理数据库写仍受控排空，completion及close等待真实I/O结束后才归还租约，不声称可终止不可取消的写入。
失败不发送成功文案；未确认或重开后的服务结果保持interrupted，不自动重放，显式recover也拒绝重放未知服务动作。
受信人工核对后的恢复出口仍待后续实现。enable_node_updates=true接入下述普通应用能力；现有product-install要求
可信build-info清单、独立bundle且无node_modules，完整产品pipeline仍待接通，不能把任意Git checkout冒充产品包。
本批真实接口测试的精确HTTPS fixture地址由测试可执行shim映射到临时bare仓库，生产不开放file入口，Git TLS网络传输未验。
软件与有限桌面观测不代表完整provider、目标板、真实设备或部署验收。
分项结果、初轮缺assets失败及限定补验见[Git更新候选验收](../host/contracts/update-manager-git-acceptance.json)。
#### Git Node 依赖生命周期候选

`NodeDependencyTransaction` 为后续 Git 部署提供独立的 manifest 捕获、
`prepare`、`commit`、`rollback`、`reconcile` 和显式 `discardBackup`。
GitDeployment在 `enable_node_updates=true` 时捕获变更前manifest及依赖目录身份，
按两侧锁文件哈希变化触发真实prepare／commit；同锁校验并保留当前树。
普通更新要求变更前已有有效lock和匹配生产树，缺失则在Git变更前拒绝并要求显式
recover `update_deps=true`；新Git目标缺lock则保留interrupted，不隐式force或声称ready。
公开 `update_deps=true` 是用户force；hard换根及其已记录中断的重建是独立内部原因。
服务动作仅在依赖一致且阶段耐久保存后运行；未知服务结果继续拒绝重放。
可信运行选项 `updateNodeDependencies` 可注入npm工具／cache，默认只从当前Node安装发现npm，
不读取HTTP参数或用户环境中的npm路径，不将普通Git checkout当作已验证产品包。

普通应用要求 npm v2／v3 锁文件、带完整性摘要的 HTTPS 生产依赖，
在私有暂存目录实际执行隔离 npm `ci --omit=dev --include=optional --ignore-scripts`。
只核实际生产树；省略的开发依赖含脚本不阻止纯生产包安装。
普通应用的安装／prepare 脚本、原生构建或 `.node`、file／link 包、
工作区、项目 `.npmrc` 目前明确拒绝，不能据此宣称本产品所需依赖已完整支持。
用户 npmrc、registry 重写及凭据不继承，原始 npm 输出不公开。
产品包来源另须调用方提供可信生成流程产出的 `build-info.json` 摘要并通过
`verifyProductBundle`；本模块不生成或自签该文件，也不重建原生插件。

提交前重核授权、manifest 和目录身份；失败／取消保留旧依赖并等 npm 退出。
替换先耐久保存 intent，再两次 rename 与目录 fsync；关闭等一致性收尾。
重开不执行脚本，须显式 `reconcile`；Git manifest 回到对应版本后才能回滚旧树。
备份删除先保存可重复的discard intent。连续A→B→C自动保留最新一代B回滚：
先耐久确立Git回滚目标及旧manifest，真实npm候选完成prepared后才清理过期备份、提交新树。
同锁Git回滚识别当前依赖，不能误用更旧备份。失败保留旧树与interrupted阶段；显式recover
对齐当前Git与旧依赖，不把Git更新但依赖过期的状态称为ready。
hard恢复从耐久Git克隆记录读取旧root／.git、旧目录位置及新身份，逐项核验后重新绑定Node所有者；
旧根依赖保留，新根实际准备依赖；迁移后prepared中断可重开显式恢复，不绕过身份检查。
manifest、条目、文件、输出和期限均有上限；50ms 采样暂存／cache 容量是应用层监测，
不是内核磁盘配额。Linux 内核目录锁排除另一所有者。

184 Node 26.12.0／npm 11.19.1 使用锁定纯包与隔离离线 cache 完成真实安装、
A→B→回滚 A、取消排空和故障恢复；HTTPS 传输、产品实际 npm 安装、完整新包／原生构建、
服务和设备均未验。复用既有依赖与 `sealed-file.node`，不是全新构建。
分场首次失败、定向修正及一次有限计时见
[Node 依赖基础验收](../host/contracts/node-dependency-update-acceptance.json)。
接线场次另见[Git Node生命周期验收](../host/contracts/update-git-node-lifecycle-acceptance.json)：
真实Git＋离线npm首轮5／6，手工fetch绕过fixture映射失败保留；只补失败项与配置解析2／2。
备份保留顺序与hard迁移后中断分别定向补验；服务顺序断言在可信hook边界，实际HTTP／RPC验证更新、
回滚及force，不宣称本轮执行真实OS服务或网络TLS，也不重跑基础性能取代原样本。
测试 npm 从当前 Node 安装发现，也可显式设置可信 `ANYRAID_TEST_NPM_CLI`。
功能项仅 Linux；真实预构建产品项要求 `ANYRAID_TEST_PRODUCT_BUNDLE` 指向现有可信产物，
缺失时明确 skip，默认 CI 不覆盖该项，不能把 184 的实测结果归给 CI。

#### 可信产品代际准备候选

`ProductUpdatePreparation` 是产品专用的受信运行API，提供 initialize／prepare／prepared／discard／close，
没有公开HTTP执行路径或激活入口。调用方须预先批准物理Git仓库、无凭据HTTPS origin、完整commit及
`productRecipeDigest`；摘要只证明内容一致，不能让任意checkout自行取得信任。
从已批准commit的Git archive提取产品所需源码子集，拒绝链接、特殊文件、路径穿越、借用build或node_modules。
工具绝对路径、Node headers和可选内容cache种子由可信配置提供；隔离HOME、npmrc、npm cache、Cargo registry／target，
不继承用户registry重写、凭据或构建环境。缓存只提供锁定包内容，不复用既有编译输出。

专用子进程执行完整产品配方：实际开发依赖安装、TypeScript编译、全新九个C／Rust addon与三个helper、
生产依赖安装，以及九addon加载、sharp小图和Worker smoke。npm仍使用ignore-scripts；本产品当前锁定依赖不要求
npm安装脚本，实际原生步骤由批准的产品配方显式构建。这不扩展普通Git应用的脚本／原生支持，也不宣称任意npm脚本可用。
父进程异步监督，默认20分钟期限、4MiB输出、4GiB工作区／150000条目应用层采样上限；采样不是内核配额。
继承模式的编译器子进程不自行声明整组已停，也不提前删构建目录；guardian在组排空后才耐久写入绑定attempt inode与nonce的凭据。
父owner异常退出时继承flock仍被guardian持有，stdin EOF触发排空；正常close取消等待真实退出。
guardian自身被强杀不能证明孙进程已停，即使锁随后可取也拒绝discard并保留interrupted；当前API无绕过出口，需受信人工排空和处理。
已确认排空后的discard先耐久保存清理阶段，允许重开幂等收尾，不自动重建或重跑脚本。

候选完整清单绑定批准来源、输入摘要、工具及运行时、build-info和实际代码／原生／node_modules文件摘要与模式；
父进程在组排空后重核源码、原生输入／输出及Node headers，fsync后封存，重开prepared仍校验持锁身份与attempt inode。
184 Node26.12一次fresh成功耗时63714.650655ms，10ms父timer6157样本的最大额外延迟17.837409ms；没有新增通过门限。
该次源码夹具commit为d68f012c，先于最终guardian收口；后者另用真实父SIGKILL、guardian SIGKILL和close窄场验证，不重复fresh。
前两次fresh的归档容量和缺Unicode输入失败保留，最终完整类型检查通过。
默认CI不执行完整fresh：仅当显式提供`ANYRAID_TEST_PRODUCT_SOURCE`与JSON格式`ANYRAID_TEST_PRODUCT_BUILD_TOOLS`才启用，
缺失会说明skip，不能把184工具链路径或结果当作CI覆盖。详见[产品准备验收](../host/contracts/product-update-preparation-acceptance.json)。

本批不改变安装服务布局。现有unit的ExecStart／ExecStartPre固定realpath，不能靠切current软链接更新已安装服务；
后续仍须固定launcher、代际指针、外部profile绑定／迁移、真实响应后的重启、新进程确认及失败回滚，完整核心更新尚未交付。
未执行网络TLS、真实OS服务／设备、目标板或硬件验收。

标准 `ConfiguredMoonraker` 现拥有一份 Node HTTP／HTTPS 客户端，
通过内部 `httpClient` 接口供组件借用，`server.info` 发现该组件。
它不增加供外部调用者传入任意 URL／目标路径的公共端点，也不改变
打印设备所有者。公告借用客户端，退出时服务关闭客户端并排空，
独立公告实例则只关闭其自建客户端；关闭借用者不关闭进程资源。
保留默认 TLS 证书校验、跨源重定向凭据隔离、连接／请求期限，
限制 32 个活动／排队请求与 64 个缓存条目，缓存总量最多 512 MiB。
公告使用原 1 MiB 输入边界，下载采取流式背压与原最大输入容量。
调用者提供明确绝对目标，或使用 `$TMPDIR` 的私有下载目录；远端
文件名只允许目录内名称。下载写私有同盘暂存，成功后同步并替换，
提交前失败或取消保留旧文件；提交后清理失败增加诊断计数，不误报
或重试已提交下载。此处不代表目录同步／断电恢复已验证。
相关源码／独立 JS 43 项、下载鉴权及清理故障补充各 15 项及原预算通过，
见[HTTP 接线证据](../host/contracts/moonraker-http-client-acceptance.json)。
独立闭包不是完整新产品包；剩余消费者、宽编码／整数兼容、客户端
和目标板／打印门槛仍待完成。

当前另有一份 `997417d4` 控制构建新包：构建进程固定 CPU 0、
`CARGO_BUILD_JOBS=1`，其余源码、锁定依赖及 release 参数保留。
没有据此修改生产构建或应用默认亲和性，也不将一次成功判为稳定。
十二次有限编译核心／负载对照成功，库及元数据字节一致，根因未证。
新包及独立依赖摘要绑定后用于 R20／R21，同包检查和关闭时复核。
R20 上传工具长等待跨过期限，只有登录／列表确认；R21 由 API
种入合成文件，UI 两层预览及重建后队列／配置读取确认。API 下载
944 字节一致不等于浏览器下载，未执行完整打印或 SIGKILL 恢复。
两场分别 888／651 秒关闭，无延长／过期重启。新包工厂 UI 的
2.059 倍原预算仍失败。证据见
[构建控制与客户端](../host/contracts/native-affinity-client-acceptance.json)。

当前调用消息使用已有 `wire` 类型参数和一个有界 `TextOutput`，
包括外壳、JSON 转义在内最多 65536 字节；超限不进入 JS 能力函数。
整数与浮点、负零、嵌套容器等原语义保持，不修改原生回复通道。
相关源码和禁用 TS／外部 JS 子进程的独立编译各 183 项通过。
两个性能原型已撤回，宽参数比值 0.819 不覆盖仍失败的小参数 UI。
完整单并行构建又在锁定依赖的编译器内部索引检查失败；早期原型
没有输出新包，最终实现只编译项目 crate、复用锁定依赖缓存。
下面 `fff160bf` 的新包是前序锁定产物，不包含本次消息外壳改动。
完整证据见[消息边界](../host/contracts/template-call-envelope-acceptance.json)，
前序 `6f027708` 自身 CI 现已全通过，不借用于本次新代码。

## 当前新包构建对照

`fff160bf` 已完成一次 `CARGO_BUILD_JOBS=1` 的全新原生对照和完整
产品构建，release 优化、数值语义、Cargo 锁定及路径映射不变。
这只是本次验收构建的显式环境参数，产品默认构建没有改成串行。
新包独立安装 18 个锁定生产依赖，不执行安装脚本。全部 684 个
清单文件及 11 个原生输出核对 SHA-256，验证 CLI 和实际冒烟通过；
禁止 TS 加载及 PATH 程序，源码／编译的固定频谱、整形输出一致。
桌面冒烟不连接真实设备，不代表完整客户端、打印或目标板验收。

默认并行 Rust 捕获仍在 num-bigint 的 LLVM 循环优化处 SIGSEGV。
捕获目录保留原命令、限定环境项、锁定源文件、两个实际 extern
元数据和失败输出；完整 target 与官方编译器归档不打进证据，
其已检查摘要保留。Cargo 的探测退出 1 与该 SIGSEGV 分开记录。
两次单命令对照使用字节一致的依赖复制、不同输出路径，不带原
jobserver 描述符；默认栈和 16 MiB 栈都成功，不能据此定根因。
沙箱 EPERM 的重放不计为编译成功；授权后的两次无启动错误。

新包独立 UI 固定预算仍为 1.801 倍，原 1.5 门限不变；工厂三项
通过不覆盖它。全新单并行包只用于后续锁定本机验收，未发布生产或
切换默认打印入口。构建、依赖、探测与性能原始记录见
[构建对照](../host/contracts/native-build-investigation.json)，压缩证据
条目带字节数及 SHA-256，先核对归档摘要再提取。
同一头十五项 CI、普通 4736／4736 已通过，见
[精确头终态](../host/contracts/pr68-fff-terminal.json)。

## 启动入口

原生入口使用 Node.js 26.9 或更高的 26.x 版本：

```sh
node scripts/product-host.ts --help
node scripts/product-host.ts --profile /etc/anyraid/machine.ts
```

`--profile` 必须是本机 `.ts`、`.mts`、`.js` 或 `.mjs` 模块的绝对路径。
帮助不会加载机器模块或原生插件；参数语法错误不会导入机器模块，
命名用户路径展开会借用既有 Unix NSS 插件。运行主机前仍须安装
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

## 原生 sanitizer 检查调度

从 `host` 目录执行 `npm run test:native-sanitized` 仍依次运行 UBSAN
和 ASAN。独立模式可用 `npm run test:native-sanitized -- --mode=ubsan`
或 `--mode=asan`；`--list` 只输出命令清单，不编译或运行测试。
模式参数写错会在构建前拒绝。覆盖参考见
[原成功 CI 命令清单](../host/contracts/native-sanitizer-command-reference.json)。

CI 将两种模式和普通检查分开运行；每种模式内部保持原逐文件
顺序，先执行 `npm run build:native` 准备原测试依赖的普通插件，再运行
原 sanitizer 构建参数、运行环境和 60 秒子命令期限。最终 `host` 检查只在
普通检查及全部 sanitizer 作业成功时通过，取消或跳过均不能放行。
本机控制验证覆盖命令完整性和门禁失败传播；精确候选头和合并后 CI
已核验，见[9bd 合并后终态](../host/contracts/develop-9bd-terminal.json)、
[诊断集成终态](../host/contracts/develop-e647-terminal.json)
与[UFP 组合终态](../host/contracts/pr50-ade4-terminal.json)。记录只证明
对应提交、输入和环境通过，不将一次检查耗时当作目标板性能提升。
当前 CI 参考测试仍需要 Python，不因调度拆分移除 Python 配置。

## 普通测试失败观测

`npm test` 保留原生前置构建及 `test/*.test.ts` 全部普通检查，原并发、
断言和期限不变。沿用 spec 输出，另输出 `nodeTestFailure` JSON 行，
记录文件／用例、错误类型、测试子进程退出码及信号；未提供的字段为
null。正常结束有一行 `nodeTestObservation` 总计，失败退出仍由 Node
测试 runner 决定。不增加重试，不接管产品进程或改变打印运行参数。

额外报告只读取选定元信息，字段长度有上限，不复制环境变量、任意错误
对象、断言实际／期望值或调用栈。原 spec 报告内容保留，不能把额外报告
理解为对原日志的脱敏。历史只含 `test failed` 的记录不能倒推信号；
该候选及一次成功均不关闭已知运动数值异常或 G3。
五项控制和全量类型通过；一次完整普通检查捕获 16 项失败，原始记录见
[退出观测](../host/contracts/ordinary-test-exit-observation.json)。PR #55
精确头首轮全部 15 项远程检查通过并正常合入 develop `1f0e11f1`，
普通检查 Node 26.11.1 为 4398／4398，根总计与 spec 一致，见
[精确头终态](../host/contracts/pr55-5fb-terminal.json)。这不是本机失败
Node 26.10.0 的同版本对照。实际合并后全部 15 项检查亦已独立核验
通过，见[合并后终态](../host/contracts/develop-1f0-terminal.json)；不能把
观测能力当作稳定性修复。

### 有限滤波边界捕获

`host/scripts/diagnose-node-asan.ts` 新增 `--filter-trace off|on`，默认
off。on 只接受 `--case motion --execution source --runs 1 --workers 1`。
调用前校验已审查滤波源码摘要，只在新诊断目录生成私有模块；不修改
产品源码。原 16 轮、参考、容差、10 秒子进程期限、输出上限和失配
捕获保留。每轮额外二进制最多 8 MiB；固定六个索引保存实际单次
输入读取、加权项、补偿过渡与输出赋值，并保存调用前后的全输入。

一次 Node 26.10 源码观测记录 96 个位置、15,936 项过渡，全部符合
独立整数舍入模型；没有复现历史失配。插桩会改变 JIT 形态和时间，
这只证明捕获设施可用，不是性能测试、根因判断或 G3 通过。产品
源码和依赖未变，完整同包客户端与真实运动门禁仍保留。
两项实际注册控制、类型检查、原始驱动／模块／16 份二进制、初始
仅文件级测试结果和重放结果均见
[边界捕获准备](../host/contracts/motion-filter-boundary-capture.json)。

捕获设施经 PR #59 正常合入 develop `e312c172`；精确候选头与
实际合并后的全部 15 项检查分别核验通过。普通为 4434／4434，
包含两项新控制；原 sanitizer 清单和运动诊断条件保留。终态见
[候选记录](../host/contracts/pr59-ea4-terminal.json)与
[合并后记录](../host/contracts/develop-e312-terminal.json)，不关闭 G3。

证据归档是 gzip JSON；`entries` 含相对路径、原始字节数、SHA-256
及 base64。校验归档和条目摘要后将 `capture/` 提取到新临时目录，
无需再次运行运动生成或子进程。保留原历史捕获文件和独立整数模型，
从仓库根目录执行以下只读分析，输出必须为不存在的新路径：

```sh
node docs/diagnostics/node26-motion-capture-20261008/filter-boundary-analysis.mjs \
  /absolute/extracted/capture /absolute/new-analysis.json
```

分析按所给目录读取条目，不依赖报告中的历史绝对路径。当前模型仅
覆盖捕获中正常、有限 binary64 的运算范围；不声明完整 IEEE 特殊值
覆盖。不在相同条件下扩展子进程次数求绿。

### 编译入口与子进程退出所有权

`npm --prefix host run typecheck` 由 `host/scripts/run-typescript.ts` 运行。
标准 `buildProductHost` API 使用同一所有者，开发解析器
`typescript-resolver.mjs` 不进入运行包。官方 getExePath 在独立 Node
子进程解析，父进程不加载可能同步阻塞的包元信息；锁定 TS／平台
包版本、绝对普通可执行文件和所选字节核验后直接 spawn 平台编译器，
不使用 PATH 或 execve，不需外部 shim。锁文件限 1 MiB，包元信息／
解析器限 64 KiB，现有候选观察器的有界读取保持；实际二进制摘要
仅为启动前身份，不能保证无 TOCTOU 替换。

两阶段共用类型检查 120 秒／构建 TS 60 秒 deadline，每流 4 MiB 输出
保持；触发取消时 SIGKILL 自有 detached 组。解析器／编译器直接子进程正常退出也清理
同组残余，实际 close／管道退出和组内无活成员后才释放暂存。组终态
观察失败返回 COMPILER_JOIN_FAILED、cleanupComplete=false，构建
保留 stage／lock，并保持旧产品；按失败回执路径检查已无活所有者
后才能恢复，不能直接删锁。期限不保证 kernel D-state 或不可读状态
的物理结束时间；已死 zombie 不宣称已 reaped。builder 的 signal
覆盖 TS 与发布前检查，同步原生构建不是即时可取消。仅 Linux
x64／arm64 可用，其他系统明确拒绝；本机只实际验证 x64。

Node26.10／26.9 的标准类型检查与各 13 项相关测试通过；最终新增
CLI 测试的完整严格范围在 26.9 核对。实际 Node runner／builder 的
SIGTERM／SIGINT 取消由自身收口后退出，不代表向 npm 父进程发
信号必然传播。标准构建 API 使用既有 nativeDirectory 参数核验复用
原生，700 文件及依赖摘要完全相同；完整 npm 构建 CLI／新原生编译
未验。历史 execve 挂起原因未证，全部历史边界保留，见
[编译所有者验收](../host/contracts/typescript-process-owner-acceptance.json)。
以下保留原候选摘要观察器的验收范围。

### 产品 TypeScript 编译失败观测

构建所有者在原编译命令启动前读取入口、包装器、解析器、包元信息、
当前平台原生编译器候选、所选配置、host 基础配置和锁文件的 SHA-256。
包元信息限 64 KiB，其他摘要文件限 64 MiB；非阻塞打开后只读取普通文件，
摘要流读取期限 2 秒。物理包目录发现不隐式解析 exports，不能读取时记录有限错误码，仍执行
原编译。只有失败时追加 `productCompilerFailure` JSON，记录包装器
进程的 status、signal 和 spawn 错误码；原失败前缀、编译输出、60 秒
期限、4 MiB 输出限制和清理逻辑保留，不增加重试或编译选项。

摘要是启动前读到的字节，不能证明实际 execve／子进程路线、内存映射、
完整源码输入或执行中未被修改。没有导出环境变量、任意错误对象或额外
绝对路径；原编译器输出仍可能包含路径。候选解析遵循当前已安装的
TypeScript 7 平台包布局，缺失或不兼容时明确记录 unavailable，不能
把候选摘要当成执行证明。该工具不进入产品编译闭包，不参与打印循环。
历史故障条件映射与限制见[工具链只读审计](../host/contracts/toolchain-fault-readonly-audit.json)。
四项控制和全量类型通过，完整普通回归仍有 12 项失败；四次真实编译
故障已记录启动前候选摘要及原包装器 status 2／signal null。桌面摘要
开销 P95 24.00 ms，新编译清单与原 B 包完全一致。全部原日志及限制见
[编译观测验收](../host/contracts/product-compiler-observation-acceptance.json)。
随后修复包元信息 FIFO 的无界读取；六项控制通过，桌面摘要 P95 为
28.70 ms，仍低于原 250 ms 预算。单次本机完整尝试中断，不计通过；
PR #56 最终头和实际合并头的远程普通 4404／4404 及适用检查成功，见
[有界读取证据](../host/contracts/product-compiler-metadata-bounds.json)和
[合并头终态](../host/contracts/develop88-build-terminal.json)。

## 数据库本机验证与历史参考

在 Node.js 26 环境安装 `host` 依赖并构建原生插件后，从 `host` 目录执行：

```sh
node --test --test-concurrency=1 test/database.test.ts test/database-reference.test.ts
node bench/database.ts
node bench/database-registration.ts
node bench/database-namespace-read.ts
node bench/database-sql.ts
node bench/database-table.ts
node bench/database-backup.ts
node bench/database-restore.ts
```

这些测试和七项基准本身不再运行 Python。数据库测试保留原断言，以整体
SHA-256 和上游源码指纹保护独立封存的九份原 Python 参考；实际原 SQLite
图像用于读取互操作验证，Node 写入后由原始 SQLite 只读查询独立核对。
记录结构或参考输入变化须重新核验，不能从待测 Node 实现生成预期值。
重新封存须在隔离检出中恢复参考的 `sourceBase`，复跑原测试和原基准，
审核原程序／输入／输出及 SQLite 指纹，再更新封存数据和整体摘要。

基准的 `nodeSamplesMs` 是当前测量，部分数组沿用统计排序，并非按执行
顺序排列；`historicalPythonReference` 明确保存历史 Python 时间、环境及
范围。兼容的旧 `python*` 统计字段也只来自历史参考。合法的未封存参数
仍运行 Node，历史参考和对应统计为 null；不能将 null 解释为零耗时。
可用 `DATABASE_BENCH_ROOT` 指定测试磁盘，耗时须结合实际文件系统、
负载和耐久操作范围判断，不能直接当作目标板打印速度。其余测试仍有
Python 依赖，不能据此移除全局 CI 的 Python 配置。当前证据见
[数据库退役验收](../host/contracts/database-reference-retirement-acceptance.json)。

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

需要逐份清台确认时，在同一 `[job_queue]` 设置
`job_transition_policy=operator_confirmation`，并使用进程授权所有者。
默认策略为 `none`，不改变原手动／自动队列行为。旧配置中单独的
`job_transition_gcode=PAUSE`（大小写不限）映射到相同确认流程，不执行
G-Code；复合命令、其他宏和 `load_on_startup=true` 仍拒绝。

设备空闲时，无令牌 `POST /server/job_queue/start` 只生成确认，不启动
首份作业。启用自动续打时，当前打印的持久完成事件也只生成下一份确认。
`status.transition` 为 `null` 或包含 `phase=awaiting_confirmation`、
`state_token`、`job_id`、`filename`、`completed_request_id` 和 `expires_at`
的对象；客户端展示待清台的文件，由操作者清台后显式提交
`POST /server/job_queue/start {"transition_token":"上述 state_token"}`。
此受控操作需要客户端接入，不能把现有客户端的普通“启动队列”按钮
解释为已确认。策略关闭时不增加 `transition` 状态字段。

确认只在当前进程内有效，默认 300 秒；
`job_transition_confirmation_timeout` 以秒配置，允许 0.001–900。
执行期限使用单调时钟，`expires_at` 仅供显示。确认时同时复核原授权、
当前登录、设备代际、目录版本和队首文件身份；操作者必须与生成确认时
相同。暂停、已提交的队列变化、设备退役、到期、关闭及重启均撤销确认，
原凭据失效不能用新登录延续。失效后刷新状态并重新显式请求确认，
不能自动重试或重放设备动作。该确认不替代真实机器准备和打印授权。

启动自动加载、其余旧过渡宏转换、同包实际客户端、目标板负载和正常
集成仍待验，不能据此关闭完整 M3 或默认 Python 退役门槛。软件范围见
[清台确认验收](../host/contracts/native-queue-clearance-acceptance.json)和
[原队列契约](../host/contracts/native-job-queue-acceptance.json)。

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
  dataPath: '/var/lib/anyraid',
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

进程模式必须提供 `dataPath` 绝对目录；缺少目录身份或非法路径在取得
依赖前拒绝。工厂自动向标准服务传入该目录，并加载一份共享模板／
私密文件代际，无 LDAP 时也一样。`createProcess` 的 `server` 不得再
提供 `templates` 或 `authorization.templateSecrets`，重复所有者会拒绝
并清理已返回依赖。普通标准服务的显式接口仍保留。

目录内的 `moonraker.secrets` 沿用既有优先级与有界读取；设备 RESTART
和配置代际重建不会重新读取私密文件，更新需明确重启服务进程。
模板资源在最终服务器关闭时释放，之后工厂再关闭其余进程依赖。
服务信息只声明已装配的 `template`／`secrets`，不公布私密值或解析后的
目录。这个入口接入不代表通用组件加载器、完整模板语言、异步性能、
独立原生构建或目标板打印验收已经完成。

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
新建备份仅在私有暂存快照上切换为 DELETE 日志模式，关闭后才 fsync、
原子发布及同步目录。活动数据库仍沿用 WAL；新快照只读恢复不产生
被误列为备份的 WAL／SHM 文件。旧快照行为不能沿用本轮新建快照结论。
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

MCU 的八条热身回复使用特殊初始离群规则，不能直接作为设备就绪
依据。`ClockRuntime.start` 还须等待既有首条普通采样产生可用估计；
等待期间串口会话保持 warming，不能配置步进或进入 ready。无效回复
沿原周期重试，不延长最后可用估计的4.9195秒期限；取消、超时与
到期走原停止／清理流程。一次可用普通回复不保证频率收敛或实际
运动精度，目标板与G3仍须验收；详见[准入证据](../host/contracts/clock-startup-admission-acceptance.json)。

启动校准候选保留 uptime 的完整计数和原八条热身。仅当其中已知发送
时间的真实回复具有更短 RTT 时，使用最短回复的完整计数重建时钟锚点，
后续保留样本只调节原估计器，不重发旧释放值或继承旧授权期限。
随后按原 50 ms 热身间隔最多取得八条新回复，总期限为原 4.9195 秒，
最后仍须普通采样可用才允许 ready。没有更短回复时保留原查询数量；
活动期间的周期、离群规则、精度与停止保护不变。通常多用约 400 ms
热身时间，设备启动及恢复可能变慢；这项候选不保证物理时钟收敛。
反例、原混合负载、性能和保留失败见
[启动校准验收](../host/contracts/clock-startup-calibration-acceptance.json)。
后续 #41 `bffeaae0` 主机 CI 的三项失败在本机原样复现，均涉及夹具
时钟假设：ADC 预留超出当次校准上界，以及固定 1.8 秒运动早于位置
观测。夹具修复采用现有命令独占所有者、实际预留和当前时钟，不改变
生产准入、期限或位置历史保护；源码 10／10 和编译相关 66／66 通过。
原 124／125 fd 失败及后续有快照的 125／125 均保留，后者不解释
前者。夹具头 f167815d 的普通 4222／4222、协议、sanitizer、Linux MCU
和固件已终态成功；组合新头及目标板仍待验，见
[补充验收](../host/contracts/clock-startup-fixture-acceptance.json)。
启动修复与 sharp 0.35.5 的独立组合包已完成 105 项编译回归和一次
原双 MCU 两代完整混合负载，原 1000 条运动、90 秒子进程期限、停止、
正步提前量及循环门槛保留；封存包及依赖指纹见
[组合验收](../host/contracts/clock-sharp-composition-acceptance.json)。
安全依赖 #44 已完成 12 项检查并正常合入 develop；启动修复 #41
组合新头及其正常集成／合并后验证仍未完成，见
[集成追踪](../host/contracts/clock-sharp-integration-preparation.json)及
[旧头终态记录](../host/contracts/clock-sharp-pr41-terminal.json)。
不得据此切换默认入口或允许真实运动。状态／上传
尾延迟单次观测的上升和既有图片性能代价仍保留，目标板尚未验收。

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
单独安装；构建命令不下载依赖，默认从私有源码快照重建 9 个原生插件，
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
失败诊断只报告退出码、信号、超时／输出上限及已知 npm 错误类别，
不转发 npm 原始输出、注册表地址或嵌套命令；例如 ENOTFOUND 表示
名称解析失败，EINTEGRITY 表示下载摘要不符。类别未知时保持 null，
不从缺失输出推断网络、缓存或编译器原因。调用方可读取稳定错误码
ERR_PRODUCT_DEPENDENCY_INSTALL 及 exitCode、signal、npmCode 字段。
诊断、失败清理及编译 CLI 的有限软件验证见
[安装诊断记录](../host/contracts/product-install-diagnostics.json)；执行环境
导致的输出缺失与历史安装／编译失败分别保留，不据此认定故障根因。
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

### 元数据原子版本头试验

独立候选将版本记录改为每个历史文件名一个
`.metadata-head-<文件名 SHA-256>.json`。外层格式为 v2，包含原 v1
六字段记录及其 SHA-256；精确序号仍使用 uint64 十进制字符串。
同步新临时头、原子替换、同步目录完成后才确认新代次。替换前取消
保留旧头；替换后的取消等待提交。同步失败封锁该所有者，必须重开
完整验证，不能推断回滚。失效标记继续占用历史文件名容量。

该版本目录沿用唯一排他租约、私有目录和描述符锚定。新头须为 0600
常规单链接文件，每头最多 32768 字节，最多 4096 个历史文件名；
单次写入只重写对应头。重开完整校验新头与旧内容／回执的摘要、
文件名、状态和精确序号，拒绝冲突序号与未知条目。只有全部校验
完成、所有最新头与目录均已同步后，才先删除旧回执、再删除旧内容。
部分迁移及进程终止后可按同样规则继续；损坏时保留现场，不自动
回退到较旧的 selected。

这是尚未采纳的存储协议试验，不能用于当前打印服务默认切换。旧
实现不能打开包含 v2 头的目录。试用前须保存完整且相互一致的
文件库、元数据库及恢复数据副本；降级使用迁移前的完整副本，不能
删掉新头后把残存旧回执当作有效回滚。原完整混合、当前头集成 CI、
目标板和 G3 门槛独立保留，结果见
[原子版本头审查](../host/contracts/native-metadata-atomic-heads-acceptance.json)。

在启动时钟准入与 sharp 0.35.5 基线上的内容准备候选，让模型最终同步
和预览准备并行；两支全部排空后才处理失败或继续原目录／回执屏障。
五次耐久同步、摘要、源身份、配额及关闭等待均保留，没有安装或迁移
选项变化。同一封存包的原完整混合软件负载和七路原性能预算已通过；
失效重建与冷元数据等尾延迟上涨保留。原失败仍封存，当前头集成 CI、
实际客户端、目标板及 G3 未完成，不能据此切换默认打印入口，见
[内容准备组合验收](../host/contracts/content-paired-composition-acceptance.json)。

后续回执准备候选在模型与预览内容已同步并链接后，让内容目录同步
与私有临时回执的写入、同步及关闭并行。两支全部排空且成功后，才
链接公开回执；再同步目录后才通知客户端。预览存在时仍为五次同步，
配额、源身份、失败封锁、取消和关闭保护沿用原行为；不新增选项或
修改持久格式。临时回执已同步而内容目录屏障尚未完成时的 SIGKILL
恢复只证明进程中断范围，不是物理断电耐久证明。
新组合包通过七路新比较、原固定和此前失败比较预算，以及原完整
混合软件验收。冷发布中位数与同期基线相近，不宣称打印提速；PR #58
精确头与实际合并后检查通过并正常集成，原文见
[合并后终态](../host/contracts/develop87-build-terminal.json)。实际客户端和目标板仍待验，见
[回执准备审查](../host/contracts/native-publication-authority-preparation.json)。

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

`gcodes` 上传的 path 可以指定不存在的子目录。完成摘要核验和上传授权后，
缺失的各级目录还须通过 `server.files.post_directory` 授权；目录权限等待
期间已存在的父目录消失时返回 409，不隐式重新创建。全部缺失目录以一次
既有目录索引耐久提交创建，保留已有目录时间和原目录／存储配额；通知在
提交后按父到子发送，随后才发布文件。目录提交失败返回 500，
`error.data.operation=create_upload_parents`，phase 沿用 before-replace／replaced；
后者须先恢复文件库。之后文件发布失败或请求取消可留下已耐久创建的空目录，
应查询实际目录和文件回执，不把目录与文件当成一个原子事务或自动重试。
`config` 根继续采用原配置写入保护，本能力不扩大其可写目录范围。
源码、同包软件负载及有限本机性能范围见
[上传父目录验收](../host/contracts/upload-parents-acceptance.json)；真实客户端和目标板仍待验。

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
准入前拒绝可能没有该记录。成功发布现返回 HTTP 201 和 `Location`，
顶层字段及旧 `result` 别名保持。Location 使用入站时捕获的请求
Host 和逐段 URI 编码的回执路径，适用于 gcodes／config、显式旧 ID 地址、
中文、空格和字面百分号；不带令牌／查询，不采纳 X-Forwarded-Host。
当前后端监听 HTTP。use_xheaders 启用时，仅原 TrustedClients／NSS
核验的实际代理可按 X-Scheme／X-Forwarded-Proto 选择 HTTP(S)，
前者优先，取最后一项并区分大小写；畸形、超限或禁用时保持原真实传输协议。
该协议选择不授予 API 身份，匿名客户端仍核对原双地址／强制登录。
元数据在请求开始同步冻结，坏凭据先在原上传授权阶段拒绝，协议
等待沿原请求／上传期限和容量；等待后复核当前身份，暂存前完成。
原生配置不允许外部覆盖这两个回调，产品在 MCU／日志获取前拒绝。
源码、独立 JS、实际包各 244 项、原三组预算和原模拟打印通过；
保护允许逐摘要绑定的原 NSS／缩略图进程及测试专用 PTY C 编译，
其他程序与 TS 仍拒绝。完整记录见
[代理协议证据](../host/contracts/proxy-protocol-owner-acceptance.json)。
既有获准跨域来源可读取该头；来源、鉴权及 OPTIONS 准入未扩大。
已发布但打印准入失败仍为 201，可读取文件和 `print_error`；发布前失败
保留原错误状态，不提供成功 Location。客户端应按 2xx 判断上传成功，
不能继续硬编码 200。源码、独立 JS、同包混合打印与同盘性能见
[标准上传回执验收](../host/contracts/upload-created-acceptance.json)。
自动创建父目录、UFP、完整页面及目标板验收仍待完成。
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

### 保留身份的公开资料与旧时间恢复

启用用户接口时，GET /access/user 和 WS access.get_user 返回当前已认证主体的
username、source、created_on：可信IP为 _TRUSTED_USER_，API Key为 _API_KEY_USER_，
两者 source 均为 moonraker；有效JWT继续使用注册用户原资料。只读资料通过当前GET
私有绑定交付并消费，不能靠传入用户名替换主体；合法订阅共用signal继续允许。

可信IP首次成功观察时间仅作公开元数据，按有效地址保存一小时滑动寿命，300秒清理，
最多4096项。描述淘汰不改变既有WS或已发一次令牌持有的冻结身份；每次仍复核当前
地址和force_logins。一次令牌只能消费一次；失效／地址不匹配后继续原API Key／可信IP
规则，因此合法可信IP回落可获得当前描述，不会再次恢复令牌原描述。关闭清理timer。

新API Key与 api_key_created_on 在原私有namespace同一batch持久化，轮换和重开保留
创建时间。无迁移收据的旧native key缺时间时仅首次记录补时，不能称其原历史时间。
旧安装SQL／namespace保留原 created_on；原namespace确无该字段才一次生成。
已完成schema1收据缺时间时，须原startup声明并核完整留存源 sourceSha256，再在原事务
补时，合法旋转后的当前key／用户保持。损坏源、畸形时间或缺声明拒绝启动；已有合法
时间不重读或覆盖旧源。任何已存在收据（包括null）都不能被当作普通无迁移库补当前时间。
新候选1735的隔离网络／数据库、窄鉴权验证见[保留身份验收](../host/contracts/client-recovery-followup-acceptance.json)的reservedIdentityFollowUp；
随后同包可信回环Mainsail有限旅程另见mainsailTrustedLifecycleFollowUp，完整A4与真实设备仍未验收。

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
预置上传严格要求标准 HTTP 201；旧的 HTTP 200 预期会在页面启动前
误报失败。此夹具修正不修改产品上传接口、15 分钟期限或运行授权，
也不构成实际客户端通过，见
[夹具回执准备记录](../host/contracts/client-fixture-created-receipt.json)。
限位事件遵循 MCU 时钟，加热器输出 PWM 后 ADC 切换为固定热态值；
这只是软件流程模拟，不是物理升温／冷却模型。现采用 createProcess 工厂，
在所有设备代际保留原模拟 MCU、数据库、文件和历史。RESTART 复用有效
固件配置；FIRMWARE_RESTART 通过产品策略复位原 MCU 并重建配置。ADC 与
加热活动按当前设备所有者观察，普通重启可读取此前保留的传感器配置；
停止确认后暂停模拟输入，下一次实际 ready 才恢复，不清零停止计数。
只能在无物理设备接入的开发环境使用。标准编译产品流程仍使用既有
`product-compiled-journey.test.ts`。

### 固定同一编译包验收

本机会话同时固定浏览器来源，不再按场次递增端口。Fluidd 使用
`http://127.0.0.1:18430`（探针 18428），Mainsail 使用
`http://127.0.0.1:18434`（探针 18432）；声明见
[固定端口](../host/contracts/client-acceptance-ports.json)。下一场先确认
上一场的监督进程和监听已退出；端口占用时停止启动，不自动改端口，
不终止不属于本任务的服务。日志、回执及模拟数据仍按场次隔离。
产品内部上游可使用动态端口，浏览器 HTTP／WebSocket 均经过固定来源。
每场含启动最多 15 分钟，到期关闭，不延长或重启过期夹具。
固定来源减少登录和权限匹配变化，不能单凭此认定上传工具阻塞已解决；
工具调用没有返回原因时保持未验证，不推断权限拒绝或产品故障。

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

可信内部维护调用可使用 MaintenanceGate.acquireLease() 和 ProductHostControl.requestMaintenanceAction(action, lease, afterResponse?)。
attach 必须绑定当前设备代际的 gate；无绑定的退休分支、陌生／复制／过期lease拒绝，不创建公网参数或新接口。
transfer 在同一同步栈内更换令牌并保持 maintenance=true，复制对象的release不能释放原lease，旧release也不能解除新持有者的围栏；现有acquire()闭包仍兼容。
#request、running持久写入之后、#begin及宿主validate／handler均核当前所有权／代际，所有生产者activity入口持续拒绝。

调用同步返回 admission／completion 句柄；同步前置拒绝仍由调用者持有原lease，转移后即使admission拒绝也必须等待completion。
普通外部服务内部调用直接等待控制生命周期，不伪造HTTP响应回调；server_restart及当前进程自己的服务重启必须传真实afterResponse。
queued／running／终态journal写入、响应未发送／十秒超时、动作失败和不确定结果均有结算路径；结果含operation和failure分类。
未换代且gate仍有效时，completion归还重新key且仍持围栏的lease，调用者可以连续执行下一服务，最终必须显式release。
单独control.close会取消未派发请求或等待已派发动作，仍可归还有效lease；实际退役／代际失效则返回fenced且无lease，旧gate保持closed。
租约不进入持久回执或公开status。控制succeeded仍只表示OS job submission生命周期结束，不能证明目标服务ready或停止。
本能力尚未接入update provider、managed_services或Node依赖更新，不提供其他进程／外部服务启动者的全局锁。

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

### 显式地址和主机名信任与 Mainsail 联调

原生授权支持 trusted_clients 中的 IPv4、IPv6 和 CIDR，手工装配对应
trustedClients 数组。默认列表为空，没有内置信任网段。CIDR 必须是网络
地址；带主机位的网段、无效地址及区域标识会明确拒绝。IPv4 映射
IPv6 地址可匹配对应 IPv4 规则。最多支持 1024 条配置；明确的小写
主机名通过系统 NSS 的规范名／首个含点别名查询，结果小写后精确
比较并缓存 84,000 秒。查询期限、取消和资源边界见本文开头证据。

匹配真实 socket 地址且未提供错误凭据时，请求可取得 _TRUSTED_USER_
身份。force_logins=true 且至少存在一个本地用户时禁用此准入；已有可信
WebSocket 和一次性令牌再次使用时也重新检查。access.info.trusted 报告
地址规则是否匹配，login_required 单独报告强制登录状态。

当前没有实现代理委托；带 Forwarded、X-Forwarded-For 或 X-Real-IP 的
请求不能单凭网络信任获得权限，仍可使用有效 JWT／API Key。不得在
公共代理后仅配置代理的地址并据此声称支持可信代理。完整 CORS 与
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


## 原生文件元数据强制重扫候选

已启用原生文件元数据路由的装配新增 `POST /server/files/metascan?filename=part.gcode`
和 JSON-RPC `server.files.metascan`，参数只接受相对于 `gcodes` 的 `filename`。
成功结果与 `server.files.metadata` 相同；每次成功都重新解析固定文件身份，
不会沿用缓存或旧持久快照。契约依据[上游文件 API](https://moonraker.readthedocs.io/en/latest/external_api/file_manager/)。
HTTP GET 返回 405，错误参数返回 400，缺失源文件返回 404。
请求沿用现有 REST／RPC 授权；权限拒绝不会开始扫描。

持久装配复用同一元数据事务、版本、图片和恢复所有者，有界串行执行。
失效准入候选为读取／重扫及失效分别保留四个位置，含正在执行者，
总数最多八个；活动事务完成后优先失效，连续四次失效后让一个排队
读取执行，两类内部均 FIFO。同文件失效合并为同一 Promise。饱和读取
不再占用耐久文件变更后的失效位置；失效自身超限或耐久失败仍触发
原恢复故障，不伪报成功。状态新增 `pendingRequests`、
`pendingInvalidations` 及各自上限；`pending` 仍是两类总数。
关闭取消读取并排空已接受的失效，持久格式与降级要求沿用原协议。
软件组合负载通过，但冷发布对比 P95 失败，候选不具备合并或默认
切换准入，见[失效准入证据](../host/contracts/native-metadata-invalidation-admission.json)。
内存装配仍保留两个请求的容量：重扫等待此前同文件读取，后续读取等待
重扫结果，超出容量返回 503。取消或关闭不自动重试；扫描开始前取消
保留原缓存，扫描已开始则旧预览可能失效，后续查询按原恢复／重建流程
取得有效结果。源文件删除或身份变化不能提交陈旧元数据。

强制重扫成功后，旧缩略图地址及已取得的读取句柄失效；持久重启恢复
新地址。该接口只扫描原生发布命名空间，外部磁盘 UFP 由下述独立
投递目录候选提供。

磁盘导入的内部接入增量为 `NativePrintUploads.importUfp`：进程所有者
借用已打开的普通文件描述符和可见 UFP 路径，传入当前本地写入授权。
入口与 HTTP 上传共用设备代际、维护、容量及发布事务，分别校验原包
和转换模型，拒绝转换或目的授权期间的来源变化；借用源不关闭、删除
或自动打印。此方法现由下述显式配置的外部目录服务调用；方法本身
不领取或删除原包，不能将内部摘要仓库当作磁盘投递目录使用。接口与
本机性能对照见[描述符导入记录](../host/contracts/ufp-descriptor-import-acceptance.json)。
目录事件桥 `FileEvents` 已提供 Linux 关闭写入、移动及队列溢出边界，
借用目录描述符并显式等待关闭。它现由显式配置的投递服务使用，缺省
不监听用户目录。构建包含 `file-events.node`，原生 sanitizer 覆盖
该组件；不能用普通 `fs.watch` 静默时间冒充关闭写入。
内部调用可传固定认领 ID 重放已完成的导入；此时重新授权并逐字节
验证模型及预览摘要，返回原回执且不自动打印。固定 ID 不提供持久
日志或原包清理；本轮账本／恢复装配见下节，完整出口仍未交付。原回归及
本机开销范围见[事件与重放记录](../host/contracts/file-events-claim-acceptance.json)。
旧附件 `MetadataFiles` 与原生进程文件所有者互斥，不能混装两个文件所有者。
源码、独立编译包、取消／竞争和性能证据见
[重扫验收](../host/contracts/native-metadata-rescan-acceptance.json)。
桌面模拟结果不代表 Cycnumbris 500 目标板性能、真实运动或 G3 通过。

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
警告后忽略规则；有有效模式时数字 Origin 可按 trusted_clients 的
IP／主机名名单回退。配置装配借用原授权所有者的 NSS 查询和缓存，
不把 Origin 主机名直接加入信任，也不把跨域许可变成 API 身份。
手动装配时，CorsPolicy 的第四个参数须显式借用对应授权所有者的
resolveTrustedAddress；不提供时仍只执行原同步策略。HTTP 和升级
查询使用原请求期限、取消和关闭；未完成升级占用原连接／请求容量，
客户端 EOF 或关闭会取消等待。保留现有网络边界，只接受规范 HTTP(S) Origin。
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
规范登录入口为 `/access/client-login`，避开旧官方 Service Worker 的
导航缓存；`/_client/login` 保留兼容。原 `/sw.js` 在未登录或会话失效后
仍提供不拦截请求的迁移 Worker，立即接管后让全部请求访问网络。
登录页遇到旧 Worker 时先更新并等待激活，最多五秒；失败不提交凭据，
提示重新加载。登录、退出、API 和控制台导航不得由缓存代替鉴权。
官方资源原字节仍保留；不导入旧导航 Worker，保留用户偏好和其他打印机凭据，
不强制重新加载其他打印窗口。迁移入口仅公开登录 HTML 和无凭据的
固定 Worker，其他资源和 API 继续验证原生身份。
原生登录成功后，登录页仅移除与显式 `--origin` 对应的 Fluidd
`user-token-`／`refresh-token-` 存储键，避免旧来源的客户端身份参与
新会话初始化。MD5 只用于匹配官方存储键，不参与身份或凭据校验。
账号密码错误不删除已有凭据；浏览器存储不可用时提示重新登录并停止
自动进入客户端。该行为不清空存储、不迁移远程打印机或别名 URL。
同来源 R14 拒绝刷新、R15 登录及模拟完成／恢复的对照见原验收记录
`credentialMigrationOct11`；此前 R10 错误记录保留。
本会话后续有限场次已有用户持续授权：每次含启动最多 15 分钟，
仅 127.0.0.1、锁定软件包与模拟 MCU，到期关闭，不自动延长或重启
过期场次。每次仍记录开始、期限、关闭和子进程退出。
后续本会话的同包有限场次复用固定来源：Fluidd 为
`http://127.0.0.1:18388`，Mainsail 为 `http://127.0.0.1:18378`，
减少变更端口带来的新站点审批。启动前检查端口空闲，不能占用其他
进程；每次仍使用新的场次记录和独立期限，复用地址不延长或重启
过期场次。聊天授权不等于已修改浏览器的审批设置。
迁移回归、固定包摘要和有限官方页面结果见
[缓存迁移验收](../host/contracts/product-client-worker-migration-acceptance.json)。
同一锁定包的 Fluidd R11 已通过实际配置保存、重启、重开，以及
取消后停止、明确固件恢复和新作业完成。新来源没有 JWT 刷新请求，
不将此有限对照用于关闭原复用来源的兼容性缺项，见
[R11 补充证据](../host/contracts/product-client-r11-acceptance.json)。
初始速度候选只修正 `motion_report` 的请求速度：已配置队列在当前
打印时刻尚无运动段时返回零。缺失队列、失效代际和未知位置仍为 null；
不从未来端点构造当前位置，也不授权或调度运动。独立新包与原混合
旅程、有限官方页面及桌面配对查询预算见
[速度兼容性验收](../host/contracts/live-motion-velocity-acceptance.json)。
新包的 Rust 模板输出摘要曾与旧包不同；后续已定位为 Cargo 依赖源码
路径未映射。映射后，两条缓存路径构建的完整包清单相同；原本机
编译器 SIGSEGV 仍保留，见[默认包记录](../host/contracts/moonraker-template-default-package.json)。
同一包的 Mainsail R12 已通过实际暂停／恢复至完成、取消后的明确固件
恢复及新打印完成，见[R12 补充证据](../host/contracts/product-client-r12-acceptance.json)。
场次包含启动 4 分 31 秒，两个进程正常退出、全部端口释放。初始新作业
遥测曾短暂显示 NaN／null，完整外部故障恢复、预览及原 JWT 缺项仍保留。
当前 `080a1b1` 的候选远程检查终态见[15 项 CI 证据](../host/contracts/pr68-080a-terminal.json)，
不替代完整本机回归、目标板、实机与 G3 门槛。

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

### 一次性按层暂停候选

原生设备代际提供鉴权 `GET/POST/DELETE /printer/print/layer_pause`，
JSON-RPC 对应 `printer.print.get_layer_pause`、`post_layer_pause`、
`delete_layer_pause`。这是运行态意图，不支持旧宏或任意 G-code 写入。
GET 返回当前请求、打印 `print_state_token`、意图 `state_token`、层信息、
目标、到期时间与回执。POST 示例（时间替换为当前未来时间）：

```json
{"version":1,"request_id":"当前打印请求","print_state_token":"GET 返回的打印令牌","state_token":"GET 返回的意图令牌","layer":"next","expires_at":1791363600000}
```

打印须正在执行且已知当前／总层数；`layer` 也可为大于当前层且不超过
总层数的安全整数。到期时间须是未来 24 小时内的 Unix 毫秒。两种令牌
同时比较，接纳即更换意图令牌；旧请求返回 409，不自动重发或覆盖新意图。
DELETE 只传上述 version、请求身份和两种令牌，撤销等待中的意图，不恢复
已经暂停的打印。GET 允许重新核对状态；失败回执不泄漏设备内部异常。

仅文件流已成功接受且自身带 `CURRENT_LAYER` 的 `SET_PRINT_STATS_INFO`
可触发；控制台层信息及文件仅总层数更新均不触发。跳层时在首次达到
或超过目标的层信息之后、下一条文件命令之前阻止准入。前缀释放调度权后
请求同一 `PrintController.pause()`，其 ACK、停车路径、温控、原期限和
安全停止继续由既有所有者执行。文件泵不等待控制器暂停，以免失败清理
反过来等待文件泵。此前已接受的运动仍按原停车策略处理，本入口不承诺
切片器元数据与实际物理层完全一致。

实际暂停继续通过原打印状态查询／订阅观察，必须显式恢复。取消、手动
状态变化、到期、设备退役和进程重启均使等待意图失效；不持久化或自动重放。
原完整混合负载的基线／候选各一场已通过；另有带层元数据的补充场景
验证鉴权层暂停、显式恢复、后续原暂停／超时取消及代际拒绝。均为独立
编译 JavaScript 产品与 PTY MCU 模型，仍需实际客户端与 Cycnumbris 500
目标验证，G3 不变。指纹、全部指标及首版夹具顺序失败见
[层暂停验收](../host/contracts/print-layer-pause-acceptance.json)。

补充输入仅在 `ANYRAID_BENCH_LAYER_PAUSE=on` 启用，限定完整 namespace／
原生授权／API 负载场景；未启用时逐字使用原运动程序。启用后增加 11 条
切片层元数据和 1 秒等待，去除后必须严格还原原 1000 条运动程序。层暂停
放在第二个既有作业，首作业的文件覆盖 printing 断言保持原样。复验须
提供上述契约的固定包、manifest 与实际依赖摘要，再在 host 下执行：

```bash
ANYRAID_BENCH_CORS_ORIGIN=https://fluidd.example.com \
ANYRAID_BENCH_MACHINE_CONTROL=on ANYRAID_BENCH_AUTOMATIC_QUEUE=on \
ANYRAID_BENCH_LAYER_PAUSE=on \
node --test --test-concurrency=1 \
  --test-name-pattern='^namespace=true nativeAuthorization=true apiLoad=true load=false spi=false ' \
  acceptance/product-compiled-journey.test.ts
```

`ANYRAID_ACCEPTANCE_BUNDLE`、`ANYRAID_ACCEPTANCE_MANIFEST_SHA256` 和
`ANYRAID_ACCEPTANCE_DEPENDENCIES_SHA256` 须绑定同一固定产物。原 180 秒
用例、90 秒子进程、停止／精度及负载预算均保持；补充输入不作为原
未改输入的性能配对样本，也不证明完整页面或物理层边界。

## 受保护的清台确认页面候选

官方客户端接入的控制台新增“打印队列”入口 `/_client/queue`，与
`/_client/control` 共用原生账号、网关会话、同源策略和退出流程。
页面使用原生队列状态，显示完整文件名；逐份确认仍需管理员在
`[job_queue]` 启用 `job_transition_policy=operator_confirmation`。
页面不创建账号、替换权限、执行过渡 G-code 或赋予设备就绪权限。

用户先请求确认，核对下一份文件、取走成品及残留材料，再勾选清台并
点击“确认并开始下一份”。页面始终显式发送
`POST /server/job_queue/start {"request_confirmation":true}` 请求确认，
该参数只能是 `true`，不能与 `transition_token` 同时提交。策略未启用、
设备忙或不支持该参数的旧服务直接拒绝，避免页面读取状态后服务重启
关闭策略时，无参数请求退化为直接打印。确认时只发送当前一次性令牌，
后端继续校验当前文件身份、账号权限、设备代际和单调期限。

页面每秒读取一次，隐藏时暂停读取，不并发轮询。队列头／令牌变化、
回到页面、网络错误和提交均清除勾选；晚到响应不能恢复旧确认。
标准原生装配另提供 `transition_available`，观察同一打印控制器与
维护门禁；正在打印、维护、关闭或无法观察时禁用清台确认和请求，
提示先在控制台核对设备状态。缺少提示的旧响应不启用这些按钮。
就绪提示为 true 也不授予打印权限，仍须按当前令牌明确确认；变为
false 会撤销勾选，恢复后必须重新勾选。观察失败保留队列可查询。
提交结果不确定时保留提示，用户须在控制台确认状态，页面不自动重试。
“停止后续排队”只暂停队列，当前打印沿用原状态。文件名使用文本节点，
页面使用动态 CSP nonce 和 `no-store`，不写入浏览器本地持久凭据。

源码回归与编译脚本检查只覆盖请求、状态和所有者边界，不等于实际
浏览器交互验收。静态 `data:` 预览被浏览器协议策略拒绝，未绕过；完整
2026-10-10 两次明确授权的客户端场次已执行关闭，页面结果及未完成
范围见[同包证据](../host/contracts/integrated-client-bundle-readiness.json)。
两次均未启用队列，不能计算为队列页面通过。后续夹具显式装配
`[job_queue]`、`load_on_startup=false`、`automatic_transition=false` 和
`job_transition_policy=operator_confirmation`，沿用同一进程数据库、
文件及打印日志；接口回归覆盖实际装配和确认前零打印副作用。
验收代理保留原生授权头，将 HTTP Host／Origin 及 WebSocket Origin
对齐私有后端；不从浏览器 cookie 合成授权，凭据仍由网关与原生
身份所有者校验。本会话已获上传／下载及新有限场次的持续授权，
固定来源下可继续验收，无需因新场次重复询问。当前 R31／R32
在同包页面分别完成两份独立确认任务；R32 实际打印时禁用下一份
操作，完成后恢复提示并重新确认。实际上传、配置编辑、完整故障
恢复及全部宏场景仍待验，见[就绪证据](../host/contracts/queue-readiness-acceptance.json)。
原默认入口、实机打印、目标板及 G3
未关闭。候选尚未发布，不据独立测试或桌面性能宣称消费级交付完成。

### 原生磁盘 UFP 投递候选

仅进程模式工厂可配置 `diskImports.root`，它必须为绝对、服务 UID
所有且权限不允许组／其他用户的独立目录。真实路径及尚未创建路径的
已有祖先均须与 filesRoot、metadataRoot 分离。原生摘要库不接受原包
投递，旧 MetadataFiles 与原生文件所有者仍互斥。

同时由 `createProcess` 资源提供 `diskImportContext(signal)`，返回
当前本地文件写入策略的 RpcContext；没有默认身份或隐式允许。策略
必须验证原归档、转换模型与父目录授权，清理前再次执行当前授权，并
响应 signal。工厂纳入进程退役信号。标准 runProductHost 调用工厂
bootstrap 后启动监听；包装工厂必须保留 bootstrap，不能只转发函数
和 serverLifetime。`diskImportStatus` 是只读进程诊断，包含完成／
拒绝／忙／容量阻塞及故障；没有新增公开管理或打印接口。

服务通过 Linux CLOSE_WRITE、MOVED_TO、启动和目录变化发现输入。
最多 1024 个目录、16384 个扫描条目，按 256 条有界批次排空。完整
写入但仍有写描述符的文件不会导入。独立 `file-write-lease` C 程序
持有只读租约并隔离 SIGIO，重新打开写入使当前证明失效；租约总期限
30 秒。不支持租约的文件系统明确失败，不能降级为静默计时。该能力
尚未在目标板文件系统验证。

原包移入私有 `.native-ufp-claims/<UUID>/source.ufp`，移动前持久化
来源设备／inode、路径和归档大小／SHA-256。共同发布模型与 PNG 后，
决定记录绑定完整发布回执及原意图。只有当前授权和完整模型／PNG
验证均成功才删除领取原包；决定最后删除，部分清理重开不重复发布。
原路径消失可能只是已领取；完成应以发布、私有账本排空和 owner
状态为准。来源身份／摘要冲突、未知账本或关闭故障保留数据并报错。

默认最多保留 32 个领取、256 MiB，配置上限为 128 个／1 GiB；单包
仍受原上传 64 MiB 限制。已领取的非法归档或授权撤销可持久隔离，
未领取的拒绝／忙／容量超限保留原路径。目前没有消费者隔离记录的
受控清理／重试界面，运维不得删除未核对账本。没有自动启动打印。
设备重建保留同一所有者；代际中断的在途导入可能停止并保留账本，
不冒用新代授权重试。故障后先核对状态和一致备份，再显式重开恢复。

新独立包、SIGKILL、sanitizer 和性能范围见
[磁盘事务记录](../host/contracts/native-ufp-disk-ledger-acceptance.json)。
后续共同内容发布优化会先完整验证并同步已有内容 inode，再提交新
回执；重复临时副本不执行昂贵的数据同步。首次内容、回执及目录同步
仍执行，读取、校验或同步失败拒绝新回执及覆盖，原引用保持。该路径
不改变账本格式、来源授权或清理顺序。本机 ABBA 有局部收益，但相同
完整混合打印仍失败，不能视作打印性能通过；样本及故障控制见
[竞争与内容复用记录](../host/contracts/native-ufp-contention-acceptance.json)。
元数据重建后续候选只在当前恢复版本已经耐久失效时跳过重复的失效
写入；仍先有序清理旧扫描，再提交全新的扫描意图、pending 和 selected。
selected／pending 状态、源绑定校验、缓存撤销及故障恢复边界不变。
并行写入图片／快照的试验未证明整体收益，已撤回；保留原串行协议。
失效后重建的桌面对照有局部收益，但冷扫描及缓存的部分尾延迟上涨，
完整打印仍未通过。运行配置和默认入口不变，不能据此宣称打印加速，
见[元数据审查记录](../host/contracts/native-metadata-invalidation-acceptance.json)。
普通恢复及 136 项编译回归通过，但新增完整混合负载仍失败，正常集成、
完整客户端、目标板预算及 G3 未通过。候选默认关闭，不能视作已发布。
旧程序不支持新 PNG 状态及领取账本，降级须恢复升级前一致的文件／
元数据／作业副本，不能直接打开新状态或删除字段降级。

## 原生公告候选

标准 ConfiguredMoonraker 在拥有数据库时装配公告组件；无需打印机就绪。
固定 Fluidd 1.37.6 实际调用 `server.announcements.list` 和
`server.announcements.dismiss`，该候选补齐五组标准 REST／RPC 接口：

| HTTP 路径 | 方法 | RPC 名称 |
| --- | --- | --- |
| /server/announcements/list | GET | server.announcements.list |
| /server/announcements/dismiss | POST | server.announcements.dismiss |
| /server/announcements/update | POST | server.announcements.update |
| /server/announcements/feed | POST／DELETE | server.announcements.post_feed／delete_feed |
| /server/announcements/feeds | GET | server.announcements.feeds |

它沿用进程数据库、HTTP／WebSocket 鉴权和授权通知分发，独立于设备代际。
列表默认包含已忽略条目，可传 `include_dismissed=false`；条目按时间倒序。
忽略请求使用 `entry_id` 和可选整数秒数 `wake_time`，再次忽略为无操作。
恢复时间持久化；重启时按固定上游规则立即恢复距唤醒不足十秒的条目。
为限制异常长期计时，单次绝对秒数最多一年，非整数或超限明确拒绝。
通知为 `notify_announcement_update`、`notify_announcement_dismissed` 和
`notify_announcement_wake`；仅耐久提交后发布。关闭停止后台工作并等待
已进入数据库的写入，不能把客户端断开当作写入失败。

`[announcements]` 的 `enable_moonlight` 默认 true，默认订阅
moonraker、klipper，`subscriptions` 为逗号分隔的附加名称。
监听成功后开始后台更新，周期三十分钟；网络失败不阻塞就绪、打印或缓存读取。
订阅名称限 64 位 ASCII 字母／数字／下划线／连字符，首位为字母或数字。
请求不能提供 URL：只访问固定官方 Moonlight HTTPS 源，拒绝重定向。
GET 最多五次，间隔 500 ms，单订阅总网络期限十秒；ETag 仅在成功解析和
持久提交后更新。已存在 GUID 保留原内容和忽略状态；过期条目仅在所属订阅内修剪，
避免不同源的相同前缀互相删除。错误 XML／DTD／容量超限保留旧缓存。

XML 解析在有两秒期限和内存限制的 Worker 中完成。RSS 限 1 MiB，
最多 256 条目、32 个订阅和 512 KiB 持久目录，变更等待队列限 16 项。
受信任组件的新源注册在变更进行中返回 409，提交前再次核对配置与持久订阅
的联合容量；不能让并发注册绕过上限。XML 命名空间和空字段按固定上游语义区分。
高频查询只读缓存、返回隔离副本，不访问网络或 SQLite。
新版本以私有 `native_announcements` 原子目录保存条目、订阅和版本。
首次启动校验并导入固定上游的 `announcements` 和
`moonraker.announcements` 记录；原记录完整保留，之后不再作为运行所有者。
无效记录使启动失败，不静默丢弃或重置。公共数据库接口不能修改这两个公告目录；
降级应使用迁移前完整备份，不能让两个实现同时写入同一数据库。

`dev_mode=true` 需要受信任装配显式提供绝对
`announcements.developmentDirectory`，读取该目录的 `<feed>.xml`。
拒绝符号链接、非普通文件和读取中变化；没有明确目录时启动拒绝，
不能由请求参数推导开发目录。生产依赖锁定 saxes 6.0.0／xmlchars 2.2.0，
许可证随编译包保存。公告描述沿用上游文本／HTML 数据，组件不执行 HTML；
显示端负责内容渲染与净化；该候选的软件检查不替代实际客户端验收。

候选的[封存证据](../host/contracts/native-announcements-acceptance.json)绑定
源码、固定上游与实际 Fluidd 资源。最新公告控制在两个结果中覆盖 14 个
不同用例（13 项通过及修正空值夹具后的单项通过），不记为一次完整 14 项通过。
最新编译包在约 500 KiB 目录下的后台更新并发查询 P95 为 0.477 ms，
事件循环最大延迟 4.55 ms，通过原有限桌面预算。首轮直方图测量失败和
独立控制均保留；仅修正停启期间的直方图生命周期，未改变预算。
修正前源码的完整普通测试为 4396／4404，另有 8 项失败；首版候选与
同期旧基线均在第二代打印清理重叠断言失败，未证明共同根因或无回归。
后续精确公告头 `9ceb7dda` 的完整 15 项 CI 成功，原文见
[独立头终态](../host/contracts/pr57-9ceb-terminal.json)。公告独立包的原
混合失败按原指纹保留；接入文件失效准入与私有回执准备后，组合包
`8deb5fc7`／依赖 `7149c1b8` 首次通过原完整混合软件验收，71.0 秒，
并通过七路原预算，见[组合证据](../host/contracts/native-publication-authority-preparation.json)。
正常任务分支接入同一组受测源码，组合头 `df45a8e1` 的全部 15 项 CI
成功，原文见[组合头终态](../host/contracts/pr57-df45-terminal.json)；PR #57
已正常合入 develop `92c98110`，内容树与受测组合相同。实际合并后
全部 15 项检查亦通过，见[集成终态](../host/contracts/develop92-build-terminal.json)。
有限软件结果不解释旧失败共同根因，也不关闭实际客户端门禁。
实际同包客户端、目标板和 G3 仍待验，不构成完整 Moonraker 或发布完成。

## 原生私密配置文件所有者候选

`loadSecrets(reader, {dataPath})` 提供通用模板与 LDAP 的文件依赖；
`dataPath` 必须是明确的绝对数据目录。优先读取其中的
`moonraker.secrets`；仅默认路径没有普通文件时，才使用 `[secrets]`
的已弃用 `secrets_path`。旧路径按照启动工作目录解析，`~/` 展开为
用户目录；存在但格式错误的默认文件不会退回旧凭据。路径可以指向
普通文件的符号链接，读取时重新核对实际打开的描述符。

支持顶层 JSON 对象及无插值 INI。INI 保留行内注释和百分号字面量，
选项名转小写，支持默认项、续行及内部空行；不会执行 include。
JSON 安全范围外的整数保留为 BigInt，不经过 JavaScript Number
舍入；整数 `-0` 归零，浮点 `-0.0`／`-0e0` 保留负零，字符串不改写。
这不构成通用模板整数／浮点类型桥接完成。默认限制为 1 MiB、
深度 64、65,536 个值及 4,096 位整数，调用者可以显式收紧。
非有限 JSON 浮点、无效 Unicode 和超限格式不会作为可用凭据发布。
文件无法正常读取、非普通文件及读取超限报配置错误；格式无效返回
`type=invalid` 的空代际和不含内容的警告。缺少可选默认文件不警告。

调用者通过 `item(name)` 或 `get(name, defaultValue)` 获取冻结值，
生命周期内不重复读取文件；新的配置代际必须显式重新加载。
调用者持有并关闭所有者，关闭后拒绝读取，重复关闭无副作用。
对象检查和 JSON 编码只显示状态，私密值不进入配置快照、公共数据库
或网络端点。关闭只释放本对象的引用，不保证垃圾回收前内存清零，
已经交给调用者的值仍由调用者负责。

### 独立异步与 UI 模板候选

`MoonrakerAsyncTemplateOwner` 借用一个明确的 `SecretsStore` 代际。
`createTemplate(source)` 使用单花括号配置语法，`createUiTemplate(source)`
使用双花括号 UI 语法；返回模板以 `renderAsync(rawJson, options)` 渲染。
原始 JSON 保留整数／浮点词法，不能先经过普通 `JSON.stringify(Number)`。
这两个 API 是独立候选，尚未作为标准组件工厂或公开接口启用。

`options.callables` 是 `ReadonlyMap<string, TemplateCallable>`。真实函数
收到只读的 `{args, kwargs, signal}` 调用上下文，返回 `TemplateValue`
或其 Promise。取消信号通过 `call.signal` 读取，首次读取才创建原生
`AbortSignal`；同一渲染内的调用共用信号，不同渲染各自独立。即使首次
读取发生在完成、取消或关闭之后，也能观察已经结束的生命周期和原因。
这是尚未发布的组件 API 调整，原来的第二个信号参数不再提供。
整数用 BigInt，浮点用 `templateFloatValue(number)`，普通 JS Number
拒绝隐式转换；负零和非有限浮点保留种类。当前原生整数运算仍限于
有符号 i128，范围外拒绝，完整 Python 任意精度整数继续开发。
`addEnvironmentGlobal` 会更新已有配置模板并检查名称冲突，UI 模板
不继承这些全局对象或 secrets；调用者显式传入的 UI 上下文仍可使用。

每个所有者有两个专用计算线程，至多 32 个活跃渲染、64 个模板与
64 个自定义全局对象，每次渲染至多 64 次真实调用。默认期限 10 秒，
`timeoutMs` 可缩短至 1—10000 ms；source、context、output 各最多
64 KiB。取消、关闭与期限使原生等待停止，晚到结果被丢弃，不重试
有副作用的函数。函数必须协作处理信号；不能强制抢占任意 JS 函数。
渲染完成也会结束函数信号的生命周期。模板和所有者都必须明确 `close()`；
私密代际先关闭时拒绝后续渲染。错误不暴露源文、文件路径或私密结果。

源码／编译相关回归和独立快照构建通过，纯模板满足固定桌面预算；
函数／UI 路径仍未满足 1.5 倍原参考门限。不能据此切换默认打印入口。
中间分配与进程隔离、完整模板工厂及标准装配仍开放，详见
[候选证据](../host/contracts/moonraker-template-async-acceptance.json)。
随后按需信号候选通过源码／独立编译各 118 项相关检查；固定编译基准
纯模板、函数、UI 比值为 0.960／1.424／1.653，UI 仍使整组失败。
相同输入交错旧／新对照与此前失败保留，详见
[按需信号候选](../host/contracts/moonraker-template-lazy-signal-acceptance.json)。
运行新基准可使用 `node host/bench/template-async.ts`；其参考摘要固定，
不会启动 Python，性能缺项时退出 1。构建工具链和默认打包要求沿用
下面的同步候选说明，独立 Rust 快照包含 `src/async_text.rs`。

### 同步私密文本模板候选

标准 `ConfiguredMoonraker.loadAuthorized` 的授权选项可以显式提供
`templateSecrets: {dataPath: "/明确的私密数据目录"}`。当前由标准服务
持有私密模板代际；也可在 `load` 或 `loadAuthorized` 的通用选项中
提供 `templates: {dataPath: "/明确的私密数据目录"}`，无 LDAP 时也加载。
两个入口不能同时提供。存在 `[ldap]` 时，在监听与目录连接之前渲染
五个 LDAP 字段，每个启动模板随后关闭，私密代际保留至服务关闭。
后续登录使用已验证的目录配置，不在请求中重新读取私密文件。
已有 `ldapConfiguration.signal` 和 CA 配置继续保留；不能同时指定
`templateSecrets` 与自定义 `ldapConfiguration.render`。

例如 `bind_password: {secrets["ldap"]["password"]}` 从该文件读取。
JSON 必须保留原始文本进入原生环境，`1`、`1.0`、`1e0`、`-0.0`
和安全范围外的整数不经过 JavaScript Number 再编码；INI 值仍为
字符串。公开配置继续显示模板占位与脱敏密码，不显示解析后的值。
同步所有者也可以显式通过 `MoonrakerTemplateOwner` 创建可复用
文本模板；其 `render(context)` 接收 JSON 文本，调用者负责私密输入
和渲染结果，不能把这些值接入公开日志或接口。

同步真实函数候选新增 `render(context, {callables})`，`callables` 为
`ReadonlyMap<string, SyncTemplateCallable>`。函数接收 `TemplateCall`
的只读位置参数和关键字 Map，返回 `TemplateValue`；整数显式使用
`bigint`，浮点使用 `templateFloatValue(number)`，不接受普通 Number
或 Promise。输入和返回值保留整数／浮点区别、负零和非有限浮点。
`addEnvironmentGlobal(name, value)` 可以注册环境值或同步函数，影响
已经创建的模板；同名原始上下文或显式上下文函数优先。拒绝重复名称
和覆盖环境内置名称。这里只支持可信函数，不接入公开模板接口。

调用留在当前 Node 线程，原生模板不保存 Node 环境或函数引用；
嵌套渲染使用独立作用域，调用中关闭模板或所有者后停止后续副作用
并丢弃输出。每次最多 64 次调用，最多 16 层活动渲染、64 个模板和
64 个自定义全局，源／上下文／输出和调用消息各限 64 KiB。
原生侧在函数前后检查 10 秒期限；不能中断任意同步 JavaScript。
完整中间分配、任意精度整数、可启用日志和系统隔离仍待完成。
该新增模块 `src/sync_functions.rs` 已纳入产品源码快照清单；本机
独立快照构建在依赖 `memchr` 编译时 SIGSEGV，未计作构建通过。
固定函数基准可运行 `node host/bench/template-sync-functions.ts`，
日常只读取摘要锁定的上游参考，不启动 Python。环境函数参考包含
类型化调用记录，上下文函数参考不记录；两侧保留各自原工作量。
源码／独立 JavaScript 各 139 项通过，禁止 JS 子进程的编译检查
80 项通过；原生模块明确允许，不等于系统隔离。新同步函数预算
通过，但旧缓存读取和异步／UI 预算失败，不能用于默认入口切换。
详细失败和对照见[同步真实调用证据](../host/contracts/moonraker-template-sync-functions-acceptance.json)。

`npm test` 先编译独立 `template.node`；工具链为 Rust 1.89.0，依赖
锁定在 `host/native/template/Cargo.lock`。`npm run build:template`
支持指定 `CARGO`、`CARGO_HOME`、`RUSTUP_HOME` 和 `CARGO_TARGET_DIR`，
隔离工作区必须使用自己的构建目录。默认 `build-product-host.ts` 现将
模板列为必需插件，从独立源码快照重建；外部原生目录也必须包含该
插件，缺失时拒绝发布。构建信息绑定 C／Rust 输入、Cargo 锁文件、
Node 头文件、产物摘要及 Rust／Cargo 1.89.0 版本；其他 Rust 版本
直接拒绝。产物构建不复用传入的 `CARGO_TARGET_DIR`，而是创建、
使用并清理自己的输出目录。随机快照路径映射到 `/anyraid-product-build`，
有效 `CARGO_HOME` 下的 `registry/src` 映射到 `/anyraid-cargo-registry`；
未指定 `CARGO_HOME` 时使用 Cargo 默认的用户目录 `.cargo`。
此映射保留依赖的诊断位置，避免嵌入本机缓存路径。两条已核对实际
字节的缓存路径、两种参数通道经完整包清单对照一致。该有限对照
不替代源码与依赖字节核验，也不构成完整工具链签名或
密闭构建证明，不因测试通过自动替换默认打印入口。

默认打包首批四项用例为三通过／一 Rust 编译器 SIGSEGV；此前
全量本机四项失败保留。显式 `RUST_MIN_STACK=16777216` 的一次
有限对照通过两项，不推断栈不足或根因修复，也未将该变量写为
产品默认值。桌面启动校验和同一固定模板预算通过；编译后的模板
与 LDAP 在保留包中关闭 TS 加载复验，证据与实际覆盖范围见
[默认包记录](../host/contracts/moonraker-template-default-package.json)。
该默认包关闭 TS 加载后通过原 30 项模板／LDAP 断言，并在同一
锁定产物上通过原完整混合软件旅程；约 61 秒完成，原 90 秒期限、
输入与预算不变。仅使用模拟 MCU，不计算实际页面或目标板通过。
性能参考与此前冻结基线的关联见
[输入关联](../host/contracts/moonraker-template-default-inputs.json)。

当前仅验证同步文本／私密 JSON 路径、默认关闭的 debug 日志行为、
正负 i128 整数范围及明确的资源拒绝。源、上下文和输出各限 64 KiB，
私密 JSON 限 1 MiB，JSON 深度限 64，执行使用 100000 fuel；这些
限制不等于全部中间分配或实时执行预算。同步函数及独立异步／UI
候选已分别推进；共用工厂及显式标准代际装配见下文。完整语言、
通用组件加载、完整 Python 大整数仍待补齐，后续须完成隔离执行。
目前只允许可信启动配置和明确的
开发候选，不用于默认打印高频回调。
原失败、上游参考与桌面预算见
[同步模板验收](../host/contracts/moonraker-template-sync-acceptance.json)。

私密文件已为上述显式标准模板候选提供依赖；通用组件默认装配及
生产入口尚未切换，secrets／模板与 LDAP 完整契约仍未关闭。
默认 `template-numbers.test.ts`、`native-template-check.ts` 和
`native-template-integers.ts` 现读取固定摘要的
`template-numeric-reference.json.gz`，不启动 Python 或回退在线生成。
原 42744 组逐位舍入、5424 组整数／布尔及 1293 组转换用例保持；
参考保留原 JSON 文本到读取时，避免重编码丢失 `-0.0`。缺失、损坏
或输入集合变化立即失败。`node host/bench/template-sync.ts` 无需
`JINJA_REFERENCE`、`MOONRAKER_REFERENCE` 或 `SECRETS_BASELINE`，
使用原封存性能参考和同一输入／次数／预算，不属于同轮 Python 对照。
本轮源码与独立编译 JavaScript 均在外部程序不可用、Node 未授予
子进程权限时通过；原生插件另获显式加载许可，不据此宣称原生沙箱。
上述四条入口的原失败及范围见
[参考退役证据](../host/contracts/template-reference-retirement.json)。
随后 `native-template.ts`、`native-template-round.ts`、
`native-sensor-messages.ts`、`template-numbers.ts` 与
`template-candidate.ts` 也使用 `template-benchmark-reference.json.gz`，
输入、原始输出及压缩文件摘要均校验。原两轮预热、七样本和工作量
保持，不再准备 Jinja wheel 或启动 Python；原准备及数值助手已删除。
直接运行 `node host/bench/<上述名称>` 即可；原生入口仍须模板插件。
三条原生基准增加事先固定的 1.5 倍历史中位预算；原语和 JS 候选只
报告差距，`--numeric-adapter --require-compatible` 仍退出 1。
源码及独立 JavaScript 编译在相同隔离条件下通过，详见
[基准退役](../host/contracts/template-benchmark-retirement.json)。
此前 Unicode 原语性能差距已在桌面固定预算下补齐：实际转换使用
64 KiB BMP 数字查表和原补充平面映射，不缓存输入，不改变数字范围、
词法或舍入。`template-numbers.ts` 五种原语现在均执行事先固定的
1.5 倍历史中位预算；独立编译 Unicode 比值为 1.367。新增验证覆盖
680 个固定数字、跨文字混用、代理对、负零、空白、非法下划线、
非有限值和配置边界；相关 89／89、完整类型和规定空白通过。
原失败与交错对照见[Unicode 优化](../host/contracts/config-numeric-unicode-acceptance.json)。
这不关闭 JS 语法／类型兼容、其他传感器差分、完整模板工厂、全面
Python 退役及目标板打印性能门槛。
默认测试使用实际固定上游源码
生成的 24 项原冻结参考及六项负零补充参考，不新增运行时 Python；生成和性能对照只在
独立临时目录执行一次。失败、后续定向验证和原始性能见
[私密文件所有者记录](../host/contracts/native-secrets-owner-acceptance.json)。

性能复现：Node.js 26 下运行 `node host/bench/moonraker-secrets.ts`。
两轮预热、七个计时样本，输入、迭代数和每轮结果均核对。合成输入
约 3 KiB，JSON 2,000 次解析中位 59.24 ms，上游 Python 25.47 ms，
仍约慢 2.3 倍；INI 为 275.60／728.07 ms。100 万次缓存读取为
31.45／182.93 ms。16 次异步启动加载中位 2.52 ms，未测对应 Python
文件 IO。JSON 冷解析差距保留，不把缓存优势写成全面无退化。
读取不在打印或订阅热路径；这些桌面样本不证明目标板、真实打印、
模板渲染或部署预算通过，也未改动运动内核、容差或原锁定客户端包。

自审补充发现快路径误保留整数负零。首次参考经 JavaScript JSON
编码丢失浮点负零，六项为一通过／五失败，其中两项属于参考封装
失配；改用显式符号标签后，两个浮点控制通过，三个整数控制仍失败。
修复只为整数负零取原始数值 token，之后三个整数控制及受新条件
影响的字符串控制通过，原失败与配对源码性能见
[负零修复记录](../host/contracts/native-secrets-negative-zero-acceptance.json)。
相同普通 JSON 输入，七轮 ABBA、各组 14 个样本，2,000 次解析中位
为旧源码 49.99 ms／修复源码 53.44 ms，约增加 6.9%；修复源码包含
整数／浮点负零的输入中位为 128.92 ms，逐轮核对符号。新增原始扫描
成本保留，缓存读取和打印路径没有改变。原性能记录保留在原源码
范围，不将其摘要改写为当前头结果，也不宣称全面无退化。

## LDAP 身份所有者接入候选

`LocalUserOptions` 新增明确的 `ldap` 目录认证依赖及 `defaultSource`。
依赖实现 `authenticate(username, password, signal)`，必须执行实际
目录认证并响应取消；账号所有者负责串行身份操作和持久发布，目录
客户端的创建及关闭由装配者管理。当前标准配置加载器已接入实际
目录传输所有者，见后文标准配置；独立注入回调不能证明实际目录、
TLS、通用模板或完整 LDAP 已完成。

目录首次登录成功后建立 `source=ldap` 的持久身份，密码及盐为空；
不会将目录密码保存到私有数据库。来源必须匹配已有身份，不支持
显式创建目录用户或通过本地接口修改目录密码。目录自动建立身份的
响应仍为 `user_logged_in`，不发布本地用户创建事件。已有 JWT 的
刷新、退出、删除及重启撤销沿用同一账号所有者；关闭目录登录后，
已有有效 JWT 的行为与固定上游保持一致，退出或删除仍撤销授权。

目录失败只返回不含凭据的错误；请求取消或所有者关闭后，迟到的
目录结果不能建立身份。没有自动更改信任网段、开放监听器或启用
LDAP；`/access/info` 仅按明确注入的可用来源报告策略。

七项新身份控制及一项实际原生 HTTP／WebSocket 控制分别通过；
首轮测试接法与类型错误、缺少复用插件及沙箱监听失败全部保留，
不同轮次不拼成一次全绿链，见[身份所有者证据](../host/contracts/native-ldap-identity-acceptance.json)。
与 `48731115` 原账号源码做七轮 ABBA、每组 14 个样本的对照：
10 万次缓存 JWT 校验中位 20.69→20.93 ms，本地登录两次为
30.60→30.82 ms，约增加 1.2%／0.7%。均通过运行前固定的
1.1 倍加 2 ms 批次桌面预算，不证明目录传输或目标板打印预算。
复现时先用 `git show 48731115:host/src/moonraker/local-user-authorization.ts`
导出原源码，再以 Node.js 26 运行 `node host/bench/ldap-identity.ts <原源码路径>`。

## LDAP／LDAPS 传输接入候选

`LdapAuthorization` 实现上述目录依赖，由装配者创建、注入并关闭。
`LdapOptions` 接受已解析的 `host`、`port`、`secure`、`baseDn`、
`groupDn`、`bindDn`、`bindPassword`、`userFilter`、`membershipAttribute`、
`checkDnCase` 及 `activeDirectory`；不自行渲染模板或公开已解析凭据。
标准 `loadAuthorized` 已装配 `[ldap]` 的实际传输，通用模板和
实际用户目录验收尚未完成。旧传输证据仍保留原先独立源码范围，
标准装配结果使用后文的新证据，不改写历史归档。

先绑定服务账号或匿名身份，在基准 DN 下搜索，然后以结果第一项
DN 绑定用户。默认查询 uid，AD 查询 sAMAccountName；自定义过滤器
的所有 USERNAME 均替换为 RFC4515 转义值。分组按指定属性校验，
默认 DN 大小写敏感。重绑失败仅尝试新的用户连接，不透明重连或
自动重放记忆凭据，不能因会话断开退回匿名搜索。

每次登录独立建立连接。默认总期限 10 秒、响应总量 1 MiB、队列
32 项、搜索最多 1024 项；超过期限或资源界限拒绝该登录。取消和
`close()` 关闭实际连接及等待操作，关闭目录所有者后不能再登录。
数据回调在库解析前检查已取消状态，并隔离解析异常。LDAPS 最低
TLS 1.2，始终验证 CA 和主机名，DNS 名提供 SNI；`ca` 只允许配置
在加密传输上，不提供关闭证书校验的选项。错误、状态及对象检查
不返回绑定密码；不承诺 JavaScript 字符串的即时内存清零。

固定库为 ldapts 9.2.0，安装源码与固定标签 Client Git blob 一致。
九项不同控制分轮验证，完整类型及规定空白检查通过；合成目录
登录七轮、每轮八次，P95 42.32 ms，事件循环 P99 最高 1.79 ms。
预定桌面预算分别为登录 P95 250 ms、事件循环 P99 20 ms／最大
50 ms。复现：Node.js 26 执行 `node host/bench/ldap-transport.ts`，
仅在本机合成目录监听 127.0.0.1 并关闭。范围与原始证据见
[传输验收记录](../host/contracts/native-ldap-transport-acceptance.json)，
不证明实际用户目录、TLS 延迟、目标板打印或 G3 通过。

## LDAP 标准配置装配候选

### 配置路径与共享模板

`reader.section(name).getPath(option, {defaultValue, deprecate})` 使用绑定
工厂同步渲染，上下文包含该私密代际明确的 `data_path`。TS 中用绝对
字符串表示路径结果；选项不存在时，缺省 JSON 值保持原值与身份，
包括不展开的模板字符串。解析记录保留模板来源，不能拿解析后的
私密路径替换它。临时选项模板在成功或失败后关闭；调用方提供的
缺省模板仍由调用方持有。缺少工厂时，即使选项有缺省也会拒绝。

路径逐段跟随真实或悬空符号链接，然后处理 `..`；不先做词法折叠。
有效六十层链可用，自引用／互相引用循环拒绝。`~` 使用 `HOME` 或
当前用户的系统目录；空 `HOME` 展开为根目录，相对 `HOME` 保持相对
于工作目录的语义。`~用户名` 通过现有 Unix 原生插件的 libc NSS 查询，
不启动 `getent` 或 Python，也不限于手工读取 `/etc/passwd`。这些同步
文件／用户查询仅供配置加载；实际远程 NSS 提供者尚未验收。

标准服务提供 `templates: {dataPath: ...}` 和 `klippy: {}` 时，
`klippy_uds_address: {data_path}/comms/klippy.sock` 会由共用工厂展开，
无需再传 `pathContext.render`。未配置 socket 的缺省仍为 `/tmp/klippy_uds`，
Linux socket 路径容量校验保留。显式 `pathContext` 的旧适配入口仍可用；
它不等于完整通用组件加载。私密文件旧 `secrets_path` 回退复用物理
路径解析，加载 secrets 不反向依赖模板，避免组件启动循环。

固定上游 24 条路径、5 条缺省及独立 9 条 HOME 输出与 legacy 文件
探针保留。源码／关闭 TS 加载的 JavaScript 相关回归各 217／217；
新 C 查询的 UBSan／ASan 各 38／38。三组每批 500 次、两轮预热、
七样本的原 1.5 倍桌面预算通过，编译比值为 0.220／0.252／0.291。
复现使用 `node host/bench/moonraker-config-path.ts`。这不证明打印吞吐、
目标板或完整私密服务冷启动。禁止 JS 子进程的补充检查有 34 条在
符号链接夹具创建处被 Node 权限模型拒绝，不能计作隔离通过；未扩大
权限重跑抹除失败。最初错误的空 HOME 断言已由上游探针反证并修复。
独立 JavaScript 复用已有 Rust 插件与依赖，不宣称完整新产品构建。
全部参考、初始失败、最终来源摘要及预算见
[配置路径记录](../host/contracts/moonraker-config-path-acceptance.json)。

### MQTT 凭据消费共享模板

`readMqttSensorOptions(reader)` 与 `configureNativeSensorsFromConfig(reader, trackingEnabled)`
使用 reader 已绑定的共享私密工厂渲染 `[mqtt]` 的 `username` 和
`password`，例如 `{secrets["mqtt"]["password"]}`。不额外传入
`context.render`；同时存在两个渲染依赖会拒绝加载。配置 getter
与上游 JinjaTemplate 均裁剪首尾空白，内部空白保持；模板结果只在
可信连接选项中流转，公开 original／parsed 配置的凭据来源脱敏。

临时凭据模板在成功或失败后关闭，保留工厂和私密文件代际供其他
组件使用；私密文件变化不会替换已加载代际。旧未绑定 reader 的字面
配置和显式渲染器仍可用。`password_file` 仍按上游顺序先读取，即使
后续模板覆盖密码也不忽略不存在、过大或无效文件。

getter 本身不启动传输。标准 `ConfiguredMoonraker.load`／`loadAuthorized`
及普通原生产品入口现读取 `[mqtt]`／`[sensor ...]` 并创建一份连接和
传感器代际，凭据消费同一私密工厂；`start()` 才连接，设备配置重建
保留连接，服务退出或启动失败清理。调用方已提供完整 `sensors`／
`sensorTransport` 时保留显式装配路径；仅提供 sensor store 则拒绝
竞争所有者。直接调用 generation 工具时仍由调用方负责转移及清理。

`enable_moonraker_api` 要求明确的 `mqttAuthorize`，不会从 HTTP 权限
推断 broker 请求权限。无该策略时缺省关闭。旧 Klippy 组合的传感器
历史字段须提供匹配的 `history`，且不得已有 `auxiliary`／
`auxiliaryTotals`；任务状态仍由 HistoryRuntime 门控。
原生产品有匹配的持久日志时自动接线，普通配置传感器无需再提供
旧 `history`。配置传感器与 `nativeHistoryAuxiliary(fields)` 中注册
的进程字段共享同一注册表；该回调必须同步、返回 void，只注册
HistoryFields 提供者，不转移或关闭其外部资源。提供者资源仍由
进程 `createProcess`／`release` 所有者管理，在控制器退休后释放。
全表上限 64 项、身份唯一，监听前封存；异步回调、重复身份、
非持久控制器及与旧历史竞争的组合明确拒绝。
原生控制器在持久预约确认后打开累计；失败／重复预约回滚重置。
pausing 保持此前打印态，resuming 保持此前暂停态，收到设备确认
后才切换 exclude_paused 门控。终态快照在数据库等待前冻结，
故障先冻结再安全停止；快照失败仍停止设备并拒绝持久确认。
设备重建使用同一字段表和 MQTT 连接，旧控制器确认退休后释放
借用；恢复只确认原始日志，不采入新代际遥测。累计重置仍需要
原鉴权和日志空闲检查，只清理声明字段，历史快照不变。
原生打印日志已提供可选辅助快照接口：`reserve(request, snapshot)`、
`transition(id, revision, state, statistics, snapshot)` 与
`historyResetTotals(fields)`。辅助捕获在入队前完成，首次结果在同一
SQLite 事务中更新快照、累计和基础统计；失败确认及恢复不会替换
原快照。历史 HTTP／RPC 与通知返回持久的辅助数据，旧任务保持空值。
日志格式第 1 至 5 版在身份检查的同一事务内升级到第 6 版；不适用
旧程序直接读取新日志，回退必须保留升级前数据库副本。当前未切换
生产入口，只用临时数据库验收。自动门控及提供者组合见上，
源码／独立 JavaScript 各 381 项，产品／真实进程恢复各 24 项通过；
范围与冻结性能记录见
[接线验收](../host/contracts/native-history-fields-acceptance.json)。
普通 `get(id)`、`active()` 及恢复扫描保持请求元数据范围，避免高频
状态查询解码整份历史；完整快照由 `get(id, true)` 和历史列表／详情
接口显式读取。辅助表采用 WITHOUT ROWID，维持原最小日志容量；
累计项用显式序号保留注册顺序，不依赖数据表物理 rowid。

reader 绑定共享工厂时，传感器消息现持有该代际的一份同步句柄；
未绑定的显式旧路径继续使用独立原生适配器。传感器渲染可读取同一
secrets 校准数据与全局值，调用可信 Node 同步函数；消息内的 payload
和 set_result 覆盖同名环境全局。异步传感器模板拒绝。

Rust 在私密 text 环境内批量收集 set_result，不逐参数调用 JS；输出、
燃料、参数和安全数值边界保持，失败不发布部分测量值或历史。基于
当前环境唯一模板的静态变量依赖，未使用的函数不创建帧绑定；不存在
外部模板加载器。后注册的被引用函数立即使该句柄走同步回调路径；
宏、函数别名和嵌套调用分别验证。自定义函数仍须控制自身同步耗时，
不能由同步 JS 强制抢占。关闭传感器只释放句柄，最终服务关闭释放工厂。

高频基准为 `node host/bench/shared-sensor-components.ts`，可追加
`--unused-globals=32` 或 `--unused-globals=64` 复现共享环境压力。
每批 1 万帧含 UTF-8 解码、四个类型化结果、存储与平均历史；两轮预热
及七样本，原生独立路径基线在改动前冻结，默认及两种压力通过原 1.5
倍桌面门限。原 JS 逐参数回调和初版 32 函数超限均保留。此预算不含
模块／文件初始化、MQTT、实际打印或任意用户函数，见
[共享传感器记录](../host/contracts/shared-sensor-components-acceptance.json)。

复现装配基准使用 Node.js 26 执行
`node host/bench/configured-mqtt-components.ts`，其冻结参考为之前手工
装配同一私密工厂、传输和传感器的路径。计时含配置加载、真实
CONNECT／SUBACK 和 HTTP 监听，模块导入及夹具准备不计入冷启动。
另组混合 1000 条消息与 100 次鉴权查询，均通过原 1.5 倍桌面预算；
不是完整产品包、打印或目标板证明，见
[配置装配记录](../host/contracts/configured-mqtt-components-acceptance.json)。

复现凭据加载基准使用 Node.js 26
执行 `node host/bench/mqtt-config.ts`，日常不调用 Python。17 条固定参考
使用上游真实 JinjaTemplate 包装，源码／编译相关回归各 24 项通过，
三组加载通过修改前冻结的 1.5 倍桌面预算。初次错误参考及监听 EPERM
保留；这些结果不证明打印负载、目标板性能或完整新包构建。见
[MQTT 消费记录](../host/contracts/mqtt-template-components-acceptance.json)。

### 共用模板工厂与服务代际

异步所有者与 `template.node` 现在要求 `completionProtocol=1`。
部署须使用同一构建清单中的 Node 模块和插件；旧插件混配立即拒绝，
不静默等待期限。原生完成文本直接通过 N-API 传递，调用参数仍用
原有明确数字类型编码；原始输出超过 64 KiB 时在裁剪空白前拒绝。
模板环境不可变，晚注册全局只为下一次渲染建立代际，UI 保持隔离。
每所有者一个截止计时器覆盖最多 32 个帧，较早期限及时重新调度；
活动工作维持进程存活，空闲计时器 unref，关闭取消全部工作并清理。
源码及独立 JavaScript 各 179 项通过；工厂固定预算通过，独立 UI
回调最终 1.781 倍仍失败，全新原生快照遭 regex-automata 编译
SIGABRT。不得用缓存编译或最好一轮替代完整新包及性能验收。
当前结果见[异步开销记录](../host/contracts/template-completion-acceptance.json)。
下面工厂 175 项和原 SIGSEGV 是前序证据，保留原失败。

可信组件通过 `server.templates` 或 `reader.templates()` 取得
`MoonrakerTemplateFactory`。`createTemplate(source, isAsync)` 与
`createUiTemplate(source)` 保留原始源；同步／异步模式误用遵循固定
上游错误阶段。配置模板共用环境全局，异步执行器在首次异步／UI
使用时创建；UI 使用双花括号，不继承配置全局或 secrets。
`getTemplate` 保留缺省值并记录首次来源，`loadTemplate` 额外编译
字符串缺省值。显式 `toString()` 供可信来源记录；JSON／对象检查
不公开原文。模板关闭丢弃来源和闭包，服务关闭取消活动调用、清理
全局和私密代际、解除 reader 绑定；外部取消与关闭竞态保留首次理由。

直接创建工厂时，`MoonrakerTemplateFactory.load(reader, context,
{debug: call => ...})` 可提供明确的可信日志接收器，参数保持类型和
关键字顺序。异步日志接收器拒绝，失败不公开私密异常。服务的该入口
尚未接入通用日志配置，不据此宣称完整日志兼容。当前禁用日志处理
补齐上游 `msg` 绑定，布尔／None 文本保持 Python 形式。

源码与关闭 TS 加载的独立 JavaScript 各 175 项通过；六文件进程内
111 项通过，JS 子进程禁止，原生插件、数据库 worker、文件和网络
明确允许，实际网络仅使用 localhost，不能作为系统隔离证明。
事先固定的 500 次、两轮预热、七样本工厂预算中，同步比值 0.328
通过，异步／UI 1.569／1.935 超原 1.5 门限。原独立异步 UI 比值
1.655 仍失败；当前缓存预算通过，不消除此前 1.250 失败的根因。
原标准无 LDAP／无私密模板选项服务器的启动／鉴权查询预算通过，
不证明新增私密工厂冷启动或目标板打印速度。当前独立产品原生快照
在 minijinja 编译时 Rust SIGSEGV，完整新包未通过，不重试覆盖。
固定参考、回退节夹具 KeyError 诊断及全部失败见
[共用工厂记录](../host/contracts/moonraker-template-factory-acceptance.json)。
复现固定渲染预算使用 Node.js 26 执行
`node host/bench/template-factory.ts`，超限时退出 1。
共享配置 `getPath` 已补齐，见“配置路径与共享模板”；动态可变全局对象、属性／可迭代对象、
完整大整数、通用
组件加载和默认产品装配继续开放；默认 Python 打印入口未切换。

`ConfiguredMoonraker.loadAuthorized` 在 `[ldap]` 存在时解析配置，创建
实际 LDAP／LDAPS 所有者并纳入关闭；未配置时不加载 ldapts。
`[authorization] default_source=ldap` 要求该所有者存在，默认来源
仍为 moonraker，不隐式更改登录、信任网段或默认产品入口。

支持固定上游的 `ldap_host`、`ldap_port`、`ldap_secure`、`base_dn`、
`group_dn`、`bind_dn`、`bind_password`、`user_filter`、
`membership_attribute`、`check_dn_case` 和 `is_active_directory`。
未知字段拒绝；空分组 DN 拒绝，避免模板返回空值时取消成员校验。
绑定 DN 要求绑定密码。字面值直接解析；base、group、bind、password
和 user_filter 中的模板均须通过显式
`authorization.ldapConfiguration.render(source, signal)` 所有者渲染。
这只是依赖契约，不能代替完整通用模板实现或关闭模板兼容门槛。

五个字段共用 10 秒总渲染期限和调用方取消信号；异步迟到结果丢弃，
错误不附带私密原文。可信同步渲染器仍须执行自身资源限额。自定义
过滤器保留 USERNAME。TLS 证书仅可由明确的 ca 依赖提供，不能通过
配置关闭证书或主机名验证。

公开 `ConfigurationReader.parsed()`、`snapshot()` 中的绑定密码
显示为 `<redacted>`，不遍历继承的 constructor／原型。内部原始源
和受保护配置文件仍包含配置原文，不据此宣称所有下载文件已脱敏。
标准服务器关闭先取消目录连接，再等网络、账号与数据库排空；配置
失败未接管数据库时，调用方数据库保持打开。

实际配置与标准服务器控制、首次失败／受影响修复、配对源码和预算
见[装配验收](../host/contracts/native-ldap-configuration-acceptance.json)。
当前中位预算通过；历史尾延迟增加原因未确定，不能用后续正常样本
消除该记录。完整通用模板、实际目录、目标板打印与 G3、全面 Python
退役及主线发布仍未完成。

PR #62 已合入 develop `6fb19680`；精确候选与实际合并后的全部
15 项检查分别通过，含普通 4499／4499、协议、Linux MCU、324 条
sanitizer 命令和 500 个进程诊断，见[合并后终态](../host/contracts/develop-6fb-terminal.json)。
这些检查不等于真实目录或目标板验收。

2026-10-10 R5／R6 追加客户端验收使用原锁定包 `8deb5fc7`，未包含
此 LDAP 更新。Mainsail 补齐配置保存、文件／队列和进程／设备恢复；
Fluidd 选择器上传和原受保护页面进程恢复通过，下载摘要一致。
新场次已关闭，旧上传 400 原因仍未确定，见
[场次范围](../host/contracts/integrated-client-r5-r6-scenes.json)。临时
代理和字段观察器属于验收夹具，不能作为正式部署配置。
