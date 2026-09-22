# 诊断 PDF 字体

DejaVu Sans 及 Bold 从本机 Debian `fonts-dejavu-core` 包复制，未经修改。
来源：https://dejavu-fonts.github.io/ 。完整许可见 `LICENSE-DejaVu.txt`。
字体随 Node 诊断工具分发，避免依赖目标机器是否安装相同字体。

| 文件 | SHA-256 |
| --- | --- |
| DejaVuSans.ttf | 3b37418b20f0b172b26a263e2231c8730f9f9d76cfbd2ab97643d4ab5a679681 |
| DejaVuSans-Bold.ttf | acd8332050ebe01429a0c6987322e03b6e2d1740df62b5bc90a03bb7e0b7dc37 |

导出器检查可见标签的字形；例如此字体不覆盖的中文字形会明确报错。
SVG/PNG 仍可使用系统字体回退；PDF 的自定义字体与通用 CJK 支持待补齐。
