---
name: job
description: Help the user find a job from the AgentDeck client — collect their background, build a resume, check which job sites and mailboxes are reachable on this machine, search and apply in batches, and track every application. Use whenever the user wants to look for a job, change jobs, write or polish a resume or cover letter, apply to positions, or check how their applications are going.
---

# Job search

The user reads your replies in the AgentDeck app, usually on a phone away from this machine. They are looking for work, not configuring tools: keep each step short, ask only what the current step needs, and do the checking yourself. A job search runs over many sessions, so everything lives in one workspace you read at the start of each session and keep up to date.

## Workspace

Always `~/JobSearch/` (create it on first use), whatever the session's working directory:

- `sources/`: everything the user gave, unchanged. Copy files they send (attachments arrive as `file://` links in a temporary folder that gets cleared) and links' content; save facts they told you in chat as `sources/YYYY-MM-DD-chat.md`, in their words. Never edit or delete these.
- `profile.md`: your summary of the user: contact, target, experience, education, skills, achievements. Every fact links to where it came from, e.g. `Led a team of 6 ([source](sources/2026-11-13-chat.md))`. Update it when new material arrives; when sources disagree, ask.
- `preferences.md`: roles, cities or remote, salary, company types, deal-breakers, and the job sites the user chose.
- `resume/`: `resume.html` (the main version), `resume.pdf`, and tailored versions named `resume-<company>-<role>.html/.pdf`.
- `applications.json`: the tracker, below.
- `notes.md`: what's done and what's next, so the next session picks up without asking again.

At the start of every session, if the workspace exists, read `notes.md`, `preferences.md` and `applications.json` and continue from there; don't re-ask anything already recorded.

**Development mode**: if `~/JobSearch/skill-feedback.md` exists, the user is improving this skill while using it. Read it at the start of every session and follow the instructions at its top: they say what to record (gaps in this skill, job site behaviour, browser page tools to fix or add) and what you may do about it. Never create this file yourself.

## Flow

Don't walk the user through all of this at once. Finish the step at hand, say in one line what comes next, and let them steer.

1. **Start**: ask only three things: the kind of job they want, where (city or remote), and whether they have a resume (send the file, a link such as a LinkedIn profile, or just tell you about themselves). Save the answers and the material, then go straight to the resume.
2. **Resume**: write `profile.md` from the sources, then `resume/resume.html`: one page when the experience allows, clean print styles, in the language of the target market. Export the PDF with a headless Chromium browser installed on this machine (e.g. `"<Chrome or Edge binary>" --headless --no-pdf-header-footer --print-to-pdf=resume.pdf resume.html`). Show it with an `agentdeck-preview` block when that skill is available, else link the PDF, and ask what to change. Ask for missing facts only when they matter for the resume, and keep later details (expected salary, notice period, references) until an application needs them.
3. **Tools check**: do it yourself, then report one short list.
   - Browser: everything on job sites goes through browser tools that drive the user's real, logged-in browser (browser4agent's MCP tools or CLI skill; another browser automation tool you have also works). Without one, say that searching and applying need it, and that browser4agent is a browser extension (Chrome, Edge, Firefox) plus a local helper, installed on this computer from https://github.com/mantou132/browser4agent; meanwhile keep working on the resume and on applying by email.
   - Email: prefer a mail tool you already have (e.g. a Gmail MCP); otherwise check whether webmail (Gmail, Outlook, QQ Mail, 163 …) is logged in in the browser.
   - Job sites: ask which sites the user wants to use, suggesting the main ones for their market and field, and check each chosen site's login state by opening it (look for the user's avatar or name, not just cookies).
   - Page tools: browser4agent offers site-specific page tools (e.g. BOSS直聘, LinkedIn, Wellfound, Upwork, V2EX) that return structured jobs, chats and drafts instead of whole pages. On each job site, list the tools available for the tab and prefer them; if a site the user relies on has none, they can subscribe to more in the extension's Toolset Market.
4. **Login** for a chosen site that isn't logged in, one site at a time:
   - Open its login page and check for a human verification challenge (slider, picture puzzle, CAPTCHA, "verify you are human"). Never try to solve or bypass one: ask the user to finish that site on this computer when they are next at it, and carry on with the other sites.
   - Without a challenge, use whatever the page offers. QR code: take a screenshot of just the code, save it under `~/JobSearch/.login/`, and show it inline as a Markdown image (`![Login QR](/abs/path.png)`); the user screenshots it and scans it from their photos in the site's own app (or scans it from another device). Codes expire within minutes: when it's stale, refresh the page and send a new one. Phone or email code: ask for the number or address, fill it in, request the code, then fill in the code the user sends.
   - Confirm the login worked, then move on.
5. **Search**: search the chosen sites with the preferences, open promising postings and read the full description, and skip ones that hit a deal-breaker or are already in the tracker. Present a shortlist of about 5–10: company, role, location, salary when shown, a one-line reason it fits, any gap, and the link. With the `widget` skill, make it a checklist whose button sends the picked ones back with `agentdeck.send`; otherwise a numbered list the user answers with numbers. Add the shortlist to the tracker as `saved`.
6. **Apply in batches**: the user's pick is the go-ahead for that batch, so apply to each picked job without asking again, one by one. Use the site's own way (apply button, uploading the resume, the greeting message on chat-first sites — write one per job that ties the user's experience to the posting), or email the resume when the posting says so. Tailor the resume only when the posting calls for something the main one undersells. Stop and ask when a form needs an answer that isn't in the workspace (salary, visa, availability, a screening question), and record the answer in `preferences.md` for next time. Any message beyond the batch the user approved — follow-ups, replies to recruiters, emails to new addresses — needs their OK on the exact text. Update the tracker after each application, then report what went out and what failed.
7. **Follow up**: when the user asks how it's going, or at the start of a session with open applications, check the sites' messages and the mailbox for replies, update the tracker, and show a short summary: new replies first, then counts by status. Draft replies for the user to approve. For interviews, record the time and offer an `agentdeck-event` block when that skill is available; help them prepare from the posting and their profile.

## Tracker

`applications.json` is an array; keep fields short and dates as `YYYY-MM-DD`:

```json
[
  {
    "id": "boss-1234567",
    "company": "Acme",
    "role": "Frontend Engineer",
    "location": "Shanghai",
    "salary": "30-45K",
    "source": "BOSS直聘",
    "url": "https://…",
    "status": "applied",
    "resume": "resume/resume.pdf",
    "updated": "2026-11-13",
    "next": "Wait for reply",
    "history": [
      { "date": "2026-11-12", "status": "saved", "note": "Fits: React + team lead" },
      { "date": "2026-11-13", "status": "applied", "note": "Sent greeting" }
    ]
  }
]
```

`status` is one of `saved`, `applied`, `talking`, `interview`, `offer`, `rejected`, `withdrawn`. Every change adds a `history` entry. Use the posting's own id when the site has one, so the same job is never applied to twice.

## Rules

- Only facts from the sources go into a resume or an application. Improve the wording, never invent experience, numbers or skills; if something would help but isn't there, ask.
- Contact details and documents stay in the workspace and go only to the employers the user applies to.
- Respect each site: work at a human pace, stop when a site rate-limits or warns, and never get around paywalls or verification.
- Opening chats one by one is what most often trips a site's verification. Read the chat list first and judge from its previews; open only unread chats and those where the other side spoke last, a few seconds apart and at most about 20 per session, and say what's left for next time.
- Some sites ignore automated clicks on sensitive buttons (sending a resume, confirming a request). If a click changes nothing, don't retry it in other ways: tell the user exactly what to tap in the site's app.
- Talk to the user in their language and keep replies short; use tables or widgets for lists of jobs and statuses instead of long prose.
