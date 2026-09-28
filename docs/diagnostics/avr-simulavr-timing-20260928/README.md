# 真实 AVR 固件时序诊断

协议、CRC、100 步计数和固件位置通过；默认同刻 GPIO/步进场景的
10 µs 探索性诊断门槛失败。不要将错峰对照的通过当作修复。
两份 VCD 使用 gzip 压缩；JSON 保存逐步时刻与间隔偏差。

先按 [仿真工具说明](../../Debugging.md#testing-with-simulavr) 构建引擎。
在仓库根目录使用 Node 26 和 AVR 工具链运行：

```sh
mkdir -p /tmp/avr-klipper-check
cp host/test/fixtures/simulavr/klipper.config /tmp/avr-klipper-check/config
make KCONFIG_CONFIG=/tmp/avr-klipper-check/config OUT=/tmp/avr-klipper-check/out/ CROSS_PREFIX=avr- olddefconfig
make -j2 KCONFIG_CONFIG=/tmp/avr-klipper-check/config OUT=/tmp/avr-klipper-check/out/ CROSS_PREFIX=avr-
AVR_FIRMWARE=/tmp/avr-klipper-check/out/klipper.elf AVR_EVIDENCE=/tmp/avr-coincident node --test --test-isolation=none host/acceptance/simulavr-klipper.test.ts
AVR_FIRMWARE=/tmp/avr-klipper-check/out/klipper.elf AVR_EVIDENCE=/tmp/avr-offset AVR_GPIO_OFFSET_TICKS=8000 node --test --test-isolation=none host/acceptance/simulavr-klipper.test.ts
```

第一项保留同刻场景和失败门槛；第二项仅用于半周期错峰对照。
AVR_EVIDENCE 指定输出前缀，会写入 `.json` 和 `.vcd`，不改变断言。
首次采样与错峰采样时钟起点不同，比较的是相邻步间隔，不是绝对时间。
真实硬件精度、完整 G-code 打印和原有 Node 数值异常均未由本检查验证。

## 旧 GPIO 对照

`gpio-comparison.json` 记录三组交替执行的样本及精确源码/固件哈希。
以提交 1f172867 的 Makefile、src、scripts、host/src、lib 做临时源码
快照，仅将 src/gpiocmds.c 替换为 a593d551 的父提交中的同名文件，
按上方 AVR 配置编译。不得在当前工作区回退该文件。对照仅隔离 GPIO
代次扩展前后的差异，不是整个旧 Python 主机的基线。

每轮分别设置 AVR_FIRMWARE 指向当前与旧 GPIO 固件，使用相同测试
及 AVR_GPIO_OFFSET_TICKS=0。六次均在保存完整波形后因精度门槛失败；
失败不代表进程失联或丢步。第二轮反转运行顺序，以减少固定先后次序
的影响。两份 `*-digital-load.asm` 展示实际链接固件的处理函数，当前
版本有 `move_free` 调用，旧对照为内联；需要进一步控制实验确认其贡献。
