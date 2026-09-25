# AgentDeck Daemon (`crates/daemon`)

AgentDeck 独立后台守护服务 `agentdeckd`，负责本地 ACP Agent 生命周期调度、文件及 Git 操作，并通过 Relay 提供跨网络安全多端连接。

## 关键入口与核心模块

- `npm/`：npm 分发入口、平台二进制打包和安装验证；不加入 pnpm workspace，发布包由 Release 构建产物生成。
- `src/main.rs`：CLI 与前台运行入口；负责参数解析、命令分派和终端输出。
- `src/app_data.rs`：唯一的本地存储布局定义；`AppPaths` 管理 Daemon 文件，`AgentPaths` 管理 Agent 安装文件。路径方法无文件系统副作用，写入方显式创建目录；清理复用相同路径定义。
- `src/config.rs`：配对 ID 生成、Relay 默认值与配置持久化；普通启动合并已保存配置，reset 从默认值和显式参数构建全新配置，不读取旧配置。
- `src/awake.rs` / `src/awake/platform.rs`：防自动睡眠策略、活动计时与状态快照；通过 `keepawake` 的 idle 模式管理跨平台防睡眠，`platform.rs` 仅负责外接电源检测。
- `src/daemon/`：守护进程生命周期与开机自启服务管理。
  - `reset.rs`：编排停止、持锁清理与配置重建、恢复原先服务状态；返回状态供 CLI 展示，不负责终端输出。
  - `singleton.rs`：跨平台运行时单例锁（基于 `fd-lock` 建议性文件锁与 PID 记录）以及进程安全终止辅助。
  - `status.rs`：统一服务状态枚举（`NotInstalled`、`Running`、`Stopped`）。
  - `service_mgr.rs`：macOS 与 Linux 用户级自启动服务统一实现（基于 `service-manager` 分别管理 LaunchAgent 与 systemd --user）。
  - `windows.rs`：Windows 计划任务管理（基于 `planif` 创建登录自启任务与 `schtasks`）。
  - `fallback.rs`：非主流系统的回退桩。
- `src/acp_agent/`：
  - `acp_agent.rs`：ACP 协议客户端；管理 Agent 子进程、标准输入输出流与会话状态机。
  - `catalog.rs`：本地与内置 Agent 注册表（如 Claude, Codex）；管理不同平台的启动命令与 npx 回退规则。
  - `provision.rs`：下载、缓存与解压分发各平台预编译 Agent 二进制包（`.tar.gz`、`.zip` 及独立可执行程序）。
  - `lifecycle_tests.rs`：会话生命周期、取消、清理与并发重连单元测试。
- `src/agent_rpc.rs`：Agent RPC 服务端实现；提供安全目录限制下的文件读取、目录浏览、路径展开及 Git status / diff 支持。
- `src/relay_client.rs`：Relay WebSocket 通信层；`RemotePeerManager` 负责在单一 Relay 连接上多路复用多台远端设备（手机、浏览器扩展等），维护 `peerId` 分配与映射。
- `src/relay_encryption.rs`：ChaCha20-Poly1305 + HKDF-SHA256 端到端加密；确保无共享凭据的中继服务器无法窥探消息内容。
- `src/peer.rs`：对称双向 JSON-RPC 协议帧解析与分发。
- `src/push.rs`：FCM 远程推送通知转发（会话产生事件时代发系统通知）。

## 运行约束与设计准则

- **端到端加密**：凡以 `adk1_` 开头的配对必须启用端到端加密，中继服务仅做帧路由，禁止自动退回明文模式。
- **运行时单例**：启动时独占持有 `daemon.lock`，防止同一用户环境下多次启动冲突。
- **开机自启动集成**：
  - macOS: `service-manager` -> `~/Library/LaunchAgents/com.agentdeck.daemon.plist`
  - Linux: `service-manager` -> `systemd --user`
  - Windows: `planif` -> Windows Task Scheduler (Logon trigger)
  - `start` 即完成自启注册并在未运行状态下立即拉起服务。
  - `stop` 即注销自启并安全关闭当前所有运行中的实例。
- **CLI 配置**：命令与参数用法以 `agentdeckd --help` 及子命令 help 为准。配置保存在 `daemon.json`，自启读取保存值；Relay 配置变更需重启，awake 配置自动重载。显示配对 ID 时必须包含安全警示边框。
- **防自动睡眠**：默认与 reset 均为 `never`，通过 `keepawake` 只阻止自动睡眠。`active` 按最后一次收发 RPC 的时间计时，一小时无 RPC 后释放；活动仅保存在内存。运行状态写入 `awake_status.json`，随 daemon 退出清理。
- **Daemon 重置**：`reset` 停止服务并持有单例锁后，删除 `remote_peers_v1.json`、`logs/` 和 `agents/*/install/` 临时下载目录；应用 `--pairing-id` / `--relay-url` 参数，未传 ID 时生成新的 `adk1_` Pairing ID，未传 URL 时恢复默认 Relay 地址；保留锁文件、已安装 Agent 及历史。完成后恢复原先运行/停止状态并输出与 `status` 相同的信息（含新 ID），运行中的前台实例会恢复为后台服务。
- **设备多路复用**：一台 Host 守护进程可服务多个远端 Peer，设备状态及 `peerId` 映射存储于系统应用数据目录。

## 常用命令

- `agentdeckd` 或 `agentdeckd run`：在前台直接运行守护进程。
- `agentdeckd start`：注册开机自启后台服务并在未运行状态下立即启动。
- `agentdeckd stop`：注销开机自启后台服务并尝试关闭正在运行的进程。
- `agentdeckd restart`：重启后台守护服务。
- `agentdeckd status`：查看服务状态、运行 PID、Relay URL 及带安全警示的 Pairing ID。
- `agentdeckd reset`：轮换 Pairing ID、清理本地连接状态、日志和临时下载，恢复服务状态并输出 status。
- `agentdeckd start --relay-url wss://your-relay.example/ws`：指定并保存 Relay 服务器。
- `cargo check -p agentdeck-daemon`：语法与类型快速检查。
- `cargo test -p agentdeck-daemon`：运行 daemon 单元测试套件。
- `cargo build --release -p agentdeck-daemon`：编译生产环境二进制包 `agentdeckd`。

## npm 分发

- 主包 `agentdeckd` 使用 `bin` 启动器和精确版本 `optionalDependencies` 引用四个平台包：`agentdeckd-darwin-arm64`、`agentdeckd-darwin-x64`、`agentdeckd-linux-x64-gnu`、`agentdeckd-windows-x64`。平台包用 `os` / `cpu` / `libc` 限制安装；无 postinstall，不自动启动服务。
- `npm/platforms.mjs` 为平台映射；新增平台时同步 Release Rust matrix。用户需要 Node.js 22+；Linux 当前只支持 x64 glibc。
- `node crates/daemon/npm/build.mjs <version> <artifacts目录> <输出目录>`：校验 Release archive SHA-256、生成五个包并 `npm pack`；在 macOS/Linux 上运行，需要 npm、tar、unzip。
- `node --test crates/daemon/npm/distribution.test.mjs`：用临时本地 registry 验证真实 npm 全局安装、平台筛选、参数与退出码、信号转发、缺包提示和校验和失败；需要 zip。
- `node crates/daemon/npm/verify.mjs <输出目录>`：从本地 registry 安装打包产物并执行当前平台二进制的 `--help`，不启动服务。
- `release.yml` 在手动执行时只打包和验证 npm；推送 `v*` tag 后，以 tag 去掉 `v` 为 npm 版本，平台包先发布，主包最后发布。预发布版本使用 `next`，正式版本使用 `latest`；重跑跳过已发布版本，其他 registry 错误直接失败。
- npm 发布 job 使用 GitHub-hosted runner、Node.js 24（npm >= 11.5.1）和 job 级 `id-token: write`，不配置 `NPM_TOKEN`。OIDC 同时生成 provenance。
- 一次性配置：在 npm 上为上述五个包分别配置 Trusted Publisher：GitHub owner `mantou132`、repository `AgentDeck`、workflow filename `release.yml`、environment 留空，并允许直接 `npm publish`。包需先由维护者建立；首次发布可下载手动运行的 `npm-packages` artifact，在 `npm login` 后用 `node crates/daemon/npm/publish.mjs <解压目录>` 初始化，再配置信任关系。参考 https://docs.npmjs.com/trusted-publishers/ 。
- 自启路径仍是二进制绝对路径。升级流程 `stop → npm install -g agentdeckd@latest → start`；切换 Node 环境后从新安装执行 `restart`，卸载前执行 `stop`。
