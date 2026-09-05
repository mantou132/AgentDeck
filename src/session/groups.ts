import type { DeckSession } from './types';

export type SessionGroup = {
  cwd: string;
  latestActivity: number;
  sessions: DeckSession[];
};

export const getSortedSessionGroups = (sessions: DeckSession[]): SessionGroup[] => {
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
  return groups.sort((a, b) => b.latestActivity - a.latestActivity);
};
