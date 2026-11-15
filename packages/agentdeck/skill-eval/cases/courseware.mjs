import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { openPage, read, shoot } from '../helpers.mjs';

const root = path.join(homedir(), 'Courseware');

const listLessons = () => (existsSync(root) ? readdirSync(root) : []);

/** The lesson folder this case created; folders that existed before are the user's and never count. */
const lessonDir = (ctx) => {
  const created = listLessons().filter((name) => !ctx.before.includes(name));
  return created.length ? path.join(root, created.sort().at(-1)) : undefined;
};

/** The single-file deliverable `<topic>.html` beside the source `index.html`. */
const deliverable = (dir) => {
  const name = readdirSync(dir).find((file) => file.endsWith('.html') && file !== 'index.html');
  return name && path.join(dir, name);
};

const setup = (ctx) => {
  ctx.before = listLessons();
};

const done = (ctx) => {
  const dir = lessonDir(ctx);
  return Boolean(dir && deliverable(dir));
};

/** Opens every slide like the skill's own check does, screenshots it and looks for overflow and errors. */
const checkSlides = async (ctx, check, file, { minSlides, maxSlides }) => {
  const wait = read(file).includes('importmap') ? 6000 : 1500;
  const { page, errors } = await openPage(ctx, file, { query: '?steps=all&toolbar=0#1' });
  const count = await page.locator('#cw-stage > section.slide').count();
  await page.close();
  check(
    `幻灯片数量 ${count}`,
    count >= minSlides && count <= maxSlides ? true : 'warn',
    `预期 ${minSlides}–${maxSlides}`,
  );

  const overflowing = [];
  for (let n = 1; n <= count; n++) {
    const slide = await openPage(ctx, file, { query: `?steps=all&toolbar=0#${n}` });
    await slide.page.waitForTimeout(wait);
    const overflow = await slide.page.evaluate(() => {
      const current = document.querySelector('section.slide.cw-current');
      return (
        !!current && (current.scrollHeight > current.clientHeight + 4 || current.scrollWidth > current.clientWidth + 4)
      );
    });
    if (overflow) overflowing.push(n);
    await shoot(ctx, slide.page, `第 ${n} 页${overflow ? '（溢出）' : ''}`);
    errors.push(...slide.errors);
    await slide.page.close();
  }
  check(
    '没有内容溢出',
    overflowing.length ? 'warn' : true,
    overflowing.length ? `第 ${overflowing.join('、')} 页` : '',
  );
  const unique = [...new Set(errors)];
  check('控制台没有报错', !unique.length, unique.slice(0, 5).join('\n'));
};

/** Checks shared by every courseware case; `needs` are markers the page must contain. */
const checkLesson = async (ctx, check, { plan, needs, minSlides, maxSlides }) => {
  const dir = lessonDir(ctx);
  check('新建了课件目录 ~/Courseware/<日期>-<课题>/', Boolean(dir), dir ?? '');
  if (!dir) return;
  ctx.outputs.push(dir);
  const file = deliverable(dir);
  check('生成了单文件交付 <课题>.html', Boolean(file), file ?? '');
  check(
    '有 brief.md 和 notes.md',
    existsSync(path.join(dir, 'brief.md')) && existsSync(path.join(dir, 'notes.md')) ? true : 'warn',
  );
  check(
    '删掉了模板里的 gallery.html 和 README.md',
    !existsSync(path.join(dir, 'gallery.html')) && !existsSync(path.join(dir, 'README.md')) ? true : 'warn',
  );
  if (plan) {
    const text = read(path.join(dir, 'plan.md'));
    const missing = ['教学目标', '教学重点', '教学难点', '教学过程', '板书设计'].filter((word) => !text.includes(word));
    check('教案 plan.md 结构完整', Boolean(text) && !missing.length, missing.length ? `缺：${missing.join('、')}` : '');
  }
  if (!file) return;
  const html = read(file);
  check('单文件不引用 assets/', !/(src|href)="assets\//.test(html));
  for (const [label, pattern] of needs) check(label, pattern.test(html));
  await checkSlides(ctx, check, file, { minSlides, maxSlides });
};

export default [
  {
    id: 'cuboid-net-link',
    title: '交互式链接：长方体的展开图',
    turns: [
      '人教版五年级下册《长方体和正方体的展开图》，做一个交互式链接：学生在白板上能旋转长方体、点棱剪开、展开，并记录找到的不同展开图。我用希沃白板上课，其他你定。',
      '可以，就按这个做。',
    ],
    setup,
    done,
    check: (ctx, check) =>
      checkLesson(ctx, check, {
        plan: false,
        needs: [['用 three.js 做 3D', /three/]],
        minSlides: 1,
        maxSlides: 2,
      }),
  },
  {
    id: 'area-open-class',
    title: '整套课件：面积和面积单位（公开课）',
    turns: [
      '人教版三年级下册《面积和面积单位》第一课时，40 分钟公开课，要完整课件和教案。其他你定。',
      '大纲可以，开始做吧。',
    ],
    setup,
    done,
    check: (ctx, check) =>
      checkLesson(ctx, check, {
        plan: true,
        needs: [['用到了钉子板或拖拽等动手环节', /cw-geoboard|data-drag/]],
        minSlides: 8,
        maxSlides: 30,
      }),
  },
  {
    id: 'clock-lesson',
    title: '整套课件：认识钟表（普通课，分层练习）',
    turns: [
      '人教版一年级上册《认识钟表》，普通课 40 分钟，要用钟表教具，练习分基础、变式、拓展三层。其他你定。',
      '可以，开始做。',
    ],
    setup,
    done,
    check: (ctx, check) =>
      checkLesson(ctx, check, {
        plan: true,
        needs: [
          ['用了钟表教具 cw-clock', /<cw-clock/],
          ['有选择或拖拽练习', /class="choices"|data-drag/],
        ],
        minSlides: 8,
        maxSlides: 30,
      }),
  },
];
