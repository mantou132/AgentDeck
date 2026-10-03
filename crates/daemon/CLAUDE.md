# AgentDeck Daemon (`crates/daemon`)

后台守护服务 `agentdeckd`：管理本地 ACP Agent，提供文件与 Git 接口，经 Relay 连接多台远端设备。

## 代码导航

- `src/main.rs`：CLI 与前台运行入口，负责状态输出和配对二维码。
- `src/app_data.rs`：唯一的本地存储布局定义（`AppPaths` / `AgentPaths`）；路径方法没有文件系统副作用，写入方自行创建目录，清理复用同一套路径定义。
- `src/config.rs`：Pairing ID 生成、Relay 默认值和 `daemon.json` 持久化。普通启动会合并已保存的配置；reset 从默认值加显式参数重建，不读旧配置。
- `src/daemon/`：服务生命周期。`reset.rs` 编排重置；`singleton.rs` 是 `daemon.lock` 单例锁；自启在 macOS / Linux 用 `service_mgr.rs`（LaunchAgent / systemd --user），Windows 用 `windows.rs`（计划任务）。
- `src/acp_agent/`：`acp_agent.rs` 是 ACP 客户端，每种 Agent 共用一个子进程，每个会话一个 actor；`catalog.rs` 负责 Agent 注册表（每次启动 Agent 进程时后台拉取官方 CDN 最新版并存为数据目录的 `registry.json`，供之后的启动使用；不等网络，当前用已拉取的或内置版本；Agent 运行时按需创建）、各平台启动命令、npx 回退和 `agentdeck_env`（启动 Agent 时叠加在注册表 env 之上：Codex 通过 `CODEX_CONFIG` 关闭 `visualize` 插件；`free` 以 `OPENCODE_DB`（`agents/free/data/`，reset 保留）、`OPENCODE_AUTH_CONTENT={}` 与 `OPENCODE_CONFIG_CONTENT`（只启用免费的 `opencode` provider，`skills.paths` 挂载全部渲染 skill）与用户的 OpenCode 隔离，不用 XDG 变量，因为它们会传给 Agent 执行的命令）；内置 Agent `free` 复用注册表 `opencode` 的二进制，总用托管版本（不用用户的 CLI），与 `opencode` 共用 `agents/opencode/` 安装目录；`provision.rs` 负责下载和解压预编译 Agent（装好新版本后删除旧版本目录）；会话生命周期与并发测试在 `lifecycle_tests.rs`。
- `src/agent_rpc.rs`：远端 RPC 入口（会话、文件、Git）。
- `src/relay_client.rs`：`RemotePeerManager` 在一条 Relay 连接上复用多台设备，维护 deviceId → peerId 映射（`remote_peers_v1.json`）。请求带 `ephemeral: true` 时，记录 `(peerId, id)`，该请求的 event 与最终回复也以 ephemeral 发出。
  `peer_attach` 回复带 `version`（`CARGO_PKG_VERSION`，发布时由 `release.yml` 按 tag 写入 `Cargo.toml`），App 据此提示升级。
- `src/peer.rs`：JSON RPC 对端。`handle_with_bytes` 注册的处理函数可在结果旁返回原始字节（如 `file_read` 的图片与 raw 读取），由传输层携带，对端在 `result.data` 收到；结果本身不放 `data`，也不做 base64。
- `src/relay_codec.rs`：RPC 消息与 Relay 帧互转（加密、帧大小限制与超限错误回复）。带字节的回复总是拼成二进制帧（`[u32 头长度][回复 JSON][原始字节]`，加密为 `[nonce][密文]`，AAD 带 `binary` 标签），Relay 按 ephemeral 投递。不涉及 peer 与设备。
- `src/relay_encryption.rs`：XChaCha20-Poly1305 + HKDF-SHA256 端到端加密原语。
- `src/push.rs`：prompt 成功完成时，向发起该 prompt 的设备推送 FCM 通知。
- `src/screen_capture.rs`：`screen_capture` RPC，按 target 截一帧（`ios:` 用 `simctl` 的 alpha 遮罩得到屏幕形状；`android:` 用 adb，形状取自 `dumpsys display`；`browser:` 用 rmcp 连 browser4agent 本地 MCP 服务 `127.0.0.1:39271/mcp`，并以页面脚本判断标签页是否在模拟手机），缩放后以 JPEG 字节回复，不保存状态。
- `src/render_skills.rs`：渲染能力对应的 skill（`src/render_skills/<能力>/SKILL.md`），首次使用时写入 `AppPaths::skills_dir()`；mermaid / LaTeX 不单独声明能力，写在 chart skill 里。

## 约束与现状

- **端到端加密**：`adk1_` 配对必须加密，Relay 只做帧路由，禁止自动退回明文。
- **信任模型**：Pairing ID 是唯一凭证，所有设备共用同一把密钥，deviceId 由设备自报，不能按设备吊销（只能 `reset` 整体轮换）。所有设备共享全部会话。文件和 Git 接口直接使用客户端传入的路径，**没有目录限制**；`file_read` 带 `raw: true` 时，任意文件都返回原始字节（`type: "binary"`，附文件总大小 `size`），供 App 预览协议使用；再带 `offset` + `length` 时只读该片段且不受整文件 8MB 上限约束（单片仍不超过 8MB），用于视频等媒体的 Range 请求。
- **会话并发**：同一会话同时只能被一处 load；同一会话的 prompt 互斥。权限请求只发给发起 prompt 的设备。
- **配置**：`daemon.json` 自启时读取；Relay 配置变更需要重启，awake 配置会自动重载。显示 Pairing ID 时必须带安全警示边框。配对二维码为 `agentdeck://connect?pairingId=…`，使用非默认 Relay 时追加 `relayUrl`。
- **防自动睡眠**：默认和 reset 后均为 `never`。`active` 以最后一次 RPC 收发时间计时，一小时无 RPC 后释放；状态写入 `awake_status.json`，daemon 退出时清理。
- **reset**：停止服务并持锁后，删除 `remote_peers_v1.json`、`logs/` 和 `agents/*/install/`；未传 `--pairing-id` 时生成新的 `adk1_` ID，未传 `--relay-url` 时恢复默认 Relay。保留已安装的 Agent 及其历史，完成后恢复原来的运行/停止状态，并输出 status。
- **会话指令**：面板上下文等指令一律通过 `session/new` / `session/load` 的 `_meta.systemPrompt.append` 下发，不判断 Agent 能力。OpenCode（含 `free`）忽略该字段，面板上下文对其不生效。不要用 MCP instructions 承载客户端上下文（语义不符，Codex 也不会当作指令）。正式字段见 RFD agent-client-protocol#1237。
- **下一句建议**：`session/new` / `session/load` 一律在 `_meta.claudeCode` 中开启 `promptSuggestions`，并用 `emitRawSDKMessages` 只订阅 `prompt_suggestion`（claude-agent-acp 默认丢弃），与 `systemPrompt` 一样不判断 Agent，其他 Agent 忽略该键。建议在回合结束后以 `_claude/sdkMessage` 到达，由连接级处理器按 sessionId 转成 `agent_prompt_suggestion` 通知，只发给最近一次发起 prompt 的设备。
- **渲染 skill**：客户端在 `peer_attach` 的 `capabilities`（如 `{ "render": ["chart"] }`）中声明能力，daemon 按设备保存。Agent 声明了 `sessionCapabilities.additionalDirectories` 时，把对应 skill 目录作为 `additionalDirectories` 传入 `session/new` / `session/load`；未声明的 Agent（如 opencode）不注入；`free` 例外，进程级挂载全部 skill，不区分设备。

## 常用命令

- `cargo check -p agentdeck-daemon` / `cargo test -p agentdeck-daemon` / `cargo build --release -p agentdeck-daemon`
- CLI 用法以 `agentdeckd --help` 为准。

## npm 分发（`npm/`）

- 主包 `agentdeckd` 通过精确版本的 `optionalDependencies` 引用四个平台包（darwin-arm64/x64、linux-x64-gnu、windows-x64）。平台映射在 `npm/platforms.mjs`，新增平台时同步 Release 的 Rust matrix。包里没有 postinstall，安装后不会自动启动服务。
- 构建与验证：`build.mjs`（校验 SHA-256、生成并 pack）、`verify.mjs`（从本地 registry 安装并执行 `--help`）、`distribution.test.mjs`（完整安装行为测试，需要 zip）。
- 发布：推送 `v*` tag 后由 `release.yml` 通过 OIDC Trusted Publisher 发布，不使用 `NPM_TOKEN`。先发平台包，最后发主包；预发布版本用 `next` tag，正式版本用 `latest`。新增包需要先由维护者用 `publish.mjs` 初始化，再在 npm 上配置 Trusted Publisher（`mantou132/AgentDeck`，`release.yml`）。
