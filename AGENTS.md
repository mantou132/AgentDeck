# Agent Rules

1. 遇到没有明确的事情不要自由发挥，应该询问确定。
2. 始终根据目的站在全局视角下考虑问题，如果有更简洁的方案应该提出来。
3. 结构、入口或构建方式变化时同步更新本文档及对应子目录 CLAUDE.md，仍要保持精简；外层只保留导航、公用运行约束和全局开发规范，各子项目的实现细节下沉到各自目录。
4. 只处理有实际依据的场景；不为不会发生的情况增加防御逻辑或不必要的复杂度。
5. 测试文件是服务于业务代码的，不要为了测试去明显增加业务代码复杂度。

# 项目导航

项目为 monorepo 结构（pnpm workspace + Cargo workspace）：

- `packages/agentdeck/`：AgentDeck 客户端前端工程、移动端适配与本地持久化。详情参见 [`packages/agentdeck/CLAUDE.md`](file:///Users/mantou/agent-deck/packages/agentdeck/CLAUDE.md)。
- `packages/extension/`：AgentDeck 浏览器扩展（Chrome & Firefox）。详情参见 [`packages/extension/CLAUDE.md`](file:///Users/mantou/agent-deck/packages/extension/CLAUDE.md)。
- `packages/website/`：官网落地页（`https://agentdeck.xianqiao.wang`），Gemkit 应用，中英双语，部署在 Vercel。详情参见 [`packages/website/CLAUDE.md`](file:///Users/mantou/agent-deck/packages/website/CLAUDE.md)。
- `crates/daemon/`：独立后台守护服务 `agentdeckd`，含 CLI、统一存储布局、Relay 配置、防自动睡眠与本地状态重置。详情参见 [`crates/daemon/CLAUDE.md`](file:///Users/mantou/agent-deck/crates/daemon/CLAUDE.md)。
- `crates/agentdeck/`：Tauri 2 原生入口、配置和 Android / iOS 原生工程；`src/frontend_update.rs` 为前端热更新（见下方发布）。
- `docs/`：内部资料，如竞品对比 `comparison.md`。
- `.github/workflows/`：
  - `ci.yml`：push 到 main 与 PR 时运行全局检查（Biome、tsc、前端与扩展测试和构建、`cargo check` 与 Daemon 测试）；Tauri crate 编译需要前端构建产物与系统 WebView，所以 Rust 检查跑在 macOS。
  - `release.yml`：Daemon 多平台构建、npm OIDC 分发、扩展打包与 GitHub Release / 商店发布流水线（支持 tag 推送触发与 `workflow_dispatch` 手动测试）；npm 实现见 `crates/daemon/CLAUDE.md`。
  - `release-android.yml`：Android 签名构建与 Google Play 发布。
  - `release-ios.yml`：iOS 签名构建；push 到 main 上传 TestFlight（版本号为最新 tag 的下一个 patch）并分发给公开链接所在的外部测试组「朋友」，tag 提交 App Store 发布；商店资料与首次上架清单见 `distribution/appstore/`。
  - `bump-packages.yml`：版本自动递增与包依赖管理。
- `biome.json`：代码风格格式化与 Lint 配置。

# 全局运行与通信约束

- **Relay 连接约定**：App 经 `relay-client-ts` 连接 Relay endpoint 2，agentdeckd 使用 endpoint 1；地址见 `packages/agentdeck/src/config.ts`。
- **端到端加密（E2EE）**：普通 UUID 保持明文；`adk1_` 配对 ID 只留在两端，Relay 使用派生路由 ID。加密层只负责消息加解密，不保存消息状态；不允许自动退回明文。
- **会话状态机制**：新会话先建本地待创建会话（App 中称 pending session），首次发送才向远端 create；打开已有会话保留 close → load，手机端与扩展端不能依赖页面卸载时 close。
- **连接与重试**：host 握手成功才算 connected，普通重连保留 SDK 消息状态。短请求有超时，prompt 不套固定短时限；load 等事件流调用与 `peer_attach` 从收到 host 的最后一帧起计时（重连后 Relay 先补发积压消息）。权限请求与问题由 daemon 保存，App 每次连上经 `agent_prompts_running` 补回，不依赖请求重投。
- **投递方式**：只有 `file_read` 与 `screen_capture` 经 `CallOptions.ephemeral` 走 Relay ephemeral（不落库、不 ack，host 离线或断线即失败，回复同样 ephemeral，字节回复为二进制帧），其余一律可靠投递。
- **重置与清理**：异常必须保留重试或 settings 重置入口。重置重载文档并清理本地 Relay 消息状态，保留配对和设备标识；不删除远端历史，也不保证停止远端任务。

# 前端开发（Gem 规范与语法指南）

所有前端项目（`packages/agentdeck`、`packages/extension`）均统一使用 Gem 框架、Tap UI / Duoyun UI 和最新 ECMAScript 语法。

- 对象参数的内联类型较长、导致参数声明多行展开时，提取为命名类型。
- 函数调用前不加无必要的 `void`；需要等待时使用 `await`，错误处理保持显式。
- `unplugin-gem` 自动导入 Gem 成员与项目自定义元素，无需手动导入；开发期 HMR 由插件处理，不配置 Gem helper `preEntry`。
- 布局优先 Tailwind utility，Shadow DOM 内不能使用。Light DOM 样式用 `:scope`，Shadow DOM 用 `:host`；通过 `css` / `@adoptedStyle` 共享样式，避免模板内联样式。
- 元素文件名去前缀的标签名，继承 `GemElement`；使用 ES 装饰器（2023-11 标准），不使用已弃用的生命周期函数，也不额外声明自定义元素类型。
- 用 `@property` / attribute 装饰器定义输入；不要在元素内部修改输入，attribute 不赋默认值。内部数据用 `createState`，CSS 状态用 `@state`；优先使用 `#` 私有字段。
- `@memo` / `@effect` 用依赖数组控制执行，effect 返回清理函数；`@template` 定义模板，支持 `v-if`、ref 和属性展开。
- 全局状态用 `createStore` / `@connectStore`；事件用 `@emitter`，跨 Shadow DOM 冒泡用 `@globalemitter`；part / slot 用静态装饰字段。
- Toast 的消息文案应该适当简短

完整写法见带注释的示例 `packages/agentdeck/node_modules/@mantou/gem/AGENTS.md`，写元素前先读。

# 常用全局命令

- `pnpm run lint`：Biome 检查并修复，再对各包运行 tsc。
- `cargo check`：Rust Workspace 全局类型检查。
- `pnpm -r test`：运行全工作区前端与扩展自动化测试。
- `cargo test -p agentdeck-daemon`：Daemon 单元测试。
- 提交前依次运行上述检查；Husky 通过 lint-staged 对暂存文件执行 Biome（`pnpm install` 后生效）。

# 发布

- 推送 `vX.Y.Z` tag 触发全部发布，版本号取自 tag：Daemon → npm / Homebrew（`mantou132/homebrew-tap`）/ Scoop（`mantou132/scoop-bucket`）/ GitHub Release；扩展发布到 Chrome、Edge、Firefox 商店；Android 提交 Google Play；iOS 经 fastlane 提交 App Store（已有版本在审或待发布时停在提交前，审核结束后重跑该 job）。
- macOS Daemon 用 Developer ID 证书签名（identifier `com.agentdeck.daemon`，使隐私授权在升级后保留），证书不可用时退回 ad-hoc。
- 前端热更新：Release 附带 `agentdeck-frontend-<native id>.tar.gz`（native id 为 `crates/agentdeck` 与 `Cargo.lock` 的 git 哈希），App 下载同 id 的更新包，下次启动生效，未经 `frontend_update_ready` 确认的包回退。原生层改动会换 id，只能走商店。热更新只用于修复与小改动，新功能仍走商店审核。
- 可选：打 tag 前更新 `distribution/whatsnew/`（每种语言不超过 500 字符）作为 Google Play 与 App Store 更新说明。更新前把旧说明按其版本存到 `history/`（如 `history/whatsnew-en-US-0.8.0`）；不能放在 `whatsnew/` 根目录，Google Play 上传会把根目录下所有 `whatsnew-*` 文件名当语言代码提交。
- 所需 Secrets 以各 workflow 文件中的引用为准。
