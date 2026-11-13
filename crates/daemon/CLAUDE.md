# AgentDeck Daemon (`crates/daemon`)

后台守护服务 `agentdeckd`：管理本地 ACP Agent，提供文件与 Git 接口，经 Relay 连接多台远端设备。

## 代码导航

- `src/main.rs`：CLI 与前台运行入口，负责状态输出和配对二维码。
- `src/app_data.rs`：唯一的本地存储布局定义（`AppPaths` / `AgentPaths`）；路径方法没有文件系统副作用，写入方自行创建目录，清理复用同一套路径定义。
- `src/config.rs`：Pairing ID 生成、Relay 默认值和 `daemon.json` 持久化。普通启动会合并已保存的配置；reset 从默认值加显式参数重建，不读旧配置。
- `src/daemon/`：服务生命周期。`reset.rs` 编排重置；`singleton.rs` 是 `daemon.lock` 单例锁；自启在 macOS / Linux 用 `service_mgr.rs`（LaunchAgent / systemd --user），Windows 用 `windows.rs`（计划任务）。macOS 的 plist 由 daemon 自己生成，内容未变且已加载时 start 不重写、restart 用 `launchctl kickstart -k`，因为重写 LaunchAgent 会再弹"后台项目已添加"通知；`stop` 仍会删除 plist。
- `src/acp_agent/`：`acp_agent.rs` 是 ACP 客户端，每种 Agent 共用一个子进程（`AcpRuntime`），`AgentSessionManager` 对外提供会话接口；`session.rs` 是每个会话一个的 actor（回合、未作答请求、load 回放）；`provision.rs` 下载预编译 Agent；生命周期与并发测试在 `lifecycle_tests.rs`。`catalog.rs`：Agent 注册表（启动 Agent 时后台拉取官方 CDN 存为 `registry.json`，不等网络）、自定义 Agent（`custom_agents.json`，`{ id, name?, command?, args? }`，只有 `id` 时取注册表同名 Agent，同 id 的 `command` 覆盖注册表；reset 保留，只有它们下发给客户端）与 `agentdeck_env`（Codex 用 `CODEX_CONFIG` 关闭 `visualize`）。内置 Agent `free` 复用托管的 `opencode` 二进制，经 `OPENCODE_DB` / `OPENCODE_AUTH_CONTENT` / `OPENCODE_CONFIG_CONTENT` 与用户的 OpenCode 隔离（只用免费 provider，挂载全部 skill）；不用 XDG 变量，因为它们会传给 Agent 执行的命令。
- `src/agent_rpc.rs`：远端 RPC 入口，注册全部处理函数并做参数校验；`agent_rpc/files.rs` 是目录补全、浏览与文件读取，`git.rs` 是 Git 接口与会话列表的 worktree 识别，`prompt.rs` 组装 prompt（面板系统提示、语音标记、附件落盘）。
- `src/relay_client.rs`：`RemotePeerManager` 在一条 Relay 连接上复用多台设备，维护 deviceId → peerId 映射（`remote_peers_v1.json`）。请求带 `ephemeral: true` 时，记录 `(peerId, id)`，该请求的 event 与最终回复也以 ephemeral 发出。
  `peer_attach` 回复带 `version`（`CARGO_PKG_VERSION`，发布时由 `release.yml` 按 tag 写入 `Cargo.toml`），App 据此提示升级；还带 `customAgents`（`custom_agent_list()`），App 把它们列在 `free` 之后。
- `src/peer.rs`：JSON RPC 对端。`handle_with_bytes` 注册的处理函数可在结果旁返回原始字节（如 `file_read` 的图片与 raw 读取），由传输层携带，对端在 `result.data` 收到；结果本身不放 `data`，也不做 base64。失败回复为 `{ id, error, code? }`：`handle_rpc` 的处理函数可附 `code`，目前只有 `agent_prompt` 在 Agent 返回 ACP `AuthRequired` 时带 `auth_required`，App 据此提示用户在电脑上登录该 Agent（SDK 的 `start_session` 会把 `session/new` 的错误变成 internal error，所以创建与加载会话拿不到这个码）。
- `src/relay_codec.rs`：RPC 消息与 Relay 帧互转（加密、帧大小限制与超限错误回复）。带字节的回复总是拼成二进制帧（`[u32 头长度][回复 JSON][原始字节]`，加密为 `[nonce][密文]`，AAD 带 `binary` 标签），Relay 按 ephemeral 投递。不涉及 peer 与设备。
- `src/relay_encryption.rs`：XChaCha20-Poly1305 + HKDF-SHA256 端到端加密原语。
- `src/push.rs`：prompt 成功完成时，向发起该 prompt 的设备推送 FCM 通知；正文用 `notification_response_complete` 由 App 本地化（Android strings、iOS `Localizable.strings`）；`data` 带 `host`（`push::host_key`，配对 ID 的 SHA-256 前 8 字节，不泄露配对 ID）、`agent` 与 `sessionId`，供 App 点击通知时打开会话。
- `src/screen_capture.rs`：`screen_capture` RPC，按 target 截一帧（`ios:` 用 `simctl` 的 alpha 遮罩得到屏幕形状；`android:` 用 adb，形状取自 `dumpsys display`；`browser:` 用 rmcp 连 browser4agent 本地 MCP 服务 `127.0.0.1:39271/mcp`，并以页面脚本判断标签页是否在模拟手机），缩放后以 JPEG 字节回复，不保存状态。
- `src/render_skills.rs`：内置 skill（`src/render_skills/<能力>/` 整个目录嵌入，新增只需在 `SKILLS` 加名字），每个进程首次使用时重写到 `AppPaths::skills_dir()`（只替换 `.agents` / `.claude`，保留 `<能力>/learned.md`：`job` 与 `travel` 末尾同一段让 Agent 在本机自优化 skill，只记用户纠正过或验证有效的做法，最多 20 条，错了即删，默认开启）。`app` 另带 Gem + Tap UI 的移动端模板；`job` 是求职流程（工作区 `~/JobSearch/`）、`travel` 是旅行规划（每次行程一个 `~/Trips/<YYYY-MM>-<地点>/`），不对应渲染块但同样按能力开关；mermaid / LaTeX 写在 chart skill 里。
- `src/logger.rs`：`tracing` 日志（含依赖库事件）按天写入 `logs/agentdeckd.YYYY-MM-DD.log`，保留 7 个文件；默认 `info`，`RUST_LOG` 可覆盖；只在 `run` 中初始化，不输出到终端。

## 约束与现状

- **端到端加密**：`adk1_` 配对必须加密，Relay 只做帧路由，禁止自动退回明文。
- **信任模型**：Pairing ID 是唯一凭证，所有设备共用同一把密钥，deviceId 由设备自报，不能按设备吊销（只能 `reset` 整体轮换）。所有设备共享全部会话。文件和 Git 接口直接使用客户端传入的路径，**没有目录限制**；`file_read` 带 `raw: true` 时，任意文件都返回原始字节（`type: "binary"`，附文件总大小 `size`），供 App 预览协议使用；再带 `offset` + `length` 时只读该片段且不受整文件 8MB 上限约束（单片仍不超过 8MB），用于视频等媒体的 Range 请求。
- **工具图片瘦身**：转发 `tool_call` / `tool_call_update`（含 load 回放）前，删除 `content` 与 `rawOutput` 中图片的 base64 数据（`update_to_json`）。App 不渲染工具图片，而截图类结果会让回放达到几十 MB，堵住有序的 Relay 队列。
- **文件附件**：`agent_prompt` 的 `{ type: "file", name, data, mimeType }` 附件解码后写入系统临时目录 `agentdeck-attachments/<时间戳>/<文件名>`（文件名中的空白与 `()[]<>` 替换为 `_`），以 `file://` ResourceLink 交给 Agent 自行读取；由系统清理临时目录，daemon 不删除。不用 ACP blob resource，因为 claude-agent-acp 会丢弃它。
- **会话并发**：同一会话同时只能被一处 load；同一会话的 prompt 互斥。prompt 与 load 一律以事件流返回（不看 `stream` 参数）；prompt 超过 `timeoutSeconds` 没有任何 update 即取消并向调用方返回超时，回合本身等 agent 确认取消后才结束，其间的新 prompt 被拒绝。会话状态（设备、回合、未作答请求）只在会话 actor 内，连接级处理器经 manager 的会话表把请求转给 actor；load 先占住会话键再联系 agent。
- **会话设备**：每个会话记录创建、加载或最近一次 prompt 的设备（`SessionActor::notifier`），权限请求与问题（仅回合进行中）、下一句建议和回合间的会话更新都以通知发给它。
- **等待用户输入**：权限请求（`session/request_permission`）与问题（`elicitation/create`，`initialize` 只声明 `elicitation.form`，claude-agent-acp 因此启用 `AskUserQuestion`）走同一套：daemon 加 `requestId` 按会话保存，以 `agent_permission_request` / `agent_elicitation_request` 通知会话设备，任意设备用 `agent_user_input_respond`（`{ agent, sessionId, requestId, response }`）作答；`agent_prompts_running` 返回 `userInputs` 供重连补回。不设单独时限，回合取消、会话关闭或空闲超时都按取消结束。
- **子代理会话**：按 ACP Subagent Sessions RFD（`unstable_subagents`），连接级处理器把子会话（可嵌套）登记到根会话（`AcpRuntime::children`），其 update、权限与问题都经根会话转发并带 `childSessionId`。`agent_prompt_cancel` 带 `childSessionId` 时只在子会话声明了 `cancel` 时发送。不持久化子会话（claude-agent-acp 在 load 回放中重放），也不 prompt / load 子会话。
- **配置**：`daemon.json` 自启时读取；Relay 配置变更需要重启，awake 配置会自动重载。显示 Pairing ID 时必须带安全警示边框。配对二维码为 `agentdeck://connect?pairingId=…`，使用非默认 Relay 时追加 `relayUrl`。
- **防自动睡眠**：默认和 reset 后均为 `never`。`active` 以最后一次 RPC 收发时间计时，一小时无 RPC 后释放；状态写入 `awake_status.json`，daemon 退出时清理。
- **reset**：停止服务并持锁后，删除 `remote_peers_v1.json`、`logs/` 和 `agents/*/install/`；未传 `--pairing-id` 时生成新的 `adk1_` ID，未传 `--relay-url` 时恢复默认 Relay。保留已安装的 Agent 及其历史，完成后恢复原来的运行/停止状态，并输出 status。
- **会话指令**：面板上下文等指令一律通过 `session/new` / `session/load` 的 `_meta.systemPrompt.append` 下发，不判断 Agent 能力。OpenCode（含 `free`）忽略该字段，面板上下文对其不生效。不要用 MCP instructions 承载客户端上下文（语义不符，Codex 也不会当作指令）。正式字段见 RFD agent-client-protocol#1237。
- **下一句建议**：`session/new` / `session/load` 一律在 `_meta.claudeCode` 中开启 `promptSuggestions`，并用 `emitRawSDKMessages` 只订阅 `prompt_suggestion`（claude-agent-acp 默认丢弃），与 `systemPrompt` 一样不判断 Agent，其他 Agent 忽略该键。建议在回合结束后以 `_claude/sdkMessage` 到达，由连接级处理器按 sessionId 转成 `agent_prompt_suggestion` 通知发给会话设备。
- **会话列表的 worktree**：cwd 在 git linked worktree 的会话附上 `worktree: { mainCwd, name }`；worktree 已删除时退回识别 Claude Code 的 `<repo>/.claude/worktrees/<name>`。
- **分支会话**：`agent_session_fork` 发送 ACP `session/fork`（`unstable_session_fork`），不建 actor，客户端随后照常 load。分支点用 claude-agent-acp 识别的 `_meta.jetbrains.air.fork`，其他 Agent 会复制整个会话。
- **回合间的会话更新**：会话 actor 空闲时也读取 ACP session update（如 `session/new` 返回后才推送的 `available_commands_update`），以 `agent_session_update` 通知（`{ agent, sessionId, update }`）发给会话设备；回合与 load 回放中的仍随各自事件流转发。
- **语音对话**：`agent_prompt` 带 `voiceChat: true` 时在附件末尾追加 `<agentdeck-voice-chat/>` 标记；`remote_app` 系统提示说明见到标记要在回复末尾写 `<!-- agentdeck-speech … -->` 注释作为朗读摘要（只有 Claude 读系统提示）。客户端从历史用户消息中去掉该标记。
- **渲染 skill**：客户端在 `peer_attach` 的 `capabilities.render` 声明能力，daemon 按设备保存，对声明了 `sessionCapabilities.additionalDirectories` 的 Agent 把对应 skill 目录传给 `session/new` / `session/load`；其他 Agent 不注入，`free` 进程级挂载全部 skill。

## 常用命令

- `cargo check -p agentdeck-daemon` / `cargo test -p agentdeck-daemon` / `cargo build --release -p agentdeck-daemon`
- CLI 用法以 `agentdeckd --help` 为准。

## npm 分发（`npm/`）

- 主包 `agentdeckd` 通过精确版本的 `optionalDependencies` 引用四个平台包（darwin-arm64/x64、linux-x64-gnu、windows-x64）。平台映射在 `npm/platforms.mjs`，新增平台时同步 Release 的 Rust matrix。包里没有 postinstall，安装后不会自动启动服务。
- 构建与验证：`build.mjs`（校验 SHA-256、生成并 pack）、`verify.mjs`（从本地 registry 安装并执行 `--help`）、`distribution.test.mjs`（完整安装行为测试，需要 zip）。
- 发布：推送 `v*` tag 后由 `release.yml` 通过 OIDC Trusted Publisher 发布，不使用 `NPM_TOKEN`。先发平台包，最后发主包；预发布版本用 `next` tag，正式版本用 `latest`。新增包需要先由维护者用 `publish.mjs` 初始化，再在 npm 上配置 Trusted Publisher（`mantou132/AgentDeck`，`release.yml`）。
