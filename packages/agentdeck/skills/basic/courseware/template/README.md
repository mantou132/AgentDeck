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
| `assets/live.js` | 扫码互动（可选，需要联网），在 `courseware.js` 之后加载；示例 `index.html` 不带 |

## 硬约束

- **离线、无构建**：双击 `index.html` 就能用，模板本身不引入 CDN、npm 依赖、Web 字体或构建步骤（只有可选的 `live.js` 用到时从 esm.sh 加载二维码库）。交付时 Agent 会把 CSS 和 JS 内联成一个文件（见 `SKILL.md` 的 Handing it over），所以 `assets/` 里不要出现 `</script>`、`</style>` 这样的字符串。只有课件需要 3D 时才按 `SKILL.md` 从 CDN 加载 three.js，这部分写在课件里，不进模板。
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
- 对外暴露 `window.courseware = { next, prev, go, reset, setPickerSource }`，供测试和课件内的自定义脚本使用。`setPickerSource({ names(), picked(name) })` 由 `live.js` 设置：有人扫码时点名改从 `names()` 抽（优先于名单和学号），抽中后调用 `picked`。

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

## 扫码互动（live.js）

老师的大屏显示二维码，学生用手机或平板的浏览器扫码打开 AgentDeck 官网的观众页 `https://agentdeck.xianqiao.wang/zh/live`（代码在 `packages/website/src/pages/live/`），作答结果实时回到大屏。

- **房间**：每个课件一个房间，按 `location.pathname` 存在 `localStorage['cw-live:<路径>']`（`room`、`key`、`numbers`），刷新或重开课件后二维码和编号都不变。二维码链接是 `…/zh/live#<room>.<key>`，`#` 后面不发给服务器。
- **传输**：复用 AgentDeck 的 Relay（`wss://agentdeck.xianqiao.wang/ws`），relayId 为 `live_<room>`。大屏连 endpoint 1，每台学生设备连 endpoint 2，`device_id` 是该设备在这个房间的固定 id（存在观众页的 localStorage）。全部用 ephemeral 消息（不落库、不 ack，只发给当时在线的设备）：广播的可靠消息要所有登记过的设备都 ack 才清除，学生离开会让消息一直挂着。Relay 不校验 Origin，`file://` 打开的课件也能连。
- **加密**：消息体是 `{ iv, c }`，用链接里的 32 字节密钥做 AES-GCM，Relay 只看到密文。解不开的消息直接丢弃。
- **消息**（加密前）：学生 → 大屏 `{ t: 'join', from }`、`{ t: 'data', from, value }`；大屏 → 学生 `{ t: 'present' }`（大屏连上时广播，在线设备回 `join`）、`{ t: 'hello', n }`（编号）、`{ t: 'view', html }`（要显示的界面）、`{ t: 'data', value }`、`{ t: 'notice', text }`（弹出提示）。大屏收到 `join` 就给该设备单发编号和当前界面，所以学生中途加入、刷新、大屏刷新都能恢复。观众页的类型定义在 `packages/website/src/pages/live/_protocol.ts`，两边要同步改。
- **编号**：设备第一次 `join` 或作答时按顺序分配，永久保存在房间里。点名从所有编号里抽，不管是否在线（手机切到别的应用就会断开）；抽中的设备在线时弹出「你被抽到了！」。
- **学生端界面**：`view` 的 HTML 放在观众页的 `<iframe sandbox="allow-scripts allow-forms">` 里运行（不同源，碰不到官网页面），带一套手机样式（按钮、输入框，`.selected`、`.right`、`.wrong`、`.primary`）。脚本里有 `live.send(value)`、`live.onmessage = (value) => {}`、`live.id`。同样的 HTML 再发一次不会重建 iframe，学生输了一半的内容不会丢。
- **组件**：`cw-poll` 和 `cw-responses` 在所在页显示（`cw-enter` 事件）时发出自己的界面，用随机 id 区分答案；同一设备多次作答只算最后一次。`cwReset()` 清空统计并让学生端复位。`window.CwLive.room()` 返回房间（`url`、`count`、`numberOf(id)`、`on('join'|'data'|'status', fn)`、`show(html)`、`send(value, to?)`、`notice(text, to?)`、`qr(size)`），课件里的自定义互动可以直接用。
- **二维码**：`qr()` 动态 `import('https://esm.sh/qrcode-generator@2.0.4')` 生成 SVG；加载失败时提示需要联网。
- `live.js` 的模板字符串里把结束标签写成 `${'</'}script>`（Biome 会去掉 `<\/script>` 的转义），内联成单文件后也不会提前结束脚本。

测试：本地运行 Relay（`mantou132/relay`）和官网（`pnpm run build && pnpm run start`），用 Playwright 打开课件和两个手机视口的观众页，把两边的 WebSocket 用 `routeWebSocket` 在 Node 里转到本地 Relay（`connectToServer()` 不能改地址）。检查加入人数与编号、投票计数与公布答案、数字与文字作答、学生刷新、大屏刷新后房间与编号不变、点名弹窗。

前提：教室电脑和学生设备都要能上网，学生设备要能用浏览器扫码（学校平板可能被管控）；在真实的希沃一体机和学生平板上还没测过。
