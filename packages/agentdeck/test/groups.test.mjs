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

test('getSortedSessionGroups: subsequent sort preserves existing group order even after new activity', () => {
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

  // Now project-a gets new activity making it the most recent
  const updatedSessions = [
    { sessionId: '1', cwd: '/project-a', updatedAt: '2026-01-01T15:00:00.000Z' },
    { sessionId: '2', cwd: '/project-b', updatedAt: '2026-01-01T12:00:00.000Z' },
    { sessionId: '3', cwd: '/project-c', updatedAt: '2026-01-01T11:00:00.000Z' },
  ];

  const nextGroups = getSortedSessionGroups(updatedSessions, initialGroups);
  // Order of groups should remain as the old order: b, c, a
  assert.deepEqual(
    nextGroups.map((g) => g.cwd),
    ['/project-b', '/project-c', '/project-a'],
  );
  // But latestActivity and session order inside project-a should be updated
  const groupA = nextGroups.find((g) => g.cwd === '/project-a');
  assert.equal(groupA.latestActivity, Date.parse('2026-01-01T15:00:00.000Z'));
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
