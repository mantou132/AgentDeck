---
name: courseware
description: Build interactive primary school math courseware for a teacher from the AgentDeck client — single-file interactive links (交互式链接) that let students explore one idea on the classroom whiteboard (e.g. unfolding a cuboid in 3D, dragging a number line), and full lesson decks from the bundled template with hands-on manipulatives (number line, fractions, clock, geoboard, counter, column arithmetic, charts, spinner), exercises, classroom tools and a lesson plan. Use whenever the user wants an interactive link, a math lesson, an open class (公开课 / 赛课), courseware (课件), a lesson plan (教案) or a classroom interactive.
---

# Interactive math courseware

The user is a primary school math teacher, or someone helping one, reading your replies in the AgentDeck app, usually on a phone. They know the class and the textbook; you do the building. The result must be usable in class as it is: correct math, the textbook's own wording, readable from the back row, and nothing that breaks on a school computer. Keep replies short, decide details yourself within what they asked, and say in a line what you assumed.

## Workspace

Each lesson has its own folder `~/Courseware/<YYYY-MM-DD>-<topic>/`, whatever the session's working directory:

- `sources/`: what the user sent (textbook pages, an old deck, the school's lesson plan form), copied unchanged; attachments arrive in a temporary folder that gets cleared.
- `brief.md`: what the user asked for, in their words, plus the answers to your questions.
- `plan.md`: the lesson plan (教案), below.
- `index.html` and `assets/`: the source, copied from the template, below.
- `<topic>.html`: the single-file deliverable built from the source (see Handing it over), e.g. `长方体的展开图.html`.
- `notes.md`: what's decided, what the user changed, what's still open, so the next session picks up without asking again.

At the start of a session, if the user refers to a lesson that has a folder, read it and continue; don't re-ask anything recorded. List `~/Courseware/` when it's unclear which lesson they mean.

## What to build

Teachers mostly ask for one of two things; tell from the request, and ask only when it's unclear:

- **An interactive link (交互式链接)**: one page for one idea, opened on the whiteboard at the point of the lesson where students explore, while the rest of the lesson stays in the teacher's own 希沃白板 or PPT deck. For example a 3D cuboid that students rotate, cut edge by edge and unfold, recording each net they find; a number line to jump along; a fraction wall to compare. This is the most common request, especially for open classes and 赛课. Build it as a one-slide deck from the template (it keeps the toolbar's pen, timer and picker), the interactive filling the slide.
- **A whole lesson deck**: slides for the full lesson, below.

## Flow

1. **Brief**: ask only what's missing, in one message: grade, textbook edition (人教版 / 北师大版 / 苏教版 / 青岛版 …), unit and lesson, length (usually 40 minutes), and whether it's an open class (公开课 / 评优课, observed and judged) or an ordinary lesson. Use sensible defaults for the rest and say what you assumed.
2. **Research**: with web search, find this lesson's actual textbook content (例题, 做一做, 练习 numbers and pictures) and the curriculum standard (义务教育数学课程标准 2022): goals, key and difficult points (重难点), the core competencies it serves (数感, 量感, 符号意识, 运算能力, 几何直观, 空间观念, 推理意识, 数据意识, 模型意识, 应用意识, 创新意识), what students learned before and what comes after, and common misconceptions. Prefer the textbook pages the user sends over search results. Don't invent what the book says; mark what you couldn't confirm.
3. **Plan**: for a whole deck, write `plan.md` and show a short outline before building: goals, key and difficult points, and the stages with minutes and the slide or manipulative each uses. For an interactive link, describe in a few lines what students will do with it and what they should discover. Wait for the user's OK or changes.
4. **Build** the courseware from the template, then **check** it (below) before showing it.
5. **Show**: build the single file, then show it with an `agentdeck-preview` block when that skill is available (the path of `<topic>.html`, not edge to edge), else the path; then two or three lines on how to use it in class.
6. **Adjust**: the user tries it or rehearses; update the deck, plan and notes, re-check, and only describe what changed. On request, add the teacher's words per slide or a 说课稿 to `plan.md`.

## Designing the lesson

- Shape: a hook from students' lives or a story (情境导入, 3–5 min); exploration where students find the idea themselves, by hand and on the board (探究新知, 15–20 min); layered practice, basic → varied → stretch (分层练习, 10–15 min); a summary students say in their words (课堂小结, 3–5 min). Adjust to the lesson type: a 练习课 or 复习课 is mostly practice.
- Open classes are judged on student thinking: let the exploration be the centrepiece with one strong manipulative used by students at the board, questions that make them explain why (说一说你是怎么想的), and comparison of different methods. Avoid slides that just tell the answer.
- One idea per slide, a question students can act on, and the answer behind a step (`data-step`) so the teacher controls when it appears.
- Use the textbook's own examples first, then your own variations; numbers must stay within what the grade has learned.
- An interactive must be usable without explanation: a short on-screen hint of what to do (拖动旋转, 点击棱剪开 …), undo and reset, an automatic demo the teacher can play when students are stuck, and where it fits, a record of what students found (each net discovered, each answer tried) so the class can compare.

## The template

Copy `template/` next to this file into the lesson folder (`cp -R <this skill>/template/. ~/Courseware/<folder>/`). Never edit the template in place: it is rewritten whenever agentdeckd restarts. Read `template/gallery.html` for every manipulative's markup, then delete `gallery.html` and `README.md` (notes for maintaining the template) from the lesson copy. Edit only `index.html` for the lesson; touch `assets/` only to fix a bug or change the colors in `:root` of `courseware.css`.

The deck is plain HTML on a 1920×1080 stage scaled to any screen. Each `<section class="slide">` inside `<main id="cw-stage">` is a slide; the script tags at the bottom stay in that order.

**Built in, nothing to add**: arrow keys, PageUp / PageDown, Space and Enter (clickers / 翻页笔), swipe on touch screens, `F` or F5 for full screen, `B` or `.` for a black screen, a toolbar at the bottom right (previous / next, page number, 画笔 pen with colors and eraser, 计时 countdown with a beep, 点名 random picker by name list or student numbers without repeats, 重置 resets the current slide, 全屏), `#3` in the URL opens slide 3.

**Slide content** (classes in `courseware.css`):

- `class="slide title"` for the cover with `<h1>` and `.subtitle`; other slides start with `<h2>`, optionally with `<span class="tag">情境导入</span>` (`.tag.accent`, `.tag.good` for other colors).
- Layout: `.cols` (side by side), `.center` (centred column), `.row`, `.fill` (takes the remaining height, centres its content), `.card` (`.primary`, `.accent`, `.good`).
- Text: body is 40px; `.big` (72px), `.huge` (120px numbers), `.small`, `.muted`, `.primary-text`, `.accent-text`, `.good-text`, `.bad-text`, `.mark` (highlight a key word), `.blank` (a fill-in blank).
- Math: fractions `<span class="frac"><span>3</span><span>4</span></span>`; write ×, ÷, −, ＝, ≈, ＜, ＞, °, ² as characters, never `*`, `/` or `x`. `.math` keeps an expression on one line.
- Steps: `data-step` on any element hides it until the next click; they appear in document order, or set numbers (`data-step="2"`) to reorder, with equal numbers appearing together. Don't mix numbered and unnumbered steps on one slide. Going back to a slide shows all its steps.
- Multiple choice: `<ol class="choices"><li data-correct>…</li><li>…</li></ol>`; tapping marks right or wrong, tapping again clears. `.one-col` for long options.
- Sorting and matching: `data-drag="a"` on items and `data-drop="a"` (space-separated, `*` for any) on zones; a right drop turns green, a wrong one shakes and returns. Without drop zones items just move freely (`data-snap="40"` snaps to a grid), e.g. to cut and rearrange shapes drawn in SVG.

**Manipulatives** (custom elements; inside a choice or a draggable card they are just pictures):

- `<cw-number-line min max step points="3,8" hops fractions="4" label-every snap width hide-readout>`: draggable points; `hops` draws jumps with their difference; `fractions="n"` makes ticks at 1/n with fraction labels.
- `<cw-fraction shape="circle|bar|grid" parts shaded size rows color controls hide-readout>`: tap a part to shade it; `controls` adds buttons to change the number of parts.
- `<cw-clock time="3:00" snap="5" size hide-readout>`: drag the minute hand (the hour hand follows) or the hour hand; a button hides or shows the time.
- `<cw-geoboard cols rows cell points="1,1 6,1 6,4" show="area perimeter lengths angles" unit="cm">`: drag the vertices on the grid; without `points` students tap squares to count area.
- `<cw-counter places="4" value="1309">` (计数器): tap above the beads to add one, tap the beads to take one away; ten beads on a rod show 满十进一.
- `<cw-bar-chart items="苹果,香蕉" values="0,0" unit="人" tally>`: tap a bar to add one, with an undo; `tally` writes 正 marks.
- `<cw-spinner sectors="红,红,黄,蓝">`: spin once or ten times quickly; counts the results (possibility lessons).
- `<cw-column a="358" b="267" op="+|-|×" steps>` (竖式): the textbook layout with carries and borrow dots; `steps` reveals the answer digit by digit from the right (partial products row by row for ×). `+` and `−` take decimals; `×` takes whole numbers. Division and other layouts: draw them in SVG with `data-step`.

When a lesson needs something else (a ruler, a protractor, symmetry, a balance), draw it in inline SVG on the slide and use `data-drag` / `data-step`, or add a small script at the end of `index.html` in the same style as `assets/manipulatives.js`. Figures you don't draw must be free to use; prefer SVG.

**3D** (solids, nets, views from different sides, stacking cubes): use three.js loaded from a CDN, in an inline module script at the end of `index.html`:

```html
<script type="importmap">
{ "imports": {
  "three": "https://registry.npmmirror.com/three/0.170.0/files/build/three.module.min.js",
  "three/addons/": "https://registry.npmmirror.com/three/0.170.0/files/examples/jsm/"
} }
</script>
<script type="module">
  import * as THREE from 'three';
  import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
  // put the renderer's canvas in an element on the slide
</script>
```

npmmirror is fast in China and sends the CORS headers a `file://` page needs; `https://esm.sh/three@0.170.0` works the same way elsewhere. Pin the version. Keep module code inline: a `file://` page can import modules from `https://` but not from its own folder. Size the renderer to its element on the slide and pick objects with `getBoundingClientRect()`, since the stage is scaled. If the library hasn't loaded within a few seconds, show a clear message on the slide (需要联网才能显示立体模型) instead of a blank area. Use other libraries only when the lesson really needs them, in the same way.

**Compatibility**: school computers are often offline, old or locked down. Everything except a library like three.js stays in the file (no web fonts, remote images or other CDN scripts), so the page opens offline; a page that loads three.js needs the classroom computer online, so say so when you hand it over. Template code uses plain `<script>` tags and nothing newer than ES2017. Pages work in Chrome, Edge, 360 or QQ Browser (极速模式) and the browser on a Seewo / Hite whiteboard, not in Internet Explorer; 3D pages also need WebGL and import maps (Chrome 89 or newer).

## Checking before you show it

Open every slide of the single file in a headless Chromium browser installed on this machine at 1920×1080, with `?steps=all&toolbar=0#<n>` in the URL (all steps shown, no toolbar), take screenshots, and look at each one. For WebGL in headless Chromium add `--use-angle=swiftshader --enable-unsafe-swiftshader`, and give 3D pages time to load (`--virtual-time-budget=10000`). Then drive the interactives with a browser automation tool when one is available (drag, tap, undo, reset, the demo) and check they respond:

- Nothing overflows the slide, overlaps or is cut off; text is large enough; Chinese line breaks don't strand a single character.
- Every number, answer, figure and unit is right: work each exercise out yourself, check `cw-column` and geoboard readouts against your answer, and match the textbook's wording and notation.
- The browser console has no errors.

Fix and re-check until clean. Delete the screenshots afterwards.

## Handing it over

- The deliverable is one file, `<topic>.html`, so the teacher can send it on WeChat or copy it to a USB drive and open it by double-clicking. Build it from `index.html` after every change: replace `<link rel="stylesheet" href="assets/courseware.css">` with a `<style>` holding that file's contents, and each `<script src="assets/….js"></script>` with a `<script>` holding that file's contents, in the same order; keep CDN imports as they are. Check the built file, not `index.html`. Say how to use it in one line the first time.
- Other formats on request: a PDF of the slides by printing with headless Chromium (`--headless --no-pdf-header-footer --print-to-pdf=lesson.pdf index.html`; every slide one 16:9 page with all steps shown, manipulatives as still pictures); a PPTX by putting the slide screenshots one per page with `python-pptx` when it's installed (say that interactives become pictures, and offer to install it if missing); the lesson plan as `.docx` with `pandoc plan.md -o plan.docx` or as a PDF.

## The lesson plan

`plan.md` follows the usual 教案 layout unless the user's school has its own form (then fill that): title, grade and edition; 教材分析; 学情分析; 教学目标 (knowledge and skills, process and methods, attitudes, written as what students will be able to do); 教学重点 and 教学难点; 教具学具; 教学过程 as stages with minutes, teacher activity, student activity, the design intent (设计意图) and the slide numbers; 板书设计; and an empty 教学反思 for the teacher.

## Rules

- Math must be correct and fit the grade: only terms, symbols and methods students have learned by this lesson in this edition.
- Students' names, photos or other personal details go nowhere in the files; names pasted into the picker stay in that browser only.
- Talk to the user in their language and keep replies short.

## Learned notes

`{{LEARNED_PATH}}` holds what earlier sessions on this machine learned about doing this skill's work. If it exists, read it before following this skill. Where a note and this skill disagree, follow the note; where a note and the user disagree, follow the user and fix the note.

Keep it up to date yourself:

- Add a note only for something the user corrected, or something you did and confirmed works: a missing or wrong step, how a tool or site actually behaves, a pitfall. No guesses, and nothing about the user or the task at hand (their details, preferences and content belong in the task's own files).
- One line per note, written as a rule to follow, ending with the date and the evidence, e.g. `(2026-11-13, user corrected)`.
- At most 20 notes: when full, merge similar ones and drop the least useful before adding one.
- When following a note fails or the user says it's wrong, fix or delete it right away; delete notes this skill now covers.
- When the user asks to clear the notes, delete the file.
