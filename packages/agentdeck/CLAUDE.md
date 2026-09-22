# AgentDeck Client (`packages/agentdeck`)

AgentDeck 客户端前端工程，结合 Tauri 2 提供移动端（Android / iOS）及桌面端体验。

## 关键入口与目录结构

- `src/main.ts` → `src/app.ts`：加载主题、挂载 App、启动 transport；未配置 Relay ID 时打开 settings，否则打开 session-list。
- `src/pages/`：`session-list`、`session`、`settings` 三页面；settings 提供 Relay 获取指南 sheet，首次未配对使用时自动展示一次；`navigation.ts` 提供 Stack 入口，通过 property 传递 sessionId。
- `src/state/store.ts`：单一全局状态与基础更新；`state/sessions.ts` 管理会话生命周期，`state/app.ts` 负责启动、设置、重置及 transport 消息消费；`state/modes.ts` 执行模式切换。
- `src/agent/`：`transport.ts` 管理 Relay 连接与 host 握手，`api.ts` 提供远端接口，`rpc.ts` 负责双向流式通信，`encryption.ts` 提供由 ID 识别的可选端到端加密；`config.ts` 保存配置读取与连接常量。
- `src/agent/push.ts`：移动端 FCM 注册与同步；使用 `tauri-plugin-fcm` 插件管理通知权限、渠道和 token 刷新。
- `src/session/`：`types.ts` 为会话类型，`events.ts` 为 ACP reducer，`groups.ts` / `timeline.ts` 为列表与消息分组，`turn.ts` 控制流式任务和权限决断，`modes.ts` 适配 ACP 模式信息。
- `src/elements/`：
  - `composer.ts`：管理输入和附件。
  - `session-timeline.ts`：展示消息并通过 `Sheet.open` 打开过程弹层。
  - `process-detail.ts`：按 sessionId / groupId 从 store 读取过程分组，使用内部 Stack 导航到 process-step。
  - `process-step.ts`：按 sessionId / groupId / itemId 自行订阅详情更新。
  - `attachment.ts` / `attachment-preview.ts`：展示附件。
  - `file-viewer.ts`：通过 `file_read` 浏览远端文件。
  - `file-browser.ts`：通过 `file_browse` 浏览远端目录与文件，在新建会话弹窗及独立页面栈中复用。
  - `sheet.ts`：封装普通弹层及内部 sheet-layer，通过 tap-reflect 映射到 body 并保留样式作用域。
- `src/composer/`：`files.ts` 读取文件并检查限制，`references.ts` 管理粘贴引用与编辑范围；`lib/` 提供 Markdown、diff2html 输入转换与路径显示；`follow-bottom.ts` 提供 session、process-detail、process-step 共用的滚动跟底逻辑。
- `src/styles/`：`tailwind.css` 共享主题 token，`theme.ts` 桥接 Tap UI。

## 运行与平台约束

- 新会话先建本地 draft，首次发送才向远端 create；打开已有会话保留 close → load，手机端不能依赖页面卸载时 close。
- Android 客户端配置在 `crates/agentdeck/gen/android/app/google-services.json`，禁止放入服务账号私钥。FCM token 经 `peer_attach` 同步，更新不切换连接状态，通知由 FCM 在后台显示。
- Android identifier / namespace / applicationId / MainActivity package 保持 `com.mantou.agentdeck` 一致；对应 `crates/agentdeck/tauri.conf.json`、`crates/agentdeck/gen/android/app/build.gradle.kts` 和 `MainActivity.kt`。
- iOS 原生资源位于 `crates/agentdeck/`；更新应用图标时需同步更新 `LaunchIcon`。

## 常用命令

- `pnpm run dev`：启动 Rsbuild 前端本地开发服务器。
- `pnpm run build`：Rsbuild 生产环境打包。
- `pnpm run test`：Node 单元测试 (`test/*.test.mjs`)。
- `pnpm run tauri android dev`：原生应用 Android 联调开发。
