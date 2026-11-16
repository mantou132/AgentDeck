---
name: courseware
description: Build interactive math courseware for a primary or junior high school (小学 / 初中, grades 1–9) teacher from the AgentDeck client — single-file interactive links (交互式链接) that let students explore one idea on the classroom whiteboard (e.g. unfolding a cuboid in 3D, dragging a number line, changing k and b of a linear function), and full lesson decks from the bundled template with hands-on manipulatives (number line, fractions, clock, geoboard, counter, column arithmetic, charts, spinner, function graphs, dynamic geometry, algebra tiles), formulas, exercises, scan-to-answer, classroom tools and a lesson plan. Use whenever the user wants an interactive link, a math lesson, an open class (公开课 / 赛课), courseware (课件), a lesson plan (教案) or a classroom interactive.
---

# Interactive math courseware

The user is a primary or junior high school math teacher (grades 1–9), or someone helping one, reading your replies in the AgentDeck app, usually on a phone. They know the class and the textbook; you do the building. The result must be usable in class as it is: correct math, the textbook's own wording, readable from the back row, and nothing that breaks on a school computer. Keep replies short, decide details yourself within what they asked, and say in a line what you assumed.

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

1. **Brief**: ask only what's missing, in one message: grade, textbook edition (小学: 人教版 / 北师大版 / 苏教版 / 青岛版 …; 初中: 人教版 / 北师大版 / 华师大版 / 湘教版 / 浙教版 / 苏科版 …), unit and lesson, length (usually 40 minutes), and whether it's an open class (公开课 / 评优课, observed and judged) or an ordinary lesson. Use sensible defaults for the rest and say what you assumed.
2. **Research**: with web search, find this lesson's actual textbook content (例题, 做一做, 练习 numbers and pictures) and the curriculum standard (义务教育数学课程标准 2022, which covers grades 1–9; it calls the core competencies 意识 in primary school and 观念 / 能力 in junior high, e.g. 空间观念 vs 空间意识, so use the wording of the stage): goals, key and difficult points (重难点), the core competencies it serves (数感, 量感, 符号意识, 运算能力, 几何直观, 空间观念, 推理意识, 数据意识, 模型意识, 应用意识, 创新意识), what students learned before and what comes after, and common misconceptions. Prefer the textbook pages the user sends over search results. Don't invent what the book says; mark what you couldn't confirm.
3. **Plan**: for a whole deck, write `plan.md` and show a short outline before building: goals, key and difficult points, and the stages with minutes and the slide or manipulative each uses. For an interactive link, describe in a few lines what students will do with it and what they should discover. Wait for the user's OK or changes.
4. **Build** the courseware from the template, then **check** it (below) before showing it.
5. **Show**: build the single file, then show it with an `agentdeck-preview` block when that skill is available (the path of `<topic>.html`, not edge to edge), else the path; then two or three lines on how to use it in class.
6. **Adjust**: the user tries it or rehearses; update the deck, plan and notes, re-check, and only describe what changed. On request, add the teacher's words per slide or a 说课稿 to `plan.md`.

## Designing the lesson

- Shape: a hook from students' lives or a story (情境导入, 3–5 min); exploration where students find the idea themselves, by hand and on the board (探究新知, 15–20 min); layered practice, basic → varied → stretch (分层练习, 10–15 min); a summary students say in their words (课堂小结, 3–5 min). Adjust to the lesson type: a 练习课 or 复习课 is mostly practice.
- Open classes are judged on student thinking: let the exploration be the centrepiece with one strong manipulative used by students at the board, questions that make them explain why (说一说你是怎么想的), and comparison of different methods. Avoid slides that just tell the answer.
- One idea per slide, a question students can act on, and the answer behind a step (`data-step`) so the teacher controls when it appears.
- Use the textbook's own examples first, then your own variations; numbers must stay within what the grade has learned.
- Junior high: the exploration is often a conjecture students test by dragging (does the angle sum stay 180°? what does k change?) followed by the reasoning or proof on the board; let the manipulative raise the question and keep the proof steps behind `data-step`. Write formulas in `.tex` and keep notation as the textbook writes it (e.g. 人教版 uses y = kx + b, a ≠ 0, √).
- An interactive must be usable without explanation: a short on-screen hint of what to do (拖动旋转, 点击棱剪开 …), undo and reset, an automatic demo the teacher can play when students are stuck, and where it fits, a record of what students found (each net discovered, each answer tried) so the class can compare.

## The template

Copy `template/` next to this file into the lesson folder (`cp -R <this skill>/template/. ~/Courseware/<folder>/`). Never edit the template in place: it is rewritten whenever agentdeckd restarts. Read `template/gallery.html` for every manipulative's markup, then delete `gallery.html` and `README.md` (notes for maintaining the template) from the lesson copy. Edit only `index.html` for the lesson; touch `assets/` only to fix a bug or change the colors in `:root` of `deck.css`.

The deck is plain HTML on a 1920×1080 stage scaled to any screen. Each `<section class="slide">` inside `<main id="cw-stage">` is a slide; the script tags at the bottom stay in that order.

**Built in, nothing to add**: arrow keys, PageUp / PageDown, Space and Enter (clickers / 翻页笔), swipe on touch screens, `F` or F5 for full screen, `B` or `.` for a black screen, a toolbar at the bottom right (previous / next, page number, 画笔 pen with colors and eraser, 计时 countdown with a beep, 点名 random picker by name list or student numbers without repeats, 重置 resets the current slide, 全屏), `#3` in the URL opens slide 3.

**Slide content** (classes in `deck.css` and `courseware.css`):

- `class="slide title"` for the cover with `<h1>` and `.subtitle`; other slides start with `<h2>`, optionally with `<span class="tag">情境导入</span>` (`.tag.accent`, `.tag.good` for other colors).
- Layout: `.cols` (side by side), `.center` (centred column), `.row`, `.fill` (takes the remaining height, centres its content), `.card` (`.primary`, `.accent`, `.good`).
- Text: body is 40px; `.big` (72px), `.huge` (120px numbers), `.small`, `.muted`, `.primary-text`, `.accent-text`, `.good-text`, `.bad-text`, `.mark` (highlight a key word), `.blank` (a fill-in blank).
- Math: fractions `<span class="frac"><span>3</span><span>4</span></span>`; write ×, ÷, −, ＝, ≈, ＜, ＞, °, ² as characters, never `*`, `/` or `x`. `.math` keeps an expression on one line.
- Formulas with letters, roots, powers, systems of equations (mostly junior high): LaTeX in `<span class="tex">a^2+b^2=c^2</span>`, or `<div class="tex display">x=\frac{-b\pm\sqrt{b^2-4ac}}{2a}</div>` for a centred one. They are typeset with KaTeX loaded from a CDN only when the deck has any, so the classroom computer must be online; offline the LaTeX source shows in grey, so say so when you hand it over. Primary school decks keep the plain characters above.
- Steps: `data-step` on any element hides it until the next click; they appear in document order, or set numbers (`data-step="2"`) to reorder, with equal numbers appearing together. Don't mix numbered and unnumbered steps on one slide. Going back to a slide shows all its steps.
- Multiple choice: `<ol class="choices"><li data-correct>…</li><li>…</li></ol>`; tapping marks right or wrong, tapping again clears. `.one-col` for long options.
- Sorting and matching: `data-drag="a"` on items and `data-drop="a"` (space-separated, `*` for any) on zones; a right drop turns green, a wrong one shakes and returns. Without drop zones items just move freely (`data-snap="40"` snaps to a grid), e.g. to cut and rearrange shapes drawn in SVG.

**Manipulatives** (custom elements; inside a choice or a draggable card they are just pictures):

- `<cw-number-line min max step points="3,8" hops fractions="4" label-every snap width hide-readout opposite abs>`: draggable points; `hops` draws jumps with their difference; `fractions="n"` makes ticks at 1/n with fraction labels; negative `min` for rational numbers, `opposite` shows each point's opposite number as a hollow point, `abs` its distance from 0 (absolute value).
- `<cw-fraction shape="circle|bar|grid" parts shaded size rows color controls hide-readout>`: tap a part to shade it; `controls` adds buttons to change the number of parts.
- `<cw-clock time="3:00" snap="5" size hide-readout>`: drag the minute hand (the hour hand follows) or the hour hand; a button hides or shows the time.
- `<cw-geoboard cols rows cell points="1,1 6,1 6,4" show="area perimeter lengths angles" unit="cm">`: drag the vertices on the grid; without `points` students tap squares to count area.
- `<cw-counter places="4" value="1309">` (计数器): tap above the beads to add one, tap the beads to take one away; ten beads on a rod show 满十进一.
- `<cw-bar-chart items="苹果,香蕉" values="0,0" unit="人" tally>`: tap a bar to add one, with an undo; `tally` writes 正 marks.
- `<cw-spinner sectors="红,红,黄,蓝">`: spin once or ten times quickly; counts the results (possibility lessons).
- `<cw-column a="358" b="267" op="+|-|×" steps>` (竖式): the textbook layout with carries and borrow dots; `steps` reveals the answer digit by digit from the right (partial products row by row for ×). `+` and `−` take decimals; `×` takes whole numbers. Division and other layouts: draw them in SVG with `data-step`.

Junior high (they also fit upper primary where the content does):

- `<cw-graph x="-6,6" y="-5,5" fn="k*x+b" params="k=1,-3,3,0.5; b=1,-4,4,1" label="y = {k}x + {b}" marks="intercepts vertex axis" points="A(2,3) P(2)" step snap width height hide-readout>`: a plane rectangular coordinate system (平面直角坐标系) with equal units. `fn` is one or more functions of x separated by `;`, written in JavaScript style with `*` (and `^` for powers, `sqrt`, `abs`); `params` adds a slider per parameter (`name=value,min,max,step`); `label` is how each function is shown under the graph, `{k}` replaced by the value and tidied the textbook way (`y = 1x + -2` shows as `y = x − 2`; separate terms with spaced ` + ` / ` − `). `marks` labels the intersections with the axes, the vertex and the axis of symmetry. `points`: `A(2,3)` is a draggable point with dashed lines to the axes and its coordinates, `P(2)` slides along the first function. Without `fn` it is just a coordinate grid for plotting points. Keep `height` at most 540 for a full slide and about 420 beside something else, as the readout and sliders sit below.
- `<cw-geometry figure="A(2,1) B(11,1) C(5,7); M = mid(B, C); poly(A,B,C); dseg(A,M); angle(C,A,B); len(B,M); area(A,B,C)" grid snap="0.5" unit="cm" scale="80" width height hide-readout>` (动态几何): coordinates in units of `scale` pixels, y upwards. Statements separated by `;`, spaces or new lines. Points: `A(2,1)` free (students drag it); `P = on(A,B,0.3)` slides along segment AB; `Q = oncircle(O,A,60)` slides around the circle centred O through A; constructed points (not draggable) `mid(A,B)`, `foot(P,A,B)` (foot of the perpendicular from P to AB), `centroid / circum / incenter / orthocenter(A,B,C)`, `cross(A,B,C,D)` (where lines AB and CD meet), `reflect(P,A,B)` (axis AB), `rotate(P,O,90)` (degrees, anticlockwise), `translate(P,A,B)` (by vector AB). Drawn: `seg`, `dseg` (dashed, for auxiliary lines), `line`, `ray`, `poly`, `circle(O,A)` or `circle(O,2)`, `angle(B,A,C)` (arc and degrees at A, a square mark at 90°), `len(A,B)`; `area(A,B,C…)` only measures. All measures are listed below the figure; when all three angles of a triangle are shown their whole degrees always add up to 180°. Unknown statements are listed in red, so check the screenshot.
- `<cw-algebra-tiles expr="x^2+3x+2" negative x="3.4">` (代数瓦片): students drag x², x and 1 tiles out of the tray (red negative ones with `negative`), tap an x tile to turn it, drag a tile back to the tray to remove it. Below it shows the polynomial on the mat and, when the tiles form a full rectangle, its factored form, e.g. `x² + 3x + 2 = (x + 1)(x + 2)`, for 整式乘法, 因式分解 and 配方. `expr` puts the tiles of a polynomial on the mat loosely to start with.

**Scan to answer** (扫码互动, only when the teacher wants students to answer on phones or tablets; needs the classroom computer and the devices online): add `<script src="assets/live.js"></script>` after `deck.js`. Students scan a QR code on the board, which opens the AgentDeck audience page in their browser; nothing to install. Each device gets a number (1 号, 2 号 …) that stays the same for this deck, shown on the device, and 点名 then draws among those numbers and pops 你被抽到了！ up on that device.

- `<cw-live-join>`: a big QR code and how many have joined; put it on its own slide before the first question (`size` changes the QR size).
- `<cw-poll options="A 的内容,B 的内容,C 的内容" correct="2" multiple qr>`: single choice (also 判断题 with `options="对,错"`), `multiple` for multiple choice with a 提交 button; the board shows a bar per option live, 公布答案 marks `correct` (1-based, comma-separated for multiple) on the board and on every device, 重新作答 clears.
- `<cw-responses type="number" unit=" 克" answer="5">` collects a number (count, min, max, average, 公布答案 checks `answer`); `type="text"` collects a short sentence as cards (tap a card to hide it, e.g. an unkind one).
- The question students see is the slide's `<h2>` (without the tag), or `question="…"`; `placeholder` sets the input hint. `qr` adds a small QR code beside a poll or responses for latecomers; use it only when the element has the full slide width (beside a figure in `.cols` it squeezes the bars).
- The device shows the question of the slide on the board, so put one poll or responses per slide.
- Ask first whether the students have phones or tablets with a browser and the classroom has internet. Keep an offline way through the lesson (a `.choices` question on the board does the same job).

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

**Compatibility**: school computers are often offline, old or locked down. Everything except a library like three.js stays in the file (no web fonts, remote images or other CDN scripts), so the page opens offline; a page that loads three.js or has `.tex` formulas needs the classroom computer online, so say so when you hand it over. Template code uses plain `<script>` tags and nothing newer than ES2017. Pages work in Chrome, Edge, 360 or QQ Browser (极速模式) and the browser on a Seewo / Hite whiteboard, not in Internet Explorer; 3D pages also need WebGL and import maps (Chrome 89 or newer).

## Checking before you show it

Open every slide of the single file in a headless Chromium browser installed on this machine at 1920×1080, with `?steps=all&toolbar=0#<n>` in the URL (all steps shown, no toolbar), take screenshots, and look at each one. For WebGL in headless Chromium add `--use-angle=swiftshader --enable-unsafe-swiftshader`, and give 3D pages time to load (`--virtual-time-budget=10000`). Then drive the interactives with a browser automation tool when one is available (drag, tap, undo, reset, the demo) and check they respond:

- Nothing overflows the slide, overlaps or is cut off; text is large enough; Chinese line breaks don't strand a single character.
- Every number, answer, figure and unit is right: work each exercise out yourself, check `cw-column` and geoboard readouts against your answer, and match the textbook's wording and notation.
- The browser console has no errors.

Fix and re-check until clean. Delete the screenshots afterwards.

## Handing it over

- The deliverable is one file, `<topic>.html`, so the teacher can send it on WeChat or copy it to a USB drive and open it by double-clicking. Build it from `index.html` after every change: replace each `<link rel="stylesheet" href="assets/….css">` with a `<style>` holding that file's contents, and each `<script src="assets/….js"></script>` with a `<script>` holding that file's contents, in the same order; keep CDN imports as they are (`assets/live.js` is inlined like the others; it loads its QR code library from esm.sh itself). Check the built file, not `index.html`. Say how to use it in one line the first time.
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
