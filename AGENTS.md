# Agent Rules

1. 遇到没有明确的事情不要自由发挥，应该询问确定。
2. 始终根据目的站在全局视角下考虑问题，如果有更简洁的方案应该提出来。
3. 结构、入口或构建方式变化时同步更新本文档及对应子目录 CLAUDE.md，仍要保持精简；外层只保留导航、公用运行约束和全局开发规范，各子项目的实现细节下沉到各自目录。
4. 只处理有实际依据的场景；不为不会发生的情况增加防御逻辑或不必要的复杂度。
5. 测试文件是服务于业务代码的，不要为了测试去明显增加业务代码复杂度。

# 项目导航

monorepo（pnpm workspace + Cargo workspace）：

- `packages/agentdeck/`：客户端前端、移动端适配与本地持久化，见 [CLAUDE.md](packages/agentdeck/CLAUDE.md)。
- `packages/extension/`：浏览器扩展（Chrome & Firefox），见 [CLAUDE.md](packages/extension/CLAUDE.md)。
- `packages/website/`：官网（`https://agentdeck.xianqiao.wang`），Gemkit，中英双语，见 [CLAUDE.md](packages/website/CLAUDE.md)。
- `crates/daemon/`：后台守护服务 `agentdeckd`（CLI、存储布局、Relay 配置、防睡眠、重置），见 [CLAUDE.md](crates/daemon/CLAUDE.md)。
- `crates/agentdeck/`：Tauri 2 原生入口、配置和 Android / iOS 原生工程。
- `docs/`：内部资料，如发布流程 `release.md`、竞品对比 `comparison.md`、云端无头环境部署 `cloud-setup.md`。
- `.github/workflows/`：`ci.yml`（push main 与 PR 的全局检查，Rust 跑在 macOS，因 Tauri 需前端产物与系统 WebView）、`release.yml`（Daemon / 扩展发布）、`release-android.yml`、`release-ios.yml`、`bump-packages.yml`。
- `biome.json`：格式化与 Lint 配置。

# 全局运行与通信约束

实现细节见 `packages/agentdeck/CLAUDE.md` 与 `crates/daemon/CLAUDE.md`。

- **Relay**：App 经 `relay-client-ts` 连 endpoint 2，agentdeckd 用 endpoint 1，地址见 `packages/agentdeck/src/config.ts`。官网 `/live` 也用同一 Relay（relayId `live_*`，只发 ephemeral），与配对无关。
- **E2EE**：普通 UUID 明文；`adk1_` 配对 ID 只留在两端，Relay 使用派生路由 ID。加密层不保存消息状态，不允许自动退回明文。
- **会话状态**：新会话先建本地 pending session，首次发送才 create。运行状态、未作答请求与 `(epoch, seq)` 事件日志由 daemon 持有；App 离开页面或切换 host 只退订，只有用户显式关闭或删除才 `agent_session_close`。
- **连接**：host 握手成功才算 connected；host 离线时进入 `unavailable`，运行中回合保留，重连后经 `agent_active_sessions` 对账并多端同步。
- **投递**：只有 `file_read`、`screen_capture` 与 `host_reconnected` 走 Relay ephemeral，其余一律可靠投递。
- **重置**：异常必须保留重试或 settings 重置入口。重置清理本地 Relay 消息状态，保留配对和设备标识；不删除远端历史，不停止远端运行中的任务。

# 前端开发（Gem 规范）

`packages/agentdeck`、`packages/extension` 统一使用 Gem、Tap UI / Duoyun UI 和最新 ECMAScript 语法。写元素前先读 `packages/agentdeck/node_modules/@mantou/gem/AGENTS.md`。

- `unplugin-gem` 自动导入 Gem 成员与项目自定义元素，HMR 由插件处理，不配置 `preEntry`。
- 布局优先 Tailwind（Shadow DOM 内不可用）。Light DOM 用 `:scope`，Shadow DOM 用 `:host`；通过 `css` / `@adoptedStyle` 共享样式，避免模板内联样式。
- 元素文件名为去前缀的标签名，继承 `GemElement`，使用 ES 装饰器（2023-11），不用已弃用生命周期，不额外声明自定义元素类型。
- 输入用 `@property` / attribute 装饰器，元素内部不修改输入，attribute 不赋默认值；内部数据用 `createState`，CSS 状态用 `@state`，优先 `#` 私有字段。
- `@memo` / `@effect` 用依赖数组，effect 返回清理函数；`@template` 支持 `v-if`、ref 和属性展开。
- 全局状态用 `createStore` / `@connectStore`；事件用 `@emitter`，跨 Shadow DOM 用 `@globalemitter`；part / slot 用静态装饰字段。
- 对象参数内联类型过长时提取为命名类型；不加无必要的 `void`，错误处理保持显式；Toast 文案简短。

# 常用命令

提交前依次运行（Husky + lint-staged 会对暂存文件跑 Biome）：

- `pnpm run lint`：Biome 修复 + 各包 tsc。
- `cargo check`
- `pnpm -r test`
- `cargo test -p agentdeck-daemon`

# 发布

推送 `vX.Y.Z` tag 触发全部发布；签名、前端热更新、`distribution/whatsnew/` 更新说明等细节见 [docs/release.md](docs/release.md)。
