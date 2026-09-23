# agentdeckd

Run and manage local ACP agents from [AgentDeck](https://github.com/mantou132/AgentDeck) on your phone or browser.

Requires Node.js 22 or newer. Supports macOS arm64/x64, Linux x64 with glibc, and Windows x64. Linux arm64 and Alpine/musl are not included.

```sh
npm install -g agentdeckd
agentdeckd start
```

Paste the Pairing ID into AgentDeck's Settings. Keep it secret: anyone with it can access your agent.

The matching precompiled binary is installed as an optional dependency. No Rust toolchain, postinstall script, or GitHub download is needed. Do not omit optional dependencies.

## Upgrade and uninstall

Stop before upgrading, particularly on Windows where the running executable cannot be replaced:

```sh
agentdeckd stop
npm install -g agentdeckd@latest
agentdeckd start
```

Autostart uses the binary's absolute path. After changing your Node installation or npm prefix, run the newly installed `agentdeckd restart` to register the new path and restart the daemon. Installation itself does not start or restart services.

Before uninstalling:

```sh
agentdeckd stop
npm uninstall -g agentdeckd
```

Use `agentdeckd --help` for commands and options.
