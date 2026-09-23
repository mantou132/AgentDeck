import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { currentPlatform, platforms } from './platforms.mjs';
import { withInstallation } from './verify.mjs';

test('packed distribution installs globally without scripts and preserves CLI behavior', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'agentdeckd-pack-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const artifacts = join(directory, 'artifacts');
  const output = join(directory, 'dist');
  mkdirSync(artifacts);
  const fixture = `#!/usr/bin/env node
if (process.argv[2] === 'wait') {
  process.on('SIGTERM', () => process.exit(42));
  setInterval(() => {}, 1000);
  console.log('ready');
} else {
  console.log(JSON.stringify(process.argv.slice(2)));
  console.error('fixture stderr');
  process.exit(Number(process.argv[2]) || 0);
}
`;
  for (const platform of platforms) {
    const staging = join(directory, platform.suffix);
    mkdirSync(staging);
    const windows = platform.os === 'win32';
    const binary = windows ? 'agentdeckd.exe' : 'agentdeckd';
    writeFileSync(join(staging, binary), fixture);
    chmodSync(join(staging, binary), 0o755);
    const archive = join(artifacts, `agentdeckd-${platform.target}.${windows ? 'zip' : 'tar.gz'}`);
    execFileSync(windows ? 'zip' : 'tar', windows ? [archive, binary] : ['-czf', archive, binary], { cwd: staging });
    writeFileSync(`${archive}.sha256`, createHash('sha256').update(readFileSync(archive)).digest('hex'));
  }
  execFileSync(process.execPath, [join(import.meta.dirname, 'build.mjs'), '1.2.3-beta.1', artifacts, output]);
  const publication = JSON.parse(readFileSync(join(output, 'publish.json'), 'utf8'));
  assert.equal(publication.tarballs.length, 5);
  assert.equal(publication.tarballs.at(-1), 'agentdeckd-1.2.3-beta.1.tgz');
  await withInstallation(output, async (command, root) => {
    const child = spawn(command, ['7', 'with spaces', '中文', '$(literal)']);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => {
      stdout += data;
    });
    child.stderr.on('data', (data) => {
      stderr += data;
    });
    assert.deepEqual(await once(child, 'close'), [7, null]);
    assert.deepEqual(JSON.parse(stdout), ['7', 'with spaces', '中文', '$(literal)']);
    assert.match(stderr, /fixture stderr/);

    const waiting = spawn(command, ['wait']);
    t.after(() => {
      if (waiting.exitCode === null) waiting.kill('SIGKILL');
    });
    await once(waiting.stdout, 'data');
    waiting.kill('SIGTERM');
    assert.deepEqual(await once(waiting, 'close'), [42, null]);

    rmSync(join(root, 'node_modules', `agentdeckd-${currentPlatform().suffix}`), { recursive: true });
    assert.throws(
      () => execFileSync(command, ['--help'], { stdio: 'pipe' }),
      (error) => {
        assert.equal(error.status, 1);
        assert.match(error.stderr.toString(), /--include=optional/);
        return true;
      },
    );
  });
  writeFileSync(join(artifacts, 'agentdeckd-aarch64-apple-darwin.tar.gz.sha256'), 'invalid');
  assert.throws(
    () =>
      execFileSync(process.execPath, [join(import.meta.dirname, 'build.mjs'), '1.2.3', artifacts, output], {
        stdio: 'pipe',
      }),
    (error) => {
      assert.match(error.stderr.toString(), /Checksum mismatch/);
      return true;
    },
  );
});

test('publishing resumes in order and stops on registry errors', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'agentdeckd-publish-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const log = join(directory, 'calls.jsonl');
  const npm = join(directory, 'npm');
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(
    npm,
    `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_NPM_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'view') {
  if (args[1].startsWith('agentdeckd-darwin-arm64@')) {
    console.log('"1.2.3-beta.1"');
  } else {
    console.log(JSON.stringify({ error: { code: process.env.TEST_NPM_ERROR || 'E404' } }));
    process.exit(1);
  }
}
`,
  );
  chmodSync(npm, 0o755);
  writeFileSync(
    join(directory, 'publish.json'),
    JSON.stringify({
      version: '1.2.3-beta.1',
      tarballs: [
        'agentdeckd-darwin-arm64-1.2.3-beta.1.tgz',
        'agentdeckd-linux-x64-gnu-1.2.3-beta.1.tgz',
        'agentdeckd-1.2.3-beta.1.tgz',
      ],
    }),
  );
  const env = { ...process.env, PATH: `${directory}:${process.env.PATH}`, TEST_NPM_LOG: log };
  const args = [join(import.meta.dirname, 'publish.mjs'), directory];
  execFileSync(process.execPath, args, { env });
  const calls = readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const publishes = calls.filter(([command]) => command === 'publish');
  assert.equal(publishes.length, 2);
  assert.match(publishes[0][1], /agentdeckd-linux-x64-gnu-/);
  assert.match(publishes[1][1], /agentdeckd-1\.2\.3-beta\.1/);
  assert.deepEqual(publishes[1].slice(-2), ['--tag', 'next']);
  writeFileSync(log, '');
  assert.throws(() =>
    execFileSync(process.execPath, args, {
      env: { ...env, TEST_NPM_ERROR: 'E503' },
      stdio: 'pipe',
    }),
  );
  assert.doesNotMatch(readFileSync(log, 'utf8'), /"publish"/);
});
