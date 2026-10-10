# Privacy Policy for AgentDeck

Last updated: October 9, 2026

AgentDeck is an open-source Agent Client Protocol (ACP) client developed by mantou132. It consists of the AgentDeck app, the AgentDeck browser extension, and the `agentdeckd` daemon that runs on a computer you control. This policy explains what data these components handle.

## 1. What We Do Not Collect

AgentDeck contains no analytics, advertising, or tracking SDKs. We do not sell data or use it for advertising, and we do not build user profiles.

## 2. Data Stored on Your Devices

- **App and extension**: settings (Pairing ID, custom relay URL, selected agent), a randomly generated device ID, unsent drafts and attachments, and cached session data for in-progress tasks. This data stays in local storage on your device and is removed when you reset the app or uninstall it.
- **Daemon**: the Pairing ID and relay settings, the connected device IDs and notification tokens, and logs. These are stored in the daemon's data directory on your computer. Your agents keep their own session history according to their own policies.

## 3. Relay

The app, the extension, and the daemon communicate through a WebSocket relay: the default relay at `wss://agent-deck.xianqiao.wang/ws`, or a relay you host yourself.

- With `adk1_` Pairing IDs, messages are end-to-end encrypted. The relay only receives ciphertext, a routing ID derived from the Pairing ID, device IDs, and connection metadata (IP addresses, timestamps, message sizes). It cannot read prompts, replies, or files.
- The relay stores undelivered encrypted messages temporarily and deletes them after delivery or when they expire.
- Legacy UUID Pairing IDs are not encrypted, so the relay can read their message contents.

## 4. Push Notifications

To tell you when a task is complete, the app registers with Firebase Cloud Messaging (FCM), a Google service, and sends its FCM token to your daemon. On iOS, FCM delivers notifications through Apple Push Notification service (APNs). When a task completes, the daemon sends the token, the agent ID, and the session ID to our notification forwarder (`agent-deck.xianqiao.wang/push`), which passes them to FCM. Notifications never contain prompts or replies. FCM processes the token under [Google's privacy policy](https://policies.google.com/privacy).

## 5. Permissions

- **Internet**: connects to the relay.
- **Notifications**: shows task completion notifications.
- **Camera**: scans the pairing QR code. Images are processed on your device and are not stored or uploaded.
- **Microphone**: used only when you start voice input. Speech is recognized by your device's system speech service, which may process audio according to its own provider's policy, and the recognized text is inserted into the input box.
- **Browser extension**: `storage` saves settings locally and `sidePanel` shows the panel. The DevTools panel passes only the ID of the inspected tab to your agent session. The extension does not read or collect web page content.

## 6. Your Agents

Prompts and files you send are processed by the agents running on your computer (for example Claude Code or Codex), which may send them to their model providers. That processing is governed by those agents' and providers' own terms and privacy policies, not by AgentDeck.

## 7. Contact Us

If you have questions about this Privacy Policy, email [contact@xianqiao.wang](mailto:contact@xianqiao.wang) or open an issue at https://github.com/mantou132/AgentDeck.
