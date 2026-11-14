# AgentDeck Client (`packages/agentdeck`)

AgentDeck 客户端前端工程，结合 Tauri 2 提供移动端（Android / iOS）及桌面端体验；扩展复用其 `agent/transport` 与部分元素。

## 代码导航

- 启动：`main.ts` → `app.ts`；未配置 Pairing ID 时打开 settings，否则打开 session-list（宽屏时在侧栏，见下方宽屏双栏）。页面在 `pages/`，Stack 入口在 `navigation.ts`。
- 状态：`state/store.ts` 按变化频率拆成三个 store：`agentdeckStore`（设置、连接）、`sessionsStore`（会话列表与按会话聚合的 `runtimes`，即 `SessionRuntime`：加载状态 `load`、进行中回合 `turn`、错误、配置、权限、问题、建议等）、`messagesStore`（消息，随流式增量变化，只有显示消息的元素连接；Stack 下层页面仍挂载，所以列表页不连）。删除会话即删 runtime 与消息。`state/sessions.ts` 会话生命周期；`state/app.ts` 启动、设置保存、重置与 transport 消息消费。
- 远端通信：`agent/transport.ts`（Relay 连接、host 握手）、`agent/api.ts`（远端接口）、`agent/relay-codec.ts`（RPC 消息与 Relay 载荷互转：加密、帧大小限制、二进制回复）、`agent/encryption.ts`（`adk1_` 端到端加密原语）、`agent/relay-store.ts`（Relay outbox 与接收游标，存 IndexedDB，与扩展共用；localStorage / chrome.storage 配额放不下带附件的 prompt，启动时删除旧的 `relay-client.v1`）。连接常量、存储键、`DATABASES`、`SUPPORTED_SKILLS` 统一在 `src/config.ts`。
- ACP 事件：`session/events.ts` 为 reducer，`session/turn.ts` 控制流式任务；等待用户输入（权限请求与问题）的状态在 `state/user-input.ts`，问题（form elicitation）的 schema 解析在 `session/elicitation.ts`，卡片为 `elements/elicitation.ts`。
- 附件：`attachment/`（与扩展共用，不依赖 App 的 i18n 与状态，文案由调用方传入）。`types.ts` 为 `Attachment`；`read.ts` 读取选择或粘贴的文件；`prompt.ts` 转成 `agent_prompt` 的线上格式；`message.ts` 处理消息与历史中的附件（ACP 图片、内联 data 图片、上传到主机的文件链接）。卡片与预览元素在 `elements/attachment*.ts`，粘贴引用与草稿在 `composer/`。
- 持久化：`lib/database.ts` 为 drafts、in-flight 与 Relay 存储共用的 IndexedDB Store API；新增库或 store 在 `DATABASES` 声明，已有名称不得改动。
- 原生插件：推送 `agent/push.ts`（`@mantou/tauri-plugin-fcm`）；语音识别 `lib/speech-recognition.ts`（`tauri-plugin-stt`）与朗读 `lib/speech-synthesis.ts`（`tauri-plugin-tts`），均只在移动端注册，以 `speechSupported` 判断；日历事件见下方事件卡片（`tauri-plugin-add-to-calendar`，以 `calendarSupported` 判断）。

## 行为约束

- **会话列表**：按 cwd 分组，worktree 会话归入 `mainCwd`，Claude 桌面版的 `…/Claude/scratch-workspaces/…` 合为「这台电脑」。
- **会话配置**（`state/config-options.ts`）：select 类型的 `configOptions` 都可选（旧版 `modes` 作为 mode）。修改立即生效，失败回退；按 agent 存到 `CONFIG_DEFAULTS_KEY` 供新会话沿用（create 后逐项应用，不支持的跳过），settings 重置保留。
- **进行中回合**：回合存入 in-flight，重启后恢复等待回复。Relay 会丢弃过期未 ack 的消息，所以每次连上 host 都调 `agent_prompts_running` 对账（`settleLostTurns`）：daemon 已不在运行的回合就地结束、标未读，并 close → load 历史；旧 daemon 无此接口时保持等待。
- **等待用户输入**：权限请求与问题只在本设备的回合进行中显示（按 `requestId` 去重），用 `agent_user_input_respond` 作答，失败时恢复可答。回合结束、取消或会话关闭由 host 取消，App 只清本地状态；重连后由 `settleLostTurns` 补回。
- **问题卡片**（`elements/elicitation.ts`）：存 runtime 的 `elicitations`（仅内存），嵌在提问的工具调用之后；跳过为 decline，未答的在回合结束时标为已取消。
- **下一句建议**：`agent_prompt_suggestion` 存 runtime 的 `suggestion`（回合进行中到达的丢弃，新回合清除），输入为空时作为 placeholder 可直接发送，长按填入输入框。
- **斜杠命令**：`available_commands_update` 按 agent 存入 `commandsByAgent` 并持久化到 `CONFIG_DEFAULTS_KEY`，pending session 也有候选；选中后作为普通文本发送。
- **分支会话**：只对 `claude-acp` 开放（其他 Agent 不支持分支点）。用户消息长按菜单（`tap-callout`）的「从这里分支」以之前最近的 agent 消息 `messageId` 调 `agent_session_fork`，并把该用户消息存为新会话草稿。
- **发送到**（`elements/send-to.ts`）：选中回复文字时原生选择菜单（`tauri-plugin-selection-menu`）只有「发送到…」，引用到当前、新建或其他会话的草稿，只引用不发送。
- **子代理会话**（`elements/subagent-card.ts`、`pages/subagent.ts`）：子代理不建 runtime，信息记在根会话 runtime 的 `subagents`；带 `childSessionId` 的事件只写入该子代理的消息，不改根会话的任何状态，也不进会话列表。子代理页只读（可取消时可停止），权限与问题挂在根会话。重新 load 根会话时先清掉子代理，由回放重建。
- **语音对话**（`elements/voice-chat.ts`、`session/voice-chat.ts`）：composer 无可发内容时发送按钮变为入口，按住录音、松开发送，移出按钮可按词撤销。消息带 `voiceChat: true`，回合结束后朗读回复末尾的 `<!-- agentdeck-speech … -->`（没有时读回复开头），时间线隐藏标记与注释。Sheet 拖拽会抢占指针，按住期间在 window 捕获阶段拦截 move；显示时保持亮屏。
- **连接错误**：自动重连期间（`isConnecting()`）不显示连接与列表错误（后台恢复时冻结计时器集中超时产生的错误在连上后清除），由顶部圆点表示；手动重连与下拉刷新只跳过退避等待。
- **daemon 版本**：host 在 `peer_attach` 返回 `version`（旧版没有，视为过旧），每次启动首次连上时与 `config.ts` 的 `MIN_DAEMON_VERSION` 比较，过旧则 Toast 提示升级。只在需要 App 与 daemon 一起升级时调高该常量。
- **附件**：图片压缩后内联，256 KB 内的文本内联，其他文件（≤ 5 MB，受 Relay 单帧限制）以 base64 的 `file` 发给 daemon 存到主机，Agent 自己读。Claude 历史回放为 `[@name](file://…/agentdeck-attachments/…)`，时间线还原成附件：App 点击打开 file-viewer，再次发送时作为 `resource` 链接。
- **分享接收**（`state/share.ts`、`crates/agentdeck/src/share.rs`）：分享内容都作为附件写入共享目录，由 `share_take` 取走。Android 由 `MainActivity.kt` 接收；iOS 由 Share Extension（App Group `group.com.mantou.agentdeck`）写入后以 `agentdeck://share` 唤起（扩展不能直接用 `UIApplication`，经响应链调用）。随后打开新建会话的目录面板，确认后追加进草稿。
- **设置**：自定义 Relay URL 只能扫配对二维码设置，手改 Pairing ID 即恢复默认。握手成功后按 host 记录到 `PAIRING_HISTORY_KEY`（含 hostname、customAgents 与上次选的 Agent），settings 重置保留。换 host 清空远端状态；只换 Agent 时保留 runtime 与进行中回合。更多设置 Sheet 在 `elements/more-settings.ts`；反馈在系统浏览器打开预填版本信息的 GitHub issue。
- **草稿**（`composer/drafts.ts`）：仅 App 启用（composer 传入 draftKey），扩展不启用。新会话按 agent + 工作目录恢复，正式会话按 sessionId 恢复，跨 Relay 配置保留。提交交给 in-flight 持久化后清除；失败时回填且不覆盖新输入；删除会话和 settings 重置时清理。
- **渲染能力**：已闭合的 `agentdeck-*` 代码块由 `lib/markdown.ts` 转成元素（mermaid / latex / diff2html 动态导入）。能力在 `SUPPORTED_SKILLS` 声明，按 settings 开关（`SKILL_TOGGLES_KEY` 存用户改过的，其余按 `DEFAULT_OFF_SKILLS`，如 `job`、`travel` 默认关）与依赖（`SKILL_REQUIRES`，`app` 依赖 `preview`）过滤后经 `peer_attach` 告知 host，修改立即重新 attach。只有 Tauri 声明 `preview` / `app`，只有移动端声明 `event`；`job`（求职）与 `travel`（旅行规划）是流程 skill，不对应代码块。
- **Skill 文件**：`skills/<能力>/` 是交给 Agent 的 skill（`app` 另带 Gem + Tap UI 移动端模板，`job` 工作区 `~/JobSearch/`，`travel` 每次行程一个 `~/Trips/<YYYY-MM>-<地点>/`；mermaid / LaTeX 写在 chart skill 里），构建时由 `rsbuild.config.ts` 打成独立的 `dist/skills.json`（不进 JS，随热更新发布），代码里只有内容哈希 `__SKILLS_HASH__`（`src/skills.ts`；只在启动构建时读一次，dev 改 skill 要重启）。`peer_attach` 只带 `skills: { hash, enabled }`，host 回复 `skillsMissing` 时才 fetch `skills.json` 并 `skills_install`，之后才算 connected；安装失败只记日志、照常 connected（skill 非必需，下次 attach 重试）；流程 skill 用 `{{LEARNED_PATH}}` 指向 host 上跨版本保留的笔记。不参与 tsc。扩展不声明 skill。
- **交互内容**（`elements/widget.ts`）：`agentdeck-widget` 的 HTML 与脚本直接渲染在回复中。agent 输出视为可信，不用 iframe：每块一个 shadow root 只为隔离样式，脚本以 `new Function` 执行并注入 Preact / htm 与 `agentdeck`；控件 class 清单与 `skills/widget` 保持一致。`agentdeck.send()` 需要用户激活，且所在回复后已有用户消息时被拦截。
- **新会话卡片**（`elements/new-session.ts`）：`agentdeck-session` 为 `{ title, prompt, cwd? }`，点击以同一 agent 建 pending session 并立即发送 prompt（目录依次取 `cwd`、worktree 的 `mainCwd`、当前 cwd）。
- **事件卡片**（`elements/event.ts`）：`agentdeck-event` 经 `tauri-plugin-add-to-calendar` 打开系统编辑界面，App 不读写日历，已添加的按块原文记在 `EVENTS_ADDED_KEY`（Android 打开即记，iOS 保存后才记）。
- **地图**（`elements/map.ts`）：MapLibre + OpenFreeMap。maplibre-gl 的 dist 由 `rsbuild.config.ts` 拷到 `/maplibre/` 运行时导入，worker 地址需显式设置（`tauri://` 下无法推导）。卡片渲染一次截图后释放 WebGL 上下文，全屏页在进场动画结束后才创建地图。
- **实时画面**（`elements/screen.ts`）：实时页逐帧拉取 `screen_capture`（上一帧返回后再请求），离开即停；最近一帧按 target 缓存，设备框按 daemon 返回的形状绘制。
- **预览协议**：`crates/agentdeck/src/js_protocol.rs` 与 `lib/js-protocol.ts` 是不含业务的通用 JS 协议层（Android IPC 会把字节序列化成数字数组，所以 IPC 前转 base64）；`agent/preview.ts` 把 host 映射到入口目录并用 `file_read` raw 读取，失败回带错误的 404 HTML（WebKit 对空 404 不触发 iframe `load`）。Markdown 中的主机图片也走此协议。`file_read` 是 ephemeral，自动重连期间先等连上，断线后重读一次，每次最多等 20 秒（Android WebView 30 秒放弃）。单文件上限 8 MiB；file-viewer 分享按 8 MiB 分段读取整个文件。扩展没有该协议。
- **保存的应用**（`state/saved-apps.ts`、`elements/app.ts`、`crates/agentdeck/src/saved_apps.rs`）：`agentdeck-app` 卡片可预览或保存到手机（整个目录写到本地，iOS 在 App Group 的 `apps/<id>/`），在更多设置中管理，settings 重置不动。Rust 的 `agentdeck-app` 协议以 `id` 为 host 从磁盘提供文件；打开时主窗口导航过去（iOS 重启会清空 iframe 中跨域页面的存储），请求 `/__agentdeck/exit` 时返回。桌面入口打开 `agentdeck://app/<id>`（deep-link）：Android 用 `tauri-plugin-pin-shortcut` 固定快捷方式，iOS 用小组件（`gen/apple/WidgetExtension`）；冷启动的链接在渲染 AgentDeck 前打开。应用显示时收到分享或推送点击会退出回 AgentDeck 再处理。
- **内置浏览器安全区**：iframe 跨域读不到 App 的 inset，`lib/safe-area.ts` 用当前 inset 生成脚本源码（页面加载时取值）；网页浏览不注入。`agentdeck-preview` 语言后带 `edge-to-edge` / `headerless` 时以 `floatheader` / `headerless` 打开预览，并使用单独的预览 host，只有该 host 的 HTML 在 doctype 后内联同一脚本；普通预览在 navbar 下方，不注入。
- **页面进场**：Stack 动画由 JS 逐帧驱动，重渲染会让它中途卡顿。更改列表、提交历史、diff、文件查看、文件浏览、实时画面与会话时间线等请求返回后才渲染的内容，在 `tap-page` 首次 `full-show`（完全进入视口且可见，即进场动画结束；这些页面关闭 `trackVisibility` 以免延迟）后才渲染，请求照常立即发出；会话只在需要远端加载时等待、实时画面只在没有缓存帧时等待，其余直接渲染。
- **手势**：对齐 iOS，一次触摸只锁定一个方向，cell 横滑与下拉刷新互斥。
- **页面布局**：内容交给 `tap-page` 自己滚动，不另包滚动容器，这样内容能从 header / footer 下方滚过；需要滚动元素时用 `tap-page` 的 `scrollElement`（会话页跟随到底部）。slot 进 header / footer 的自定义栏用半透明背景加 `backdrop-blur-lg`（`tap-navbar` 自带）。地图、实时画面、文件浏览为固定内容，不滚动。
- **宽屏双栏**（`state/layout.ts`、`app.ts`）：宽 ≥ 800 且高 ≥ 500，或双屏横跨铰链时分栏，会话列表在左、全局 Stack 在右。所有页面推入同一个全局 Stack，宽窄切换时已开页面保留；双栏中选会话以 `Stack.replace(…, { keep: 1 })` 替换。双栏时 Sheet 不用多档 snap。
- **弹层**：Sheet 灰底，其中卡片用 `lightBackgroundColor`。`Sheet.open` 的 body 由 patch 改为渲染到 light DOM 再经 slot 投影：WebKit 27 不把 shadow root 中的 `@scope` 规则应用到被 slot 进内层 shadow host 的元素（[Bug 327165](https://bugs.webkit.org/show_bug.cgi?id=327165)），Gem light DOM 元素样式会失效。
- **点击推送**（`agent/push.ts`）：fork 的 `@mantou/tauri-plugin-fcm` 暂存点击通知的 `data`，前端经 `takeOpenedNotification` 取走；`host` 与当前配对的 `pushHostKey` 不同则只打开 App，Agent 不同先切换。
- **Android**：`crates/agentdeck/gen/android/app/google-services.json` 禁止放入服务账号私钥。identifier / namespace / applicationId / MainActivity package 统一为 `com.mantou.agentdeck`（`tauri.conf.json`、`build.gradle.kts`、`MainActivity.kt`）。FCM token 经 `peer_attach` 同步，更新 token 不切换连接状态。
- **iOS**：原生资源在 `crates/agentdeck/`；更新应用图标时同步更新 `LaunchIcon`。tauri 会改写 `project.pbxproj`，它已与 `project.yml` 不一致，不能直接用 xcodegen 重新生成覆盖：改 target 时同步 `project.yml`，在临时目录生成后把增量合并进 pbxproj。tauri 只给名字含 `_iOS` 的 App target 设签名团队、bundle ID 与版本，Share Extension 的团队写死为同一团队，版本由其构建前脚本从 App 的 Info.plist 拷贝。

- **tap-ui patch**：`patches/@mantou__tap-ui@*.patch` 带入尚未发版的改动（目前为 Sheet 投影与 `lib/image.js` 的 SVG 栅格化修复），已同步改 tap-ui 源码，上游发版后删除。

## 命名

- `pendingCreation`：尚未在远端创建的会话（pending session），本地 sessionId 为 `pending-<uuid>`，以 `pendingCreation` 判断而非 ID；首次发送时由 `promotePendingSession` 转为正式会话；页面先切到正式 ID 再调用 `discardPendingSession` 清理，避免中间一帧找不到会话而重建页面。创建中取消或关闭即清掉其 `turn`，创建返回后发现 `turn` 已不是本次的就关闭远端会话。
- `turn`：runtime 中本设备进行中的回合；pending session 创建期间也有 `turn`，只是没有 `rpcId`。
- `draft` / `ComposerDraft`：只指未发送的输入文字和附件。

## 常用命令

- `pnpm run dev` / `pnpm run build`：Rsbuild 开发服务器 / 生产打包。
- `pnpm run test`：Node 单元测试（`test/*.test.mjs`）。
- `pnpm run test:e2e`：Playwright 主流程 e2e（`e2e/`），连真实 host，只在本地手动跑；`E2E_PAIRING_ID`（必填，可用审核机的）与 `E2E_CHROME_PATH`（默认系统 Chrome）从环境或 gitignored 的 `.env.local` 读取。Free agent 上删除会话不生效，每次运行会在 host 上留下一个会话。
- `pnpm run tauri android dev`：Android 联调。
