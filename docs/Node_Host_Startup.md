# Node 主机启动与机器集成

原生入口使用 Node.js 26.9 或更高的 26.x 版本：

```sh
node scripts/product-host.ts --help
node scripts/product-host.ts --profile /etc/anyraid/machine.ts
```

`--profile` 必须是本机 `.ts`、`.mts` 或 `.mjs` 模块的绝对路径。
帮助和参数错误不会加载机器模块或原生插件。运行主机前仍须安装
`host` 依赖并完成 `npm --prefix host run build:native`，运行环境和
迁移范围见 [迁移说明](Node_Host_Migration.md)。

这是显式机器集成入口。仓库未提供可直接套用到任意打印机的生产
机器模块，也未将默认 Python 服务切换到此命令。声明式配置装配、
目标机部署、其余设备支持和实机验收仍需继续完成。

## 机器模块契约

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
