export type Breadcrumb = {
  name: string;
  path: string;
};

export const displayPath = (path: string, home?: string) => {
  if (home) {
    const windows = /^[a-z]:[\\/]/i.test(home) || home.startsWith('\\\\');
    const trimEnd = (value: string) => value.replace(/[\\/]+$/, '');
    const normalizedHome = trimEnd(home);
    const normalizedPath = trimEnd(path);
    const comparableHome = windows ? normalizedHome.replaceAll('\\', '/').toLowerCase() : normalizedHome;
    const comparablePath = windows ? normalizedPath.replaceAll('\\', '/').toLowerCase() : normalizedPath;

    if (comparablePath === comparableHome) return '~';
    if (comparablePath.startsWith(`${comparableHome}/`)) {
      return `~/${normalizedPath.slice(normalizedHome.length + 1).replaceAll('\\', '/')}`;
    }
  }
  return path.replace(/^\/Users\/[^/]+(?=\/|$)/, '~').replace(/^\/home\/[^/]+(?=\/|$)/, '~');
};

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
