# AgentDeck Client (`packages/agentdeck`)

AgentDeck 客户端前端工程，结合 Tauri 2 提供移动端（Android / iOS）及桌面端体验；扩展复用其 `agent/transport` 与部分元素。

## 代码导航

- 启动：`main.ts` → `app.ts`；未配置 Pairing ID 时打开 settings，否则打开 session-list。页面在 `pages/`，Stack 入口在 `navigation.ts`。
- 状态：`state/store.ts` 为单一全局 store；`state/sessions.ts` 会话生命周期；`state/app.ts` 启动、设置保存、重置与 transport 消息消费。
- 远端通信：`agent/transport.ts`（Relay 连接、host 握手）、`agent/api.ts`（远端接口）、`agent/relay-codec.ts`（RPC 消息与 Relay 载荷互转：加密、帧大小限制、二进制回复）、`agent/encryption.ts`（`adk1_` 端到端加密原语）。连接常量、存储键、`DATABASES`、`RENDER_CAPABILITIES` 统一在 `src/config.ts`。
- ACP 事件：`session/events.ts` 为 reducer，`session/turn.ts` 控制流式任务与权限决断。
- 持久化：`lib/database.ts` 为 drafts 与 in-flight 共用的 IndexedDB Store API；新增库或 store 在 `DATABASES` 声明，已有名称不得改动。
- 原生插件：推送 `agent/push.ts`（`tauri-plugin-fcm`）；语音识别 `lib/speech-recognition.ts`（`tauri-plugin-stt`）与朗读 `lib/speech-synthesis.ts`（`tauri-plugin-tts`），均只在移动端注册，以 `speechSupported` 判断。

## 行为约束

- **会话**：新会话先建本地 pending session，首次发送才向远端 create；打开已有会话保留 close → load，手机端不能依赖页面卸载时 close。
- **会话配置**（`state/config-options.ts`）：所有 select 类型的 `configOptions`（mode / model / effort…）均可选，旧版 `modes` 作为 mode 一项。composer 只展示当前模型，点击打开带 Stack 的 Sheet（`elements/session-config.ts`）：根页为模型单选，其余配置点击后 push 单选页（均用 `tap-cell-group`，依赖 `patches/@mantou__tap-ui@*.patch`：group 可穿透样式、`label` 支持模板、无箭头行也触发 `onClick`；上游发版升级后删除 patch）。选择立即生效，远端失败时 toast 并回退。用户修改后按 agent 存整组选项到 `CONFIG_DEFAULTS_KEY`（未存过时以首个加载的会话为准），新会话直接沿用；create 后逐项应用，远端不支持的项或值跳过。settings 重置保留。
- **进行中回合**：回合存入 in-flight，重启后恢复等待回复。Relay 会丢弃过期未 ack 的消息，所以每次连上 host 都调 `agent_prompts_running` 对账（`settleLostTurns`）：daemon 已不在运行的回合就地结束、标未读，并 close → load 历史；旧 daemon 无此接口时保持等待。
- **下一句建议**：host 的 `agent_prompt_suggestion` 存入 `suggestionsBySession`（回合进行中到达的丢弃），新回合开始时清除。composer 输入为空时用它替换 placeholder，可直接发送，长按填入输入框继续编辑（tap-ui 的 `longPress` 指令，暂由 `patches/@mantou__tap-ui@*.patch` 提供，上游发版后删除该部分 patch；iOS 只在手势中弹键盘，所以松开时再聚焦）；只在内存中，不持久化。
- **语音对话**（`elements/voice-chat.ts`）：composer 无内容可发（含下一句建议）时发送按钮变为入口，会话页打开 Sheet；按住录音、松开发送、移出按钮松开取消，回合进行中按下只播报提示。消息带 `voiceChat: true`，daemon 追加 `<agentdeck-voice-chat/>` 标记，`remote_app` 系统提示要求 agent 见到它时在回复末尾写 `<!-- agentdeck-speech … -->` 注释（其他客户端也不渲染）；时间线隐藏这两者（`session/voice-chat.ts`、`lib/markdown.ts`），回合结束后朗读该注释（不读系统提示的非 Claude agent、旧 daemon 或没有注释时，朗读去掉 Markdown 的回复开头）。没说话松开不发送也不提示。权限请求在 Sheet 内显示并朗读。Sheet 显示时经 duoyun-ui 的 `DuoyunWakeLockBaseElement` 保持亮屏，锁屏后不可用。
- **daemon 版本**：host 在 `peer_attach` 返回 `version`（旧版没有，视为过旧），每次启动首次连上时与 `config.ts` 的 `MIN_DAEMON_VERSION` 比较，过旧则 Toast 提示升级。只在需要 App 与 daemon 一起升级时调高该常量。
- **设置**：自定义 Relay URL 只能通过扫描配对二维码设置，UI 不展示；手动修改 Pairing ID 即恢复默认 Relay。
- **草稿**（`composer/drafts.ts`）：仅 App 启用（composer 传入 draftKey），扩展不启用。新会话按 agent + 工作目录恢复，正式会话按 sessionId 恢复，跨 Relay 配置保留。提交交给 in-flight 持久化后清除；失败时回填且不覆盖新输入；删除会话和 settings 重置时清理。
- **渲染能力**：Markdown 中已闭合的 `agentdeck-chart`（内容为 ECharts option，JSON 无效时显示原文）、`agentdeck-preview`（内容为入口 HTML 绝对路径）和 `agentdeck-screen`（内容为截图 target）代码块由 `lib/markdown.ts` 转成元素。能力在 `RENDER_CAPABILITIES` 声明，经 `peer_attach` 告知 host；只有 Tauri 声明 `preview`。mermaid / latex / diff2html 元素较大，由 `lib/markdown.ts` 动态导入，不进首屏包。
- **实时画面**（`elements/screen.ts`）：卡片进入可见区域时截一帧作背景；实时页逐帧拉取 `screen_capture`（上一帧返回后再请求），离开页面即停止，出错保留重试。最近一帧按 target 存在模块内 store，卡片与实时页共用；设备框按 daemon 返回的形状绘制（手机圆角与挖孔、浏览器窗口；模拟手机的标签页用通用圆角的手机框）。
- **预览协议**：`crates/agentdeck/src/preview.rs` 注册 `agentdeck-preview` 协议，请求 emit 给 webview；`agent/preview.ts` 把 URL host 映射到入口所在目录，用 `file_read` raw 读取后以 base64 字符串调用 `preview_respond`（Android IPC 会把原始字节序列化成数字数组）；读取失败时回复带错误信息的 404 HTML 页（WebKit 对无类型的空 404 不触发 iframe `load`，Browser 会一直显示加载中）。`file_read` 的 raw 与图片回复在 Relay 上走二进制帧，`relay-codec.ts` 解出的 `result.data` 为 `Uint8Array`：预览在调用 IPC 前转 base64，file-viewer 用 Blob URL 显示图片。Markdown 中的主机图片也走此协议，相对路径在消息中按会话 cwd、在 file-viewer 中按文件所在目录解析；扩展没有该协议，会在 file-viewer 中隐藏本地图片。单文件受 daemon `FILE_READ_MAX_BYTES`（8 MiB）限制。
- **页面进场**：Stack 动画由 JS 逐帧驱动，重渲染会让它中途卡顿。更改列表、提交历史、diff、文件查看、文件浏览、实时画面与会话时间线等请求返回后才渲染的内容，在 `tap-page` 首次 `full-show`（完全进入视口且可见，即进场动画结束；这些页面关闭 `trackVisibility` 以免延迟）后才渲染，请求照常立即发出；会话只在需要远端加载时等待、实时画面只在没有缓存帧时等待，其余直接渲染。该事件暂由 `patches/@mantou__tap-ui@*.patch` 提供，上游发版后删除该部分 patch。
- **弹层**：Sheet 与页面一致用灰底（主题 `backgroundColor`），其中的卡片、代码块用 `lightBackgroundColor`。`elements/sheet.ts` 通过 tap-reflect 映射到 body 并保留样式作用域；`foldable.ts` 的 Sheet 在全局 Stack 变化时关闭。
- **Android**：`crates/agentdeck/gen/android/app/google-services.json` 禁止放入服务账号私钥。identifier / namespace / applicationId / MainActivity package 统一为 `com.mantou.agentdeck`（`tauri.conf.json`、`build.gradle.kts`、`MainActivity.kt`）。FCM token 经 `peer_attach` 同步，更新 token 不切换连接状态。
- **iOS**：原生资源在 `crates/agentdeck/`；更新应用图标时同步更新 `LaunchIcon`。

## 命名

- `pendingSession` / `pendingCreation`：尚未在远端创建的会话，本地 sessionId 为 `pending-session`，首次发送时由 `promotePendingSession` 转为正式会话。
- `pendingSessionIds`：正在执行任务的会话 ID 列表，和 `pendingCreation` 无关。
- `draft` / `ComposerDraft`：只指未发送的输入文字和附件。

## 常用命令

- `pnpm run dev` / `pnpm run build`：Rsbuild 开发服务器 / 生产打包。
- `pnpm run test`：Node 单元测试（`test/*.test.mjs`）。
- `pnpm run tauri android dev`：Android 联调。
