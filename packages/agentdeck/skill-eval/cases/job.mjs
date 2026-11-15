// Only the local part of the job skill: nothing here opens a job site or sends anything. Each case runs with HOME
// at ~/SkillEval/homes/job, so the workspace is ~/SkillEval/homes/job/JobSearch, never the user's own.

import { cpSync, existsSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { openPage, pdfPages, read, readJson, shoot } from '../helpers.mjs';

const workspace = (ctx) => path.join(ctx.home, 'JobSearch');

const reset = (ctx, { withWorkspace }) => {
  rmSync(workspace(ctx), { recursive: true, force: true });
  rmSync(path.join(ctx.home, 'Downloads'), { recursive: true, force: true });
  if (!withWorkspace) return;
  cpSync(path.join(ctx.fixtures, 'workspace'), workspace(ctx), { recursive: true });
  cpSync(path.join(ctx.fixtures, 'jds'), path.join(ctx.home, 'Downloads/jds'), { recursive: true });
};

const tracker = (ctx) => readJson(path.join(workspace(ctx), 'applications.json'));

const statuses = ['saved', 'applied', 'talking', 'interview', 'offer', 'rejected', 'withdrawn'];

/** Shape every tracker entry must have. */
const checkTracker = (check, entries) => {
  check('applications.json 是合法的数组', Array.isArray(entries));
  if (!Array.isArray(entries)) return [];
  const bad = entries.filter(
    (entry) =>
      !entry.id || !entry.company || !statuses.includes(entry.status) || !entry.history?.length || !entry.updated,
  );
  check('每条记录有 id、公司、合法状态、history 和 updated', !bad.length, bad.map((entry) => entry.company).join('、'));
  return entries;
};

const byCompany = (entries, name) => entries.filter((entry) => entry.company?.includes(name));

const replyText = (ctx) =>
  ctx.turns
    .flatMap((turn) => turn.events)
    .filter((event) => event.type === 'text')
    .map((event) => event.part.text)
    .join('\n');

/** Experience the candidate never mentioned; finding it in a resume means it was made up. */
const invented = /Kubernetes|K8s|硕士|Angular/i;

export default [
  {
    id: 'resume-from-chat',
    title: '从聊天内容建资料、写简历',
    home: true,
    turns: [
      '我想找前端的工作，上海或者远程都行。我叫李明，邮箱 liming@example.com，电话 13800000000。2019 年毕业于同济大学软件工程本科。2019-2021 在拼图网络做前端，用 Vue 做电商后台；2021 年到现在在星图科技，React + TypeScript，负责数据可视化平台（ECharts），带 3 个人，把首屏加载从 4 秒降到 1.5 秒。期望 25K 以上，不考虑外包，也不接受 996。',
      '其他按你的判断来，先把简历做出来。',
    ],
    setup: (ctx) => reset(ctx, { withWorkspace: false }),
    done: (ctx) => existsSync(path.join(workspace(ctx), 'resume/resume.pdf')),
    check: async (ctx, check) => {
      const dir = workspace(ctx);
      const sources = path.join(dir, 'sources');
      check('聊天内容原样存进 sources/', existsSync(sources) && readdirSync(sources).length > 0);
      check('profile.md 每条事实带来源链接', read(path.join(dir, 'profile.md')).includes('](sources/'));
      check('preferences.md 记下了不考虑外包', read(path.join(dir, 'preferences.md')).includes('外包'));
      check('有 notes.md 记录进度', existsSync(path.join(dir, 'notes.md')));
      const html = read(path.join(dir, 'resume/resume.html'));
      check('生成了 resume/resume.html', Boolean(html));
      check(
        '简历有姓名、邮箱和量化成果',
        ['李明', 'liming@example.com', '1.5'].every((text) => html.includes(text)),
      );
      check('简历没有编造经历', invented.test(html) ? 'warn' : true, html.match(invented)?.[0] ?? '');
      const pdf = path.join(dir, 'resume/resume.pdf');
      check('导出了 resume.pdf', existsSync(pdf));
      if (existsSync(pdf)) check('PDF 只有一页', pdfPages(pdf) === 1 ? true : 'warn', `${pdfPages(pdf)} 页`);
      if (html) {
        const { page } = await openPage(ctx, path.join(dir, 'resume/resume.html'), {
          viewport: { width: 900, height: 1270 },
        });
        await shoot(ctx, page, 'resume.html');
        await page.close();
      }
    },
  },
  {
    id: 'screen-jds',
    title: '筛选 5 份 JD 加进追踪表',
    home: true,
    turns: ['我在 ~/Downloads/jds/ 存了几份 JD，帮我看看哪些值得投，加到追踪表里，先别投。'],
    setup: (ctx) => reset(ctx, { withWorkspace: true }),
    done: (ctx) => (tracker(ctx)?.length ?? 0) > 1,
    check: (ctx, check) => {
      const entries = checkTracker(check, tracker(ctx));
      const saved = (name) => byCompany(entries, name).some((entry) => entry.status === 'saved');
      check('星河科技（完全符合）加为 saved', saved('星河'));
      check('远帆（远程，缺 Kubernetes）加为 saved', saved('远帆') ? true : 'warn');
      check('蓝鲸信息（外包驻场）没有加', !saved('蓝鲸'));
      check('云图智能（北京到岗）没有加', !saved('云图'));
      const qingteng = byCompany(entries, '青藤');
      check(
        '青藤数据已投过，没有重复添加、状态仍是 applied',
        qingteng.length === 1 && qingteng[0].status === 'applied',
      );
      check(
        '新记录都没有标成 applied（用户说先别投）',
        !entries.some((entry) => !entry.company?.includes('青藤') && entry.status === 'applied'),
      );
      check('回复里指出了 Kubernetes 的差距', /Kubernetes|K8s/i.test(replyText(ctx)) ? true : 'warn');
    },
  },
  {
    id: 'tailor-remote',
    title: '为远程职位定制简历和打招呼的话',
    home: true,
    turns: ['远帆那个远程职位我想投，帮我准备一下：需要的话做份定制简历，再写一段打招呼的话。先给我看，别发。'],
    setup: (ctx) => reset(ctx, { withWorkspace: true }),
    done: () => true,
    check: (ctx, check) => {
      const dir = workspace(ctx);
      const fixture = (file) => read(path.join(ctx.fixtures, 'workspace', file));
      check(
        '原简历 resume.html 没被改动',
        read(path.join(dir, 'resume/resume.html')) === fixture('resume/resume.html'),
      );
      check(
        'sources/ 里的原始资料没被改动',
        read(path.join(dir, 'sources/2026-11-01-chat.md')) === fixture('sources/2026-11-01-chat.md'),
      );
      const tailored = readdirSync(path.join(dir, 'resume')).filter((file) => /^resume-.+\.html$/.test(file));
      check(
        '定制简历按 resume-<公司>-<职位>.html 命名',
        tailored.length ? true : 'warn',
        tailored.join('、') || '没有生成',
      );
      const claims = tailored.filter((file) => invented.test(read(path.join(dir, 'resume', file))));
      check(
        '定制简历没写候选人没有的 Kubernetes 经验',
        claims.length ? 'warn' : true,
        claims.length ? '需人工确认是写了经验还是写了差距' : '',
      );
      check('回复里给出了打招呼的话', replyText(ctx).length > 100);
      const entries = tracker(ctx) ?? [];
      check('没有标成已投（用户说别发）', !byCompany(entries, '远帆').some((entry) => entry.status === 'applied'));
    },
  },
];
