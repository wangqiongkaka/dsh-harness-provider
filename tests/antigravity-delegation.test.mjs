import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';
import { Context, Service } from '@deepseek-ai/cordis';
import Typert from '@deepseek-ai/dsh-typert-registry';
import Agents from '@deepseek-ai/dsh-agent';
import Loop from '@deepseek-ai/dsh-agent-loop';
import Llm, { createUserMessage } from '@deepseek-ai/dsh-llm';
import Sessions from '@deepseek-ai/dsh-session';
import Projections from '@deepseek-ai/dsh-session-projection';
import Prompt from '@deepseek-ai/dsh-system-prompt';
import LocalAttachments from '@deepseek-ai/dsh-attachment-local';
import Tools, { executeTool } from './tools.mjs';
import Persistence from './session-persistence.mjs';
import { HarnessOutputChannel } from '../dist/contracts.js';
import { AcpAdapter, catalogsOf, modelRef } from '../dist/acp-adapter.js';
import { HarnessService, inject } from '../dist/dsh.js';
import { delegationInstructions } from '../dist/delegation.js';
import { Config, defaultSettings, settingsOf } from '../dist/settings.js';

const exec = promisify(execFile);
const git = async (cwd, ...args) => (await exec('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args])).stdout.trim();

test('委派与讨论配置接受 Antigravity，并继续拒绝不支持的选项', () => {
  assert.deepEqual(settingsOf(Config({ delegateHarnesses: ['dsh', 'codex', 'claude-code', 'antigravity'] }))().delegateHarnesses, ['dsh', 'codex', 'claude-code', 'antigravity']);
  assert.deepEqual(settingsOf(Config({ discussHarnesses: ['codex', 'claude-code', 'antigravity'] }))().discussHarnesses, ['codex', 'claude-code', 'antigravity']);
  assert.deepEqual(settingsOf(Config({ discussHarnesses: ['antigravity'] }))().discussHarnesses, ['antigravity']);
  assert.ok(Config['~standard'].validate({ discussHarnesses: ['dsh'] }).issues?.length);
});

test('委派与讨论完整支持 Antigravity：模型选择、worktree、只读计划模式讨论与多参与者互评', { timeout: 20000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-agy-delegate-'));
  const repo = join(root, 'repo');
  const ctx = new Context();
  const opens = [], created = [], renamed = [];
  const workspace = { id: 'workspace', title: 'Repo', path: repo, sessionIds: ['source'] };
  class Commands extends Service {
    constructor(ctx) { super(ctx, 'sessionController'); }
    async resolveAgent(id) { const agent = ctx.agents.get(id); return agent ? { agent } : { error: new Error('missing session') }; }
    async create(request) {
      created.push(request);
      const { agent } = await ctx.agents.create({ agentOptions: { provider: 'fixture', model: 'fixture' }, sessionId: request.sessionId, meta: { cwd: repo } });
      workspace.sessionIds.push(agent.id);
      return { sessionId: agent.id };
    }
    async prompt(request) {
      ctx.agents.get(request.sessionId).followup(createUserMessage({ content: request.content, source: { kind: 'user', rpcId: request.requestId } }));
      return { accepted: true };
    }
    async rename(request) { renamed.push(request); return { title: request.title, seq: 1 }; }
    async fork() {} async selectModel() {} updateQueue() {}
  }
  const catalogs = {
    codex: { models: [{ ref: { id: 'gpt-5.5' }, label: 'GPT-5.5' }], thinkingOptions: [{ id: 'high', label: 'High' }], defaultModel: { id: 'gpt-5.5' } },
    'claude-code': { models: [{ ref: { id: 'sonnet' }, label: 'Sonnet' }], thinkingOptions: [{ id: 'high', label: 'High' }], defaultModel: { id: 'sonnet' } },
    antigravity: { models: [{ ref: { id: 'gemini-4-neon-high' }, label: 'Gemini 4 Neon (High)' }, { ref: { id: 'gemini-3.8-flash-low' }, label: 'Gemini 3.8 Flash (Low)' }], thinkingOptions: [], defaultModel: { id: 'gemini-4-neon-high' } },
  };
  const modes = {
    codex: [{ id: 'read-only', label: 'Read only' }, { id: 'agent', label: 'Agent' }, { id: 'agent-full-access', label: 'Full access', dangerous: true }],
    'claude-code': [{ id: 'plan', label: 'Plan' }, { id: 'auto', label: 'Auto' }, { id: 'bypassPermissions', label: 'Full access', dangerous: true }],
    antigravity: [{ id: 'default', label: 'Standard' }, { id: 'plan', label: 'Plan Mode' }],
  };
  const adapter = harness => ({
    async inspect() {
      return { status: 'ready', catalog: catalogs[harness], permissionModes: { modes: modes[harness], defaultModeId: modes[harness][0].id } };
    },
    async open(input) {
      opens.push({ harness, input });
      const channel = new HarnessOutputChannel();
      return { ok: true, value: {
        initialState: { effectivePermissionModeId: input.permissionModeId },
        outputs: channel.outputs,
        async close() { channel.end(); },
        async execute(command) {
          channel.emit({ kind: 'event', event: { type: 'item.completed', turnId: command.turnId, snapshot: { item: { type: 'agentMessage', itemId: 'answer', text: `${harness} reply` }, outcome: { status: 'succeeded' } } } });
          channel.emit({ kind: 'event', event: { type: 'turn.completed', turnId: command.turnId, outcome: { status: 'succeeded' } } });
          return { ok: true, value: { turnId: command.turnId } };
        },
      } };
    },
    async close() {},
    async listSkills() { return []; },
  });
  try {
    await mkdir(repo, { recursive: true });
    await git(repo, 'init', '-q');
    await writeFile(join(repo, 'a.txt'), 'init\n');
    await git(repo, 'add', '-A');
    await git(repo, 'commit', '-q', '-m', 'init');
    await ctx.plugin(LocalAttachments, { dshHome: root });
    for (const plugin of [Llm, Sessions, Projections, Prompt, Tools, Agents, Typert]) await ctx.plugin(plugin);
    await ctx.plugin(Persistence, { root: join(root, 'sessions'), compression: 'none' });
    await ctx.plugin(Commands);
    ctx.provide('userQuestions', { async ask() { return { answers: [{ id: 'worktree', selected: ['暂不处理'] }] }; } });
    ctx.provide('workspaceRegistry', { list: () => [workspace] });
    ctx.provide('fileUploads', { resolve: () => undefined, bindPrompt: () => ({ commit() {}, [Symbol.dispose]() {} }) });
    ctx.provide('sessionTitle', {});
    ctx.provide('sessionSkillCatalog', { async list() { return { skills: [] }; } });
    ctx.provide('permissionPresets', { names: ['workspace-write'], current: () => 'workspace-write', resolve: name => ({ sandbox: name }), set() {} });
    ctx.provide('shell', { sandboxMode: 'workspace-write' });
    await ctx.plugin({ inject, apply(scope) {
      new HarnessService(scope, join(root, 'bindings'), { codex: adapter('codex'), 'claude-code': adapter('claude-code'), antigravity: adapter('antigravity') });
    } });
    ctx.on('agent/pre-step', async (payload, next) => payload.agent.id === 'source' || !(await ctx.harness.bindings.read(payload.agent.id)) ? { kind: 'enter', messages: [] } : next());
    await ctx.plugin(Loop, { agents: [] });
    await ctx.agents.create({ agentOptions: { provider: 'fixture', model: 'fixture' }, sessionId: 'source', meta: { cwd: repo } });
    const h = ctx.harness;

    // 1. 委派给 Antigravity（从默认 workspace-write 原生会话发起，带模型选择与默认标题）
    const delegated = await h.delegateFromUser({
      sessionId: 'source', requestId: 'agy-1', harness: 'antigravity', prompt: 'Refactor module',
      reportBack: false, worktree: false, attachments: [], picks: { antigravity: { model: 'gemini-3.8-flash-low' } },
    });
    await ctx.agents.get(delegated.sessionId).whenIdle();
    assert.equal(delegated.harness, 'antigravity');
    assert.equal(opens.at(-1).harness, 'antigravity');
    assert.equal(opens.at(-1).input.permissionModeId, 'default');
    assert.equal(opens.at(-1).input.model.id, 'gemini-3.8-flash-low');
    assert.deepEqual(renamed.at(-1), { sessionId: delegated.sessionId, title: 'Antigravity · Refactor module' });

    // 2. 错误模型报错必须指明 Antigravity，且不创建会话
    const beforeBad = created.length;
    await assert.rejects(h.delegateFromUser({
      sessionId: 'source', requestId: 'agy-bad-model', harness: 'antigravity', prompt: 'x',
      reportBack: false, worktree: false, attachments: [], picks: { antigravity: { model: 'missing-model' } },
    }), /Antigravity 没有模型 missing-model/);
    assert.equal(created.length, beforeBad);

    // 3. 多目标委派支持全部 4 个 Harness，且 Antigravity 支持独立 worktree
    const allFour = await h.delegateFromUser({
      sessionId: 'source', requestId: 'agy-all-four', harnesses: ['dsh', 'codex', 'claude-code', 'antigravity'],
      prompt: 'Compare implementations', reportBack: false, worktree: false, attachments: [], picks: {},
    });
    assert.deepEqual(allFour.sessions.map(s => s.harness), ['dsh', 'codex', 'claude-code', 'antigravity']);
    for (const entry of allFour.sessions) await ctx.agents.get(entry.sessionId).whenIdle();

    const wt = await h.delegateFromUser({
      sessionId: 'source', requestId: 'agy-wt', harness: 'antigravity', prompt: 'Work in worktree',
      reportBack: false, worktree: true, attachments: [], picks: {},
    });
    await ctx.agents.get(wt.sessionId).whenIdle();
    assert.equal(opens.at(-1).harness, 'antigravity');
    assert.equal(opens.at(-1).input.cwd, join(root, 'bindings', 'worktrees', wt.sessionId));

    // 4. 模型目录接口（dock、CLI、harness_models 工具）均包含 Antigravity
    const dockModels = await h.models({ sessionId: 'source', harness: 'antigravity' });
    assert.deepEqual(dockModels.models.map(m => m.id), ['gemini-4-neon-high', 'gemini-3.8-flash-low']);
    assert.equal(await h.bindings.read('source'), undefined);
    const environment = await h.delegation.environment('source');
    const cliModels = JSON.parse((await exec(process.execPath, [resolve('dist/delegate-cli.mjs'), 'models'], { env: { ...process.env, ...environment } })).stdout);
    assert.deepEqual(cliModels.antigravity.models.map(m => m.id), ['gemini-4-neon-high', 'gemini-3.8-flash-low']);
    const toolModels = await executeTool(ctx.tools, { callId: 'm', name: 'harness_models', arguments: {}, agent: ctx.agents.get('source'), signal: new AbortController().signal });
    assert.equal(toolModels.isError, false);
    assert.deepEqual(JSON.parse(toolModels.content[0].text), cliModels);

    // 5. 宿主说明和工具描述均包含 Antigravity
    assert.match(delegationInstructions(), /Antigravity|antigravity/);
    assert.match(ctx.tools.get('harness_discussion_dispatch').description, /Antigravity/);
    assert.match(JSON.stringify(ctx.tools.get('harness_discussion_dispatch')), /"antigravity"/);

    // 6. 讨论支持全选 3 个外部 Harness，并以只读 plan 模式打开 Antigravity 参与者
    await h.startDiscussionFromUser({
      sessionId: 'source', requestId: 'agy-discuss-3', harnesses: ['codex', 'claude-code', 'antigravity'],
      prompt: 'Review architecture', attachments: [],
    });
    await ctx.agents.get('source').whenIdle();
    h.discussions.set('source', {
      requestId: 'agy-discuss-3', content: [{ type: 'text', text: 'Review architecture' }],
      harnesses: ['codex', 'claude-code', 'antigravity'],
    });
    const dispatched = await executeTool(ctx.tools, {
      callId: 'd', name: 'harness_discussion_dispatch',
      arguments: { assignments: [
        { harness: 'codex', role: '后端', task: '检查后端' },
        { harness: 'claude-code', role: '前端', task: '检查前端' },
        { harness: 'antigravity', role: '安全', task: '检查安全', model: 'gemini-3.8-flash-low' },
      ] },
      agent: ctx.agents.get('source'), signal: new AbortController().signal,
    });
    assert.equal(dispatched.isError, false, JSON.stringify(dispatched));
    const result = JSON.parse(dispatched.content[0].text);
    assert.equal(result.peerReview, true);
    assert.deepEqual(result.participants.map(p => p.harness), ['codex', 'claude-code', 'antigravity']);
    const agyParticipant = result.participants.find(p => p.harness === 'antigravity');
    const agyBinding = await h.bindings.readDelegated(agyParticipant.sessionId);
    assert.equal(agyBinding.delegation.discussion, true);
    assert.equal(agyBinding.permission, 'plan');
    const agyOpen = opens.find(entry => entry.harness === 'antigravity' && entry.input.discussion);
    assert.ok(agyOpen);
    assert.equal(agyOpen.input.permissionModeId, 'plan');
    assert.equal(agyOpen.input.model.id, 'gemini-3.8-flash-low');
    await assert.rejects(h.selectPermission({ sessionId: agyParticipant.sessionId, permission: 'default' }), /讨论/);
    await assert.rejects(h.delegate(agyParticipant.sessionId, { requestId: 'nested', harness: 'antigravity', prompt: 'x' }), /讨论/);
  } finally {
    await ctx.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('AcpAdapter 允许 Antigravity 以 plan 模式打开只读讨论并启用 sandbox，仍拒绝未授权或错误权限', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-agy-acp-discuss-'));
  const script = join(root, 'agy-peer.mjs');
  const log = join(root, 'log.jsonl');
  await writeFile(script, `
import { agent, ndJsonStream } from '${import.meta.resolve('@agentclientprotocol/sdk/unstable')}';
import { appendFileSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
const note = value => appendFileSync(${JSON.stringify(log)}, JSON.stringify(value) + '\\n');
let mode = 'default', sandbox = false, model = 'gemini-4-neon-high';
const configOptions = () => [
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: model, options: [{ value: 'gemini-4-neon-high', name: 'Gemini 4 Neon (High)' }, { value: 'gemini-3.8-flash-low', name: 'Gemini 3.8 Flash (Low)' }] },
  { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: mode, options: [{ value: 'default', name: 'Standard' }, { value: 'plan', name: 'Plan Mode' }] },
  { id: 'sandbox', name: 'Sandbox', category: 'security', type: 'boolean', currentValue: sandbox },
];
agent({ name: 'agy-fixture' })
  .onRequest('initialize', () => ({ protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } }, authMethods: [] }))
  .onRequest('session/new', () => ({ sessionId: 'agy-session', configOptions: configOptions() }))
  .onRequest('session/set_config_option', ({ params }) => {
    note({ set: params });
    if (params.configId === 'mode') mode = params.value;
    if (params.configId === 'sandbox') sandbox = params.value;
    if (params.configId === 'model') model = params.value;
    return { configOptions: configOptions() };
  })
  .onRequest('session/close', () => ({}))
  .connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
`);
  await chmod(script, 0o755);
  let launches = 0;
  const adapter = new AcpAdapter({
    environment: {},
    profile: { harnessId: 'antigravity', spawn: env => { launches++; return { command: process.execPath, args: [script], env }; } },
  });
  try {
    // 非讨论会话必须显式选择完全访问；讨论会话必须显式选择 plan 模式，均不能启动进程
    for (const hints of [{}, { permissionModeId: 'plan' }, { discussion: true }, { discussion: true, permissionModeId: 'default' }]) {
      const denied = await adapter.open({ kind: 'create', cwd: root, ...hints });
      assert.equal(denied.ok, false, JSON.stringify(hints));
    }
    assert.equal(launches, 0);

    // 讨论会话以 plan 模式打开时，设置 mode=plan 并开启 sandbox=true
    const opened = await adapter.open({ kind: 'create', cwd: root, discussion: true, permissionModeId: 'plan', model: modelRef('gemini-3.8-flash'), thinkingOptionId: 'low' });
    assert.equal(opened.ok, true, opened.ok ? '' : opened.error.message);
    assert.equal(opened.value.initialState.effectivePermissionModeId, 'plan');
    assert.equal(opened.value.initialState.effectiveModel.id, 'gemini-3.8-flash');
    assert.equal(opened.value.initialState.effectiveThinkingOptionId, 'low');
    assert.equal(opened.value.initialState.configValues.sandbox, true);
    const sets = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line).set);
    assert.ok(sets.some(entry => entry.configId === 'model' && entry.value === 'gemini-3.8-flash-low'));
    assert.ok(sets.some(entry => entry.configId === 'mode' && entry.value === 'plan'));
    assert.ok(sets.some(entry => entry.configId === 'sandbox' && entry.value === true && entry.type === 'boolean'));
    await opened.value.close();
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Antigravity 将复合模型选项拆分为模型与推理强度，并支持实时切换和旧模型 ID 兼容', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-agy-split-'));
  const script = join(root, 'agy-split-peer.mjs');
  const log = join(root, 'log.jsonl');
  await writeFile(script, `
import { agent, ndJsonStream } from '${import.meta.resolve('@agentclientprotocol/sdk/unstable')}';
import { appendFileSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
const note = value => appendFileSync(${JSON.stringify(log)}, JSON.stringify(value) + '\\n');
let mode = 'default', model = 'gemini-4-neon-high';
const configOptions = () => [
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: model, options: [
    { value: 'gemini-4-neon-high', name: 'Gemini 4 Neon (High)' },
    { value: 'gemini-4-neon-xhigh', name: 'Gemini 4 Neon (XHigh)' },
    { value: 'gemini-4-neon-medium', name: 'Gemini 4 Neon (Medium)' },
    { value: 'gemini-4-neon-low', name: 'Gemini 4 Neon (Low)' },
    { value: 'gemini-pro-orchestrator-neon', name: 'Orchestrator (Neon)' },
    { value: 'claude-opus-5-5-low', name: 'Claude Opus 5.5 (Low)' },
    { value: 'claude-opus-5-5-medium', name: 'Claude Opus 5.5 (Medium)' },
    { value: 'claude-opus-5-5-high', name: 'Claude Opus 5.5 (High)' },
  ] },
  { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: mode, options: [{ value: 'default', name: 'Standard' }, { value: 'plan', name: 'Plan Mode' }] },
];
agent({ name: 'agy-split-fixture' })
  .onRequest('initialize', () => ({ protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } }, authMethods: [] }))
  .onRequest('session/new', () => ({ sessionId: 'agy-split', configOptions: configOptions() }))
  .onRequest('session/set_config_option', ({ params }) => {
    note({ set: params });
    if (params.configId === 'mode') mode = params.value;
    if (params.configId === 'model') model = params.value;
    return { configOptions: configOptions() };
  })
  .onRequest('session/close', () => ({}))
  .connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
`);
  await chmod(script, 0o755);
  const adapter = new AcpAdapter({
    environment: {},
    profile: { harnessId: 'antigravity', spawn: env => ({ command: process.execPath, args: [script], env }) },
  });
  try {
    const inspected = await adapter.inspect({ cwd: root });
    assert.equal(inspected.status, 'ready');
    assert.equal(inspected.capabilities.configuration.selectThinkingOption, true);
    assert.deepEqual(inspected.catalog.models.map(m => [m.ref.id, m.label, m.supportedThinkingOptionIds, m.defaultThinkingOptionId]), [
      ['gemini-4-neon', 'Gemini 4 Neon', ['low', 'medium', 'high', 'xhigh'], 'high'],
      ['gemini-pro-orchestrator-neon', 'Orchestrator (Neon)', [], undefined],
      ['claude-opus-5-5', 'Claude Opus 5.5', ['low', 'medium', 'high'], 'low'],
    ]);
    assert.deepEqual(inspected.catalog.thinkingOptions.map(o => o.id), ['low', 'medium', 'high', 'xhigh']);
    assert.equal(inspected.catalog.defaultModel?.id, 'gemini-4-neon');
    assert.equal(inspected.catalog.defaultThinkingOptionId, 'high');

    // 打开时组合基础模型与强度，实时切换强度与模型映射回底层复合 ID
    const opened = await adapter.open({ kind: 'create', cwd: root, permissionModeId: 'default', model: modelRef('gemini-4-neon'), thinkingOptionId: 'xhigh' });
    assert.equal(opened.ok, true, opened.ok ? '' : opened.error.message);
    const session = opened.value;
    assert.equal(session.initialState.effectiveModel.id, 'gemini-4-neon');
    assert.equal(session.initialState.resolvedModelLabel, 'Gemini 4 Neon');
    assert.equal(session.initialState.effectiveThinkingOptionId, 'xhigh');

    // 切到不支持 xhigh 的 Claude Opus 5.5 时回退到该模型默认强度
    assert.equal((await session.execute({ type: 'model.select', model: modelRef('claude-opus-5-5') })).ok, true);
    assert.equal((await session.execute({ type: 'thinking.select', thinkingOptionId: 'high' })).ok, true);
    // 不支持的强度被拒绝
    assert.equal((await session.execute({ type: 'thinking.select', thinkingOptionId: 'xhigh' })).ok, false);
    // 无强度的模型可正常选择且拒绝强度切换
    assert.equal((await session.execute({ type: 'model.select', model: modelRef('gemini-pro-orchestrator-neon') })).ok, true);
    assert.equal((await session.execute({ type: 'thinking.select', thinkingOptionId: 'high' })).ok, false);
    await session.close();

    // 旧版已保存的原始复合模型 ID 仍能无损打开并归一化
    const legacy = await adapter.open({ kind: 'create', cwd: root, permissionModeId: 'default', model: modelRef('gemini-4-neon-medium') });
    assert.equal(legacy.ok, true, legacy.ok ? '' : legacy.error.message);
    assert.equal(legacy.value.initialState.effectiveModel.id, 'gemini-4-neon');
    assert.equal(legacy.value.initialState.effectiveThinkingOptionId, 'medium');
    await legacy.value.close();

    const modelSets = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line).set).filter(s => s.configId === 'model').map(s => s.value);
    assert.deepEqual(modelSets, ['gemini-4-neon-xhigh', 'claude-opus-5-5-low', 'claude-opus-5-5-high', 'gemini-pro-orchestrator-neon', 'gemini-4-neon-medium']);
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('设置页委派与讨论选择器和委派模型选择器支持 Antigravity，且桌面与手机均无横向溢出', async () => {
  const require = createRequire(resolve('node_modules/@deepseek-ai/dsh-client-ui-skill/package.json'));
  const nodePaths = [dirname(dirname(require.resolve('react/package.json'))), dirname(dirname(require.resolve('react-dom/package.json')))];
  const bundle = await build({
    stdin: {
      contents: `${await readFile('src/client.tsx', 'utf8')}
import { createRoot } from 'react-dom/client';
document.head.append(Object.assign(document.createElement('style'), { textContent: styles }));
const initial = ${JSON.stringify(defaultSettings())};
window.writes = [];
function App() {
  const [snapshot, setSnapshot] = useState({ status: 'ready', value: initial, writable: true, user: {} });
  const form = {
    set: async (field, value) => {
      window.writes.push([field, value]);
      setSnapshot(current => ({ ...current, value: { ...current.value, [field]: value }, user: { ...current.user, [field]: value } }));
      return true;
    },
    unset: async field => {
      setSnapshot(current => ({ ...current, value: { ...current.value, [field]: initial[field] }, user: {} }));
      return true;
    },
  };
  const catalog = {
    models: [
      { id: 'gemini-4-neon', label: 'Gemini 4 Neon', resolved: null, thinkingOptionIds: ['low', 'medium', 'high', 'xhigh'] },
      { id: 'gemini-pro-orchestrator-neon', label: 'Orchestrator (Neon)', resolved: null, thinkingOptionIds: [] },
    ],
    defaultModel: { id: 'gemini-4-neon', label: 'Gemini 4 Neon', resolved: null },
    thinkingOptions: [{ id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' }, { id: 'xhigh', label: 'XHigh' }],
    defaultThinkingOptionId: 'high', permissionModes: [], defaultPermissionModeId: null, configOptions: [], error: null,
  };
  return <>
    <HarnessSettingsSection useHarnessSettings={pick => pick(snapshot)} form={form} t={key => zh[key] ?? key} />
    <div id="pick-host"><DelegatePick harness="antigravity" pick={{}} load={async () => catalog} disabled={false} onChange={() => {}} t={key => zh[key] ?? key} /></div>
  </>;
}
createRoot(document.querySelector('#root')).render(<App />);`,
      resolveDir: resolve('src'), loader: 'tsx',
    },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', nodePaths, logLevel: 'warning',
    external: ['@deepseek-ai/dsh-client-ui-primitives'],
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<style>:root{--dsw-alias-label-primary:#eee;--dsw-alias-label-secondary:#bbb;--dsw-alias-label-tertiary:#999;--dsw-alias-border-l2:#333;--dsw-alias-border-l4:#555;--dsw-alias-bg-layer-3:#29292c;--dsw-alias-interactive-bg-hover:#262629;--dsw-specific-menu:#2c2c30}body{margin:24px;background:#1b1b1b;color:#eee;font:14px sans-serif}</style><div id="root"></div>');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });

    const delegateRow = page.locator('.hp-set-row').filter({ hasText: '委派默认目标' });
    const discussRow = page.locator('.hp-set-row').filter({ hasText: '讨论默认参与者' });
    assert.deepEqual(await delegateRow.getByRole('checkbox').allTextContents(), ['DSH 原生', 'Codex', 'Claude Code', 'Antigravity']);
    assert.deepEqual(await discussRow.getByRole('checkbox').allTextContents(), ['DSH 原生', 'Codex', 'Claude Code', 'Antigravity']);
    await expect(discussRow.getByRole('checkbox', { name: 'DSH 原生' })).toBeDisabled();
    await expect(discussRow.getByRole('checkbox', { name: 'Antigravity' })).toBeEnabled();

    await delegateRow.getByRole('checkbox', { name: 'Antigravity' }).click();
    await discussRow.getByRole('checkbox', { name: 'Antigravity' }).click();
    assert.deepEqual(await page.evaluate(() => window.writes), [
      ['delegateHarnesses', ['codex', 'antigravity']],
      ['discussHarnesses', ['codex', 'claude-code', 'antigravity']],
    ]);

    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `overflow at ${width}px`);
    }

    const pickChip = page.locator('#pick-host button.hp-chip');
    assert.equal((await pickChip.textContent()).trim(), 'Antigravity · 默认');
    await pickChip.click();
    await page.waitForFunction(() => document.querySelector('#pick-host .hp-cell-value')?.textContent === '默认 · Gemini 4 Neon', undefined, { timeout: 5000 });
    assert.deepEqual(await page.locator('#pick-host .hp-cell-label').allTextContents(), ['模型', '强度']);
    assert.deepEqual(await page.locator('#pick-host .hp-cell-value').allTextContents(), ['默认 · Gemini 4 Neon', '默认 · 高']);
  } finally {
    await browser.close();
  }
});

test('Antigravity 账户额度默认优先展示 Gemini 5 小时窗口并在面板保留其余分组', async () => {
  const { antigravityAccountSnapshot } = await import('../dist/acp-profiles.js');
  const { accountQuota } = await import('../dist/dsh.js');
  const raw = [
    'Gemini Models\tWeekly Limit Remaining\t93%\t2026-11-30T09:50:04Z',
    'Gemini Models\tFive Hour Limit Remaining\t74%\t2026-11-23T14:50:04Z',
    'Claude and GPT models\tWeekly Limit Remaining\t46%\t2026-11-30T10:26:13Z',
    'Claude and GPT models\tFive Hour Limit Remaining\t0%\t2026-11-23T15:26:13Z',
    'Gemini 4 Argon\tGemini 4 Argon Weekly Limit\t94%\t2026-11-30T10:27:15Z',
  ].join('\n');
  const account = antigravityAccountSnapshot(raw);
  assert.equal(account.credits.label, 'Gemini Models · Five Hour Limit');
  assert.equal(account.credits.periodType, 'five_hour');
  assert.equal(account.credits.usedPercent, 26);
  assert.equal(account.credits.resetsAt, '2026-11-23T14:50:04Z');
  assert.deepEqual(account.credits.productUsage.map(item => item.product), [
    'Gemini Models · Weekly Limit',
    'Claude and GPT models · Weekly Limit',
    'Claude and GPT models · Five Hour Limit',
    'Gemini 4 Argon · Gemini 4 Argon Weekly Limit',
  ]);
  const quota = accountQuota(account, 'antigravity');

  const require = createRequire(resolve('node_modules/@deepseek-ai/dsh-client-ui-skill/package.json'));
  const nodePaths = [dirname(dirname(require.resolve('react/package.json'))), dirname(dirname(require.resolve('react-dom/package.json')))];
  const bundle = await build({
    stdin: {
      contents: `${await readFile('src/client.tsx', 'utf8')}
import { createRoot } from 'react-dom/client';
document.head.append(Object.assign(document.createElement('style'), { textContent: styles }));
const t = (key, params = {}) => Object.entries(params).reduce((text, [name, value]) => text.replaceAll('{' + name + '}', value), zh[key] ?? key);
createRoot(document.querySelector('#root')).render(<QuotaChip quota={${JSON.stringify(quota)}} t={t} />);`,
      resolveDir: resolve('src'), loader: 'tsx',
    },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', nodePaths, logLevel: 'warning',
    external: ['@deepseek-ai/dsh-client-ui-primitives'],
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const chip = page.locator('.hp-chip');
    assert.equal((await chip.textContent()).trim(), 'Gemini 5 小时 74%');
    await chip.click();
    assert.deepEqual(await page.locator('.hp-panel-title').allTextContents(), [
      'Gemini 5 小时',
      'Gemini 本周',
      'Claude / GPT 本周',
      'Claude / GPT 5 小时',
      'Gemini 4 Argon 本周',
    ]);
  } finally {
    await browser.close();
  }
});

test('Antigravity 原生 agy acp 透传进展反馈系统提示、流式过程事件、工具映射、原生模型强度与恢复轮次一致性', async () => {
  const { antigravityProfile } = await import('../dist/acp-profiles.js');
  const root = await mkdtemp(join(tmpdir(), 'dsh-agy-native-acp-'));
  const script = join(root, 'native-agy-peer.mjs');
  const log = join(root, 'log.jsonl');
  const historyFile = join(root, 'history.jsonl');
  await writeFile(script, `
import { agent, ndJsonStream } from '${import.meta.resolve('@agentclientprotocol/sdk/unstable')}';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
const note = value => appendFileSync(${JSON.stringify(log)}, JSON.stringify(value) + '\\n');
const saveHistory = update => appendFileSync(${JSON.stringify(historyFile)}, JSON.stringify(update) + '\\n');
const loadHistory = () => existsSync(${JSON.stringify(historyFile)}) ? readFileSync(${JSON.stringify(historyFile)}, 'utf8').trim().split('\\n').filter(Boolean).map(line => JSON.parse(line)) : [];
let mode = 'default', model = 'gemini-4-neon', effort = 'high';
const availableModels = [
  { modelId: 'gemini-4-neon-high', name: 'Gemini 4 Neon (High)' },
  { modelId: 'gemini-4-neon-xhigh', name: 'Gemini 4 Neon (XHigh)' },
  { modelId: 'gemini-4-neon-medium', name: 'Gemini 4 Neon (Medium)' },
  { modelId: 'gemini-4-neon-low', name: 'Gemini 4 Neon (Low)' },
  { modelId: 'gemini-4-argon-low', name: 'Gemini 4 Argon (Low)' },
  { modelId: 'gemini-4-argon-medium', name: 'Gemini 4 Argon (Medium)' },
  { modelId: 'gemini-4-argon-high', name: 'Gemini 4 Argon (High)' },
  { modelId: 'gemini-pro-orchestrator-neon', name: 'Orchestrator (Neon)' },
  { modelId: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
];
const effortOpts = () => model === 'gemini-4-neon'
  ? [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }, { value: 'xhigh', name: 'Extra' }]
  : model === 'gemini-4-argon'
    ? [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }]
    : [];
const configOptions = () => [
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: model, options: [
    { value: 'gemini-4-neon', name: 'Gemini 4 Neon' },
    { value: 'gemini-4-argon', name: 'Gemini 4 Argon' },
    { value: 'gemini-pro-orchestrator-neon', name: 'Orchestrator (Neon)' },
    { value: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
  ] },
  ...(effortOpts().length ? [{ id: 'thought_level', name: 'Thinking Level', category: 'thought_level', type: 'select', currentValue: effort, options: effortOpts() }] : []),
  { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: mode, options: [
    { value: 'default', name: 'Default' }, { value: 'plan', name: 'Plan' },
  ] },
];
const conn = agent({ name: 'Antigravity ACP Server' })
  .onRequest('initialize', () => ({
    protocolVersion: 1,
    agentCapabilities: { loadSession: true, sessionCapabilities: { load: {}, close: {} }, _meta: { antigravity: { systemPrompt: { append: true } } } },
    authMethods: [],
  }))
  .onRequest('session/new', ({ params }) => {
    note({ newMeta: params._meta });
    return { sessionId: 'agy-native-1', models: { availableModels, currentModelId: 'gemini-4-neon-high' }, configOptions: configOptions() };
  })
  .onRequest('session/load', async ({ params }) => {
    note({ loadMeta: params._meta });
    for (const update of loadHistory()) await conn.client.notify('session/update', { sessionId: params.sessionId, update });
    return { sessionId: params.sessionId, models: { availableModels, currentModelId: 'gemini-4-neon-high' }, configOptions: configOptions() };
  })
  .onRequest('session/set_config_option', ({ params }) => {
    note({ set: params });
    if (params.configId === 'model') {
      model = params.value;
      const allowed = effortOpts().map(o => o.value);
      if (allowed.length && !allowed.includes(effort)) effort = allowed[allowed.length - 1];
    }
    if (params.configId === 'thought_level') effort = params.value;
    if (params.configId === 'mode') mode = params.value;
    return { configOptions: configOptions() };
  })
  .onRequest('session/prompt', async ({ params }) => {
    const promptText = params.prompt.filter(b => b.type === 'text').map(b => b.text).join('');
    saveHistory({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: promptText } });
    const send = async update => {
      if (update.sessionUpdate !== 'agent_thought_chunk' && update.sessionUpdate !== 'usage_update') saveHistory(update);
      await conn.client.notify('session/update', { sessionId: params.sessionId, update });
    };
    await send({ sessionUpdate: 'usage_update', used: 1200, size: 1048576 });
    await send({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '先检查文件并执行命令。' } });
    await send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '先查看 package.json 并运行检查命令。' } });
    await send({ sessionUpdate: 'tool_call', toolCallId: 'c-read', name: 'read_file', kind: 'read', status: 'in_progress', title: 'File package.json', locations: [{ path: '/repo/package.json' }], rawInput: { Path: '/repo/package.json', StartLine: 5, EndLine: 14 } });
    await send({ sessionUpdate: 'tool_call_update', toolCallId: 'c-read', name: 'read_file', kind: 'read', status: 'completed', rawOutput: { output: '{"version":"0.2.8"}' } });
    await send({ sessionUpdate: 'tool_call', toolCallId: 'c-cmd', name: 'run_command', kind: 'execute', status: 'in_progress', title: 'echo ok', rawInput: { CommandLine: 'echo ok', toolSummary: '输出验证文本' } });
    await send({ sessionUpdate: 'tool_call_update', toolCallId: 'c-cmd', name: 'run_command', kind: 'execute', status: 'completed', rawOutput: { output: 'ok\\n', exit_code: 0 } });
    await send({ sessionUpdate: 'tool_call', toolCallId: 'c-edit', name: 'edit_file', kind: 'edit', status: 'in_progress', title: 'Edit a.ts', rawInput: { Path: '/repo/a.ts', Target: 'old', Replacement: 'new' } });
    await send({ sessionUpdate: 'tool_call_update', toolCallId: 'c-edit', name: 'edit_file', kind: 'edit', status: 'completed', rawOutput: { output: 'edited' } });
    await send({ sessionUpdate: 'tool_call', toolCallId: 'c-write', name: 'write_file', kind: 'edit', status: 'in_progress', title: 'Write b.ts', rawInput: { Path: '/repo/b.ts', Content: 'export const b = 1;' } });
    await send({ sessionUpdate: 'tool_call_update', toolCallId: 'c-write', name: 'write_file', kind: 'edit', status: 'completed', rawOutput: { output: 'written' } });
    await send({ sessionUpdate: 'tool_call', toolCallId: 'c-web', name: 'search_web', kind: 'search', status: 'in_progress', title: 'Search docs', rawInput: { query: 'dsh harness' } });
    await send({ sessionUpdate: 'tool_call_update', toolCallId: 'c-web', name: 'search_web', kind: 'search', status: 'completed', rawOutput: { output: 'results' } });
    await send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '已完成全部检查。' } });
    return { stopReason: 'end_turn', usage: { inputTokens: 1000, outputTokens: 80, cachedReadTokens: 200, cachedWriteTokens: 0 } };
  })
  .onRequest('session/close', () => ({}))
  .connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
`);
  await chmod(script, 0o755);
  const base = antigravityProfile(defaultSettings, {});
  const adapter = new AcpAdapter({
    environment: {},
    profile: { ...base, spawn: env => ({ command: process.execPath, args: [script], env }) },
  });
  try {
    // 1. 原生拆分目录按模型列出各自支持的推理强度，不误拆 gpt-oss-120b-medium
    const inspected = await adapter.inspect({ cwd: root });
    assert.equal(inspected.status, 'ready');
    assert.deepEqual(inspected.catalog.models.map(m => [m.ref.id, m.supportedThinkingOptionIds]), [
      ['gemini-4-neon', ['low', 'medium', 'high', 'xhigh']],
      ['gemini-4-argon', ['low', 'medium', 'high']],
      ['gemini-pro-orchestrator-neon', []],
      ['gpt-oss-120b-medium', []],
    ]);

    // 2. 打开会话（带旧复合模型 ID 归一化 + 宿主说明），验证 sessionMeta 与流式过程事件
    const opened = await adapter.open({
      kind: 'create', cwd: root, permissionModeId: 'default',
      model: modelRef('gemini-4-neon-medium'), instructions: '\n\n[HOST-INSTR]',
    });
    assert.equal(opened.ok, true, opened.ok ? '' : opened.error.message);
    const session = opened.value;
    assert.equal(session.initialState.effectiveModel.id, 'gemini-4-neon');
    assert.equal(session.initialState.effectiveThinkingOptionId, 'medium');

    // 切到无 thought_level 的 orchestrator 不应误把 gpt-oss-120b-medium 当复合目录拆开
    assert.equal((await session.execute({ type: 'model.select', model: modelRef('gemini-pro-orchestrator-neon') })).ok, true);
    assert.equal(session.inspect().catalog.models.some(m => m.ref.id === 'gpt-oss-120b-medium'), true);
    assert.equal((await session.execute({ type: 'model.select', model: modelRef('gemini-4-neon') })).ok, true);

    const events = [];
    const reader = (async () => {
      for await (const out of session.outputs) {
        if (out.kind === 'event') events.push(out.event);
      }
    })();
    const started = await session.execute({ type: 'turn.start', turnId: 'dsh:test:1', input: [{ type: 'text', text: '检查项目状态' }] });
    assert.equal(started.ok, true);
    while (!events.some(e => e.type === 'turn.completed')) await new Promise(r => setTimeout(r, 15));

    const completedItems = events.filter(e => e.type === 'item.completed').map(e => e.snapshot.item);
    assert.equal(completedItems[0].type, 'reasoning');
    assert.match(completedItems[0].text, /先检查文件/);
    assert.equal(completedItems[1].type, 'agentMessage');
    assert.equal(completedItems[1].text, '先查看 package.json 并运行检查命令。');
    const readItem = completedItems.find(i => i.type === 'toolExecution' && i.toolName === 'read');
    assert.deepEqual(readItem.arguments, { file_path: '/repo/package.json', offset: 5, limit: 10 });
    const cmdItem = completedItems.find(i => i.type === 'commandExecution');
    assert.equal(cmdItem.command, 'echo ok');
    assert.equal(cmdItem.description, '输出验证文本');
    assert.equal(cmdItem.exitCode, 0);
    const editItem = completedItems.find(i => i.type === 'toolExecution' && i.toolName === 'edit');
    assert.deepEqual(editItem.arguments, { file_path: '/repo/a.ts', old_string: 'old', new_string: 'new' });
    const writeItem = completedItems.find(i => i.type === 'toolExecution' && i.toolName === 'write');
    assert.deepEqual(writeItem.arguments, { file_path: '/repo/b.ts', content: 'export const b = 1;' });
    const webItem = completedItems.find(i => i.type === 'toolExecution' && i.toolName === 'web_search');
    assert.deepEqual(webItem.arguments, { queries: ['dsh harness'] });
    assert.equal(completedItems.at(-1).type, 'agentMessage');
    assert.equal(completedItems.at(-1).text, '已完成全部检查。');

    const usageEvent = events.filter(e => e.type === 'session.usage.changed').at(-1);
    assert.equal(usageEvent.usage.contextWindowTokens, 1048576);
    assert.equal(usageEvent.usage.outputTokens, 80);

    const liveTurnKey = events.find(e => e.type === 'turn.completed').nativeTurnRef.nativeTurnKey;
    const nativeRef = session.initialState.nativeRef;
    await session.close();
    await reader;

    // 3. 关掉再恢复会话后，轮次标识必须与实时轮次一致，且 session/new 与 session/load 均传入进展反馈系统提示
    const resumed = await adapter.open({ kind: 'resume', cwd: root, nativeRef, permissionModeId: 'default' });
    assert.equal(resumed.ok, true, resumed.ok ? '' : resumed.error.message);
    const snapshot = await resumed.value.readSnapshot();
    assert.equal(snapshot.ok, true, snapshot.ok ? '' : snapshot.error.message);
    assert.equal(snapshot.value.turns.length, 1);
    assert.equal(snapshot.value.turns[0].nativeTurnRef.nativeTurnKey, liveTurnKey);
    await resumed.value.close();

    const notes = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const newMeta = notes.filter(n => n.newMeta).at(-1)?.newMeta;
    assert.match(newMeta?.antigravity?.systemPrompt?.append ?? '', /\[DSH 进展反馈\][\s\S]*\[HOST-INSTR\]/);
    const loadMeta = notes.find(n => n.loadMeta)?.loadMeta;
    assert.match(loadMeta?.antigravity?.systemPrompt?.append ?? '', /\[DSH 进展反馈\]/);
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});
