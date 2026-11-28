/**
 * Realistic, clean bilingual demo datasets fed to the real AgentDeck frontend
 * through an in-memory mock Relay WebSocket during screenshot capture.
 */

const sampleDiff = `diff --git a/src/auth/refresh.ts b/src/auth/refresh.ts
index 8a41c2f..e9d04b1 100644
--- a/src/auth/refresh.ts
+++ b/src/auth/refresh.ts
@@ -12,13 +12,24 @@ export class TokenManager {
   #token = '';
   #expiresAt = 0;
+  #inflight: Promise<string> | null = null;
 
   async getValidToken(): Promise<string> {
-    if (Date.now() < this.#expiresAt - 5e3) {
+    const skewMs = 15_000;
+    if (this.#token && !this.#isStale(skewMs)) {
       return this.#token;
     }
-    const res = await this.#fetchToken();
-    this.#token = res.token;
-    this.#expiresAt = res.expiresAt;
-    return this.#token;
+    if (!this.#inflight) {
+      this.#inflight = this.#refreshOnce()
+        .finally(() => {
+          this.#inflight = null;
+        });
+    }
+    return this.#inflight;
+  }
+
+  async #refreshOnce(): Promise<string> {
+    const res = await this.#fetchToken();
+    this.#token = res.token;
+    this.#expiresAt = res.expiresAt;
+    return res.token;
   }
 }
`;

const makeChartMarkdown = (lang) => {
  const isZh = lang === 'zh-CN';
  const option = {
    tooltip: { trigger: 'axis' },
    legend: {
      top: 4,
      right: 6,
      textStyle: { color: '#a0a4ad', fontSize: 11 },
      itemWidth: 10,
      itemHeight: 10,
    },
    grid: { left: 36, right: 14, top: 38, bottom: 26 },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: isZh ? ['东京', '新加坡', '法兰克福', '美东', '美西', '伦敦'] : ['NRT', 'SIN', 'FRA', 'IAD', 'SJC', 'LHR'],
      axisLine: { lineStyle: { color: '#383b40' } },
      axisLabel: { color: '#a0a4ad', fontSize: 11 },
    },
    yAxis: {
      type: 'value',
      name: 'ms',
      nameTextStyle: { color: '#767a91', fontSize: 10, padding: [0, 14, 0, 0] },
      splitLine: { lineStyle: { color: 'rgba(255,255,255,0.07)' } },
      axisLabel: { color: '#a0a4ad', fontSize: 11 },
    },
    series: [
      {
        name: isZh ? '优化前' : 'Before',
        type: 'line',
        smooth: true,
        symbol: 'circle',
        symbolSize: 6,
        data: [148, 162, 134, 118, 126, 140],
        lineStyle: { color: '#767a91', width: 2, type: 'dashed' },
        itemStyle: { color: '#767a91' },
      },
      {
        name: isZh ? '批处理后' : 'Batched',
        type: 'line',
        smooth: true,
        symbol: 'circle',
        symbolSize: 7,
        data: [38, 44, 34, 29, 32, 36],
        lineStyle: { color: '#7c83ff', width: 3 },
        itemStyle: { color: '#aab3ff', borderColor: '#5a5fe8', borderWidth: 2 },
        areaStyle: {
          color: {
            type: 'linear',
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(98, 107, 204, 0.42)' },
              { offset: 1, color: 'rgba(98, 107, 204, 0.02)' },
            ],
          },
        },
      },
    ],
  };

  if (isZh) {
    return [
      '已按 6 个边缘节点汇总回放延迟，将历史帧打包为 256 KB 批次后 **p95 延迟平均下降 74%**（138 ms → 35 ms）：',
      '',
      '```agentdeck-chart',
      JSON.stringify(option),
      '```',
      '',
      '- **WebSocket 往返减少 88%**：200 条历史事件合并为 1–2 帧。',
      '- **零乱序风险**：仍保持严格 `(epoch, seq)` 递增游标。',
    ].join('\n');
  }

  return [
    'Aggregated replay latency across 6 edge regions. Batching history into 256 KB frames cut **p95 latency by 74%** (138 ms → 35 ms):',
    '',
    '```agentdeck-chart',
    JSON.stringify(option),
    '```',
    '',
    '- **88% fewer round-trips**: 200 replay events collapse into 1–2 frames.',
    '- **Ordered delivery**: preserves strict `(epoch, seq)` cursors.',
  ].join('\n');
};

export function createMockData(lang) {
  const isZh = lang === 'zh-CN';
  const timeZone = isZh ? 'Asia/Shanghai' : 'America/New_York';
  // 09:41 local time in the target context timezone (matches phone status bar)
  const now = Date.parse(isZh ? '2026-11-28T01:41:00Z' : '2026-11-28T14:41:00Z');
  const iso = (offsetMinutes) => new Date(now - offsetMinutes * 60_000).toISOString();

  const home = '/Users/alex';
  const cwdMain = '/Users/alex/workspace/agentdeck';
  const cwdApi = '/Users/alex/workspace/api-gateway';
  const cwdMobile = '/Users/alex/workspace/ios-client';

  const configOptions = [
    {
      id: 'model',
      name: isZh ? '模型' : 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'claude-sonnet-4-6',
      options: [
        { value: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
        { value: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
      ],
    },
    {
      id: 'mode',
      name: isZh ? '模式' : 'Mode',
      category: 'mode',
      type: 'select',
      currentValue: 'default',
      options: [
        { value: 'default', name: isZh ? '默认审批' : 'Ask before edits' },
        { value: 'plan', name: isZh ? '规划模式' : 'Plan mode' },
      ],
    },
  ];

  const sessions = [
    {
      sessionId: 'sess-hero',
      cwd: cwdMain,
      title: isZh ? '修复并发刷新 OAuth 令牌导致的 401' : 'Fix OAuth token refresh race',
      updatedAt: iso(2),
      unread: false,
    },
    {
      sessionId: 'sess-approve',
      cwd: cwdMain,
      title: isZh ? '灰度发布 Relay Worker v2.4' : 'Deploy Relay Worker v2.4 canary',
      updatedAt: iso(1),
      unread: false,
    },
    {
      sessionId: 'sess-chart',
      cwd: cwdMain,
      title: isZh ? '对比 6 节点历史回放 p95 延迟' : 'Benchmark replay p95 latency',
      updatedAt: iso(18),
      unread: true,
    },
    {
      sessionId: 'sess-api-1',
      cwd: cwdApi,
      title: isZh ? '为 Webhook 签名校验补充单测' : 'Add HMAC signature tests',
      updatedAt: iso(45),
      unread: true,
    },
    {
      sessionId: 'sess-api-2',
      cwd: cwdApi,
      title: isZh ? '排查 Redis 连接池高峰期超时' : 'Investigate Redis pool timeouts',
      updatedAt: iso(130),
      unread: false,
    },
    {
      sessionId: 'sess-mobile-1',
      cwd: cwdMobile,
      title: isZh ? '适配键盘弹起时的底部安全区' : 'Smooth keyboard safe-area inset',
      updatedAt: iso(320),
      unread: false,
    },
  ];

  const permissionRequest = {
    method: 'agent_permission_request',
    params: {
      agent: 'claude-acp',
      sessionId: 'sess-approve',
      requestId: 'perm-deploy-1',
      toolCall: {
        title: 'pnpm run deploy:prod -- --canary 10% --region global',
        kind: 'execute',
        rawInput: {
          command: 'pnpm run deploy:prod -- --canary 10% --region global',
          cwd: cwdMain,
        },
      },
      options: [
        { optionId: 'reject', name: isZh ? '拒绝' : 'Reject', kind: 'reject_once' },
        { optionId: 'allow_always', name: isZh ? '总是允许' : 'Always allow', kind: 'allow_always' },
        { optionId: 'allow_once', name: isZh ? '允许一次' : 'Allow once', kind: 'allow_once' },
      ],
    },
  };

  const tasks = [
    {
      id: 'task-daily-digest',
      name: isZh ? '每日 PR 与 CI 健康巡检' : 'Daily PR & CI Health Digest',
      agent: 'claude-acp',
      cwd: cwdMain,
      prompt: isZh
        ? '检查过去 24 小时新合并的 PR、失败的 GitHub Actions 工作流和关键依赖告警，输出一份精简摘要并标出需要今天处理的项目。'
        : 'Review merged PRs, failing GitHub Actions workflows, and security advisories from the last 24h. Summarize action items that need attention today.',
      schedule: { type: 'daily', times: ['09:00'], weekdays: [1, 2, 3, 4, 5], timeZone },
      configOptions: { model: 'claude-sonnet-4-6' },
      timeoutMinutes: 15,
      retries: 1,
      enabled: true,
      originSessionId: 'sess-hero',
      createdAt: iso(60 * 24 * 12),
      nextRunAt: new Date(now + 1000 * 60 * (23 * 60 + 19)).toISOString(),
      running: false,
      lastRun: {
        sessionId: 'sess-task-run-3',
        scheduledFor: iso(41),
        startedAt: iso(41),
        endedAt: iso(39),
        status: 'success',
        summary: isZh
          ? '主干 CI 全部通过，3 个 PR 已合并；发现 1 项 crate 补丁升级建议。'
          : 'Main CI green, 3 PRs merged; 1 patch crate update ready to review.',
        attempt: 1,
      },
    },
    {
      id: 'task-nightly-audit',
      name: isZh ? '夜间依赖漏洞与包体积检查' : 'Nightly Bundle & Audit Check',
      agent: 'codex-acp',
      cwd: cwdApi,
      prompt: isZh
        ? '运行 pnpm audit 与生产构建体积分析，如有高危漏洞或超过 5% 体积增长则生成报告。'
        : 'Run pnpm audit and production bundle diff; report any high-severity CVEs or >5% size regressions.',
      schedule: { type: 'daily', times: ['02:30'], timeZone },
      configOptions: {},
      timeoutMinutes: 20,
      retries: 0,
      enabled: true,
      createdAt: iso(60 * 24 * 20),
      nextRunAt: new Date(now + 1000 * 60 * (16 * 60 + 49)).toISOString(),
      running: true,
      runningSessionId: 'sess-task-live',
      lastRun: {
        sessionId: 'sess-task-run-prev',
        scheduledFor: iso(60 * 24),
        startedAt: iso(60 * 24),
        endedAt: iso(60 * 24 - 3),
        status: 'success',
        summary: isZh ? '无高危漏洞，产物体积减少 14 KB。' : 'No high-severity CVEs; bundle shrank by 14 KB.',
        attempt: 1,
      },
    },
  ];

  const taskRuns = {
    'task-daily-digest': [
      {
        sessionId: 'sess-task-run-1',
        scheduledFor: iso(60 * 48 + 41),
        startedAt: iso(60 * 48 + 41),
        endedAt: iso(60 * 48 + 38),
        status: 'success',
        summary: isZh
          ? '2 个构建通过，已自动标记 1 个过期分支待清理。'
          : 'All checks passed; flagged 1 stale release branch for cleanup.',
        attempt: 1,
      },
      {
        sessionId: 'sess-task-run-2',
        scheduledFor: iso(60 * 24 + 41),
        startedAt: iso(60 * 24 + 41),
        endedAt: iso(60 * 24 + 39),
        status: 'success',
        summary: isZh
          ? '修复了 Windows 路径测试偶发失败，其余 42 项检查全绿。'
          : 'Flagged flaky Windows path test; 42 other checks green.',
        attempt: 1,
      },
      tasks[0].lastRun,
    ],
  };

  const sessionEvents = {
    'sess-hero': {
      running: false,
      userInputs: [],
      suggestion: isZh ? '补充并发刷新的回归测试' : 'Add concurrent refresh regression test',
      events: [
        {
          seq: 1,
          event: 'session_update',
          update: {
            sessionUpdate: 'user_message_chunk',
            content: {
              type: 'text',
              text: isZh
                ? '多个请求同时过期时会触发偶发 401，帮我定位 src/auth/refresh.ts 的竞态问题并修掉。'
                : 'We get intermittent 401s when requests expire simultaneously. Find the race in src/auth/refresh.ts and fix it.',
            },
          },
        },
        {
          seq: 2,
          event: 'session_update',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tc-1',
            title: isZh ? '读取 src/auth/refresh.ts' : 'Read src/auth/refresh.ts',
            kind: 'read',
            status: 'completed',
          },
        },
        {
          seq: 3,
          event: 'session_update',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tc-2',
            title: isZh ? '编辑 src/auth/refresh.ts (+17 -4)' : 'Edit src/auth/refresh.ts (+17 -4)',
            kind: 'edit',
            status: 'completed',
          },
        },
        {
          seq: 4,
          event: 'session_update',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tc-3',
            title: 'pnpm test auth/refresh.test.ts',
            kind: 'execute',
            status: 'completed',
          },
        },
        {
          seq: 5,
          event: 'session_update',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: isZh
                ? [
                    '已定位并修复 `TokenManager.getValidToken()` 的刷新竞态：',
                    '',
                    '1. **合并并发刷新**：新增 `#inflight` 单飞锁，并发过期请求共享同一次刷新，避免旧 token 被二次消费导致 401。',
                    '2. **提前刷新窗口**：将过期缓冲从 `5s` 调整到 `15s`，规避边缘节点时钟偏差。',
                    '',
                    '已运行 `pnpm test auth/refresh.test.ts`，14 项用例全部通过。点击上方项目路径即可查看完整 Git Diff。',
                  ].join('\n')
                : [
                    'Fixed the refresh race in `TokenManager.getValidToken()`:',
                    '',
                    '1. **Single-flight lock**: added `#inflight` so concurrent expired callers share one refresh instead of revoking each other.',
                    '2. **Safer skew window**: bumped expiry buffer from `5s` to `15s` to absorb edge clock drift.',
                    '',
                    'Ran `pnpm test auth/refresh.test.ts` — all 14 tests pass. Tap the project path above to review the diff.',
                  ].join('\n'),
            },
          },
        },
        { seq: 6, event: 'turn_ended', stopReason: 'end_turn' },
      ],
    },

    'sess-approve': {
      running: true,
      userInputs: [permissionRequest],
      suggestion: null,
      events: [
        {
          seq: 1,
          event: 'session_update',
          update: {
            sessionUpdate: 'user_message_chunk',
            content: {
              type: 'text',
              text: isZh
                ? '跑完构建检查后，把 Relay Worker v2.4 按 10% 流量灰度发布出去。'
                : 'Verify the production build, then roll out Relay Worker v2.4 to 10% canary traffic.',
            },
          },
        },
        {
          seq: 2,
          event: 'session_update',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tc-a1',
            title: 'pnpm run build && pnpm run test:smoke',
            kind: 'execute',
            status: 'completed',
          },
        },
        {
          seq: 3,
          event: 'session_update',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: isZh
                ? '构建和 26 项冒烟测试全部通过（耗时 11.4s）。准备执行 10% 全球灰度发布，请确认是否继续：'
                : 'Production build and all 26 smoke tests passed (11.4s). Ready to deploy the 10% global canary — confirm below to continue:',
            },
          },
        },
        {
          seq: 4,
          event: 'session_update',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tc-a2',
            title: 'pnpm run deploy:prod -- --canary 10% --region global',
            kind: 'execute',
            status: 'in_progress',
          },
        },
      ],
    },

    'sess-chart': {
      running: false,
      userInputs: [],
      suggestion: isZh ? '导出各区域完整延迟报表' : 'Export regional latency report',
      events: [
        {
          seq: 1,
          event: 'session_update',
          update: {
            sessionUpdate: 'user_message_chunk',
            content: {
              type: 'text',
              text: isZh
                ? '把这周 6 个区域节点启用批处理前后的 p95 延迟画张对比图。'
                : 'Plot our p95 replay latency across the 6 edge regions before and after frame batching.',
            },
          },
        },
        {
          seq: 2,
          event: 'session_update',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tc-c1',
            title: isZh ? '查询 benchmarks/replay-p95.json' : 'Read benchmarks/replay-p95.json',
            kind: 'read',
            status: 'completed',
          },
        },
        {
          seq: 3,
          event: 'session_update',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: makeChartMarkdown(lang),
            },
          },
        },
        { seq: 4, event: 'turn_ended', stopReason: 'end_turn' },
      ],
    },
  };

  const gitStatus = {
    repo: cwdMain,
    branch: 'fix/oauth-single-flight',
    files: [
      { path: 'src/auth/refresh.ts', status: 'modified', insertions: 17, deletions: 4 },
      { path: 'src/auth/refresh.test.ts', status: 'modified', insertions: 38, deletions: 2 },
      { path: 'src/relay/session.ts', status: 'modified', insertions: 12, deletions: 6 },
      { path: 'docs/auth-flow.md', status: 'added', insertions: 24, deletions: 0 },
    ],
    stats: { insertions: 91, deletions: 12, filesChanged: 4 },
  };

  const gitDiff = {
    path: 'src/auth/refresh.ts',
    diff: sampleDiff,
    stats: { insertions: 17, deletions: 4, filesChanged: 1 },
  };

  return {
    home,
    hostname: 'MacBook-Pro',
    configOptions,
    sessions,
    activeSessions: [
      {
        agent: 'claude-acp',
        sessionId: 'sess-approve',
        cwd: cwdMain,
        title: sessions[1].title,
        updatedAt: sessions[1].updatedAt,
      },
    ],
    pendingUserInputs: [permissionRequest],
    tasks,
    taskRuns,
    sessionEvents,
    gitStatus,
    gitDiff,
  };
}
