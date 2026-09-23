import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

test('settings translations contain show and hide relayId labels', () => {
  const zh = JSON.parse(readFileSync(path.join(root, 'src/locales/zh-CN/basic.json'), 'utf8'));
  const en = JSON.parse(readFileSync(path.join(root, 'src/locales/en/basic.json'), 'utf8'));

  assert.equal(zh['settings.showRelayId'], '查看 Relay ID');
  assert.equal(zh['settings.hideRelayId'], '隐藏 Relay ID');
  assert.equal(en['settings.showRelayId'], 'Show Relay ID');
  assert.equal(en['settings.hideRelayId'], 'Hide Relay ID');
});

test('settings page defines default masking, toggle visibility, and auto re-masking on tap-page hide', () => {
  const settingsSource = readFileSync(path.join(root, 'src/pages/settings.ts'), 'utf8');

  // Verify initial state has showRelayId: false (masked by default)
  assert.match(settingsSource, /showRelayId:\s*false/);

  // Verify input element uses password when showRelayId is false, text when true
  assert.match(settingsSource, /type=\$\{this\.#state\.showRelayId\s*\?\s*'text'\s*:\s*'password'\}/);

  // Verify visibility toggle button switches showRelayId
  assert.match(settingsSource, /showRelayId:\s*!this\.#state\.showRelayId/);

  // Verify toggle button displays appropriate icons
  assert.match(settingsSource, /this\.#state\.showRelayId\s*\?\s*icons\.visibilityOff\s*:\s*icons\.visibility/);

  // Verify toggle button aria labels
  assert.match(
    settingsSource,
    /this\.#state\.showRelayId\s*\?\s*'settings\.hideRelayId'\s*:\s*'settings\.showRelayId'/,
  );

  // Verify tap-page @hide re-masks showRelayId to false
  assert.match(
    settingsSource,
    /<tap-page\s+class="[^"]*"\s+@hide=\$\{\(\)\s*=>\s*this\.#state\(\{\s*showRelayId:\s*false\s*\}\)\}/,
  );
});
