import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const output = resolve(process.argv[2]);
const { version, tarballs } = JSON.parse(readFileSync(join(output, 'publish.json'), 'utf8'));
for (const tarball of tarballs) {
  const name = tarball.slice(0, -`-${version}.tgz`.length);
  try {
    execFileSync(
      'npm',
      ['view', `${name}@${version}`, 'version', '--json', '--registry', 'https://registry.npmjs.org/'],
      {
        stdio: 'pipe',
      },
    );
    console.log(`Already published: ${name}@${version}`);
    continue;
  } catch (error) {
    // npm versions are immutable; retries resume after packages already published successfully.
    const result = JSON.parse(error.stdout?.toString() || '{}');
    if (result.error?.code !== 'E404') throw error;
  }
  execFileSync(
    'npm',
    ['publish', join(output, tarball), '--access', 'public', '--tag', version.includes('-') ? 'next' : 'latest'],
    {
      stdio: 'inherit',
    },
  );
}
