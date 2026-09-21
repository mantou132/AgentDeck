import type { DeckSession } from './types';

export type SessionGroup = {
  cwd: string;
  latestActivity: number;
  sessions: DeckSession[];
};

export const getSortedSessionGroups = (
  sessions: DeckSession[],
  prevGroups: readonly SessionGroup[] = [],
): SessionGroup[] => {
  const groupsMap = Map.groupBy(sessions, (session) => session.cwd);
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

  const prevIndex = new Map(prevGroups.map((group, index) => [group.cwd, index]));
  const newGroups: SessionGroup[] = [];
  const existingGroups: SessionGroup[] = [];

  for (const group of groups) {
    if (prevIndex.has(group.cwd)) {
      existingGroups.push(group);
    } else {
      newGroups.push(group);
    }
  }

  newGroups.sort((a, b) => b.latestActivity - a.latestActivity);
  existingGroups.sort((a, b) => (prevIndex.get(a.cwd) ?? 0) - (prevIndex.get(b.cwd) ?? 0));

  return [...newGroups, ...existingGroups];
};
