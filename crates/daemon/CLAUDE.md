# AgentDeck Daemon (`crates/daemon`)

AgentDeck 独立后台守护服务 `agentdeckd`，负责本地 ACP Agent 生命周期调度、文件及 Git 操作，并通过 Relay 提供跨网络安全多端连接。

## 关键入口与核心模块

- `src/main.rs`：CLI 与前台运行入口；负责参数解析、命令分派和终端输出。
- `src/app_data.rs`：唯一的本地存储布局定义；`AppPaths` 管理 Daemon 文件，`AgentPaths` 管理 Agent 安装文件。路径方法无文件系统副作用，写入方显式创建目录；清理复用相同路径定义。
- `src/config.rs`：配对 ID 生成、Relay 默认值与配置持久化；普通启动合并已保存配置，reset 从默认值和显式参数构建全新配置，不读取旧配置。
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
- **CLI 配置**：全局 `--relay-id` / `--relay-url` 在前台启动、`start`、`restart`、`reset` 时写入 `daemon.json`；默认 Relay URL 不变，自启读取保存的配置。运行中修改配置使用 `restart`。显示配对 ID 时必须包含安全警示边框。
- **Daemon 重置**：`reset` 停止服务并持有单例锁后，删除 `remote_peers_v1.json`、`logs/` 和 `agents/*/install/` 临时下载目录；应用 `--relay-id` / `--relay-url` 参数，未传 ID 时生成新的 `adk1_` Pairing ID，未传 URL 时恢复默认 Relay 地址；保留锁文件、已安装 Agent 及历史。完成后恢复原先运行/停止状态并输出与 `status` 相同的信息（含新 ID），运行中的前台实例会恢复为后台服务。
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
