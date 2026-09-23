# AgentDeck

AgentDeck turns your coding agents (Claude Code, Codex, Cursor, pi) into remote services you can reach from your phone or browser extension([screenshot](https://raw.githubusercontent.com/mantou132/browser4agent/refs/tags/v0.4.0/docs/agent.png)). It is a mobile and web ACP (Agent Client Protocol) client built with Tauri 2, Gem, Tap UI, Tailwind CSS, and Rsbuild.

[![AgentDeck Demo](https://img.youtube.com/vi/_HWCKW9nfpE/maxresdefault.jpg)](https://www.youtube.com/watch?v=_HWCKW9nfpE)

## Quick start

```text
AgentDeck (phone / extension) ⇄ Relay ⇄ agentdeckd (computer) ⇄ ACP agents
```

Install the daemon on the computer where your agents run:

```sh
# npm (Node.js 22+, macOS arm64/x64, Linux glibc x64, Windows x64)
npm install -g agentdeckd

# macOS / Linux
brew install mantou132/tap/agentdeckd

# Windows
scoop bucket add mantou https://github.com/mantou132/scoop-bucket
scoop install agentdeckd

# From this repository
cargo install --path crates/daemon
```

Run `agentdeckd start`, then paste its **Pairing ID** into AgentDeck's Settings and select an agent.

For npm upgrades, run `agentdeckd stop`, `npm install -g agentdeckd@latest`, then `agentdeckd start`. Stop the daemon before uninstalling as well. If you change Node installations or npm's global directory, run `agentdeckd restart` from the new installation to update the autostart path. npm installation does not start services automatically.

**Keep the Pairing ID secret. Anyone with it can access your agent. Do not include it in screenshots or issue reports.** New installations use `adk1_` IDs with end-to-end encryption; the relay only forwards ciphertext. Legacy UUID IDs use plaintext transport.

## Daemon commands

| Command | Description |
| --- | --- |
| `agentdeckd start` | Register autostart and start in the background |
| `agentdeckd stop` | Stop the daemon and remove autostart |
| `agentdeckd restart` | Restart the background service |
| `agentdeckd status` | Show service status, PID, Relay URL and secret Pairing ID |
| `agentdeckd reset` | Rotate Pairing ID, clear local state and show status; restart if previously running |
| `agentdeckd` / `agentdeckd run` | Run in the foreground |

`reset` generates a new Pairing ID by default, invalidating the old ID. Use `--relay-id` to set a specific ID and `--relay-url` to change the relay; otherwise the default relay URL is used. Pair your devices again with the new ID shown in its status output. It clears local connection state, logs and temporary downloads while preserving installed agents and agent history. Running services restart; stopped services remain stopped.

Global options can appear before or after the command:

```sh
agentdeckd start --relay-url wss://your-relay.example/ws
agentdeckd restart --relay-id <YOUR_PAIRING_ID>
agentdeckd reset --relay-id <NEW_PAIRING_ID> --relay-url wss://your-relay.example/ws
```

Both settings are saved for future starts. Use `restart` to change settings while the daemon is running, or `reset` to also clear local state. The default relay is `wss://agent-deck.xianqiao.wang/ws`; clients must use the same relay and Pairing ID.

## Troubleshooting

- **Cannot connect:** check `agentdeckd status`, confirm the client uses the same Pairing ID and relay, then try `agentdeckd restart`. Ensure your network permits WebSocket connections to the relay.
- **Still stuck:** run `agentdeckd reset` and use **Reset App** in the client's Settings to clear local connection state.
- **Connection preempted:** close duplicate clients sharing the same device identity.
- **Connected, but an agent fails:** check that its CLI works locally and inspect `agentdeckd.log` under the data directory below. Save any useful logs before running `reset`.

| OS | Daemon data directory |
| --- | --- |
| macOS | `~/Library/Application Support/agentdeck/` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/agentdeck/` |
| Windows | `%LOCALAPPDATA%\agentdeck\` |

Logs are in `logs/agentdeckd.log`.

## Development

```sh
pnpm install
pnpm run tauri android dev  # Android device/emulator
```

### Checks before commit

```sh
pnpm run lint         # Biome & TypeScript strict check
pnpm -r test          # Workspace tests
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
