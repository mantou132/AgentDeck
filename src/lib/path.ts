export type Breadcrumb = {
  name: string;
  path: string;
};

export const displayPath = (path: string) =>
  path.replace(/^\/Users\/[^/]+(?=\/|$)/, '~').replace(/^\/home\/[^/]+(?=\/|$)/, '~');

export const getBreadcrumbs = (currentPath: string, homePath?: string): Breadcrumb[] => {
  const norm = currentPath.replace(/[\\/]+$/, '');
  if (!norm || norm === '/') return [{ name: '/', path: '/' }];

  const effectiveHome = homePath?.replace(/[\\/]+$/, '');
  const isUnderHome = Boolean(
    effectiveHome &&
      (norm === effectiveHome || norm.startsWith(`${effectiveHome}/`) || norm.startsWith(`${effectiveHome}\\`)),
  );
  const base = isUnderHome && effectiveHome ? effectiveHome : '';
  const relative = isUnderHome ? norm.slice(base.length) : norm;

  const crumbs: Breadcrumb[] = [{ name: isUnderHome ? '~' : base || '/', path: base || '/' }];
  let acc = base;
  for (const part of relative.split(/[\\/]+/).filter(Boolean)) {
    acc = `${acc}/${part}`;
    crumbs.push({ name: part, path: acc });
  }
  return crumbs;
};

export const getParentPath = (path: string): string | null => {
  const norm = path.replace(/[\\/]+$/, '');
  if (!norm || norm === '/') return null;
  return norm.replace(/[\\/][^\\/]+$/, '') || '/';
};
