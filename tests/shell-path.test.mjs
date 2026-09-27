import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { claudeProfile, codexProfile } from '../dist/acp-profiles.js';

// A GUI-launched host inherits launchd's bare PATH; the directories a version manager adds (nvm, pnpm, …) exist only in
// the user's shell. The fixture's login shell adds one such directory holding a uniquely named Node runtime.
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'shell-path-'));
  const bin = join(home, 'shellbin');
  await mkdir(bin);
  await symlink(process.execPath, join(bin, 'dsh-test-node'));
  await writeFile(join(home, '.bash_profile'), 'export PATH="$HOME/shellbin:$PATH"\n');
  return { home, bin, environment: { HOME: home, SHELL: '/bin/bash', PATH: '/usr/bin:/bin' }, close: () => rm(home, { recursive: true, force: true }) };
}

test('Harness processes keep the host PATH first and gain the directories the user shell adds', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  try {
    for (const env of [codexProfile({ command: 'codex', environment: {} }).spawn(f.environment).env,
      claudeProfile({ command: process.execPath, environment: {} }).spawn(f.environment).env]) {
      const entries = env.PATH.split(delimiter);
      assert.ok(entries.includes(f.bin), env.PATH);
      assert.ok(entries.indexOf('/usr/bin') < entries.indexOf(f.bin) && entries.indexOf('/bin') < entries.indexOf(f.bin), env.PATH);
    }
  } finally { await f.close(); }
});

test('a Codex command that is a `#!/usr/bin/env node` script runs when only the user shell puts Node on PATH', { skip: process.platform === 'win32', timeout: 10000 }, async () => {
  const f = await fixture();
  const command = join(f.home, 'codex');
  await writeFile(command, `#!/usr/bin/env dsh-test-node
import { createInterface } from 'node:readline';
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  process.stdout.write(JSON.stringify({ id: request.id, result: request.method === 'plugin/installed' ? { marketplaces: [] } : {} }) + '\\n');
}
`);
  await chmod(command, 0o755);
  try {
    assert.deepEqual(await codexProfile({ command, environment: f.environment }).listPlugins('/work'), []);
  } finally { await f.close(); }
});

test('Codex forwards the user HTTPS proxy to an enabled CUA MCP server without embedding its value in config', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cua-proxy-'));
  const codexHome = join(home, '.codex');
  const plugin = join(codexHome, 'plugins', 'cache', 'openai-bundled', 'unified-computer-use', '26.1.0');
  const server = { command: '/bin/cua', args: ['server'], env: { KEEP: 'value' }, env_vars: ['ALREADY'], enabled_tools: ['js', 'js_reset', 'turn_ended'] };
  await mkdir(plugin, { recursive: true });
  await writeFile(join(codexHome, 'config.toml'), '[plugins."unified-computer-use@openai-bundled"]\nenabled = true\n');
  await writeFile(join(plugin, '.mcp.json'), JSON.stringify({ mcpServers: { cua_repl: server } }));
  try {
    const env = { HOME: home, CODEX_HOME: codexHome, SHELL: '/bin/false', HTTPS_PROXY: 'http://proxy.example:8080' };
    const config = JSON.parse(codexProfile({ command: 'codex', environment: env }).spawn(env).env.CODEX_CONFIG);
    assert.deepEqual(config.mcp_servers.cua_repl, { ...server, env_vars: ['ALREADY', 'HTTPS_PROXY'] });
    assert.equal(JSON.stringify(config).includes('proxy.example'), false);
    await writeFile(join(codexHome, 'config.toml'), '[plugins."unified-computer-use@openai-bundled"]\nenabled = false\n');
    const disabled = JSON.parse(codexProfile({ command: 'codex', environment: env }).spawn(env).env.CODEX_CONFIG);
    assert.equal(disabled.mcp_servers?.cua_repl, undefined);
  } finally { await rm(home, { recursive: true, force: true }); }
});
