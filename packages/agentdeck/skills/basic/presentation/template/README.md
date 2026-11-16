# 演讲模板维护说明

给维护者看的。Agent 怎么用模板写在上一级的 `SKILL.md`；Agent 复制到演讲目录后会删掉本文件。

## 文件

| 文件 | 内容 |
| --- | --- |
| `index.html` | 示例演讲（「让会议少一半」），用到了全部版式和扫码互动，也是测试页；Agent 读完后换成真实内容 |
| `assets/deck.css`、`assets/deck.js`、`assets/live.js` | 符号链接，指向与课件模板共用的引擎、通用样式和扫码互动（`skills/_shared/deck/`，约束、原理和测试方法见那里的 `README.md`） |
| `assets/presentation.css` | 演讲主题：覆盖 `:root` 配色，加封面、章节页、金句页、引语、大数字、目录、整页图片和深色页，在 `deck.css` 之后加载 |

## 约定

- `#cw-stage` 带 `data-picker="抽奖"`，工具栏的随机抽取按钮显示为「抽奖」。
- 封面、章节页和 `.dark` 页用深色背景，`presentation.css` 末尾为深色页调整了扫码互动的进度条、提问卡片和按钮。
- 图片放 `assets/img/`，交付时内联成 `data:` URL（skill 打包只能带文本文件，所以模板本身不带图片）。

## 测试

改动后用无头 Chromium 打开 `index.html`，逐页截图（1920×1080，`?steps=all&toolbar=0`，用 `courseware.go(n, true)` 翻页）检查排版并确认控制台没有报错；扫码互动按共用 README 的方法用两个手机视口走一遍。
