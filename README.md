# AgentDeck

**Your coding agents, in your pocket.** Run Claude Code, Codex, Cursor or any ACP agent on your own computer, and start, steer and approve it from your phone. End-to-end encrypted, with a free agent built in so you can try it without logging in to anything.

[![AgentDeck Demo](https://img.youtube.com/vi/XVVrMgwf2YA/maxresdefault.jpg)](https://www.youtube.com/watch?v=XVVrMgwf2YA)

<a href="https://play.google.com/store/apps/details?id=com.mantou.agentdeck"><img alt="Get it on Google Play" src="https://play.google.com/intl/en_us/badges/static/images/badges/en_badge_web_generic.png" height="60"></a>

## Get started in a minute

**1. Install the daemon** on the computer where your agents run:

```sh
npm install -g agentdeckd          # Node.js 22+, macOS / Linux x64 / Windows x64
brew install mantou132/tap/agentdeckd   # or Homebrew
```

**2. Start it:**

```sh
agentdeckd start
```

**3. Scan the QR code** it prints with the AgentDeck app, then pick an agent. Choose **Free** to start chatting right away; no account or API key required.

## Why AgentDeck

- **One app for every agent.** Claude Code, Codex, Cursor, GitHub Copilot, Google Antigravity, OpenCode, Qwen Code, Kimi CLI and other [ACP](https://agentclientprotocol.com) agents. Switch agents and session options from your phone.
- **Start sessions from your phone.** The daemon runs in the background and starts with your computer, so you don't need to leave a terminal open or launch agents through a wrapper.
- **Your code stays on your machine.** Everything is end-to-end encrypted: the relay only forwards ciphertext. You can also [self-host the relay][relay].
- **Built for being away from the keyboard.**
  - Get a push notification when a task finishes.
  - Approve permission requests from your phone.
  - Talk to your agent with push-to-talk voice chat and hear a short spoken summary of each reply.
- **Review real work, not just chat.**
  - Browse files, Git changes, diffs and history.
  - Preview the HTML pages and charts your agent produces.
  - Watch a live view of the iOS Simulator, Android emulator or browser tab your agent is driving.
- **Built to keep running.** Drafts survive restarts, and the daemon can keep your computer awake while agents work.

## How it works

```text
AgentDeck app  ⇄  Relay (ciphertext only)  ⇄  agentdeckd (your computer)  ⇄  ACP agents
```

`agentdeckd` connects out to the relay, so you don't need to open ports or set up a VPN. Your phone and computer pair with a secret Pairing ID, which is carried in the QR code, and derive the encryption keys from it.

**Keep the Pairing ID secret.** Anyone who has it can use your agents. Don't include it in screenshots or issue reports. If it leaks, run `agentdeckd reset` to rotate it.

---

## More install options

```sh
# Windows (Scoop)
scoop bucket add mantou https://github.com/mantou132/scoop-bucket
scoop install agentdeckd

# From source
cargo install --path crates/daemon
```

To upgrade an npm install, run `agentdeckd stop`, then `npm install -g agentdeckd@latest`, then `agentdeckd start`. Stop the daemon before you uninstall it. If you change your Node installation or npm's global directory, run `agentdeckd restart` from the new installation so autostart uses the new path.

## Daemon commands

| Command | Description |
| --- | --- |
| `agentdeckd start` | Register autostart, start in the background and show the pairing QR code |
| `agentdeckd stop` | Stop the daemon and remove autostart |
| `agentdeckd restart` | Restart the background service |
| `agentdeckd status` | Show service status, PID, relay URL, Pairing ID and QR code |
| `agentdeckd reset` | Rotate the Pairing ID and clear local connection state (agents and history are kept) |
| `agentdeckd` / `agentdeckd run` | Run in the foreground |

Options can go before or after the command and are saved for future starts:

```sh
agentdeckd restart --relay-url wss://your-relay.example/ws
agentdeckd reset --pairing-id <NEW_PAIRING_ID>
```

When you use a custom relay, the QR code carries both the Pairing ID and the relay URL. If you type the Pairing ID in manually, the app uses the default relay (`wss://agent-deck.xianqiao.wang/ws`).

## Troubleshooting

- **Cannot connect:** check `agentdeckd status` and make sure the app uses the same Pairing ID and relay. Then try `agentdeckd restart`, and confirm that your network allows WebSocket connections to the relay.
- **Still stuck:** run `agentdeckd reset`, then tap **Reset App** in the app's Settings and scan the code again.
- **Connection preempted:** close any other client that shares the same device identity.
- **Connected, but an agent fails:** check that the agent's CLI works locally, and look at the daemon logs.

| OS | Daemon data directory |
| --- | --- |
| macOS | `~/Library/Application Support/agentdeck/` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/agentdeck/` |
| Windows | `%LOCALAPPDATA%\agentdeck\` |

Logs are written to `logs/agentdeckd.YYYY-MM-DD.log`, one file per day, and the last 7 days are kept. Set `RUST_LOG=debug` for more detail. Save any logs you need before you run `reset`.

## Privacy

Android completion notifications are sent through a forwarder (`agent-deck.xianqiao.wang/push`) to Firebase Cloud Messaging. The payload contains only the agent and session IDs, never prompts or replies. Legacy UUID Pairing IDs use plaintext transport; new installs always use encrypted `adk1_` IDs. See [PRIVACY_POLICY.md](PRIVACY_POLICY.md) for details.

## For teams

We're exploring a team edition with a self-hosted relay, SSO, an approved-agent allowlist, audit logs and device management. If your team is interested, email [contact@xianqiao.wang](mailto:contact@xianqiao.wang) and tell us which agents you use and what your security review requires.

## License

[MIT](LICENSE)

[relay]: https://github.com/mantou132/relay
