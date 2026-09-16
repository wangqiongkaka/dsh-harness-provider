import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CodexAdapter } from '../dist/codex-adapter.js';
import { CodexRpc } from '../dist/codex-rpc.js';

const here = dirname(fileURLToPath(import.meta.url));
const reference = resolve(process.env.DSH_REFERENCE_ROOT ?? '../../deepseek-harness');
const { completeResponsesEvents } = await import(pathToFileURL(join(reference, 'packages/subagent/subagent-codex/tests/responses-fixture.ts')));
const command = process.env.CODEX_COMMAND ?? '/opt/homebrew/bin/codex';
const unwrap = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.value; };

async function startFixture() {
  const requests = [], script = [
    { namespace: 'mcp__probe', name: 'ask', arguments: {} },
    { text: 'mcp-complete' }, { text: 'hook-complete' },
  ];
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    requests.push({ body: JSON.parse(body) });
    const behavior = script.shift(); assert.ok(behavior, 'fixture script exhausted');
    const events = 'text' in behavior ? completeResponsesEvents(behavior.text) : (() => {
      const item = { id: 'fc_fixture', type: 'function_call', status: 'completed', namespace: behavior.namespace,
        name: behavior.name, arguments: JSON.stringify(behavior.arguments), call_id: 'call_fixture' };
      const completed = { id: 'resp_fixture', object: 'response', created_at: 1, status: 'completed', background: false,
        error: null, incomplete_details: null, instructions: null, max_output_tokens: null, max_tool_calls: null,
        model: 'fixture-model', output: [item], parallel_tool_calls: true, previous_response_id: null,
        prompt_cache_key: null, prompt_cache_retention: null, reasoning: { effort: null, summary: null },
        safety_identifier: null, service_tier: 'default', store: false, temperature: null,
        text: { format: { type: 'text' }, verbosity: 'medium' }, tool_choice: 'auto', tools: [], top_logprobs: 0,
        top_p: null, truncation: 'disabled', usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 },
          output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 15 }, user: null, metadata: {} };
      return [{ type: 'response.created', response: { ...completed, status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item },
        { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response: completed }];
    })();
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { requests, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, close: () => new Promise(resolve => server.close(resolve)) };
}
const fixture = await startFixture();
const root = await mkdtemp(join(tmpdir(), 'dsh-codex-capabilities-'));
const home = join(root, 'codex');
const marker = join(root, 'hook.log');
await mkdir(home);
await mkdir(join(root, '.agents', 'skills', 'probe-skill'), { recursive: true });
await writeFile(join(root, '.agents', 'skills', 'probe-skill', 'SKILL.md'), `---\nname: probe-skill\ndescription: Capability probe\n---\nProbe skill.\n`);
await writeFile(join(home, 'hooks.json'), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{
  type: 'command', command: `"${process.execPath}" "${join(here, 'codex-hook-fixture.mjs')}" "${marker}"`,
}] }] } }));
await writeFile(join(home, 'config.toml'), `model = "fixture-model"
model_provider = "fixture"
approval_policy = "on-request"
sandbox_mode = "workspace-write"
check_for_update_on_startup = false
[model_providers.fixture]
name = "Local fixture"
base_url = ${JSON.stringify(fixture.baseUrl)}
env_key = "OPENAI_API_KEY"
wire_api = "responses"
requires_openai_auth = false
[mcp_servers.probe]
command = ${JSON.stringify(process.execPath)}
args = [${JSON.stringify(join(here, 'claude-mcp-fixture.mjs'))}]
[features]
codex_hooks = true
[analytics]
enabled = false
`);

const environment = {
  PATH: process.env.PATH, HOME: root, CODEX_HOME: home, OPENAI_API_KEY: 'fixture-only',
  NO_PROXY: '127.0.0.1,localhost',
};
const rpcOptions = { command, environment, requestTimeoutMs: 15000, shutdownTimeoutMs: 1000, maxFrameBytes: 16 * 1024 * 1024 };
const trustRpc = new CodexRpc({ ...rpcOptions, cwd: root, onMessage: () => {}, onFault: () => {} });
await trustRpc.request('initialize', { clientInfo: { name: 'dsh-probe', version: '1' }, capabilities: { experimentalApi: true } });
trustRpc.send({ method: 'initialized', params: {} });
const discovered = await trustRpc.request('hooks/list', { cwds: [root] });
const hooksToTrust = discovered.data[0].hooks;
await trustRpc.request('config/batchWrite', { edits: hooksToTrust.map(hook => ({
  keyPath: `hooks.state.${JSON.stringify(hook.key)}.trusted_hash`, value: hook.currentHash, mergeStrategy: 'replace',
})), reloadUserConfig: false });
await trustRpc.close();
const adapter = new CodexAdapter(rpcOptions);
const iterators = new WeakMap();

async function run(session, turnId, text, respond) {
  if (!iterators.has(session)) iterators.set(session, session.outputs[Symbol.asyncIterator]());
  const output = iterators.get(session), seen = [];
  unwrap(await session.execute({ type: 'turn.start', turnId, input: [{ type: 'text', text }] }));
  for (;;) {
    const next = await output.next(); assert.equal(next.done, false); seen.push(next.value);
    if (next.value.kind === 'interaction') await respond?.(session, next.value.interaction);
    if (next.value.kind === 'event' && next.value.event.type === 'turn.completed') {
      assert.equal(next.value.event.outcome.status, 'succeeded', JSON.stringify(next.value));
      return seen;
    }
  }
}

try {
  const session = unwrap(await adapter.open({ kind: 'create', cwd: root, permissionModeId: 'workspaceWrite' }));
  const mcp = await run(session, 'mcp', 'Use the probe ask tool', async (active, interaction) => {
    if (interaction.type === 'approval') unwrap(await active.execute({ type: 'interaction.respond', interactionId: interaction.interactionId,
      response: { type: 'approval', actionId: 'accept' } }));
    else {
      assert.equal(interaction.questions[0].id, 'region');
      unwrap(await active.execute({ type: 'interaction.respond', interactionId: interaction.interactionId,
        response: { type: 'question', answers: { region: ['eu'] } } }));
    }
  });
  assert.ok(mcp.some(output => output.event?.type === 'turn.completed'));
  assert.match(JSON.stringify(fixture.requests[1].body.input), /MCP:accept:eu/);
  console.log('PASS: real Codex CLI loads project MCP, executes its tool, and bridges MCP elicitation through DSH');

  const beforeSlash = fixture.requests.length;
  const skills = await run(session, 'skills', '/skills');
  assert.match(skills.find(output => output.event?.type === 'item.completed').event.snapshot.item.text, /probe-skill/);
  const mcpStatus = await run(session, 'mcp-status', '/mcp');
  assert.match(mcpStatus.find(output => output.event?.type === 'item.completed').event.snapshot.item.text, /probe/);
  const hooks = await run(session, 'hooks-status', '/hooks');
  const hooksText = hooks.find(output => output.event?.type === 'item.completed').event.snapshot.item.text;
  assert.match(hooksText, /userPromptSubmit/i); assert.doesNotMatch(hooksText, /disabled|untrusted|modified/i, hooksText);
  assert.equal(fixture.requests.length, beforeSlash, 'local slash command reached the model');
  console.log('PASS: /skills and /mcp use native Codex catalogs without a model request');

  const hook = await run(session, 'hook', 'Run the configured hook');
  assert.match(await readFile(marker, 'utf8'), /Run the configured hook/);
  assert.ok(fixture.requests.some(request => JSON.stringify(request.body).includes('CODEX_HOOK_CONTEXT')));
  assert.ok(hook.some(output => output.event?.type === 'item.completed' && output.event.snapshot.item.type === 'toolExecution'));
  console.log('PASS: real Codex CLI runs hooks, adds context, and DSH renders hook activity');
} finally {
  await adapter.close();
  await fixture.close();
  await rm(root, { recursive: true, force: true });
}
