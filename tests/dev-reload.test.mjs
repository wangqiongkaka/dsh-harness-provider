import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('dev:reload publishes what a DSH profile loads, the entry last', async () => {
  const live = await mkdtemp(join(tmpdir(), 'dsh-harness-live-'));
  try {
    execFileSync(process.execPath, ['scripts/dev-reload.mjs'], { env: { ...process.env, DSH_PLUGIN_LIVE: live }, stdio: 'pipe' });
    const others = ['package.json', 'cordis.patch.yml', 'dist/client.js', 'dist/delegate-cli.mjs', 'dist/codex-acp.mjs', 'dist/claude-agent-acp.mjs'];
    for (const file of [...others, 'dist/dsh.js']) assert.deepEqual(await readFile(join(live, file)), await readFile(file), file);
    // DSH reloads when the entry changes, so the programs the entry spawns must be written before it.
    const written = async file => (await stat(join(live, file), { bigint: true })).ctimeNs;
    const entry = await written('dist/dsh.js');
    for (const file of others) assert.ok(await written(file) <= entry, `${file} was written after the entry`);
  } finally {
    await rm(live, { recursive: true, force: true });
  }
});
