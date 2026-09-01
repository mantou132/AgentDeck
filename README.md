# AgentDeck

AgentDeck turns your coding agents (Claude Code, Codex, Cursor, pi) into remote services you can reach from your phone. It is a mobile ACP (Agent Client Protocol) client built with Tauri 2, Gem, Tap UI, Tailwind CSS, and Rsbuild.

## How it works

```
AgentDeck (phone) ⇄ Relay ⇄ browser4agent (desktop) ⇄ Claude Code / Codex / Cursor / pi
```

1. Run [browser4agent][browser4agent] on the machine where your agents live. Its Agent panel talks to the same ACP agents that AgentDeck uses.
2. Get the **Relay ID** from the browser4agent extension settings page. This UUID pairs AgentDeck with your desktop: it is the credential for a private, durable WebSocket channel.
3. Enter the Relay ID in AgentDeck's settings page. The app connects to the relay and lists the sessions of your selected agent, grouped by working directory.
4. Open a session to replay its history, or tap **新建会话 (New session)** in the footer and pick a working directory from the agent's machine.

The relay is protocol-agnostic and durable: if the phone goes offline, prompts sent from the other side keep their history and catch up when the app reconnects.

## Pairing AgentDeck with your agents

1. Install [browser4agent][browser4agent] and register its native host.
2. Open the extension settings page and copy the **Relay ID**.
3. In AgentDeck, open **设置 (Settings)**, paste the Relay ID, and pick an agent.
4. Save — the app connects to the relay (`wss://agent-deck.xianqiao.wang/ws` in production builds) and the session list appears.

## Development

```sh
pnpm install
pnpm run dev          # browser preview
pnpm run tauri dev    # desktop
pnpm run tauri android dev  # Android device/emulator
```

### Checks before commit

```sh
pnpm run lint:check   # Biome
pnpm run check        # TypeScript strict
pnpm run build        # frontend bundle
```

Husky runs Biome on staged files via lint-staged; install dependencies once to enable it.

## Project structure

- `src/` — Gem + Tap UI frontend: menu, session, settings pages, relay transport, ACP session state.
- `src-tauri/` — Tauri 2 native shell and generated Android/iOS projects.
- `public/` — static brand assets copied by Rsbuild.

[browser4agent]: https://github.com/mantou132/browser4agent
[relay]: https://github.com/mantou132/relay
