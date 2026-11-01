# AgentDeck Extension (`packages/extension`)

基于 Extension.js 与 Manifest V3 构建的浏览器扩展（支持 Chrome Side Panel 与 Firefox Sidebar），源码为 TypeScript（manifest 与 HTML 直接引用 `.ts` 入口）。

处于维护模式：只修 bug、跟随 App 共享代码的改动，新功能优先做在 App。

## 架构与核心文件

- `pages/agent-panel.html` & `pages/agent-panel.ts`：核心交互面板，Side Panel 与 DevTools 共同复用；状态与消息类型在 `pages/agent-panel/types.ts`。
- `shared/agent-storage.ts`：基于 `chrome.storage.local` 适配 `relay-client-ts` 的持久化存储（RelayStore）。
- `shared/agent-session-store.ts`：本地会话状态与配置持久化。
- **类型**：`agentdeck/*` 经 `tsconfig.json` 的 `paths` 指向 App 源码，API 与附件等类型直接复用 App 定义；`extension-env.d.ts` 由 Extension.js 生成。
- **通信架构**：直接复用 `agentdeck/agent/transport`（`agentApi` / `startTransport`），经 `relay-client-ts` 接入 Relay 服务与 Daemon 通信。
- **附件**：读取、线上格式、消息与历史中的附件解析复用 `agentdeck/attachment/*`，粘贴引用复用 `agentdeck/composer/references`（规则见 App 文档）；扩展没有 file-viewer，主机文件只显示为附件条。
- **等待用户输入**：`agent_permission_request` 显示权限卡片，选择或取消都经 `agent_user_input_respond` 作答；面板卸载时取消所有未作答的权限。面板没有问题卡片，收到 `agent_elicitation_request` 即以 decline 作答（Claude 视为用户跳过，继续执行）。
- **浏览器上下文**：建会话时 `panelContext` 携带当前 tab 的 `tabId` 与 `url`；Daemon 经本机 browser4agent 核实是同一浏览器后才注入浏览器提示词；扩展渲染能力提示词始终注入。

## 平台与构建约束

- **CSP 限制**：严禁远程脚本；Prism 代码高亮与 Diff 样式均使用 `public/vendor/` 本地镜像。
- **图标**：只提供 32（工具栏用，图形裁紧）与 128（四周 16px 透明边距），其他尺寸由浏览器缩放。
- **多端构建**：`pnpm run build` 同时打包 Chromium 与 Firefox 产物至 `dist/`。

## 常用命令

- `pnpm run dev`：启动 Chrome 扩展调试环境。
- `pnpm run build`：构建 Chromium 与 Firefox 扩展（`dist/chrome`、`dist/firefox`）。
- `pnpm run test`：运行单元测试；`test/register.mjs` 为无扩展名导入补 `.ts` 并把 `agentdeck/*` 指向 App 源码，由 Node 直接剥离类型运行。
