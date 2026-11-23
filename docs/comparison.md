# AgentDeck vs Happy vs Paseo

Updated in November 2026. Information on Happy and Paseo is gathered from their public repositories and documentation; "Not specified" indicates it is not mentioned in their official documentation and does not necessarily imply lack of support. Always refer to each project's official repository for the latest updates.

## One-Line Positioning

- **AgentDeck**: Mobile-first. A lightweight background daemon auto-starts on boot, allowing users to start, guide, inspect, and approve AI agents on their machines or cloud servers from their mobile phones at any time.
- **Happy**: Began as a terminal CLI wrapper around Claude Code / Codex, focusing on seamless session handoff between terminal and mobile devices as well as multi-user collaboration; now evolving into a desktop-capable multi-agent orchestration tool.
- **Paseo**: Desktop-first agent development environment. A daemon paired with cross-platform clients, focusing on parallel agent workflows (Git worktrees), integrated terminal/editor experience, and agent-to-agent coordination.

---

## Overview

| Dimension | AgentDeck | Happy | Paseo |
| :--- | :--- | :--- | :--- |
| **Integration Method** | Headless ACP (Agent Client Protocol) driver via daemon | Wraps native CLI (`happy claude` / `happy codex`) in terminal; desktop includes standalone runtime | Daemon manages agent processes, wraps official CLIs, and natively supports ACP |
| **Background Persistence** | `agentdeckd` runs on boot as a service; no open terminal required | Relies on active processes running inside a terminal session | Daemon launches alongside desktop client, or runs headless / Docker |
| **Supported Agents** | Any ACP-compliant agent (Claude Code, Codex, Cursor, Copilot, Antigravity, OpenCode, Qwen Code, Kimi, etc.), plus a built-in Free agent | Claude, Codex, Grok; Gemini via Antigravity; OpenCode and ACP agents via harness | Claude Code, Codex, Copilot, OpenCode, Pi, Antigravity, etc., and ACP agents |
| **Clients** | iOS, Android, Browser extension (maintenance mode), Web live preview | iOS, Android, Web, Desktop (macOS / Windows / Linux) | iOS, Android, Web, Desktop (Electron), CLI, TypeScript SDK |
| **Remote Connectivity** | End-to-end encrypted (E2EE) Relay server (self-hostable) | E2EE via `happy-server` (self-hostable) | Optional E2EE relay, direct connection, or Tailscale / VPN |
| **Pairing** | QR code scan carrying Pairing ID; encryption keys derived locally | Not specified | Device pairing |
| **Authentication** | No account required; zero tracking / telemetry | Not specified | No mandatory account; no telemetry |
| **Tech Stack** | Tauri 2 + Gem framework (TypeScript), Rust daemon | Expo (React Native), TypeScript CLI / server | Expo + Electron, TypeScript daemon |
| **License** | MIT | MIT | Apache-2.0 |

---

## Feature Comparison

| Feature | AgentDeck | Happy | Paseo |
| :--- | :--- | :--- | :--- |
| **Start new session from mobile** | ✅ Yes | Not specified | ✅ Yes |
| **Terminal & mobile session handoff** | ❌ No | ✅ Yes (Core feature) | Not specified |
| **Push notifications on completion** | ✅ Yes (FCM notifications) | ✅ Yes | Not specified |
| **Mobile permission approvals** | ✅ Yes (Permission requests & user input questions) | Not specified | Not specified |
| **Voice chat & spoken summaries** | ✅ Yes (Push-to-talk + synthesized summary comments) | Not specified | ✅ Yes (Local model dictation & voice chat) |
| **File browsing / Git diff / history** | ✅ Yes | Not specified | ✅ Yes (Git panel with common operations) |
| **HTML & chart previews** | ✅ Yes (`agentdeck-preview`, ECharts, widgets) | Not specified | Built-in browser |
| **Live simulator / browser screen streaming** | ✅ Yes (iOS Simulator, Android Emulator, browser tabs via `agentdeck-screen`) | Not specified | Not specified |
| **Scheduled autonomous tasks** | ✅ Yes (Built-in scheduler with timezone support `agentdeck-task`) | Not specified | Not specified |
| **Subagent sessions & delegation** | ✅ Yes (Supports ACP Subagent Sessions / `unstable_subagents`) | ✅ Yes (Subagents can use different models) | ✅ Yes (Via MCP and skills) |
| **Git worktree & session branching** | ✅ Yes (Worktree detection in session list & session fork) | Not specified | ✅ Yes (Full worktree management) |
| **Integrated terminal / code editor** | ❌ No | Not specified | ✅ Yes (Split terminal and editor) |
| **Multi-user collaboration** | ❌ No | ✅ Yes (Invite users into session) | Not specified |
| **Prevent computer sleep** | ✅ Yes (Configurable: `always`, `active`, `plugged`, `never`) | Not specified | Not specified |
| **Out-of-the-box free agent** | ✅ Yes (Built-in `free` agent using OpenCode runtime) | Not specified | Not specified |
| **Plugins / Extensions** | ❌ No (Uses MCP & dynamic skill mounting) | Not specified | ✅ Yes |

---

## Key Differences and Trade-offs

### AgentDeck Strengths

1. **True zero-touch background daemon**: Once `agentdeckd` is installed, it runs as a system background service. You never need to leave a terminal window or desktop application open on your host machine.
2. **Review & inspection capabilities**: Offers the richest visual outputs on mobile devices: structured Git diffs, interactive HTML component previews, ECharts visualizations, and real-time screen streaming from iOS simulators, Android emulators, and headless browser tabs.
3. **Autonomous scheduling & push loop**: Supports creating scheduled tasks (`agentdeck-task`) that run headless at specified times and push notifications when completed or requiring human intervention.
4. **Universal ACP protocol adoption**: Drives agents exclusively through standardized ACP, making it compatible with any modern ACP agent without vendor lock-in.
5. **Built-in Free tier agent**: Ships with an isolated free agent for immediate onboarding without requiring user API keys.

### AgentDeck Trade-offs

1. **No terminal TUI handoff**: Unlike Happy, which attaches directly to your active terminal session, AgentDeck runs headlessly via its daemon. If you prefer working in the terminal and switching back and forth with your phone mid-session, Happy is tailored for that workflow.
2. **No desktop IDE or terminal replacement**: AgentDeck is strictly mobile-first. When you are sitting at your desk, it does not aim to replace your local IDE (VS Code, Cursor) or terminal.
3. **No multi-user collaborative sessions**: Focuses on single-user remote device control rather than shared team war-rooms.

---

## Integrating Custom Agents

| Project | Integration Method |
| :--- | :--- |
| **AgentDeck** | Define custom agents in `custom_agents.json` (`{ id, name?, command?, args? }`) under the daemon data directory. The agent must implement ACP; changes take effect immediately without restarting the daemon. |
| **Happy** | Connects as an ACP harness. |
| **Paseo** | Natively supports ACP, or through plugins (`paseo plugin add`) as providers. |

All three tools treat ACP as the universal interface for modern AI agents. Implementing ACP on an agent allows it to be used across all three environments.

---

## References

- [slopus/happy](https://github.com/slopus/happy)
- [getpaseo/paseo](https://github.com/getpaseo/paseo)
- [AgentDeck Repository](https://github.com/mantou132/agentdeck)
