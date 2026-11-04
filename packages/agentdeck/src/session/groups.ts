import type { DeckSession } from './types';

export type SessionGroup = {
  cwd: string;
  latestActivity: number;
  sessions: DeckSession[];
};

/** Claude desktop runs project-less chats in their own `…/Claude/scratch-workspaces/…` directory; they share one group. */
export const scratchWorkspacesRoot = (cwd: string) => /^.*[\\/]Claude[\\/]scratch-workspaces(?=[\\/]|$)/.exec(cwd)?.[0];

/** Updated groups already within these top slots stay put, so switching between a few active projects doesn't reshuffle the list. */
const STABLE_TOP_GROUPS = 3;

export const getSortedSessionGroups = (
  sessions: DeckSession[],
  prevGroups: readonly SessionGroup[] = [],
): SessionGroup[] => {
  const groupsMap = Map.groupBy(
    sessions,
    (session) => session.worktree?.mainCwd ?? scratchWorkspacesRoot(session.cwd) ?? session.cwd,
  );
  const groups: SessionGroup[] = [];
  for (const [cwd, items] of groupsMap) {
    const sortedItems = [...items].sort(
      (a, b) => (Date.parse(b.updatedAt || '') || 0) - (Date.parse(a.updatedAt || '') || 0),
    );
    const latestActivity = sortedItems.reduce((max, s) => {
      const time = Date.parse(s.updatedAt || '') || 0;
      return Math.max(time, max);
    }, 0);
    groups.push({ cwd, latestActivity, sessions: sortedItems });
  }

  const prevGroupsMap = new Map(
    prevGroups.map((group, index) => [group.cwd, { index, latestActivity: group.latestActivity }]),
  );
  const raised: SessionGroup[] = [];
  const kept: { index: number; group: SessionGroup }[] = [];
  for (const group of groups) {
    const prev = prevGroupsMap.get(group.cwd);
    if (!prev || (prev.index >= STABLE_TOP_GROUPS && group.latestActivity > prev.latestActivity)) {
      raised.push(group);
    } else {
      kept.push({ index: prev.index, group });
    }
  }

  raised.sort((a, b) => b.latestActivity - a.latestActivity);
  kept.sort((a, b) => a.index - b.index);

  return [...raised, ...kept.map(({ group }) => group)];
};
