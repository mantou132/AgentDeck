# AgentDeck

AgentDeck turns your coding agents (Claude Code, Codex, Cursor, pi) into remote services you can reach from your phone or browser extension([screenshot](https://raw.githubusercontent.com/mantou132/browser4agent/refs/tags/v0.4.0/docs/agent.png)). It is a mobile and web ACP (Agent Client Protocol) client built with Tauri 2, Gem, Tap UI, Tailwind CSS, and Rsbuild.

[![AgentDeck Demo](https://img.youtube.com/vi/_HWCKW9nfpE/maxresdefault.jpg)](https://www.youtube.com/watch?v=_HWCKW9nfpE)

## How it works

```
AgentDeck (phone / extension) ⇄ Relay ⇄ agentdeckd (desktop daemon) ⇄ Claude Code / Codex / Cursor / pi
```

1. Run **`agentdeckd`** on the machine where your agents live.
2. Copy the **Relay ID** (Pairing ID) printed by `agentdeckd` on startup. This ID pairs AgentDeck with your desktop: it is the credential for a private, durable WebSocket channel.
3. Enter the Relay ID in AgentDeck's settings page. The app connects to the relay and lists the sessions of your selected agent, grouped by working directory.
4. Open a session to replay its history, or tap **新建会话 (New session)** in the footer and pick a working directory from the agent's machine.

The relay is protocol-agnostic and durable: if the phone goes offline, prompts sent from the other side keep their history and catch up when the app reconnects.

AgentDeck supports **end-to-end encryption** between your phone and computer. With an `adk1_` pairing ID, only your paired devices can decrypt the messages; the relay forwards and queues ciphertext and cannot read your prompts, replies, attachments, or file contents. New installations generate encrypted pairing IDs by default; existing UUID pairing IDs retain the legacy plaintext mode.

---

## AgentDeck Daemon (`agentdeckd`)

`agentdeckd` is the native background daemon for macOS, Linux, and Windows. It hosts ACP agents, manages sessions and file access, and connects securely to the Relay with single-instance enforcement and autostart capabilities.

### Installation

#### macOS & Linux (Homebrew)

```sh
brew install mantou132/tap/agentdeckd
```

#### Windows (Scoop)

```sh
scoop bucket add mantou https://github.com/mantou132/scoop-bucket
scoop install agentdeckd
```

#### From Source (Cargo)

```sh
# Install directly to your Cargo bin path (~/.cargo/bin/agentdeckd)
cargo install --path crates/daemon

# Or build the release binary manually
cargo build --release -p agentdeck-daemon
# The binary is located at target/release/agentdeckd
```

### Usage & Commands

| Command | Description |
| --- | --- |
| `agentdeckd start` | **Register autostart service and start in background** (Recommended) |
| `agentdeckd stop` | Unregister autostart service and terminate running background process |
| `agentdeckd restart` | Restart background service and display current Pairing ID |
| `agentdeckd status` | Display service status, running PID, and Pairing ID |
| `agentdeckd` or `agentdeckd run` | Run directly in the foreground (useful for debugging and logs) |

#### 1. Start in Background (Autostart on boot)

```sh
agentdeckd start
```

Output:
```text
=======================================================
  AgentDeck Daemon v0.1.0
=======================================================
  Relay URL : wss://agent-deck.xianqiao.wang/ws
  Pairing ID: adk1_...
-------------------------------------------------------
  Connect your AgentDeck Mobile App or Browser Extension
  using the Pairing ID above.
=======================================================
```

- **macOS**: Automatically registered as a user LaunchAgent (`~/Library/LaunchAgents/com.agentdeck.daemon.plist`).
- **Linux**: Automatically registered as a systemd user service (`~/.config/systemd/user/com.agentdeck.daemon.service`).
- **Windows**: Automatically registered as a Task Scheduler logon task.

#### 2. Check Status & Pairing ID

```sh
agentdeckd status
```

Output:
```text
AgentDeck Daemon Status:
  Service:    running
  PID:        91859
  Relay ID:   adk1_...
```

#### 3. Stop & Remove Autostart

```sh
agentdeckd stop
```

Unregisters the autostart service from the operating system and cleanly terminates any running `agentdeckd` instances.

#### 4. Custom Pairing ID

You can specify a custom pairing ID (an `adk1_` encrypted key or UUID):

```sh
agentdeckd start --relay-id <YOUR_PAIRING_ID>
# or in foreground:
agentdeckd --relay-id <YOUR_PAIRING_ID>
```

---

## Pairing AgentDeck with your agents

1. Start `agentdeckd` on your host computer:
   ```sh
   agentdeckd start
   ```
2. Copy the **Pairing ID** printed in the console (or check via `agentdeckd status`).
3. In AgentDeck (mobile app or browser extension), open **设置 (Settings)**, paste the Pairing ID, and pick an agent.
4. Save — the app connects to the relay (`wss://agent-deck.xianqiao.wang/ws` in production) and your agents/sessions are ready to use.

---

## Troubleshooting (故障排查)

If AgentDeck shows **Remote unavailable (远端未响应)**, **Connecting...**, or cannot establish a connection, check the following common causes and solutions:

### 1. Pairing ID Mismatch (Pairing ID 不匹配)
- **Cause**: The Pairing ID entered in the client doesn't match the one currently used by `agentdeckd` (e.g. after reinstalling or regenerating credentials), or an encrypted (`adk1_`) pairing key was mistyped/corrupted.
- **Symptoms**: Client displays `Remote unavailable` or daemon logs `Rejected encrypted RPC with mismatched device identity`.
- **Solution**:
  1. On your host computer, run `agentdeckd status` to check the active Pairing ID.
  2. In your mobile app or browser extension, open **设置 (Settings)**, re-paste the exact Pairing ID, and save.

### 2. Stale Storage Cursor / Sequence Conflict (游标序号缓存冲突)
- **Cause**: The client persists a message sequence cursor (`lastReceived`) to prevent duplicate processing. When switching between relays, restarting relay services, or reconnecting after server-side sequence resets, the client's stored cursor might be higher than the sequence sent by the server. The client's reliable transport (`relay-client-ts`) assumes incoming packets are stale duplicates, sends an ACK, and silently drops the handshake payload (`peer_attach` response).
- **Symptoms**: WebSocket connects and frames are exchanged (visible in DevTools network tab), but the client UI remains on `Remote unavailable` until the 10s handshake timeout triggers.
- **Solution**:
  - **Mobile App / Web App**: Open **设置 (Settings)** → Tap **Reset App (重置应用)** (which clears local storage, cached sessions, and reloads). In a browser, you can also run in the DevTools Console:
    ```js
    localStorage.removeItem('relay-client.v1');
    location.reload();
    ```
  - **Browser Extension (浏览器扩展)**: Open DevTools for the extension (inspect the Side Panel or Background page) and run in the Console:
    ```js
    chrome.storage.local.remove(['relay-client.v1', 'agentdeck.device_id.v1']);
    location.reload();
    ```

### 3. Daemon Not Running or Stopped (桌面守护进程未运行)
- **Cause**: The host computer went to sleep, rebooted, or `agentdeckd` crashed or was killed.
- **Symptoms**: Client connects to the Relay server WebSocket successfully, but no response is received from the host, resulting in `Remote unavailable`.
- **Solution**:
  - Check daemon status on your computer:
    ```sh
    agentdeckd status
    ```
  - If stopped, start or restart it:
    ```sh
    agentdeckd start   # or: agentdeckd restart
    ```

### 4. Connection Preempted by Another Session (设备连接被抢占)
- **Cause**: Multiple tabs, windows, or apps sharing the same Device ID connected to the same Relay endpoint simultaneously. The Relay protocol enforces single-connection exclusivity per device identity.
- **Symptoms**: The indicator turns red with `Connection preempted (连接被抢占)` or an alert stating the session was preempted by a newer connection.
- **Solution**: Close duplicate tabs or concurrent windows. If the conflict persists, execute **Reset App** in the client to generate a fresh, unique Device ID.

### 5. Network / Firewall Restrictions (网络或防火墙阻拦)
- **Cause**: Corporate firewall, strict proxy, or VPN blocking outbound WebSocket upgrades to the Relay server.
- **Symptoms**: Client gets stuck on `Connecting...` or `Reconnecting...` without ever establishing a WebSocket connection.
- **Solution**:
  - Test WebSocket connectivity:
    ```sh
    curl -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" https://agent-deck.xianqiao.wang/ws
    ```
  - Ensure outbound HTTPS/WSS traffic on port 443 to `wss://agent-deck.xianqiao.wang/ws` is permitted.

### 6. ACP Agent Process Failure (底层 Agent 执行异常)
- **Cause**: The chosen agent binary (Claude Code, OpenCode, Antigravity, etc.) is not installed, not in `PATH`, or hung during session initialization.
- **Symptoms**: Status indicator turns green (`Connected`), but sessions fail to load, or prompts hang indefinitely.
- **Solution**:
  - Inspect the daemon logs for error details:
    - **macOS**: `tail -n 100 "$HOME/Library/Application Support/agentdeck/logs/agentdeckd.log"`
    - **Linux**: `tail -n 100 "$HOME/.local/share/agentdeck/logs/agentdeckd.log"`
    - **Windows**: `%LOCALAPPDATA%\agentdeck\logs\agentdeckd.log`
  - Ensure the agent CLI runs properly when executed directly in your terminal.

---

## Development

```sh
pnpm install
pnpm run tauri android dev  # Android device/emulator
```

### Checks before commit

```sh
pnpm run lint         # Biome & TypeScript strict check
pnpm test             # Regression tests
cargo check           # Rust workspace check
cargo test -p agentdeck-daemon  # Daemon tests
```

Husky runs Biome on staged files via lint-staged; install dependencies once to enable it.

## Android releases

The **Release Android** GitHub Actions workflow builds signed universal APK and AAB files for all four Android architectures. Run it manually to verify a build and download the artifacts without publishing.

Configure these repository Actions Secrets once:

| Secret | Value |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | Base64 of the existing Google Play upload keystore |
| `ANDROID_KEY_ALIAS` | Upload key alias |
| `ANDROID_KEY_PASSWORD` | Upload key password |
| `ANDROID_STORE_PASSWORD` | Keystore password |
| `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` | JSON credentials for a service account authorized to release AgentDeck in Play Console |

For a release, increase `version` in `crates/agentdeck/tauri.conf.json`, update all files in `distribution/whatsnew/` (at most 500 characters each), commit the changes, and push the matching `vX.Y.Z` tag. Tauri derives Android's version code from this version, so each upload needs a new version. The workflow attaches APK/AAB files to a GitHub Release and **submits the production release for Google Play review**, including the release notes. Google review still applies; if managed publishing is enabled in Play Console, publish the approved changes there when ready.

The GitHub APK uses the upload key; Google Play may use a different app signing key, so test updates to a Play-installed app through a Play testing track.

## Project structure

This repository is structured as a monorepo (pnpm workspace + Cargo workspace):

- `packages/agentdeck/` — Gem + Tap UI frontend application (`src/`, `public/`, `test/`).
- `packages/extension/` — AgentDeck browser extension.
- `crates/agentdeck/` — Tauri 2 native shell, capabilities, Android and iOS projects.
- `crates/daemon/` — Standalone daemon service (`agentdeckd`).

## Privacy Policy

Please see [PRIVACY_POLICY.md](PRIVACY_POLICY.md) for details.

[relay]: https://github.com/mantou132/relay
