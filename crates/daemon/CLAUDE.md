# AgentDeck Daemon (`crates/daemon`)

AgentDeck 独立后台守护服务 `agentdeckd`，负责本地 ACP Agent 生命周期调度、文件及 Git 操作，并通过 Relay 提供跨网络安全多端连接。

## 关键入口与核心模块

- `src/main.rs`：服务主入口；基于 `clap` 解析子命令及参数，单例锁校验，初始化 Tokio 异步运行时与日志。
- `src/daemon/`：守护进程生命周期与开机自启服务管理。
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
- **设备多路复用**：一台 Host 守护进程可服务多个远端 Peer，设备状态及 `peerId` 映射存储于系统应用数据目录。

## 常用命令

- `agentdeckd` 或 `agentdeckd run`：在前台直接运行守护进程。
- `agentdeckd start`：注册开机自启后台服务并在未运行状态下立即启动。
- `agentdeckd stop`：注销开机自启后台服务并尝试关闭正在运行的进程。
- `agentdeckd restart`：重启后台守护服务。
- `agentdeckd status`：查看服务状态、运行 PID 及当前 Relay ID。
- `cargo check -p agentdeck-daemon`：语法与类型快速检查。
- `cargo test -p agentdeck-daemon`：运行 daemon 单元测试套件。
- `cargo build --release -p agentdeck-daemon`：编译生产环境二进制包 `agentdeckd`。
