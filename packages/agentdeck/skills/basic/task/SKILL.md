---
name: task
description: Set up a scheduled task that AgentDeck runs on this computer at set times, in a new session of the same agent, directory and settings as this one. Use when the user wants something done regularly or later without them (every morning, on weekdays, every few hours — e.g. sort new mail, refresh a report, check for replies), or wants to change a task made in this session; answer with an `agentdeck-task` fenced block, instead of cron, launchd, systemd timers, Task Scheduler or your own scheduling tools.
---

# AgentDeck scheduled tasks

The AgentDeck client renders a fenced code block with the `agentdeck-task` language as a task card. Tapping it saves the task; AgentDeck's daemon on this computer then runs it on schedule, each run in a new session of the same agent, in the same directory and with the same session settings (model, mode) as this conversation. Nothing is scheduled until the user taps.

````markdown
```agentdeck-task
{
  "name": "Sort new mail",
  "prompt": "Check the inbox for mail that arrived since the last run. Label each as needs-reply, FYI or newsletter, and write a reply draft for each needs-reply one without sending it. End with one line: how many arrived and how many drafts you wrote.",
  "schedule": { "type": "daily", "times": ["09:00"], "weekdays": [1, 2, 3, 4, 5] }
}
```
````

## Format

- The body is one strict JSON object.
- `name`: a few words naming the task, shown in the task list.
- `prompt`: the full brief for each run. A run sees none of this conversation: name the files, accounts, pages or tools to use, what you already found works, what not to touch, and what done looks like. Ask for a last line stating the result; it becomes the run's summary on the phone.
- `schedule`, one of:
  - `{ "type": "daily", "times": ["HH:MM", …], "weekdays": [1, …] }`: at each time (24-hour, two-digit `HH:MM`) on the listed weekdays, 1 = Monday … 7 = Sunday; leave `weekdays` out for every day. Times and weekdays are the user's own, in the time zone of the device they chat from, which may differ from this computer's: write them as the user says them, without converting. The client saves that time zone with the task. Only when the user asks for another zone (e.g. this computer's time), add `"timeZone"` with its IANA name, such as `"America/New_York"`.
  - `{ "type": "interval", "minutes": N }`: every N minutes (at least 5), counted from when the task is saved.
- `timeoutMinutes` (optional, default 60): a run still going after this long is stopped.
- `retries` (optional, default 0): extra attempts after a failed or timed-out run.

## How runs behave

- Nobody watches a run. It must not ask the user questions. A permission request goes to the user's phone and is rejected if not answered within 30 minutes; the run carries on without that action.
- Actions the user chose "always allow" for in this directory run without asking. Before proposing the task, do one run's work here in this conversation so the user can grant what it needs; mention which actions will still ask each time.
- Runs need the computer awake with AgentDeck's daemon running. A run missed by up to 6 hours (e.g. the computer slept) runs once when it wakes; older ones are skipped.
- The phone gets a notification when a run finishes, with the run's session to read.

## Changing a task

This session owns one task: a new card here replaces it (name, prompt, schedule). When the user asks for a change, answer with the complete updated card. Pausing, running now and deleting are on the task's page in the client.

## Rules

- Only propose a task when the user wants something repeated or done unattended; one card per reply.
- Don't create schedules with other tools (cron, launchd, scripts that sleep) for what this card covers.
- Do not ask the user to confirm in text; the card is the confirmation.
