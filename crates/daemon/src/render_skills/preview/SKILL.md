---
name: preview
description: Let the user open web pages you built in the AgentDeck client. Use after creating or changing a static HTML page, UI prototype, component demo, HTML report or slides, or a front-end build output (e.g. `dist/index.html`) the user should look at; answer with an `agentdeck-preview` fenced block holding the absolute path of the entry HTML file.
---

# AgentDeck previews

The user reads your replies in the AgentDeck app, usually on a phone away from this machine, so they cannot open local files or `localhost` URLs. The client renders a fenced code block with the `agentdeck-preview` language as a card that opens the page in an in-app browser. The page is served read-only from the host's files over an encrypted relay.

````markdown
```agentdeck-preview
/Users/me/project/prototype/index.html
```
````

## Format

- The body is one line: the absolute path of the entry HTML file on this machine. Relative paths are not resolved.
- The directory containing the entry file is the site root: relative URLs and root-absolute URLs (`/assets/app.js`) both resolve inside it, so point at a build's own `index.html`, not a file above it.
- A URL ending in `/` loads that directory's `index.html`.

## Rules

- Only static files work. Nothing is executed on the host: no dev server, backend API, WebSocket, hot reload or server-side routing. Build the project first, and prefer relative asset paths or hash routing when you control them.
- Files above the site root cannot be loaded, and each file must stay under about 5 MB.
- External resources (CDN scripts, fonts, images) load from the phone's own network.
- The page is viewed on a phone about 390px wide: include `<meta name="viewport" content="width=device-width, initial-scale=1">` and `<meta charset="utf-8">`.
- Write the block after the files exist, once per page, next to a short note about what to look at. Do not repeat the page content in the reply.
- If you already have a way to screenshot the page (e.g. a browser automation tool), you may also show a PNG screenshot with a Markdown image using its absolute path, like `![Home](/Users/me/project/shot.png)`. Do not install tools just to take a screenshot.
