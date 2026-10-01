# 版本变化

## 未发布

- 修复 STM32／N32 在 GCC 10.3.1 下优化前链接导致的小 ROM 构建失败，
  最终链接启用 LTO 插件，保留原容量限制和停止保护。
- Node 主机及原生 Moonraker 仍处于迁移验收阶段，当前仅推进 ANYRAID
  Cycnumbris 500 系列；默认入口和实机发布尚未切换。

详细实现和验收边界见 [交付计划](docs/Node_Host_Delivery_Plan.md)。
