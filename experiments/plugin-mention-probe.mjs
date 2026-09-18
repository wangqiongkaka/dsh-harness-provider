// Does a Codex plugin mention survive codex-acp? Compares the model requests of the user's real Codex CLI for:
//   baseline  - plain text, no mention (app-server)
//   native    - app-server `{ type: 'mention', path: 'plugin://…' }` (what the Codex TUI sends)
//   acp       - ACP `resource_link` / inline `[@name](plugin://…)` text through the bundled codex-acp
// Codex recognizes only `[@<plugin name>](plugin://<plugin>@<marketplace>)`; the display name does not match.
// The model is a local fixture; nothing reaches a real model service.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { CodexRpc } from '../dist/codex-rpc.js';
import { codexPlugins } from '../dist/acp-profiles.js';

const reference = resolve(process.env.DSH_REFERENCE_ROOT ?? '../../deepseek-harness');
const { startResponsesFixture } = await import(pathToFileURL(join(reference, 'packages/subagent/subagent-codex/tests/responses-fixture.ts')));
const codex = process.env.CODEX_COMMAND ?? '/opt/homebrew/bin/codex';
const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-plugin-mention-')));
const codexHome = join(root, 'codex'), workspace = join(root, 'workspace'), market = join(root, 'market');
const PLUGIN = 'probe-plugin', MARKET = 'probe-market', URI = `plugin://${PLUGIN}@${MARKET}`;

await mkdir(workspace, { recursive: true });
await mkdir(join(market, '.agents', 'plugins'), { recursive: true });
const pluginDir = join(market, 'plugins', PLUGIN);
await mkdir(join(pluginDir, '.codex-plugin'), { recursive: true });
await mkdir(join(pluginDir, 'skills', 'probe-plugin-skill'), { recursive: true });
await writeFile(join(market, '.agents', 'plugins', 'marketplace.json'), JSON.stringify({ name: MARKET, interface: { displayName: 'Probe Market' },
  plugins: [{ name: PLUGIN, source: { source: 'local', path: `./plugins/${PLUGIN}` }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Developer Tools' }] }, null, 2));
await writeFile(join(pluginDir, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: PLUGIN, version: '0.0.1', description: 'PLUGIN_DESCRIPTION_MARKER',
  interface: { displayName: 'Probe Plugin', shortDescription: 'PLUGIN_DESCRIPTION_MARKER', developerName: 'probe', category: 'Developer Tools', capabilities: ['Read'] }, skills: './skills/' }, null, 2));
await writeFile(join(pluginDir, 'skills', 'probe-plugin-skill', 'SKILL.md'), '---\nname: probe-plugin-skill\ndescription: PLUGIN_SKILL_DESCRIPTION_MARKER\n---\nPLUGIN_SKILL_BODY_MARKER\n');

const fixture = await startResponsesFixture(Array.from({ length: 20 }, (_, i) => ({ kind: 'complete', text: `reply-${i}` })));
await mkdir(codexHome, { recursive: true });
await writeFile(join(codexHome, 'config.toml'), `model = "fixture-model"
model_provider = "fixture"
approval_policy = "never"
sandbox_mode = "read-only"
check_for_update_on_startup = false
[model_providers.fixture]
name = "Local fixture"
base_url = "${fixture.baseUrl}"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
requires_openai_auth = false
[analytics]
enabled = false
[marketplaces.${MARKET}]
source_type = "local"
source = "${market}"
[plugins."${PLUGIN}@${MARKET}"]
enabled = true
`);
const environment = { PATH: process.env.PATH, HOME: root, CODEX_HOME: codexHome, OPENAI_API_KEY: 'fixture-only', NO_PROXY: '127.0.0.1,localhost' };

/** Model requests whose input carries `tag` (the prompt of one run), as JSON text. */
const requestsFor = tag => fixture.requests.map(r => JSON.stringify(r.body)).filter(body => body.includes(tag));
/** The developer message Codex adds for a mentioned plugin, if the run's request carries one. */
const capability = tag => requestsFor(tag).at(-1)?.match(/Capabilities from the[^"]*/)?.[0];

async function appServerRun(tag, input) {
  const done = Promise.withResolvers();
  const rpc = new CodexRpc({ command: codex, cwd: workspace, environment, requestTimeoutMs: 60_000, shutdownTimeoutMs: 2_000, maxFrameBytes: 16 * 1024 * 1024,
    onMessage: message => { if (message.method === 'turn/completed') done.resolve(message.params); }, onFault: cause => done.reject(cause) });
  try {
    await rpc.request('initialize', { clientInfo: { name: 'probe', version: '0', title: 'probe' }, capabilities: { experimentalApi: true } });
    rpc.send({ method: 'initialized', params: {} });
    if (tag === 'BASELINE_TAG') {
      const listed = await rpc.request('plugin/list', { cwds: [workspace] });
      console.log('plugin/list:', JSON.stringify({ marketplaces: listed.marketplaces.map(entry => ({ name: entry.name, plugins: entry.plugins.map(plugin => [plugin.id, plugin.installed, plugin.enabled]) })), errors: listed.marketplaceLoadErrors }));
      if (!listed.marketplaces.some(entry => entry.plugins.some(plugin => plugin.name === PLUGIN && plugin.installed)))
        console.log('plugin/install:', JSON.stringify(await rpc.request('plugin/install', { marketplacePath: join(market, '.agents', 'plugins', 'marketplace.json'), pluginName: PLUGIN }).catch(cause => String(cause))));
    }
    const installed = await rpc.request('plugin/installed', { cwds: [workspace] });
    const summary = installed.marketplaces.flatMap(entry => entry.plugins.map(plugin => ({ market: entry.name, id: plugin.id, name: plugin.name, installed: plugin.installed, enabled: plugin.enabled })));
    if (tag === 'BASELINE_TAG') console.log('plugin/installed:', JSON.stringify(summary));
    const { thread } = await rpc.request('thread/start', { cwd: workspace });
    await rpc.request('turn/start', { threadId: thread.id, input });
    const completed = await Promise.race([done.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('turn timeout')), 60_000))]);
    if (completed.turn?.status !== 'completed') console.log(tag, 'turn status', completed.turn?.status, JSON.stringify(completed.turn?.error ?? null));
  } finally { await rpc.close(); }
}

async function acpRun(tag, prompt, loadSessionId) {
  let replayed = '';
  const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/codex-acp.mjs', import.meta.url))], { cwd: workspace, env: { ...environment, CODEX_PATH: codex }, stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map(); let next = 1;
  createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line);
    if (message.method === 'session/update' && message.params.update.sessionUpdate === 'user_message_chunk' && message.params.update.content.type === 'text') replayed += message.params.update.content.text;
    if (message.id !== undefined && message.method) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: message.method === 'session/request_permission' ? { outcome: { outcome: 'cancelled' } } : {} }) + '\n');
    else if (message.id !== undefined) { const entry = pending.get(message.id); pending.delete(message.id); message.error ? entry?.reject(new Error(JSON.stringify(message.error))) : entry?.resolve(message.result); }
  });
  const request = (method, params) => new Promise((resolve_, reject) => { const id = next++; pending.set(id, { resolve: resolve_, reject }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  try {
    await request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    if (loadSessionId) { await request('session/load', { sessionId: loadSessionId, cwd: workspace, mcpServers: [] }); return replayed; }
    const { sessionId } = await request('session/new', { cwd: workspace, mcpServers: [] });
    const response = await request('session/prompt', { sessionId, prompt });
    if (response.stopReason !== 'end_turn') console.log(tag, 'stopReason', response.stopReason);
    return sessionId;
  } finally { const exited = new Promise(resolve_ => child.once('exit', resolve_)); child.kill(); await exited; }
}

try {
  const runs = [
    ['BASELINE_TAG', 'plain text, no mention', () => appServerRun('BASELINE_TAG', [{ type: 'text', text: 'BASELINE_TAG hello', text_elements: [] }]), false],
    ['NATIVE_TAG', 'app-server mention item (Codex TUI)', () => appServerRun('NATIVE_TAG', [{ type: 'text', text: 'NATIVE_TAG use @Probe Plugin', text_elements: [] }, { type: 'mention', name: 'Probe Plugin', path: URI }]), true],
    ['ACPDISPLAY_TAG', 'codex-acp resource_link named by display name', () => acpRun('ACPDISPLAY_TAG', [{ type: 'text', text: 'ACPDISPLAY_TAG use ' }, { type: 'resource_link', name: 'Probe Plugin', uri: URI }]), false],
    ['ACPNAME_TAG', 'codex-acp resource_link named by plugin name', () => acpRun('ACPNAME_TAG', [{ type: 'text', text: 'ACPNAME_TAG use ' }, { type: 'resource_link', name: PLUGIN, uri: URI }]), true],
    ['ACPTEXT_TAG', 'codex-acp inline text link', () => acpRun('ACPTEXT_TAG', [{ type: 'text', text: `ACPTEXT_TAG use [@${PLUGIN}](${URI})` }]), true],
    ...[`[@Probe Plugin](${URI})`, `[$${PLUGIN}](${URI})`, `@${PLUGIN}`, `$${PLUGIN}`].map((text, i) => [`TEXT${i}_TAG`, `app-server text ${text}`, () => appServerRun(`TEXT${i}_TAG`, [{ type: 'text', text: `TEXT${i}_TAG use ${text}`, text_elements: [] }]), false]),
  ];
  for (const [tag, label, run, expected] of runs) {
    await run();
    console.log(`${capability(tag) ? 'injects ' : 'no plugin'} | ${label}`);
    assert.equal(!!capability(tag), expected, label);
  }
  assert.equal(capability('ACPNAME_TAG'), capability('NATIVE_TAG'));
  // The `@` menu's own catalog read and mention text, sent the way a composer chip is.
  const plugins = await codexPlugins(codex, environment, workspace);
  console.log('codexPlugins:', JSON.stringify(plugins));
  const menu = plugins.find(plugin => plugin.name === PLUGIN);
  assert.ok(menu, 'the installed plugin is in the @ menu');
  const sent = `MENU_TAG use ${menu.mention} please`;
  const sessionId = await acpRun('MENU_TAG', [{ type: 'text', text: sent }]);
  assert.equal(capability('MENU_TAG'), capability('NATIVE_TAG'), 'the @ menu mention injects what the native mention does');
  console.log('injects  | @ menu mention through codex-acp');
  // Turn keys hash the prompt text; a new process must replay it byte for byte.
  const replayed = await acpRun('MENU_TAG', [], sessionId);
  assert.equal(replayed, sent, 'session/load replays the mention text unchanged');
  console.log('replays  | the mention text unchanged after session/load in a new process');
  console.log('PASS: a plugin:// resource_link named by the plugin name reaches Codex as the native plugin mention');
} finally { await fixture.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
