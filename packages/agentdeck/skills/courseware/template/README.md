# 课件模板维护说明

给维护者看的：改进模板前先读这份，不用从源码倒推。Agent 怎么用模板写在上一级的 `SKILL.md`；Agent 复制到课程目录后会删掉本文件和 `gallery.html`。

## 文件

| 文件 | 内容 |
| --- | --- |
| `index.html` | 示例课件（人教版三上「分数的初步认识」骨架），Agent 复制后改成具体的一节课 |
| `gallery.html` | 所有教具的写法示例，也是测试页 |
| `assets/courseware.css` | 主题色（`:root`）、幻灯片版式、文字与分数样式、选择题、拖拽、工具栏、浮层、打印样式 |
| `assets/courseware.js` | 引擎：舞台缩放、翻页、逐步显示、选择题、拖拽、画笔、计时器、随机点名、工具栏、快捷键 |
| `assets/manipulatives.js` | 数学教具（自定义元素），必须在 `courseware.js` 之前加载 |

## 硬约束

- **离线、无构建**：双击 `index.html` 就能用，模板本身不引入 CDN、npm 依赖、Web 字体或构建步骤。交付时 Agent 会把 CSS 和 JS 内联成一个文件（见 `SKILL.md` 的 Handing it over），所以 `assets/` 里不要出现 `</script>`、`</style>` 这样的字符串。只有课件需要 3D 时才按 `SKILL.md` 从 CDN 加载 three.js，这部分写在课件里，不进模板。
- **只能放文本文件**：skill 打包（`rsbuild.config.ts` 的 `readSkills`）按 UTF-8 读取，图片、字体等二进制文件会损坏。图形用 SVG 画，公式用 `.frac` 和 Unicode 字符，所以不带 KaTeX。
- **兼容旧浏览器**：用普通 `<script>`，不用 `type="module"`（`file://` 下浏览器会拦截模块）；语法不超过 ES2017（不用 `?.`、`??`、私有字段）；CSS 不用嵌套、`:has()`、容器查询。目标是希沃 / 鸿合一体机自带的浏览器、360 和 QQ 浏览器的极速模式；IE 不支持（需要自定义元素）。
- 仓库的 Biome 会检查这些文件，提交前运行 `pnpm run lint`。

## 引擎（courseware.js）

- **舞台**：`#cw-stage` 固定 1920×1080，用 `transform: scale` 适配屏幕并居中留黑边。所有坐标都按舞台单位：HTML 拖拽用 `stagePoint()` 换算，SVG 教具用 `getScreenCTM()` 换算（`manipulatives.js` 的 `svgPoint()`），缩放后点击位置仍然准确。
- **幻灯片**：`#cw-stage` 的直接子元素 `section.slide`，当前页加 `.cw-current`。
- **逐步显示**：进入页面时收集 `[data-step]` 并分组。空值按文档顺序各成一步，数字按大小排序、相同数字同时出现，`&` 并入上一步（`cw-column` 用它让一位数字和它的进位一起出现）。前进时先显示下一组，显示完才翻页；后退时先隐藏，回到上一页则显示该页全部步骤。
- **重置协议**：工具栏「重置」对当前页所有带 `cwReset()` 方法的元素调用它，再复位拖拽位置、选择题标记、步骤和本页墨迹，然后重新收集步骤（教具重建后节点会变）。
- **选择题**：委托在舞台上的 click，`.choices > li` 根据有没有 `data-correct` 切换 `.cw-right` / `.cw-wrong`。
- **拖拽**：`[data-drag]` 用 `transform: translate` 移动，可选 `data-snap` 吸附网格。本页有 `[data-drop]` 时，松手位置落在区域内就判定：名称匹配（或区域写了 `*`）加 `.cw-right`，否则加 `.cw-wrong` 并弹回原位。
- **滑动翻页**：只对触摸和笔生效（鼠标不触发），起点在教具、拖拽项、选择题、按钮和浮层上时忽略。
- **画笔**：舞台上一层 1920×1080 的 canvas，按页保存笔画数组，切页时重绘；橡皮删除经过的整条笔画。
- **浮层**：计时器和点名是舞台内的 `.cw-overlay`，跟着一起缩放。计时器用 `requestAnimationFrame` 计时，关闭浮层也继续走，工具栏按钮会显示剩余时间；结束时用 WebAudio 响三声。点名名单存在 `localStorage['cw-picker-names']`（`file://` 下可能不可用，那就只在本次打开期间有效），本轮抽过的不重复。
- **快捷键**：→ ↓ PageDown 空格 回车 前进；← ↑ PageUp Backspace 后退；Home / End；F 或 F5 全屏（翻页笔的「播放」键常发 F5，这里拦截，避免刷新页面）；B、`.`、W 黑屏，再按任意键恢复；P 画笔；T 计时；R 点名；Esc 关闭浮层或画笔。焦点在输入框内时不响应。
- **URL 参数**：`#3` 打开第 3 页；`?steps=all` 显示全部步骤；`?toolbar=0` 隐藏工具栏。后两个用来截图检查。
- **打印**：`@media print` 把每页排成 16in×9in（舞台 `zoom: 0.8`），显示全部步骤，隐藏工具栏、墨迹、浮层和教具按钮。PDF 导出靠它。
- 对外暴露 `window.courseware = { next, prev, go, reset }`，供测试和课件内的自定义脚本使用。

## 教具（manipulatives.js）

每个教具用 `define(name, build)` 注册：第一次挂载时记下元素原有的 innerHTML 并调用 `build`，`cwReset()` 恢复 innerHTML 后再调用一次 `build`。属性只在构建时读一次，状态放在 `build` 的闭包里。工具函数：`svg()` / `html()` 建节点，`draggable()` 处理 SVG 内的指针拖动，`num()` / `list()` 读属性，`svgFrac()` 在 SVG 里画竖排分数，`fracHtml()` 生成 HTML 分数。

| 元素 | 主要属性 | 说明 |
| --- | --- | --- |
| `cw-number-line` | `min max step points hops fractions label-every snap width hide-readout` | 可拖动的点；`hops` 画跳跃弧线并标出差；`fractions="n"` 按 1/n 画刻度并用分数标注，读数会约分 |
| `cw-fraction` | `shape(circle/bar/grid) parts shaded size rows color controls hide-readout` | 点一份切换涂色；`controls` 增减份数 |
| `cw-clock` | `time snap size hide-readout` | 拖分针时时针按比例跟着走，跨过 12 点会进退小时；也能拖时针；当前时间写在 `data-time` |
| `cw-geoboard` | `cols rows cell points show(area perimeter lengths angles) unit color` | 拖动顶点吸附格点；面积用鞋带公式；周长和边长只在边都是横竖时显示（斜边是无理数）；不写 `points` 时点方格数面积 |
| `cw-counter` | `places value` | 计数器；某一位到 10 颗时变色并出现「满十进一」，最高位最多 9 颗 |
| `cw-bar-chart` | `items values unit tally` | 点柱子加一，可撤销；`tally` 按笔顺画「正」字 |
| `cw-spinner` | `sectors size` | 扇区名称的第一个字是颜色名（红黄蓝绿紫橙白黑粉）时用对应颜色；转一次 / 快速转 10 次，统计次数 |
| `cw-column` | `a b op(+ - ×) steps` | 竖式。加法进位小 1 写在横线上方；减法在被借位的数字上方打退位点；`+ −` 支持小数（按小数点对齐，原数没写的末位留空）；`×` 只支持整数，多位乘数逐行列部分积，不显示进位 |

`cw-column` 的实现要点：先算出每个格子的行、列和出现顺序（`order`），按 `order` 排序后插入 DOM，再用 `grid-row` / `grid-column` 摆到正确位置。这样 DOM 顺序就是从右往左的出现顺序，可以直接用无编号的 `data-step`。

放在选择题和拖拽卡片里的教具，CSS 设置了 `pointer-events: none`，只当图片用，避免点击被教具拦下。

### 加一个教具

1. 在 `manipulatives.js` 里用 `define('cw-xxx', function () { … })` 实现，用 SVG 绘制，指针操作用 `draggable()` 或 click，事件里 `stopPropagation()`，避免触发翻页。
2. 读数放进 `.cw-readout`，按钮放进 `.cw-controls`，用 `button()` 创建。
3. 在 `gallery.html` 加一页示例，在 `SKILL.md` 的 Manipulatives 列表加一行，并更新本文件的表格。

## 测试

没有自动化测试文件。改动后用无头 Chromium 打开 `gallery.html` 和 `index.html`：

- 逐页截图（1920×1080，`?steps=all&toolbar=0#n`）检查排版，并确认控制台没有报错。
- 用 Playwright 模拟操作：键盘翻页和逐步显示、选择题、拖到正确和错误的区域、画笔、计时器、点名、黑屏、计数器加珠、拖动钟面分针、拖动数轴点、柱状图加一和撤销、竖式逐位出现、重置本页。
- 无头 Chromium 打印成 PDF，确认每页一张 16:9。

## 已知不足

- 没有除法竖式（「厂」字形），乘法竖式不显示进位。
- 只在 Chromium 内核里测试过，没在 Firefox、Safari 和真实的希沃一体机上测过。
- 加法进位写在横线上方是按人教版的习惯，还没有找老师核实。

## 规划：扫码互动（未实现）

目标：老师在大屏上显示二维码，学生用自己的设备扫码作答，大屏实时显示统计（正确率、各选项人数），也能展示某个学生的答案。

已确认可行的部分（读过 `mantou132/relay` 服务端源码）：

- 复用 AgentDeck 的 Relay（`wss://agentdeck.xianqiao.wang/ws`）。它与协议无关，只转发不透明的 JSON；不校验 Origin，`file://` 打开的课件也能连上；不限制每个房间的设备数。
- 一节课一个随机 relayId（写在二维码里）。大屏连 endpoint 1，每个学生连 endpoint 2，各用自己的 `device_id`。消息默认广播给对端所有在线设备，也可以用 `target_device_id` 只发给一台。
- 全部使用 ephemeral 消息：只转发给当时在线的设备，不落库、不需要 ack。不用可靠消息，因为广播消息要等所有登记过的设备都 ack 才会清除，学生中途离开会让消息一直挂着。学生中途加入时先发一条「加入」，大屏只回给他当前的题目。
- 端到端加密：密钥放在二维码链接的 `#` 后面（不会发给服务器），Relay 只能看到密文。
- 学生端是部署在线上的网页（例如官网 `/class`），因为学生扫码只能打开 https 链接。

要做的事：学生端页面和部署、课件里的「扫码作答」组件（显示二维码、收集答案、统计）、`SKILL.md` 的用法说明。

前提与待确认：教室和学生的设备要能上网，学生设备能用浏览器扫码打开网页（学校的平板可能被管控，只能用指定应用）；学生用的是答题器还是平板，还没问清楚。
