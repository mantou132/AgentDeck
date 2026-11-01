# AgentDeck vs Happy vs Paseo

整理于 2026-10-31。Happy 和 Paseo 的信息来自各自 README，“未提及”表示 README 里没有写，不代表不支持。以官方最新文档为准。

## 一句话定位

- **AgentDeck**：移动端优先。后台 daemon 开机自启，用手机随时启动、引导和审批电脑上的 agent。
- **Happy**：从 Claude Code / Codex 的 CLI 包装起家，主打终端与手机之间的会话接力和多人协作，现在扩展为带桌面端的多 agent 编排工具。
- **Paseo**：桌面端优先的 agent 开发环境。daemon 加多端客户端，主打多 agent 并行（git worktree）、终端和编辑器一体，以及 agent 之间互相编排。

## 总览

| | AgentDeck | Happy | Paseo |
| --- | --- | --- | --- |
| 接入方式 | daemon 通过 ACP 无头驱动 agent | `happy claude` / `happy codex` 在终端包装原生 CLI；桌面端另有自己的 agent runtime | daemon 管理 agent 进程，包装官方 CLI，也原生支持 ACP |
| 后台常驻 | `agentdeckd` 开机自启，不需要开终端 | 原版 CLI 依赖终端里的进程 | daemon 随桌面端启动，也可以 headless / Docker 运行 |
| 支持的 agent | 任意 ACP agent（Claude Code、Codex、Cursor、Copilot、Antigravity、OpenCode、Qwen、Kimi 等），以及内置的 Free agent | Claude、Codex、Grok，Gemini 走 Antigravity，OpenCode 和 ACP agent 作为 harness 接入 | Claude Code、Codex、Copilot、OpenCode、Pi、Antigravity 等，以及 ACP agent |
| 客户端 | iOS、Android、浏览器扩展（维护模式） | iOS、Android、Web、桌面端（macOS / Windows / Linux） | iOS、Android、Web、桌面端（Electron）、CLI、TS SDK |
| 远程连接 | 经 Relay 中转，端到端加密，Relay 可自托管 | 经 `happy-server` 中转，端到端加密，可自托管 | 可选 E2EE relay，也可以直连或走 Tailscale / VPN |
| 配对 | 扫码，二维码里带 Pairing ID，加密密钥由它派生 | 未提及 | 设备配对 |
| 登录 | 不需要账号 | 未提及 | 不强制登录，无遥测 |
| 技术栈 | Tauri 2 + Gem，Rust daemon | Expo，TS CLI / server | Expo + Electron，TS daemon |
| 协议 | MIT | MIT | Apache-2.0 |

## 功能对比

| 功能 | AgentDeck | Happy | Paseo |
| --- | --- | --- | --- |
| 手机启动新会话 | ✅ | 未提及 | ✅ |
| 终端和手机接力同一会话 | ❌ | ✅ 核心卖点 | 未提及 |
| 完成推送 | ✅ | ✅ | 未提及 |
| 手机审批权限 | ✅ | 未提及 | 未提及 |
| 语音 | ✅ 按住说话 + 回复的语音摘要 | 未提及 | ✅ 本地模型听写和语音对话 |
| 文件浏览 / Git diff / 历史 | ✅ | 未提及 | ✅ Git 面板，包括常用操作 |
| HTML / 图表预览 | ✅ | 未提及 | 内置浏览器 |
| 模拟器 / 浏览器实时画面 | ✅ iOS 模拟器、Android 模拟器、浏览器标签页 | 未提及 | 未提及 |
| 终端 / 编辑器 | ❌ | 未提及 | ✅ 分屏终端和编辑器 |
| 多 agent 并行（worktree） | ❌ | 未提及 | ✅ |
| agent 之间互相派活 | ❌ | ✅ 子 agent 可以用不同模型 | ✅ 通过 MCP 和 skill |
| 多人协作 | ❌ | ✅ 邀请别人进会话 | 未提及 |
| 防止电脑睡眠 | ✅ | 未提及 | 未提及 |
| 不登录也能试用的 agent | ✅ Free | 未提及 | 未提及 |
| 插件 | ❌ | 未提及 | ✅ |

## AgentDeck 的差异与短板

**优势**

- 装好 daemon、扫码就能用。不需要开终端，也不需要桌面客户端，适合人不在电脑前的场景。
- 用一套 ACP 接入所有 agent，新 agent 只要支持 ACP 就能用。
- 审查成果的能力最全：文件、diff、HTML 和图表预览、模拟器和浏览器的实时画面。
- 内置 Free agent，降低第一次试用的门槛。

**短板**

- 没有终端 TUI 接力。习惯在终端里用 Claude Code 的人，切到手机就是另一种体验。
- 没有 worktree 并行、agent 互相编排和多人协作，这几块分别是 Paseo 和 Happy 的强项。
- 没有桌面端。在电脑前时，AgentDeck 不能替代终端或 IDE。

## 接入自己的 agent

| | 方式 |
| --- | --- |
| AgentDeck | 在 daemon 数据目录的 `custom_agents.json` 里写 `{ id, name?, command?, args? }`。agent 需要实现 ACP，不用重启 daemon |
| Happy | 作为 ACP harness 接入 |
| Paseo | 原生支持 ACP，也可以通过插件把 agent 加为 provider（`paseo plugin add`） |

三者都把 ACP 当作通用接口。所以自己写 agent 的话，实现 ACP 就能同时接进这三个工具。

## 资料来源

- [slopus/happy](https://github.com/slopus/happy)
- [getpaseo/paseo](https://github.com/getpaseo/paseo)
- [AgentDeck README](../README.md)
