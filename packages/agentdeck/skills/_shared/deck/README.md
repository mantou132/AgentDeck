# Deck 引擎维护说明

`skills/_shared/` 不是 skill 分组，放几个 skill 共用的文件：各 skill 的模板用符号链接指向这里（如 `courseware/template/assets/deck.js -> ../../../../_shared/deck/deck.js`），`rsbuild.config.ts` 的 `readSkills` 打包时按链接读成普通文件，所以装到 host 上的每个 skill 都有完整副本；skill-eval 复制时也解开链接。改这里的文件会同时影响课件（`basic/courseware`）和演讲（`basic/presentation`），两边都要检查。

## 文件

| 文件 | 内容 |
| --- | --- |
| `deck.js` | 引擎：舞台缩放、翻页、逐步显示、选择题、拖拽、画笔、计时器、随机抽取、工具栏、快捷键、KaTeX |
| `deck.css` | 默认配色、幻灯片与通用版式、文字、选择题、拖拽、工具栏、浮层、打印、扫码互动的大屏样式 |
| `live.js` | 扫码互动（可选，需要联网），在 `deck.js` 之后加载 |

## 硬约束

- **离线、无构建**：双击模板的 `index.html` 就能用，不引入 CDN、npm 依赖、Web 字体或构建步骤（例外都是用到时才联网：`live.js` 从 esm.sh 加载二维码库；页面里有 `.tex` 公式时 `deck.js` 从 npmmirror 加载 KaTeX）。交付时 Agent 会把 CSS 和 JS 内联成一个文件，所以这里不要出现 `</script>`、`</style>` 这样的字符串；模板字符串里写成 `${'</'}script>`（Biome 会去掉 `<\/script>` 的转义）。
- **只能放文本文件**：skill 打包按 UTF-8 读取，二进制文件会损坏。
- **兼容旧浏览器**：用普通 `<script>`，不用 `type="module"`（`file://` 下浏览器会拦截模块）；语法不超过 ES2017（不用 `?.`、`??`、私有字段）；CSS 不用嵌套、`:has()`、容器查询。目标包括希沃 / 鸿合一体机自带的浏览器、360 和 QQ 浏览器的极速模式；IE 不支持（需要自定义元素）。观众端界面在手机浏览器里运行，不受这条限制。
- 仓库的 Biome 会检查这些文件，提交前运行 `pnpm run lint`。

## 引擎（deck.js、deck.css）

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
- **公式**：页面有 `.tex` 元素时才插入 KaTeX 的 CSS 和脚本（版本写死在 `KATEX` 常量），加载后逐个 `katex.render`，`.display` 为独立公式，排好的加 `.cw-typeset`。
- **打印**：`@media print` 把每页排成 16in×9in（舞台 `zoom: 0.8`），显示全部步骤，隐藏工具栏、墨迹、浮层和教具按钮。PDF 导出靠它。
- 对外暴露 `window.courseware = { next, prev, go, reset, setPickerSource }`，供测试和课件内的自定义脚本使用。`setPickerSource({ names(), picked(name) })` 由 `live.js` 设置：有人扫码时改从 `names()` 抽（优先于名单和编号），抽中后调用 `picked`。
- **点名按钮**：`#cw-stage` 上的 `data-picker` 改工具栏按钮的文字（演讲模板用「抽奖」），默认「点名」。
- **样式**：`deck.css` 带默认配色（`:root`，课件的配色）和所有通用样式；各模板的主题 CSS 在它之后加载，覆盖 `:root` 并加自己的版式。

## 扫码互动（live.js）

大屏显示二维码，观众（学生）用手机或平板的浏览器扫码打开 AgentDeck 官网的观众页 `https://agentdeck.xianqiao.wang/zh/live`（代码在 `packages/website/src/pages/live/`），作答结果实时回到大屏。

- **房间**：每个课件一个房间，按 `location.pathname` 存在 `localStorage['cw-live:<路径>']`（`room`、`key`、`numbers`），刷新或重开课件后二维码和编号都不变。二维码链接是 `…/zh/live#<room>.<key>`，`#` 后面不发给服务器。
- **传输**：复用 AgentDeck 的 Relay（`wss://agentdeck.xianqiao.wang/ws`），relayId 为 `live_<room>`。大屏连 endpoint 1，每台学生设备连 endpoint 2，`device_id` 是该设备在这个房间的固定 id（存在观众页的 localStorage）。全部用 ephemeral 消息（不落库、不 ack，只发给当时在线的设备）：广播的可靠消息要所有登记过的设备都 ack 才清除，学生离开会让消息一直挂着。Relay 不校验 Origin，`file://` 打开的课件也能连。
- **加密**：消息体是 `{ iv, c }`，用链接里的 32 字节密钥做 AES-GCM，Relay 只看到密文。解不开的消息直接丢弃。
- **消息**（加密前）：学生 → 大屏 `{ t: 'join', from }`、`{ t: 'data', from, value }`；大屏 → 学生 `{ t: 'present' }`（大屏连上时广播，在线设备回 `join`）、`{ t: 'hello', n }`（编号）、`{ t: 'view', html }`（要显示的界面）、`{ t: 'data', value }`、`{ t: 'notice', text }`（弹出提示）。大屏收到 `join` 就给该设备单发编号和当前界面，所以学生中途加入、刷新、大屏刷新都能恢复。观众页的类型定义在 `packages/website/src/pages/live/_protocol.ts`，两边要同步改。
- **编号**：设备第一次 `join` 或作答时按顺序分配，永久保存在房间里。点名从所有编号里抽，不管是否在线（手机切到别的应用就会断开）；抽中的设备在线时弹出「你被抽到了！」。
- **学生端界面**：`view` 的 HTML 放在观众页的 `<iframe sandbox="allow-scripts allow-forms">` 里运行（不同源，碰不到官网页面），带一套手机样式（按钮、输入框，`.selected`、`.right`、`.wrong`、`.primary`）。脚本里有 `live.send(value)`、`live.onmessage = (value) => {}`、`live.id`。同样的 HTML 再发一次不会重建 iframe，学生输了一半的内容不会丢。
- **组件**：`cw-poll`、`cw-responses`、`cw-wordcloud`、`cw-rating` 在所在页显示（`cw-enter` 事件）时发出自己的界面，用随机 id 区分答案；同一设备多次作答只算最后一次。`cwReset()` 清空统计并让学生端复位。`window.CwLive.room()` 返回房间（`url`、`count`、`numberOf(id)`、`on('join'|'data'|'status', fn)`、`show(html)`、`send(value, to?)`、`notice(text, to?)`、`qr(size)`），课件里的自定义互动可以直接用。
- **常驻栏（dock）**：`cw-reactions` 和 `cw-questions` 在课件加载时往 `docks` 里登记一段 HTML，之后发给手机的每个界面都是「当前界面 + `DOCK_BASE` + 各段 dock」（还没有界面时用「已加入，请看大屏幕」代替），所以表情和「提问」按钮在任何一页都能用。dock 的脚本往 `#dock` 里加按钮，用 `addEventListener('live', …)` 收消息，不占用界面自己的 `live.onmessage`。
- **表情**：手机发 `{ id, e }`（序号，250 ms 内只发一次），大屏在舞台右侧加一个上飘的 emoji（`#cw-reactions`，同时最多 40 个）。
- **提问**：手机发 `{ id, ask, k }`（`k` 由手机生成，大屏按它去重，观众页因 Relay 回报未送达重发时不会重复）、`{ id, vote: k, on }`、`{ id, sync: true }`（每次界面加载时，大屏只回给该设备完整列表和它点过赞的 `mine`）。列表变化后最多每 300 ms 广播一次 `{ id, qs }`。提问页显示时发出的界面只有一句 `window.liveOpenQuestions = true`，让 dock 直接打开提问面板。
- **词云**：手机每次发自己的全部词（最多 `max` 个），大屏按设备保存；大小写和空白不同的算同一个词。排版在所在页可见时进行（隐藏的页量不出尺寸），从大到小沿螺线找不重叠的位置，放不下的最小词丢掉。
- **二维码**：`qr()` 动态 `import('https://esm.sh/qrcode-generator@2.0.4')` 生成 SVG；加载失败时提示需要联网。
- `live.js` 的模板字符串里把结束标签写成 `${'</'}script>`（Biome 会去掉 `<\/script>` 的转义），内联成单文件后也不会提前结束脚本。

测试：本地运行 Relay（`mantou132/relay`）和官网（`pnpm run build && pnpm run start`），用 Playwright 打开课件和两个手机视口的观众页，把两边的 WebSocket 用 `routeWebSocket` 在 Node 里转到本地 Relay（`connectToServer()` 不能改地址）。也可以直接连线上的 Relay 和观众页（大屏 `CwLive.room().then((r) => r.url)` 拿到链接）。手机用普通的小视口（如 390×760），不要用 Playwright 的 `devices['iPhone …']`：Chromium 的移动端模拟会让 iframe 内的视口缩成三分之一。检查加入人数与编号、投票计数与公布答案、数字与文字作答、词云、评分、在别的页提问与点赞后提问页的排序和「正在回答」、表情上飘、观众刷新、大屏刷新后房间与编号不变、抽中弹窗。

前提：教室电脑和学生设备都要能上网，学生设备要能用浏览器扫码（学校平板可能被管控）；在真实的希沃一体机和学生平板上还没测过。
