import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { evaluatePluginCompatibility, getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot';

test('plugin peers accept the reference DSH runtime', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(evaluatePluginCompatibility(manifest, {}, getDshRuntimeVersion()), undefined);
});

test('plugin peers accept DSH 0.2.0-rc.1 and rc.2 but not untested releases', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(evaluatePluginCompatibility(manifest, {}, '0.2.0-rc.1'), undefined);
  assert.equal(evaluatePluginCompatibility(manifest, {}, '0.2.0-rc.2'), undefined);
  assert.ok(evaluatePluginCompatibility(manifest, {}, '0.2.0-rc.3'));
});
