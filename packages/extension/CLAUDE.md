# AgentDeck Extension (`packages/extension`)

基于 Extension.js 与 Manifest V3 构建的浏览器扩展（支持 Chrome Side Panel 与 Firefox Sidebar）。

## 架构与核心文件

- `pages/agent-panel.html` & `pages/agent-panel.js`：核心交互面板，Side Panel 与 DevTools 共同复用。
- `shared/agent-storage.js`：基于 `chrome.storage.local` 适配 `relay-client-ts` 的持久化存储（RelayStore）。
- `shared/agent-session-store.js`：本地会话状态与配置持久化。
- **通信架构**：直接复用 `agentdeck/agent/transport`（`agentApi` / `startTransport`），经 `relay-client-ts` 接入 Relay 服务与 Daemon 通信。

## 平台与构建约束

- **CSP 限制**：严禁远程脚本；Prism 代码高亮与 Diff 样式均使用 `public/vendor/` 本地镜像。
- **多端构建**：`pnpm run build` 同时打包 Chromium 与 Firefox 产物至 `dist/`。

## 常用命令

- `pnpm run dev`：启动 Chrome 扩展调试环境。
- `pnpm run build`：构建 Chromium 与 Firefox 扩展（`dist/chrome`、`dist/firefox`）。
- `pnpm run test`：运行单元测试。
