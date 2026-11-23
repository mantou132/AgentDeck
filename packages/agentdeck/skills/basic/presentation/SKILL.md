---
name: presentation
description: Write a talk for the user from the AgentDeck client — the speech script (演讲稿 / 发言稿) timed to their slot and the slides to present it, as one HTML file that runs offline in any browser, with optional audience interaction on phones (scan a QR code to vote, send words to a word cloud, rate the talk, ask and upvote questions, send emoji reactions, draw a lucky winner). Use whenever the user wants to prepare a speech, talk, keynote, sharing session (分享会), pitch (路演), defence (答辩), training, annual-meeting speech (年会致辞), a presentation or slides (PPT) for one, or wants their audience to interact live. Not for math lessons (use courseware).
---

# Talks with an interactive deck

The user is giving a talk and reads your replies in the AgentDeck app, usually on a phone. They know the topic, the audience and the occasion; you do the writing and building. The result must hold up on stage as it is: the script fits the time slot when read aloud, every fact is right, the slides read from the back row, and the deck opens on the venue's computer. Keep replies short, decide details yourself within what they asked, and say in a line what you assumed.

## Workspace

Each talk has its own folder `~/Presentations/<YYYY-MM-DD>-<topic>/` (the date of the talk if known, else today), whatever the session's working directory:

- `sources/`: what the user sent (notes, an old deck, reports, photos, a logo), copied unchanged; attachments arrive in a temporary folder that gets cleared.
- `brief.md`: what the user asked for, in their words, plus the answers to your questions.
- `script.md`: the speech script, below.
- `index.html` and `assets/`: the deck source, copied from the template, below.
- `<title>.html`: the single-file deck built from the source (see Handing it over).
- `notes.md`: what's decided, what the user changed, rehearsal timings, what's still open, so the next session picks up without asking again.

At the start of a session, if the user refers to a talk that has a folder, read it and continue; don't re-ask anything recorded. List `~/Presentations/` when it's unclear which talk they mean.

## Flow

1. **Brief**: ask only what's missing, in one message: the occasion and audience (who, how many, what they already know), the length of the slot in minutes, the one thing the audience should take away, the language, and whether they want the audience to interact on phones (then: does the audience have phones and the venue internet). Use their materials for everything else; for a short speech with no slides wanted (a toast, 致辞), write only the script.
2. **Material**: work from what the user sent. Look up facts, numbers and quotes with web search when the talk needs them, cite the source on the slide or in the script, and mark what you couldn't confirm. Never invent statistics, quotes, stories about real people or the user's own experiences: leave a clear placeholder (【这里讲一个你自己的例子：…】) for the user to fill.
3. **Outline**: show a short outline before writing: the key message in one sentence, the sections with minutes each, the opening hook and the closing line, and where the audience interacts. Wait for the user's OK or changes.
4. **Build** the deck from the template, embedding the spoken script and cues directly into `<aside class="notes">` in each slide (serving as the single source of truth for both slides and the mobile teleprompter). Run `node assets/export-script.js index.html` to generate `script.md` automatically without wasting LLM output tokens on duplicate writing. Then **check** before showing.
5. **Show**: build the single file, show it with an `agentdeck-preview` block when that skill is available (the path of `<title>.html`), else the path; give the script's spoken length; then two or three lines on presenting it (keys, where the interactions are).
6. **Adjust**: the user rehearses or reads; update `index.html` (and re-run `export-script.js`), re-check, and only describe what changed. When they report a rehearsal time, cut or add to fit and record it in `notes.md`.

## Writing the script

- Write for the ear, in the user's voice: short sentences, plain words, concrete examples, signposts (第一…; 说完问题，我们看办法 / "First...; having looked at the problem, let's explore the solution"), and repetition of the key message at the start and the end. No lines the speaker would never say aloud.
- Shape: an opening that earns attention in the first 30 seconds (a question, a story, a surprising number, an interaction), a body of at most three sections each with one point and its support, and a closing that returns to the key message and says what to do next. For a pitch: problem, solution, proof, ask. For a defence or report: conclusion first, then evidence.
- Fit the time: about 220 Chinese characters or 130 English words per minute of speech, minus the time interactions take (a poll or word cloud about 2 minutes, a Q&A as long as the user wants it). State the estimated length at the top.
- Cross-language delivery: when the speaker presents in a non-native language (e.g. an English keynote or pitch by a Chinese speaker), add pronunciation cues for tricky proper nouns/terms in `script.md`, explicit pause marks `//`, and natural holding phrases for Q&A (e.g. "That's a great question; to clarify...", "Let's connect offline on that specific detail").
- `script.md` follows the slides: a heading per slide (`## 3 · 先问大家`) with what to say while it is on screen, and cues in brackets for what to do: 【翻页】, 【点击出现下一条】, 【停顿】, 【请大家扫码】, 【看投票结果，读出最多的选项】 / [Next slide], [Click for next step], [Pause], [Ask audience to scan]. Interaction slides get what to say before, while waiting and after, including a line for when nobody answers.

## Designing the slides

- Slides support the speech, they don't repeat it: one idea per slide, a few words or one number or one picture, a heading that states the point (会议少了一半，产出没少 / "Meetings halved, output steady") rather than a topic (数据 / "Data"). Text is never smaller than the template's body size.
- Text density: English phrases expand significantly compared to Chinese; keep slide titles short and concise so long words don't wrap awkwardly or crowd out chart/image stage space. Always set the proper `<html lang="en">` (or `"zh"`) on `index.html` so typography, toolbar, and audience interaction adapt seamlessly.
- Prefer the template's talk layouts: a cover, section dividers between parts, statement slides for the lines to remember, big numbers, quotes, full-bleed pictures, an agenda when the talk is longer than 15 minutes, and a closing slide with the takeaway and contact.
- Reveal lists and comparisons item by item with `data-step` as the speech reaches them.
- Charts: a few bars or a trend drawn in inline SVG or as CSS bars with labelled values; check every number against the source.
- Pictures: the user's photos, screenshots and logo go in `assets/img/` (convert HEIC to JPEG, shrink to at most 1920 px wide with `sips -Z 1920` or ImageMagick). Don't use pictures from the web unless they are free to use and the user agrees; never hotlink. Without pictures, the type-only layouts look intentional, so don't fill space with clip art.

## The template

Copy `template/` next to this file into the talk folder with symlinks resolved (`cp -RL <this skill>/template/. ~/Presentations/<folder>/`); `-L` is essential because files in `assets/` link to `_shared/deck/`. Never edit the template in place: it is rewritten whenever agentdeckd restarts. Read `template/index.html` first, a sample talk using every layout and interaction, then replace its slides with the talk; delete `README.md` (notes for maintaining the template) from the copy. Edit only `index.html` for the talk; touch `assets/` only to fix a bug or to change the colors in `:root` of `presentation.css` (e.g. to the user's brand colors; keep enough contrast for a projector).

The deck is plain HTML on a 1920×1080 stage scaled to any screen. Each `<section class="slide">` inside `<main id="cw-stage">` is a slide; the script tags at the bottom stay in that order.

**Speaker notes & Teleprompter**: place `<aside class="notes">` at the bottom of each slide with the spoken speech and bracketed cues (e.g. `【翻页】`, `【停顿 2 秒】`, `【请大家扫码】` / `[Next slide]`, `[Pause]`). On mobile / touch screens or with `?mode=prompter`, the deck automatically enters Teleprompter mode with dark high-contrast large font, highlighted action badges, slide preview toggle, keep-awake (Wake Lock + video fallback), and stage timer. On desktops / projectors, presentation remains clean without any teleprompter buttons (press `N` to toggle during rehearsal).

**Built in, nothing to add**: arrow keys, PageUp / PageDown, Space and Enter (clickers / 翻页笔), swipe on touch screens, `F` or F5 for full screen, `B` or `.` for a black screen, `N` for speaker teleprompter, a toolbar at the bottom right (previous / next, page number, pen / 画笔, countdown timer / 计时, random draw / 抽奖 by name list or scanned phones, reset / 重置, fullscreen / 全屏), `#3` in the URL opens slide 3.

**Slide types** (classes on the `<section>`, styles in `presentation.css` over `deck.css`):

- `slide title`: cover and closing slide, dark: `<h1>` (an `<em>` inside is accent colored), `.subtitle`, `.byline` (speaker · event or contact).
- `slide section`: a dark divider, `<span class="num">01</span><h2>…</h2>`.
- `slide statement`: one centred sentence, `<p>…<em>…</em></p>`.
- `slide` with `<blockquote>…<cite>— who, where</cite></blockquote>` for a quote.
- `slide image`: `<img class="cover" src="assets/img/…">` fills the slide, `<p class="caption">` over its bottom.
- `slide dark`: any content slide on the dark background.
- Ordinary slides start with `<h2>`, optionally preceded by `<p class="kicker">` (a small accent label). Inside: `.stats` with `.stat` items (`<b>` big number, `<span>` label); `<ol class="agenda">`; `.cols` (side by side), `.center`, `.row`, `.fill` (takes the remaining height, centres its content), `.card` (`.primary`, `.accent`, `.good`); text `.big`, `.huge`, `.small`, `.muted`, `.primary-text`, `.accent-text`, `.good-text`, `.mark`; `data-step` on any element to reveal it on the next click (numbers like `data-step="2"` reorder, equal numbers appear together); `<ol class="choices"><li data-correct>` for a quiz on the screen; `<span class="tex">` for LaTeX (typeset by KaTeX from a CDN, so online only).

**Audience interaction** (扫码互动, only when the user wants it; needs the presenting computer and the phones online): `assets/live.js` is already loaded in the template; remove its script tag if the talk has no interaction. The audience scans a QR code, which opens the AgentDeck audience page in their phone's browser (localized to `/en/live` or `/zh/live` based on the deck's `<html lang>`); nothing to install. Each phone gets a number (`1 号`, `2 号` or `#1`, `#2`) that stays the same for this deck, and the draw tool picks winners and pops `你被抽到了！` / `You won!` up on the winner's phone.

- `<cw-live-join>`: a big QR code and how many have joined; its own slide right after the cover or the opening, with the speaker asking everyone to scan.
- `<cw-poll options="A,B,C" correct="2" multiple qr>`: a vote with live bars; `correct` (1-based) only for a quiz, then 公布答案 marks it.
- `<cw-wordcloud max="2" placeholder="…" qr>`: everyone sends up to `max` short words, shown as a live word cloud (the same word grows); tap a word to hide it.
- `<cw-rating max="5" qr>`: stars (`max` up to 5) or 1–`max` scores (up to 10), with the average and the distribution; a good last slide before the closing.
- `<cw-responses type="text|number" qr>`: short sentences as cards, or numbers with min, max and average.
- `<cw-questions qr>`: its slide is the Q&A. With it anywhere in the deck, every phone has a 提问 button from the start, so the audience can ask and upvote during the whole talk; on its slide the questions show by votes, tap one to mark it as being answered (shown big and on the phones), × hides one. Put it on a `slide dark` with only an `<h2>`.
- `<cw-reactions emoji="👏,❤️,😂,😮,🤔">`: once, anywhere (the cover is fine); every phone then shows these emoji at the bottom, and each tap floats up the right side of the screen on any slide.
- The question the phones show is the slide's `<h2>`, or `question="…"`, so keep one interaction per slide. `qr` adds a small QR code for latecomers.
- Two to four interactions in a 20-minute talk are plenty; each needs its time in the script. Keep a way through without them (a show of hands) in case the venue is offline.
- For a lucky draw (抽奖), the speaker presses 抽奖 in the toolbar (or `R`); say in the script when.

**Compatibility**: venue computers are often offline, old or locked down. Everything stays in the file (no web fonts, remote images or CDN scripts other than the QR code library of `live.js` and KaTeX), so a deck without interaction opens offline; one with interaction needs the internet, so say so when you hand it over. Template code uses plain `<script>` tags and nothing newer than ES2017. Decks work in current Chrome, Edge, Safari and Firefox and in 360 or QQ Browser (极速模式), not in Internet Explorer.

## Checking before you show it

- Read the script once as the audience would hear it: every slide has its lines, cues match the slides and steps, the estimated length fits the slot, and no placeholder is left that the user hasn't been told about.
- Open every slide of the single file in a headless Chromium browser installed on this machine at 1920×1080, with `?steps=all&toolbar=0#<n>` in the URL (all steps shown, no toolbar), take screenshots, and look at each one: wait about 1 second before capturing or pass `--virtual-time-budget=3000` so CSS entrance animations complete; nothing overflows, overlaps or is cut off; text is large enough; Chinese line breaks don't strand a single character; every number and name matches the script and the sources; the browser console has no errors.
- Fix and re-check until clean. Delete the screenshots afterwards.

## Handing it over

- The deliverable is one single file, `<title>.html`, so the user can send it or open it anywhere offline. Build it after every change using the bundled script: `node assets/bundle.js index.html -o <title>.html` (it automatically inlines local CSS, JS, and converts images to Base64 while preserving CDN imports). Check the built file, not `index.html`. Say how to present it in one line the first time.
- The script: `script.md` extracted automatically from the deck via `node assets/export-script.js index.html -o script.md`, or on request a `.docx` with `pandoc script.md -o script.docx` (big font for reading on stage: add `-V fontsize=14pt` for PDF) or a PDF.
- Other formats on request: a PDF of the slides using `node assets/export-pdf.js index.html slides.pdf --landscape --wait=3000`; a PPTX by putting the slide screenshots one per page with `python-pptx` when it's installed (say that interactions become pictures, and offer to install it if missing).

## Rules

- Facts, numbers, names and quotes must be right and sourced; the user's own stories come from the user.
- Personal details of the audience go nowhere in the files; names pasted into the draw stay in that browser only.
- Talk to the user in their language and keep replies short; write the script and slides in the language of the talk.

## Learned notes

`{{LEARNED_PATH}}` holds what earlier sessions on this machine learned about doing this skill's work. If it exists, read it before following this skill. Where a note and this skill disagree, follow the note; where a note and the user disagree, follow the user and fix the note.

Keep it up to date yourself:

- Add a note only for something the user corrected, or something you did and confirmed works: a missing or wrong step, how a tool or site actually behaves, a pitfall. No guesses, and nothing about the user or the task at hand (their details, preferences and content belong in the task's own files).
- One line per note, written as a rule to follow, ending with the date and the evidence, e.g. `(2026-11-13, user corrected)`.
- At most 20 notes: when full, merge similar ones and drop the least useful before adding one.
- When following a note fails or the user says it's wrong, fix or delete it right away; delete notes this skill now covers.
- When the user asks to clear the notes, delete the file.
