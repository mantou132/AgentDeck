#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { currentPlatform } from './platforms.mjs';

try {
  const platform = currentPlatform();
  const packageName = `agentdeckd-${platform.suffix}`;
  const executable = platform.os === 'win32' ? 'agentdeckd.exe' : 'agentdeckd';
  let binary;
  try {
    binary = fileURLToPath(import.meta.resolve(`${packageName}/bin/${executable}`));
  } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    throw new Error(`Missing ${packageName}. Reinstall with: npm install -g agentdeckd --include=optional`);
  }

  const child = spawn(binary, process.argv.slice(2), { stdio: 'inherit' });
  const handlers = new Map();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const handler = () => child.kill(signal);
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  child.on('error', (error) => {
    console.error(`agentdeckd: ${error.message}`);
    process.exitCode = 1;
  });
  child.on('exit', (code, signal) => {
    for (const [name, handler] of handlers) process.removeListener(name, handler);
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code;
  });
} catch (error) {
  console.error(`agentdeckd: ${error.message}`);
  process.exitCode = 1;
}
