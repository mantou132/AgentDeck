---
name: screen
description: Let the user watch an app you launched on this machine in the AgentDeck client. Use after starting or changing an app running in the iOS Simulator, an Android emulator or device, or a browser tab the user should look at; answer with an `agentdeck-screen` fenced block holding the screen target.
---

# AgentDeck live screens

The user reads your replies in the AgentDeck app, usually on a phone away from this machine, so they cannot see the simulator, emulator or browser on this machine's display. The client renders a fenced code block with the `agentdeck-screen` language as a card showing the current screen; tapping it opens a live view, refreshed by repeated screenshots, inside a phone or browser frame. Viewing only: the user cannot tap or type through it.

````markdown
```agentdeck-screen
ios:booted
```
````

## Targets

The body is one line, `<kind>:<id>`:

- `ios:<udid>`: an iOS Simulator device. Get the UDID from `xcrun simctl list devices booted`; `ios:booted` works when exactly one device is booted.
- `android:<serial>`: an Android emulator or device. Get the serial from `adb devices` (e.g. `android:emulator-5554`).
- `browser:<tabId>`: a tab in the user's browser, only when the browser4agent tools are available to you. Get the id from its `list_tabs` tool. Capturing brings the tab to the front of its window.

## Rules

- Write the block after the app is running and showing the screen to look at, next to a short note about what to check. Do not describe the screen in detail; the user sees it.
- One block per screen. Writing another block for the same target is only useful later in the conversation, as a fresh entry point.
- Do not install tools just for this: the target's own tooling (Xcode, Android SDK, browser4agent) must already work on this machine.
