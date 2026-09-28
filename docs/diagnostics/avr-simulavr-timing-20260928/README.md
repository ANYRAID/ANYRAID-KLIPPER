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
