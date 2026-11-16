# 课件模板维护说明

给维护者看的：改进模板前先读这份，不用从源码倒推。Agent 怎么用模板写在上一级的 `SKILL.md`；Agent 复制到课程目录后会删掉本文件和 `gallery.html`。

## 文件

| 文件 | 内容 |
| --- | --- |
| `index.html` | 示例课件（人教版三上「分数的初步认识」骨架），Agent 复制后改成具体的一节课 |
| `gallery.html` | 所有教具的写法示例，也是测试页 |
| `assets/deck.css`、`assets/deck.js`、`assets/live.js` | 符号链接，指向与演讲模板共用的引擎、通用样式和扫码互动（`skills/_shared/deck/`，说明见那里的 `README.md`）；示例 `index.html` 不带 `live.js` |
| `assets/courseware.css` | 数学样式：分数、教具、`cw-graph` 滑块、竖式，在 `deck.css` 之后加载 |
| `assets/manipulatives.js` | 数学教具（自定义元素），必须在 `deck.js` 之前加载 |

## 硬约束

- **离线、无构建**：双击 `index.html` 就能用。交付时 Agent 会把 CSS 和 JS 内联成一个文件（见 `SKILL.md` 的 Handing it over），所以 `assets/` 里不要出现 `</script>`、`</style>` 这样的字符串。只有课件需要 3D 时才按 `SKILL.md` 从 CDN 加载 three.js，这部分写在课件里，不进模板。
- **只能放文本文件**：skill 打包（`rsbuild.config.ts` 的 `readSkills`）按 UTF-8 读取，图片、字体等二进制文件会损坏。图形用 SVG 画；KaTeX 的字体是二进制，所以不打包进模板，而是从 CDN 加载（npmmirror 带 CORS 头，`file://` 页面也能加载字体），断网时 `.tex` 显示灰色的 LaTeX 原文。
- **兼容旧浏览器**：用普通 `<script>`，不用 `type="module"`（`file://` 下浏览器会拦截模块）；语法不超过 ES2017（不用 `?.`、`??`、私有字段）；CSS 不用嵌套、`:has()`、容器查询。目标是希沃 / 鸿合一体机自带的浏览器、360 和 QQ 浏览器的极速模式；IE 不支持（需要自定义元素）。
- 仓库的 Biome 会检查这些文件，提交前运行 `pnpm run lint`。

## 教具（manipulatives.js）

每个教具用 `define(name, build)` 注册（初中教具在文件后半部分，共用 `range()`、`splitTop()`、`compile()`、`formula()`、`sliders()`、`HALO`）：第一次挂载时记下元素原有的 innerHTML 并调用 `build`，`cwReset()` 恢复 innerHTML 后再调用一次 `build`。属性只在构建时读一次，状态放在 `build` 的闭包里。工具函数：`svg()` / `html()` 建节点，`draggable()` 处理 SVG 内的指针拖动，`num()` / `list()` 读属性，`svgFrac()` 在 SVG 里画竖排分数，`fracHtml()` 生成 HTML 分数。

| 元素 | 主要属性 | 说明 |
| --- | --- | --- |
| `cw-number-line` | `min max step points hops fractions label-every snap width hide-readout opposite abs` | 可拖动的点；`hops` 画跳跃弧线并标出差；`fractions="n"` 按 1/n 画刻度并用分数标注，读数会约分；负数用「−」；`opposite` 画相反数的空心点，`abs` 在数轴上方画到 0 的距离 |
| `cw-fraction` | `shape(circle/bar/grid) parts shaded size rows color controls hide-readout` | 点一份切换涂色；`controls` 增减份数 |
| `cw-clock` | `time snap size hide-readout` | 拖分针时时针按比例跟着走，跨过 12 点会进退小时；也能拖时针；当前时间写在 `data-time` |
| `cw-geoboard` | `cols rows cell points show(area perimeter lengths angles) unit color` | 拖动顶点吸附格点；面积用鞋带公式；周长和边长只在边都是横竖时显示（斜边是无理数）；不写 `points` 时点方格数面积 |
| `cw-counter` | `places value` | 计数器；某一位到 10 颗时变色并出现「满十进一」，最高位最多 9 颗 |
| `cw-bar-chart` | `items values unit tally` | 点柱子加一，可撤销；`tally` 按笔顺画「正」字 |
| `cw-spinner` | `sectors size` | 扇区名称的第一个字是颜色名（红黄蓝绿紫橙白黑粉）时用对应颜色；转一次 / 快速转 10 次，统计次数 |
| `cw-graph` | `x y fn params label marks points step snap width height hide-readout` | 坐标系，x、y 单位长度相等。`fn` 用 `compile()` 编成函数（`^` 转 `**`，`with (Math)` 提供 sqrt 等）；`params` 生成滑块（`sliders()`，松手后 blur，否则翻页笔按键会被滑块吃掉）；`label` 由 `formula()` 填值并按教材写法整理（系数 1 省略、0 项去掉、`+ −` 合并、`(x − 0)` 写成 x）。采样 800 点画曲线，跳变或非数处断开（反比例函数）；`marks` 用采样找变号点再二分求零点，找斜率变号点再三分求顶点 |
| `cw-geometry` | `figure grid snap unit scale width height hide-readout` | 动态几何。`figure` 解析成点（自由点、`on` / `oncircle` 约束点、`constructions` 里的作图点）和图形；每次拖动按定义顺序重算所有点再重画。三角形三个角都显示时由 `roundedAngles()` 用最大余数法取整，保证和为 180°。识别不了的语句以红字列在读数处 |
| `cw-algebra-tiles` | `expr negative x width height` | 代数瓦片。x 的长度取单位的 3.4 倍（故意不是整数，学生不会误以为 x 是确定的数）；松手时吸附到附近瓦片的边；拖回左侧托盘即删除；点一下 x 条绕中心转向。读数为盘面多项式，所有瓦片无重叠且恰好铺满外接矩形时，把长和宽分解成 a·x + b 写出因式 |
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
