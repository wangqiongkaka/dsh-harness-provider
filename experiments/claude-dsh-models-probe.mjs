// Real Claude Code over the plugin's DSH model gateway; no external model request or credentials.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { AcpAdapter } from '../dist/acp-adapter.js';
import { claudeProfile } from '../dist/acp-profiles.js';
import { ClaudeDshModels, dshModelId, dshThinkingId } from '../dist/claude-dsh-models.js';

const command = process.env.CLAUDE_COMMAND ?? claudeProfile({ environment: process.env }).spawn(process.env).env.CLAUDE_CODE_EXECUTABLE;
const { startMessagesFixture } = await import(pathToFileURL(resolve(process.env.DSH_REFERENCE_ROOT ?? '../../deepseek-harness', 'packages/subagent/subagent-claude-code/tests/messages-fixture.ts')));
const nativeFixture = await startMessagesFixture({ kind: 'complete', text: 'NATIVE_MODEL_REPLY' });
const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-claude-model-probe-')));
const cwd = join(root, 'workspace'), config = join(root, 'claude');
await mkdir(cwd); await mkdir(config);
await mkdir(join(cwd, '.claude', 'agents'), { recursive: true });
await writeFile(join(cwd, '.claude', 'agents', 'fixture-agent.md'), '---\nname: fixture-agent\ndescription: Local probe agent\nmodel: inherit\ntools: Read\n---\nDSH_AGENT_PERSONA_MARKER\n');
await writeFile(join(cwd, 'fixture.txt'), 'DSH_EXTERNAL_TOOL_RESULT');
await writeFile(join(config, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1' } }));
const requests = [], adapters = [];
const id = dshModelId('fixture-provider', 'fixture-model');
const off = dshThinkingId('fixture-provider', 'fixture-model', 'off');
const high = dshThinkingId('fixture-provider', 'fixture-model', 'high');
const environment = { PATH: process.env.PATH, HOME: root, SHELL: '/bin/false', CLAUDE_CONFIG_DIR: config,
  NO_PROXY: '127.0.0.1,localhost', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1' };
function adapter() {
  const gateway = new ClaudeDshModels({
    listProviders: () => [{ id: 'fixture-provider', name: '本机夹具' }],
    listModels: async () => [{ id: 'fixture-model', name: '夹具模型' }],
    resolveModelInfo: async (provider, id) => ({ provider, id, name: '夹具模型', reasoning: {
      efforts: [{ id: 'off', name: '关闭' }, { id: 'high', name: '高' }], defaultEffort: 'high',
    } }),
    async *stream(options) {
      requests.push(options);
      assert.equal(options.provider, 'fixture-provider'); assert.equal(options.model, 'fixture-model');
      const block = requests.length === 1
        ? { type: 'tool-call', id: 'tool_fixture_read', name: 'Read', arguments: JSON.stringify({ file_path: join(cwd, 'fixture.txt') }) }
        : { type: 'text', text: 'DSH_EXTERNAL_MODEL_REPLY' };
      yield { type: 'block-end', index: 0, block };
      yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 10 } };
      yield { type: 'finish', reason: { kind: block.type === 'tool-call' ? 'tool-calls' : 'stop' } };
    },
  });
  const instance = new AcpAdapter({ environment, profile: claudeProfile({ command, environment, dshModels: gateway }) });
  adapters.push(instance); return instance;
}
const unwrap = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.value; };
async function turn(session, text, expected = 'DSH_EXTERNAL_MODEL_REPLY') {
  const iterator = session.outputs[Symbol.asyncIterator]();
  unwrap(await session.execute({ type: 'turn.start', turnId: text, input: [{ type: 'text', text }] }));
  let reply = '';
  while (true) {
    const next = await iterator.next(); assert.equal(next.done, false);
    const event = next.value.event;
    if (event?.type === 'item.completed' && event.snapshot.item.type === 'agentMessage') reply += event.snapshot.item.text;
    if (event?.type === 'turn.completed') { assert.equal(event.outcome.status, 'succeeded', JSON.stringify(event)); assert.ok(reply.includes(expected), reply); return; }
  }
}
const timeout = setTimeout(() => { console.error('Claude 外部模型探针超时'); process.exit(1); }, 90_000);
try {
  const first = adapter();
  const inspected = await first.inspect({ cwd });
  assert.equal(inspected.status, 'ready', JSON.stringify(inspected));
  assert.ok(inspected.catalog.models.some(model => model.ref.id === id));
  const session = unwrap(await first.open({ kind: 'create', cwd, model: { id }, thinkingOptionId: off, permissionModeId: 'bypassPermissions',
    instructions: 'DSH_EXTERNAL_SYSTEM_INSTRUCTIONS', configValues: { fast: true, ultracode: true } }));
  assert.equal(session.initialState.effectiveThinkingOptionId, off);
  for (const configId of ['fast', 'ultracode']) assert.equal((await session.execute({ type: 'config.select', configId, value: true })).error?.code, 'unsupported');
  unwrap(await session.execute({ type: 'config.select', configId: 'agent', value: 'fixture-agent' }));
  await turn(session, '读取 fixture.txt 后回复');
  assert.ok(requests.some(request => request.messages.some(message => message.role === 'tool' && JSON.stringify(message.content).includes('DSH_EXTERNAL_TOOL_RESULT'))));
  assert.ok(requests.some(request => request.system?.includes('DSH_EXTERNAL_SYSTEM_INSTRUCTIONS')));
  assert.ok(requests.some(request => JSON.stringify(request.messages).includes('DSH_AGENT_PERSONA_MARKER') || request.system?.includes('DSH_AGENT_PERSONA_MARKER')));
  assert.ok(requests.length > 0 && requests.every(request => request.reasoningEffort === 'off'));
  const before = unwrap(await session.readSnapshot()).turns.map(turn => turn.nativeTurnRef.nativeTurnKey);
  const nativeRef = session.initialState.nativeRef;
  await first.close();
  const second = adapter();
  const resumed = unwrap(await second.open({ kind: 'resume', cwd, nativeRef, model: { id }, thinkingOptionId: off, permissionModeId: 'bypassPermissions',
    configValues: { fast: true, ultracode: true, agent: 'fixture-agent' } }));
  assert.equal(resumed.initialState.effectiveThinkingOptionId, off);
  assert.deepEqual(unwrap(await resumed.readSnapshot()).turns.map(turn => turn.nativeTurnRef.nativeTurnKey), before);
  await turn(resumed, '恢复后继续');
  assert.equal(requests.at(-1).reasoningEffort, 'off');
  assert.ok(JSON.stringify(requests.at(-1)).includes('DSH_AGENT_PERSONA_MARKER'));
  await resumed.close();
  const stronger = unwrap(await second.open({ kind: 'resume', cwd, nativeRef, model: { id }, thinkingOptionId: high, permissionModeId: 'bypassPermissions' }));
  assert.equal(stronger.initialState.effectiveThinkingOptionId, high);
  await turn(stronger, '改用高推理强度');
  assert.equal(requests.at(-1).reasoningEffort, 'high');
  await stronger.close();
  await writeFile(join(config, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: nativeFixture.baseUrl } }));
  const native = new AcpAdapter({ environment: { ...environment, ANTHROPIC_API_KEY: 'fixture-only' }, profile: claudeProfile({ command, environment }) });
  adapters.push(native);
  const switched = unwrap(await native.open({ kind: 'resume', cwd, nativeRef, model: { id: 'sonnet' }, permissionModeId: 'bypassPermissions' }));
  await turn(switched, '切回原生模型', 'NATIVE_MODEL_REPLY');
  assert.ok(nativeFixture.requests.length > 0);
  console.log('真实 Claude Code：外部模型、推理档位、Agent 预设、禁用不兼容配置、工具执行与恢复验证通过');
} finally { clearTimeout(timeout); await Promise.allSettled(adapters.map(adapter => adapter.close())); await nativeFixture.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
