# AgentDeck Client (`packages/agentdeck`)

AgentDeck 客户端前端工程，结合 Tauri 2 提供移动端（Android / iOS）及桌面端体验；扩展复用其 `agent/transport` 与部分元素。

## 代码导航

- 启动：`main.ts` → `app.ts`；未配置 Pairing ID 时打开 settings，否则打开 session-list。页面在 `pages/`，Stack 入口在 `navigation.ts`。
- 状态：`state/store.ts` 为单一全局 store；`state/sessions.ts` 会话生命周期；`state/app.ts` 启动、设置保存、重置与 transport 消息消费。
- 远端通信：`agent/transport.ts`（Relay 连接、host 握手）、`agent/api.ts`（远端接口）、`agent/relay-codec.ts`（RPC 消息与 Relay 载荷互转：加密、帧大小限制、二进制回复）、`agent/encryption.ts`（`adk1_` 端到端加密原语）。连接常量、存储键、`DATABASES`、`RENDER_CAPABILITIES` 统一在 `src/config.ts`。
- ACP 事件：`session/events.ts` 为 reducer，`session/turn.ts` 控制流式任务与权限决断。
- 持久化：`lib/database.ts` 为 drafts 与 in-flight 共用的 IndexedDB Store API；新增库或 store 在 `DATABASES` 声明，已有名称不得改动。
- 原生插件：推送 `agent/push.ts`（`tauri-plugin-fcm`）；语音 `lib/voice.ts`（`tauri-plugin-stt`，桌面端未注册，以 `voiceSupported` 判断）。

## 行为约束

- **会话**：新会话先建本地 pending session，首次发送才向远端 create；打开已有会话保留 close → load，手机端不能依赖页面卸载时 close。
- **设置**：自定义 Relay URL 只能通过扫描配对二维码设置，UI 不展示；手动修改 Pairing ID 即恢复默认 Relay。
- **草稿**（`composer/drafts.ts`）：仅 App 启用（composer 传入 draftKey），扩展不启用。新会话按 agent + 工作目录恢复，正式会话按 sessionId 恢复，跨 Relay 配置保留。提交交给 in-flight 持久化后清除；失败时回填且不覆盖新输入；删除会话和 settings 重置时清理。
- **渲染能力**：Markdown 中已闭合的 `agentdeck-chart`（内容为 ECharts option，JSON 无效时显示原文）、`agentdeck-preview`（内容为入口 HTML 绝对路径）和 `agentdeck-screen`（内容为截图 target）代码块由 `lib/markdown.ts` 转成元素。能力在 `RENDER_CAPABILITIES` 声明，经 `peer_attach` 告知 host；只有 Tauri 声明 `preview`。mermaid / latex / diff2html 元素较大，由 `lib/markdown.ts` 动态导入，不进首屏包。
- **实时画面**（`elements/screen.ts`）：卡片进入可见区域时截一帧作背景；实时页逐帧拉取 `screen_capture`（上一帧返回后再请求），离开页面即停止，出错保留重试。最近一帧按 target 存在模块内 store，卡片与实时页共用；设备框按 daemon 返回的形状绘制（手机圆角与挖孔、浏览器窗口；模拟手机的标签页用通用圆角的手机框）。
- **预览协议**：`crates/agentdeck/src/preview.rs` 注册 `agentdeck-preview` 协议，请求 emit 给 webview；`agent/preview.ts` 把 URL host 映射到入口所在目录，用 `file_read` raw 读取后以 base64 字符串调用 `preview_respond`（Android IPC 会把原始字节序列化成数字数组）。`file_read` 的 raw 与图片回复在 Relay 上走二进制帧，`relay-codec.ts` 解出的 `result.data` 为 `Uint8Array`：预览在调用 IPC 前转 base64，file-viewer 用 Blob URL 显示图片。Markdown 中的主机绝对路径图片也走此协议；扩展没有该协议，会在 file-viewer 中隐藏本地图片。单文件受 daemon `FILE_READ_MAX_BYTES`（8 MiB）限制。
- **弹层**：`elements/sheet.ts` 通过 tap-reflect 映射到 body 并保留样式作用域；`foldable.ts` 的 Sheet 在全局 Stack 变化时关闭。
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
