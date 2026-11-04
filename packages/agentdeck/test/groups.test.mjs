import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/session/groups.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS },
});
const exports = {};
vm.runInNewContext(outputText, {
  exports,
  Map,
  Date,
  Math,
});

const getSortedSessionGroups = (sessions, prevGroups) => {
  const result = exports.getSortedSessionGroups(sessions, prevGroups);
  return JSON.parse(JSON.stringify(result));
};

test('getSortedSessionGroups: initial sort orders groups by latest activity descending', () => {
  const sessions = [
    { sessionId: '1', cwd: '/project-a', updatedAt: '2026-01-01T10:00:00.000Z' },
    { sessionId: '2', cwd: '/project-b', updatedAt: '2026-01-01T12:00:00.000Z' },
    { sessionId: '3', cwd: '/project-c', updatedAt: '2026-01-01T11:00:00.000Z' },
  ];

  const initialGroups = getSortedSessionGroups(sessions);
  assert.deepEqual(
    initialGroups.map((g) => g.cwd),
    ['/project-b', '/project-c', '/project-a'],
  );
});

const at = (hour) => `2026-01-01T${String(hour).padStart(2, '0')}:00:00.000Z`;
const sessionsAt = (hours) =>
  Object.entries(hours).map(([cwd, hour]) => ({ sessionId: cwd, cwd, updatedAt: at(hour) }));

test('getSortedSessionGroups: updated groups within the top slots keep their position', () => {
  const initialGroups = getSortedSessionGroups(sessionsAt({ '/a': 10, '/b': 9, '/c': 8, '/d': 7 }));
  assert.deepEqual(
    initialGroups.map((g) => g.cwd),
    ['/a', '/b', '/c', '/d'],
  );

  const nextGroups = getSortedSessionGroups(sessionsAt({ '/a': 10, '/b': 9, '/c': 15, '/d': 7 }), initialGroups);
  assert.deepEqual(
    nextGroups.map((g) => g.cwd),
    ['/a', '/b', '/c', '/d'],
  );
  assert.equal(nextGroups[2].latestActivity, Date.parse(at(15)));
});

test('getSortedSessionGroups: updated groups below the top slots move to the front', () => {
  const initialGroups = getSortedSessionGroups(sessionsAt({ '/a': 10, '/b': 9, '/c': 8, '/d': 7, '/e': 6 }));

  const nextGroups = getSortedSessionGroups(
    sessionsAt({ '/a': 10, '/b': 9, '/c': 16, '/d': 15, '/e': 17 }),
    initialGroups,
  );
  assert.deepEqual(
    nextGroups.map((g) => g.cwd),
    ['/e', '/d', '/a', '/b', '/c'],
  );
});

test('getSortedSessionGroups: brand new groups appear at the beginning', () => {
  const previousGroups = [
    { cwd: '/project-b', latestActivity: 200, sessions: [] },
    { cwd: '/project-a', latestActivity: 100, sessions: [] },
  ];

  const sessions = [
    { sessionId: '1', cwd: '/project-a', updatedAt: '2026-01-01T10:00:00.000Z' },
    { sessionId: '2', cwd: '/project-b', updatedAt: '2026-01-01T12:00:00.000Z' },
    { sessionId: '3', cwd: '/project-new-1', updatedAt: '2026-01-01T13:00:00.000Z' },
    { sessionId: '4', cwd: '/project-new-2', updatedAt: '2026-01-01T14:00:00.000Z' },
  ];

  const groups = getSortedSessionGroups(sessions, previousGroups);
  assert.deepEqual(
    groups.map((g) => g.cwd),
    ['/project-new-2', '/project-new-1', '/project-b', '/project-a'],
  );
});

test('getSortedSessionGroups: deleted groups are removed while preserving remaining order', () => {
  const previousGroups = [
    { cwd: '/project-b', latestActivity: 200, sessions: [] },
    { cwd: '/project-c', latestActivity: 150, sessions: [] },
    { cwd: '/project-a', latestActivity: 100, sessions: [] },
  ];

  // project-c was deleted
  const sessions = [
    { sessionId: '1', cwd: '/project-a', updatedAt: '2026-01-01T10:00:00.000Z' },
    { sessionId: '2', cwd: '/project-b', updatedAt: '2026-01-01T12:00:00.000Z' },
  ];

  const groups = getSortedSessionGroups(sessions, previousGroups);
  assert.deepEqual(
    groups.map((g) => g.cwd),
    ['/project-b', '/project-a'],
  );
});

test('getSortedSessionGroups: worktree sessions join their main checkout group', () => {
  const sessions = [
    { sessionId: '1', cwd: '/repo', updatedAt: '2026-01-01T10:00:00.000Z' },
    {
      sessionId: '2',
      cwd: '/repo/.claude/worktrees/feat',
      worktree: { mainCwd: '/repo', name: 'feat' },
      updatedAt: '2026-01-01T12:00:00.000Z',
    },
  ];

  const groups = getSortedSessionGroups(sessions);
  assert.deepEqual(
    groups.map((g) => [g.cwd, g.sessions.map((s) => s.sessionId)]),
    [['/repo', ['2', '1']]],
  );
});

test('getSortedSessionGroups: Claude desktop scratch workspaces share one group', () => {
  const root = '/Users/me/Library/Application Support/Claude/scratch-workspaces';
  const sessions = [
    { sessionId: '1', cwd: `${root}/acc/org/scratch-2026-10-27-aaa`, updatedAt: '2026-01-01T10:00:00.000Z' },
    { sessionId: '2', cwd: `${root}/acc/org/scratch-2026-10-28-bbb`, updatedAt: '2026-01-01T12:00:00.000Z' },
  ];

  const groups = getSortedSessionGroups(sessions);
  assert.deepEqual(
    groups.map((g) => [g.cwd, g.sessions.map((s) => s.sessionId)]),
    [[root, ['2', '1']]],
  );
  assert.equal(exports.scratchWorkspacesRoot('/Users/me/Claude/projects'), undefined);
});
