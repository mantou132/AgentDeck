import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platforms } from './platforms.mjs';

const [version, artifactsArg, outputArg] = process.argv.slice(2);
if (!version || !artifactsArg || !outputArg) {
  throw new Error('Usage: node build.mjs <version> <release-artifacts-directory> <output-directory>');
}
const source = dirname(fileURLToPath(import.meta.url));
const artifacts = resolve(artifactsArg);
const output = resolve(outputArg);
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`Invalid release version: ${version}`);
const common = {
  version,
  license: 'MIT',
  repository: { type: 'git', url: 'git+https://github.com/mantou132/AgentDeck.git', directory: 'crates/daemon/npm' },
  publishConfig: { access: 'public', registry: 'https://registry.npmjs.org/' },
};
const packages = [];
const optionalDependencies = {};

function manifest(directory, value) {
  writeFileSync(join(directory, 'package.json'), `${JSON.stringify({ ...common, ...value }, null, 2)}\n`);
}

for (const platform of platforms) {
  const name = `agentdeckd-${platform.suffix}`;
  const directory = join(output, name);
  const bin = join(directory, 'bin');
  mkdirSync(bin, { recursive: true });
  const windows = platform.os === 'win32';
  const executable = windows ? 'agentdeckd.exe' : 'agentdeckd';
  const archive = join(artifacts, `agentdeckd-${platform.target}.${windows ? 'zip' : 'tar.gz'}`);
  const expected = readFileSync(`${archive}.sha256`, 'utf8').trim();
  const actual = createHash('sha256').update(readFileSync(archive)).digest('hex');
  if (actual !== expected) throw new Error(`Checksum mismatch: ${archive}`);
  if (windows) execFileSync('unzip', ['-o', archive, executable, '-d', bin], { stdio: 'inherit' });
  else execFileSync('tar', ['-xzf', archive, '-C', bin, executable]);
  chmodSync(join(bin, executable), 0o755);
  manifest(directory, {
    name,
    description: `AgentDeck daemon binary for ${platform.suffix}`,
    os: [platform.os],
    cpu: [platform.cpu],
    ...(platform.libc ? { libc: [platform.libc] } : {}),
    files: ['bin/'],
  });
  writeFileSync(
    join(directory, 'README.md'),
    `# ${name}\n\nPlatform binary for agentdeckd. Install with \`npm install -g agentdeckd\`.\n`,
  );
  optionalDependencies[name] = version;
  packages.push(directory);
}

const entry = join(output, 'agentdeckd');
mkdirSync(entry, { recursive: true });
manifest(entry, {
  name: 'agentdeckd',
  description: 'Run and manage local ACP agents from AgentDeck on your phone or browser',
  bin: { agentdeckd: 'cli.mjs' },
  engines: { node: '>=22' },
  files: ['cli.mjs', 'platforms.mjs'],
  optionalDependencies,
});
for (const file of ['cli.mjs', 'platforms.mjs', 'README.md']) copyFileSync(join(source, file), join(entry, file));
chmodSync(join(entry, 'cli.mjs'), 0o755);
packages.push(entry);

// Keep the entry package last so all of its exact-version dependencies exist when it is published.
const tarballs = packages.map((cwd) => {
  const result = JSON.parse(
    execFileSync('npm', ['pack', '--json', '--pack-destination', output], { cwd, encoding: 'utf8' }),
  );
  return result[0].filename;
});
writeFileSync(join(output, 'publish.json'), `${JSON.stringify({ version, tarballs }, null, 2)}\n`);
