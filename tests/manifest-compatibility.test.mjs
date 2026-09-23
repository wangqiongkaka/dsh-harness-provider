import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { evaluatePluginCompatibility, getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot';

test('plugin peers accept the reference DSH runtime', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(evaluatePluginCompatibility(manifest, {}, getDshRuntimeVersion()), undefined);
});
