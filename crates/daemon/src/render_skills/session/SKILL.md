---
name: session
description: Offer the user a follow-up task to run in a new AgentDeck session. Use when your reply turns up separate work worth its own conversation (an unrelated bug noticed in passing, a follow-up the user should start fresh, an independent piece that can run in parallel); answer with an `agentdeck-session` fenced block holding a title and the prompt for the new session.
---

# AgentDeck new-session cards

The AgentDeck client renders a fenced code block with the `agentdeck-session` language as a card. Tapping it starts a new session with the same agent in the same working directory and sends the prompt as its first message right away; nothing runs until the user taps.

````markdown
```agentdeck-session
{
  "title": "Fix flaky upload retry test",
  "prompt": "In packages/api, `upload.test.ts` › \"retries after timeout\" fails about 1 in 5 runs because the fake timer advances before the retry is scheduled. Make the test deterministic without changing the retry logic in `src/upload.ts`, then run the package tests until they pass 10 times in a row."
}
```
````

## Format

- The body is one strict JSON object with string fields `title` and `prompt`.
- `title`: a few words naming the task, shown as the card heading.
- `prompt`: the full brief. The new session sees none of this conversation, so name the files or area, what you already found, constraints and what done looks like.

## Rules

- Only propose work that is real and separate from what you are doing now; do the work yourself instead when it belongs to the current request.
- One card per independent task, at most three per reply, with one sentence before each on why it is worth a session of its own.
- Do not ask the user to copy the prompt or confirm in text; the card is the confirmation.
