import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { currentPlatform } from './platforms.mjs';

const exec = promisify(execFile);

// Exercise npm's actual platform selection and global command linking before publication.
// A local registry lets unpublished exact-version optional dependencies resolve normally.
export async function withInstallation(output, verify) {
  const { version, tarballs } = JSON.parse(await readFile(join(output, 'publish.json'), 'utf8'));
  const packages = new Map();
  for (const tarball of tarballs) {
    const { stdout } = await exec('tar', ['-xOf', join(output, tarball), 'package/package.json']);
    const manifest = JSON.parse(stdout);
    packages.set(manifest.name, { manifest, tarball, contents: await readFile(join(output, tarball)) });
  }
  const server = createServer((request, response) => {
    const name = decodeURIComponent(request.url.slice(1));
    const archive = [...packages.values()].find(({ tarball }) => name === tarball);
    if (archive) {
      response.end(archive.contents);
      return;
    }
    const pkg = packages.get(name);
    if (!pkg) {
      response.writeHead(404).end('{}');
      return;
    }
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify({
        name,
        'dist-tags': { latest: version },
        versions: {
          [version]: { ...pkg.manifest, dist: { tarball: `http://127.0.0.1:${server.address().port}/${pkg.tarball}` } },
        },
      }),
    );
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const prefix = await mkdtemp(join(tmpdir(), 'agentdeckd-npm-'));
  try {
    await exec('npm', [
      'install',
      '-g',
      `agentdeckd@${version}`,
      '--prefix',
      prefix,
      '--registry',
      `http://127.0.0.1:${server.address().port}`,
      '--cache',
      join(prefix, 'cache'),
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
    ]);
    const root = join(prefix, 'lib', 'node_modules', 'agentdeckd');
    const { stdout } = await exec('npm', ['ls', '-g', '--prefix', prefix, '--json']);
    assert.equal(JSON.parse(stdout).dependencies.agentdeckd.version, version);
    // Only the compatible binary should be installed, even with install scripts disabled.
    for (const name of packages.keys()) {
      if (name === 'agentdeckd') continue;
      const path = join(root, 'node_modules', name, 'package.json');
      if (name === `agentdeckd-${currentPlatform().suffix}`) {
        assert.equal(JSON.parse(await readFile(path, 'utf8')).version, version);
      } else {
        await assert.rejects(readFile(path), { code: 'ENOENT' });
      }
    }
    await verify(join(prefix, 'bin', 'agentdeckd'), root);
  } finally {
    await new Promise((done) => server.close(done));
    await rm(prefix, { recursive: true, force: true });
  }
}

if (process.argv[1] === import.meta.filename) {
  await withInstallation(resolve(process.argv[2]), async (command) => {
    const { stdout } = await exec(command, ['--help']);
    assert.match(stdout, /Usage:/);
    console.log(stdout);
  });
}
