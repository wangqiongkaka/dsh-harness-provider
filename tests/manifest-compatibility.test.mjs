import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { evaluatePluginCompatibility } from '@deepseek-ai/dsh-app-boot';

test('plugin peers accept the supported Web Profile runtime', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(evaluatePluginCompatibility(manifest, {}, '0.1.7-rc.2'), undefined);
});

test('plugin peers accept DSH 0.2.0-rc.1 and rc.2 but not untested releases', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(evaluatePluginCompatibility(manifest, {}, '0.2.0-rc.1'), undefined);
  assert.equal(evaluatePluginCompatibility(manifest, {}, '0.2.0-rc.2'), undefined);
  assert.ok(evaluatePluginCompatibility(manifest, {}, '0.2.0-rc.3'));
  assert.ok(evaluatePluginCompatibility(manifest, {}, '0.2.1-alpha.1'));
});

// DSH routes a linked plugin's imports to its own packages only for names the plugin declares as peers.
test('every DSH package the host entry imports is a declared peer', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const entry = await readFile(new URL('../dist/dsh.js', import.meta.url), 'utf8');
  const imported = new Set([...entry.matchAll(/^import [^;]*?from ?"(@deepseek-ai\/[^"/]+)[^"]*"/gm)].map(match => match[1]));
  assert.ok(imported.size > 0);
  assert.deepEqual([...imported].filter(name => !(name in manifest.peerDependencies)), []);
});
