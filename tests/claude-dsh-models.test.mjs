import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ClaudeDshModels, dshModelId } from '../dist/claude-dsh-models.js';
import { claudeProfile } from '../dist/acp-profiles.js';
import { catalogsOf } from '../dist/acp-adapter.js';

const model = dshModelId('my/provider', 'model/with space');
const message = { model, max_tokens: 256, messages: [{ role: 'user', content: '你好' }] };
function bridge(stream) {
  return new ClaudeDshModels({
    listProviders: () => [{ id: 'my/provider', name: '服务商' }],
    listModels: async () => [{ id: 'model/with space', name: '外部模型' }],
    resolveModelInfo: async (provider, id) => ({ provider, id, name: '外部模型' }),
    stream,
  });
}
async function request(gateway, body, headers = {}) {
  const env = await gateway.environment(model);
  return fetch(`${env.ANTHROPIC_BASE_URL}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, ...headers }, body: JSON.stringify(body),
  });
}

test('DSH models keep provider identity and convert ordered tool history and declarations', async t => {
  let received;
  const gateway = bridge(async function* (options) {
    received = options;
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: '完成' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '完成' } };
    yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 2, cacheReadTokens: 3 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });
  t.after(() => gateway.close());
  const { models: catalog } = await gateway.catalog();
  assert.equal(catalog[0].ref.id, model);
  assert.equal(catalog[0].label, '外部模型');
  assert.match(catalog[0].resolvedModelLabel, /服务商 \(DSH\)/);
  const response = await request(gateway, { ...message, system: [{ type: 'text', text: '规则' }], tools: [{ name: 'Read', description: '读取文件', input_schema: { type: 'object' } }], messages: [
    { role: 'user', content: '读取' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'Read', input: { path: 'a' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '文件内容', is_error: true }, { type: 'text', text: '继续' }] },
  ] });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).content[0].text, '完成');
  assert.equal(received.provider, 'my/provider');
  assert.equal(received.model, 'model/with space');
  assert.equal(received.system, '规则');
  assert.deepEqual(received.messages.map(entry => entry.role), ['user', 'assistant', 'tool', 'user']);
  assert.equal(received.messages[2].toolCallId, 'call_1');
  assert.equal(received.messages[2].isError, true);
  assert.equal(received.messages[1].content[0].arguments, '{"path":"a"}');
  assert.equal(received.tools[0].name, 'Read');
});

test('streaming tool calls carry complete arguments and a tool_use stop reason', async t => {
  const gateway = bridge(async function* () {
    yield { type: 'block-start', index: 0, blockType: 'tool-call' };
    yield { type: 'tool-call-delta', index: 0, id: 'call_2', name: 'Read', argumentsDelta: '{"path":' };
    yield { type: 'tool-call-delta', index: 0, id: 'call_2', argumentsDelta: '"a"}' };
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_2', name: 'Read', arguments: '{"path":"a"}' } };
    yield { type: 'finish', reason: { kind: 'tool-calls' } };
  });
  t.after(() => gateway.close());
  const response = await request(gateway, { ...message, stream: true });
  const result = await response.text();
  assert.match(result, /event: content_block_start/);
  assert.match(result, /"type":"tool_use","id":"call_2","name":"Read"/);
  assert.match(result, /"stop_reason":"tool_use"/);
  assert.match(result, /event: message_stop/);
});

test('system messages inserted by the native CLI keep their role and sequence', async t => {
  let received;
  const gateway = bridge(async function* (options) { received = options; yield { type: 'finish', reason: { kind: 'stop' } }; });
  t.after(() => gateway.close());
  const response = await request(gateway, { ...message, messages: [...message.messages, { role: 'system', content: [{ type: 'text', text: '系统更新' }] }] });
  assert.equal(response.status, 200);
  await response.text();
  assert.deepEqual(received.messages.map(message => message.role), ['user', 'system']);
  assert.equal(received.messages[1].content[0].text, '系统更新');
});

test('DSH reasoning choices follow each exact model and reach the provider including defaults and off', async t => {
  const requests = [];
  const llm = {
    listProviders: () => [{ id: 'provider', name: '服务商' }],
    listModels: async () => ['reasoner', 'plain'].map(id => ({ id, name: id })),
    resolveModelInfo: async (provider, id) => ({ provider, id, name: id, ...(id === 'reasoner' ? { reasoning: {
      efforts: [{ id: 'off/value', name: '关闭' }, { id: 'high', name: '高' }], defaultEffort: 'high',
    } } : {}) }),
    async *stream(options) { requests.push(options); yield { type: 'finish', reason: { kind: 'stop' } }; },
  };
  const gateway = new ClaudeDshModels(llm);
  t.after(() => gateway.close());
  const catalog = await gateway.catalog();
  const reasoner = catalog.models.find(model => model.label === 'reasoner');
  const plain = catalog.models.find(model => model.label === 'plain');
  assert.equal(reasoner.supportedThinkingOptionIds.length, 2);
  assert.deepEqual(plain.supportedThinkingOptionIds, []);
  const off = catalog.thinkingOptions.find(option => option.label === '关闭').id;
  const high = catalog.thinkingOptions.find(option => option.label === '高').id;
  assert.equal(reasoner.defaultThinkingOptionId, high);
  for (const [id, choice, expected] of [[reasoner.ref.id, undefined, 'high'], [reasoner.ref.id, off, 'off/value'], [reasoner.ref.id, high, 'high'], [plain.ref.id, undefined, undefined]]) {
    const env = await gateway.environment(id, choice);
    const response = await fetch(`${env.ANTHROPIC_BASE_URL}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY },
      body: JSON.stringify({ ...message, model: id }) });
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(requests.at(-1).reasoningEffort, expected);
  }
  await assert.rejects(gateway.environment(plain.ref.id, high), /推理/);
});

test('the loopback gateway rejects unauthenticated, unknown and unrepresentable requests', async t => {
  const gateway = bridge(async function* () { assert.fail('must not call a provider'); });
  t.after(() => gateway.close());
  assert.equal((await request(gateway, message, { 'x-api-key': 'wrong' })).status, 401);
  assert.equal((await request(gateway, { ...message, model: dshModelId('missing', 'model') })).status, 404);
  assert.equal((await request(gateway, { ...message, tools: [{ type: 'computer_20250124', name: 'computer' }] })).status, 400);
  assert.equal((await request(gateway, { ...message, messages: [{ role: 'user', content: [{ type: 'unknown' }] }] })).status, 400);
});

test('disconnecting aborts the DSH provider request', async t => {
  const stopped = Promise.withResolvers();
  const gateway = bridge(async function* ({ signal }) {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: '开始' };
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    stopped.resolve();
    yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'aborted' } } };
  });
  t.after(() => gateway.close());
  const response = await request(gateway, { ...message, stream: true });
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel();
  await Promise.race([stopped.promise, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('cancel was not forwarded')), 2000); timer.unref(); })]);
});

test('create and resume route external models at both environment and settings tiers, preserving native and discussion behavior', async t => {
  const gateway = bridge(async function* () {});
  t.after(() => gateway.close());
  const profile = claudeProfile({ environment: {}, dshModels: gateway });
  assert.deepEqual(await profile.modelEnvironment({ id: 'sonnet' }), {});
  assert.equal(profile.sessionMeta('create', '宿主说明').claudeCode, undefined);
  const env = await profile.modelEnvironment({ id: model });
  for (const kind of ['create', 'resume']) {
    const meta = profile.sessionMeta(kind, '宿主说明', undefined, env);
    assert.equal(meta.claudeCode.options.model, model);
    assert.equal(meta.claudeCode.options.env.ANTHROPIC_BASE_URL, env.ANTHROPIC_BASE_URL);
    assert.equal(meta.claudeCode.options.settings.env.ANTHROPIC_API_KEY, env.ANTHROPIC_API_KEY);
    assert.match(meta.systemPrompt.append, /宿主说明/);
  }
  const discussion = profile.sessionMeta('resume', '', true, env).claudeCode.options;
  assert.equal(discussion.allowDangerouslySkipPermissions, false);
  assert.equal(discussion.settings.disableAllHooks, true);
  assert.deepEqual(discussion.settingSources, []);
  const extras = await profile.modelCatalog();
  const catalog = catalogsOf({ configOptions: [{ id: 'model', category: 'model', type: 'select', name: 'Model', currentValue: 'sonnet', options: [{ value: 'sonnet', name: 'Sonnet' }] }] }, extras).catalog;
  assert.deepEqual(catalog.models.map(entry => entry.ref.id), ['sonnet', model]);
  assert.equal(catalog.defaultModel.id, 'sonnet');
});

test('external reasoning remains selected across native config updates and stays out of native model choices', () => {
  const extras = { models: [{ ref: { id: model }, label: '外部模型', supportedThinkingOptionIds: ['dsh~off', 'dsh~high'], defaultThinkingOptionId: 'dsh~high' }],
    thinkingOptions: [{ id: 'dsh~off', label: '关闭' }, { id: 'dsh~high', label: '高' }] };
  const opened = { configOptions: [
    { id: 'model', category: 'model', type: 'select', name: 'Model', currentValue: model, options: [{ value: 'sonnet', name: 'Sonnet' }, { value: model, name: '外部模型' }] },
    { id: 'effort', category: 'thought_level', type: 'select', name: 'Effort', currentValue: 'medium', options: [{ value: 'medium', name: 'Medium' }] },
  ] };
  const selected = catalogsOf(opened, extras, 'dsh~off');
  assert.equal(selected.currentThinking, 'dsh~off');
  assert.equal(selected.catalog.defaultThinkingOptionId, 'dsh~high');
  assert.deepEqual(selected.catalog.models.find(entry => entry.ref.id === 'sonnet').supportedThinkingOptionIds, ['medium']);
  assert.equal(catalogsOf(opened, extras).currentThinking, 'dsh~high');
});

test('switching Claude between native and DSH closes idle routes, persists the pick and protects background tasks', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { Context, Service } = await import('@deepseek-ai/cordis');
  const { default: Typert } = await import('@deepseek-ai/dsh-typert-registry');
  const { HarnessService, inject } = await import('../dist/dsh.js');
  const { Bindings } = await import('../dist/bindings.js');
  const root = await mkdtemp(join(tmpdir(), 'dsh-external-model-')), ctx = new Context();
  const agent = { id: 'source', status: 'idle', inbox: { nextTurn: [], nextStep: [] }, session: { header: { cwd: root }, snapshotEvents: () => [] } };
  class Commands extends Service {
    constructor(ctx) { super(ctx, 'sessionController'); }
    async resolveAgent() { return { agent }; }
    async prompt() {} async fork() {} async selectModel() {} updateQueue() {}
  }
  const ready = { status: 'ready', capabilities: {}, catalog: { models: [{ ref: { id: 'sonnet' }, label: 'Sonnet', supportedThinkingOptionIds: [] },
    { ref: { id: model }, label: '外部模型', supportedThinkingOptionIds: ['dsh~off', 'dsh~high'], defaultThinkingOptionId: 'dsh~high' }],
    defaultModel: { id: 'sonnet' }, thinkingOptions: [{ id: 'dsh~off', label: '关闭' }, { id: 'dsh~high', label: '高' }],
    configOptions: [{ id: 'fast', label: 'Fast mode', currentValue: false }, { id: 'ultracode', label: 'Ultracode', currentValue: false },
      { id: 'agent', label: 'Agent', currentValue: 'default', choices: [{ value: 'default', label: '默认' }, { value: 'reviewer', label: '审查' }] }] } };
  const adapter = { inspect: async () => ready, async close() {} };
  let closed = 0, background = false;
  const session = { inspect: () => ready, hasBackgroundTasks: () => background, async close() { closed++; }, async execute() { assert.fail('route changes must reopen, not set only a model id'); } };
  try {
    await ctx.plugin(Typert); await ctx.plugin(Commands);
    ctx.provide('agents', { get: () => agent }); ctx.provide('sessions', {}); ctx.provide('userQuestions', {});
    ctx.provide('attachments', {}); ctx.provide('fileUploads', {});
    await ctx.plugin({ inject, apply(scope) { new HarnessService(scope, root, { codex: adapter, 'claude-code': adapter }); } });
    const h = ctx.harness;
    await h.select({ sessionId: 'source', harness: 'claude-code' });
    assert.deepEqual((await h.models({ sessionId: 'source' })).configOptions.map(option => option.id), ['fast', 'ultracode', 'agent']);
    h.runner.live.set('source', { session });
    await h.selectModel({ sessionId: 'source', model });
    assert.equal(closed, 1);
    assert.equal(h.runner.live.has('source'), false);
    assert.equal((await new Bindings(root).read('source')).model.id, model);
    assert.equal((await h.bindings.read('source')).thinking, 'dsh~high');
    assert.equal((await h.models({ sessionId: 'source' })).defaultThinkingOptionId, 'dsh~high');
    assert.deepEqual((await h.models({ sessionId: 'source' })).configOptions.map(option => option.id), ['agent']);
    for (const configId of ['fast', 'ultracode']) await assert.rejects(h.selectConfig({ sessionId: 'source', configId, value: true }), /不支持/);
    await h.selectConfig({ sessionId: 'source', configId: 'agent', value: 'reviewer' });
    assert.equal((await h.bindings.read('source')).configs.agent, 'reviewer');
    assert.equal(await h.quota({ sessionId: 'source' }), null);
    h.runner.live.set('source', { session }); background = true;
    await assert.rejects(h.selectModel({ sessionId: 'source', model: 'sonnet' }), /后台任务/);
    assert.equal(closed, 1);
    assert.equal((await h.bindings.read('source')).model.id, model);
    background = false;
    h.runner.live.set('source', { session }); background = true;
    await assert.rejects(h.selectThinking({ sessionId: 'source', thinking: 'dsh~off' }), /后台任务/);
    background = false;
    await h.selectThinking({ sessionId: 'source', thinking: 'dsh~off' });
    assert.equal(closed, 2);
    assert.equal((await new Bindings(root).read('source')).thinking, 'dsh~off');
    await assert.rejects(h.selectThinking({ sessionId: 'source', thinking: 'medium' }), /不支持/);
    h.runner.live.set('source', { session });
    await h.selectModel({ sessionId: 'source', model: 'sonnet' });
    assert.equal(closed, 3);
    assert.equal((await h.bindings.read('source')).model.id, 'sonnet');
    assert.equal((await h.bindings.read('source')).thinking, undefined);
    assert.deepEqual((await h.models({ sessionId: 'source' })).configOptions.map(option => option.id), ['fast', 'ultracode', 'agent']);
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('external reasoning is not forged into signed Claude history, and provider failures never report success', async t => {
  const gateway = bridge(async function* () {
    yield { type: 'reasoning-delta', index: 0, text: '内部推理' };
    yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: '内部推理' } };
    yield { type: 'block-end', index: 1, block: { type: 'text', text: '正文' } };
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'provider error', status: 429 } } };
  });
  t.after(() => gateway.close());
  const response = await request(gateway, { ...message, stream: true });
  const content = await response.text();
  assert.match(content, /event: error/);
  assert.doesNotMatch(content, /message_stop|thinking|signature|内部推理/);
});

test('Claude 对话栏只显示模型名，桌面与窄屏均能选择真实推理档位', async () => {
  const { readFile, mkdir } = await import('node:fs/promises');
  const { resolve } = await import('node:path');
  const { createRequire } = await import('node:module');
  const { build } = await import('esbuild');
  const { chromium, expect } = await import('@playwright/test');
  const require = createRequire(resolve('node_modules/@deepseek-ai/dsh-client-ui-skill/package.json'));
  const bundle = await build({ stdin: { contents: await readFile('src/client.tsx', 'utf8') + `
import { createRoot } from 'react-dom/client';
document.head.append(Object.assign(document.createElement('style'), { textContent: styles }));
let state = { harness: 'claude-code', model: 'sonnet', thinking: null, configs: {}, recoveryRequired: false };
const catalog = { models: [{ id: 'sonnet', label: 'Claude Sonnet', resolved: null, thinkingOptionIds: null },
  { id: ${JSON.stringify(model)}, label: 'DeepSeek-V4.1-Flash', resolved: '服务商 (DSH)', thinkingOptionIds: ['dsh~off', 'dsh~high'] }],
  defaultModel: { id: 'sonnet', label: 'Claude Sonnet' }, defaultThinkingOptionId: 'dsh~high',
  thinkingOptions: [{ id: 'dsh~off', label: '关闭' }, { id: 'dsh~high', label: '高' }], configOptions: [
    { id: 'fast', label: 'Fast mode', currentValue: false, choices: null }, { id: 'ultracode', label: 'Ultracode', currentValue: false, choices: null },
    { id: 'agent', label: 'Agent', currentValue: 'default', choices: [{ value: 'default', label: '默认' }, { value: 'reviewer', label: '审查' }] }], error: null };
const read = async () => state, models = async () => catalog, subscribe = () => () => {};
const useSessions = pick => pick({ byId: { source: { running: false } } });
const selectModel = async (_, model) => { window.selected = model; return state = { ...state, model }; };
const selectThinking = async (_, thinking) => { window.selectedThinking = thinking; return state = { ...state, thinking }; };
const selectConfig = async (_, id, value) => { window.selectedConfig = [id, value]; return state = { ...state, configs: { ...state.configs, [id]: value } }; };
createRoot(document.querySelector('#root')).render(<HarnessModel sessionId="source" locked={false} useSessions={useSessions}
  read={read} models={models} selectModel={selectModel} selectThinking={selectThinking} selectConfig={selectConfig}
  subscribe={subscribe} t={key => zh[key] ?? key} />);
`, resolveDir: resolve('src'), loader: 'tsx' }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    alias: { react: require.resolve('react'), 'react/jsx-runtime': require.resolve('react/jsx-runtime'), 'react-dom': require.resolve('react-dom'), 'react-dom/client': require.resolve('react-dom/client') },
    external: ['@deepseek-ai/dsh-client-ui-primitives'] });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<style>:root{--dsw-alias-label-primary:#eee;--dsw-alias-label-secondary:#bbb;--dsw-alias-label-tertiary:#999;--dsw-alias-border-l2:#333;--dsw-alias-border-l4:#555;--dsw-alias-bg-layer-3:#29292c}body{margin:24px;background:#1b1b1b;color:#eee;font:14px sans-serif}#root{position:fixed;right:24px;bottom:32px}</style><div id="root"></div>');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await mkdir('.cache', { recursive: true });
    for (const width of [900, 390]) {
      await page.setViewportSize({ width, height: 620 });
      await page.locator('.hp-chip').click();
      await page.locator('.hp-menu .hp-cell').first().click();
      await expect(page.getByRole('menuitemradio', { name: /DeepSeek-V4.1-Flash.*服务商 \(DSH\)/ })).toBeVisible();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: resolve('.cache/claude-dsh-models-' + (width === 390 ? 'mobile' : 'desktop') + '.png'),
        clip: { x: Math.max(0, width - 420), y: 350, width: Math.min(420, width), height: 270 } });
      await page.getByRole('menuitemradio', { name: /DeepSeek-V4.1-Flash/ }).click();
      assert.equal(await page.evaluate(() => window.selected), model);
      await expect(page.locator('.hp-chip')).toHaveText('DeepSeek-V4.1-Flash');
      await page.locator('.hp-chip').click();
      await expect(page.getByRole('menuitem').filter({ hasText: '快速模式' })).toHaveCount(0);
      await expect(page.getByRole('menuitem').filter({ hasText: 'Ultracode' })).toHaveCount(0);
      await expect(page.getByRole('menuitem').filter({ hasText: 'Agent' })).toBeVisible();
      await page.screenshot({ path: resolve('.cache/claude-dsh-menu-' + (width === 390 ? 'mobile' : 'desktop') + '.png'),
        clip: { x: Math.max(0, width - 420), y: 250, width: Math.min(420, width), height: 370 } });
      await page.getByRole('menuitem').filter({ hasText: 'Agent' }).click();
      await page.getByRole('menuitemradio', { name: '审查', exact: true }).click();
      assert.deepEqual(await page.evaluate(() => window.selectedConfig), ['agent', 'reviewer']);
      await page.locator('.hp-chip').click();
      await page.getByRole('menuitem').filter({ hasText: '强度' }).click();
      await expect(page.getByRole('menuitemradio', { name: '关闭', exact: true })).toBeVisible();
      await expect(page.getByRole('menuitemradio', { name: '高', exact: true })).toBeVisible();
      await page.screenshot({ path: resolve('.cache/claude-dsh-reasoning-' + (width === 390 ? 'mobile' : 'desktop') + '.png'),
        clip: { x: Math.max(0, width - 420), y: 350, width: Math.min(420, width), height: 270 } });
      await page.getByRole('menuitemradio', { name: '关闭', exact: true }).click();
      assert.equal(await page.evaluate(() => window.selectedThinking), 'dsh~off');
      await expect(page.locator('.hp-chip')).toHaveText('DeepSeek-V4.1-Flash');
    }
  } finally { await browser.close(); }
});
