import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import Agents from '@deepseek-ai/dsh-agent';
import Loop from '@deepseek-ai/dsh-agent-loop';
import Llm, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';
import Sessions, { SessionId } from '@deepseek-ai/dsh-session';
import Projections from '@deepseek-ai/dsh-session-projection';
import Titles from '@deepseek-ai/dsh-session-title';
import Prompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import * as AllPrompts from '../node_modules/@deepseek-ai/dsh-session-title-all-prompts-llm/lib/index.js';
import * as FirstPrompt from '@deepseek-ai/dsh-session-title-first-prompt-llm';
import { Bindings } from '../dist/bindings.js';
import { HarnessOutputChannel } from '../dist/contracts.js';
import { DshRunner } from '../dist/dsh-runner.js';

const settle = () => new Promise(resolve => setImmediate(resolve));
const user = text => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] });
const titleConfig = { targetWords: 5, targetCjkCharacters: 10, maxInputBytes: 4096, maxOutputTokens: 32, timeoutMs: 1000 };

async function mount(t, { harness = 'codex', provider = AllPrompts, explicit = false, defaultModel = true, stream } = {}) {
 const root = await mkdtemp(join(tmpdir(), 'dsh-harness-titles-')), ctx = new Context(), requests = [], opens = [], inputs = [];
 t.after(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); });
 for (const plugin of [Llm, Sessions, Projections, Prompt, Tools, Agents]) await ctx.plugin(plugin);
 await ctx.plugin(Titles, { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 });
 if (defaultModel) ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'dsh-default', model: 'default-model' }) });
 class TitleAdapter extends LlmAdapter {
  async resolveModel(provider, model) { return { provider, id: model, name: model }; }
  async *stream(options) {
   requests.push(options);
   if (stream) yield* stream(options, requests.length);
   else { yield { type: 'text-delta', index: 0, text: `标题 ${requests.length}` }; yield { type: 'finish', reason: { kind: 'stop' } }; }
  }
 }
 ctx.llm.registerAdapter(['dsh-default', 'title-explicit'], new TitleAdapter());
 const providerFiber = provider && await ctx.plugin(provider, { ...titleConfig, ...(explicit ? { provider: 'title-explicit', model: 'explicit-model' } : {}) });
 const bindings = new Bindings(join(root, 'bindings'));
 const runner = new DshRunner(ctx, bindings, { [harness]: { async open(input) {
  opens.push(input);
  const channel = new HarnessOutputChannel();
  return { ok: true, value: { initialState: { nativeRef: { harnessId: harness, nativeSessionId: 'native', formatVersion: 1 } }, initialUsage: null, outputs: channel.outputs,
   async execute(command) {
    inputs.push(command.input);
    const emit = event => channel.emit({ kind: 'event', event });
    emit({ type: 'turn.started', turnId: command.turnId });
    emit({ type: 'item.completed', turnId: command.turnId, snapshot: { item: { type: 'agentMessage', itemId: 'answer', text: '回答' }, outcome: { status: 'succeeded' } } });
    emit({ type: 'turn.completed', turnId: command.turnId, outcome: { status: 'succeeded' } });
    return { ok: true, value: { turnId: command.turnId } };
   }, async close() { channel.end(); } } };
 } } });
 ctx.on('agent/pre-step', async payload => { await runner.run(payload, await bindings.read(payload.agent.id)); return { kind: 'enter', messages: [] }; });
 await ctx.plugin(Loop, { agents: [] });
 const id = SessionId('title-session');
 await bindings.write({ version: 1, sessionId: id, harness, cwd: root, locked: true });
 const { agent } = await ctx.agents.create({ sessionId: id, meta: { cwd: root } });
 const prompt = async text => { agent.followup(user(text)); await agent.whenIdle(); await settle(); };
 return { ctx, agent, runner, requests, opens, inputs, prompt, providerFiber };
}

for (const harness of ['codex', 'claude-code']) test(`${harness} updates titles for each prompt using the DSH default route without changing native inputs`, async t => {
 const f = await mount(t, { harness });
 await f.prompt('排查登录错误');
 assert.equal(f.requests.length, 1);
 assert.deepEqual([f.requests[0].provider, f.requests[0].model], ['dsh-default', 'default-model']);
 assert.equal(f.ctx.sessionTitle.get(f.agent.session).title, '标题 1');
 await f.prompt('改为实现自动标题');
 assert.equal(f.requests.length, 2);
 assert.equal(f.ctx.sessionTitle.get(f.agent.session).title, '标题 2');
 const text = f.requests[1].messages[0].content[0].text;
 assert.ok(text.includes('排查登录错误') && text.includes('改为实现自动标题'));
 assert.equal(f.opens.length, 1, 'title generation never opens another native session');
 assert.deepEqual(f.inputs, [[{ type: 'text', text: '排查登录错误' }], [{ type: 'text', text: '改为实现自动标题' }]]);
 assert.equal(f.agent.session.snapshotEvents().some(event => event.type === 'request/header'), false, 'no synthetic main request is logged');
 assert.deepEqual(f.agent.session.snapshotEvents().filter(event => event.type === 'turn/end').map(event => event.data.reason.kind), ['completed', 'completed']);
});

test('an explicit title route works without a DSH default model', async t => {
 const f = await mount(t, { explicit: true, defaultModel: false });
 await f.prompt('显式标题模型');
 assert.equal(f.requests.length, 1);
 assert.deepEqual([f.requests[0].provider, f.requests[0].model], ['title-explicit', 'explicit-model']);
});

test('first-prompt cadence, provider disable and manual titles retain their host behavior', async t => {
 const first = await mount(t, { provider: FirstPrompt });
 await first.prompt('第一条'); await first.prompt('第二条');
 assert.equal(first.requests.length, 1);
 const all = await mount(t);
 await all.prompt('自动标题');
 all.ctx.sessionTitle.rename(all.agent.session, '手动标题');
 await all.prompt('不能覆盖手动标题');
 assert.equal(all.requests.length, 1);
 assert.equal(all.ctx.sessionTitle.get(all.agent.session).title, '手动标题');
 const disabled = await mount(t, { provider: false });
 await disabled.prompt('没有标题插件');
 assert.equal(disabled.requests.length, 0);
 assert.equal(disabled.ctx.sessionTitle.get(disabled.agent.session).source.kind, 'fallback');
 await all.providerFiber.dispose();
 await all.prompt('插件关闭后');
 assert.equal(all.requests.length, 1);
});

test('title failures preserve the fallback and do not fail the Harness turn', async t => {
 const f = await mount(t, { stream: async function* () { throw new Error('title unavailable'); } });
 await f.prompt('标题服务失败时继续对话');
 assert.equal(f.requests.length, 1);
 assert.equal(f.ctx.sessionTitle.get(f.agent.session).source.kind, 'fallback');
 assert.equal(f.agent.session.snapshotEvents().findLast(event => event.type === 'turn/end').data.reason.kind, 'completed');
});

test('a newer user message and a manual rename supersede unfinished title requests', async t => {
 const gates = [];
 t.after(() => { for (const gate of gates) gate.resolve(); });
 const f = await mount(t, { stream: async function* (_options, index) {
  const gate = Promise.withResolvers(); gates.push(gate); await gate.promise;
  yield { type: 'text-delta', index: 0, text: `迟到标题 ${index}` }; yield { type: 'finish', reason: { kind: 'stop' } };
 } });
 await f.prompt('第一条');
 assert.equal(gates.length, 1, 'the Harness turn completes while its title request is pending');
 await f.prompt('第二条');
 assert.equal(gates.length, 2);
 gates[0].resolve(); await settle();
 assert.notEqual(f.ctx.sessionTitle.get(f.agent.session).title, '迟到标题 1');
 f.ctx.sessionTitle.rename(f.agent.session, '用户标题');
 gates[1].resolve(); await settle();
 assert.equal(f.ctx.sessionTitle.get(f.agent.session).title, '用户标题');
});

test('native sessions still wait for their own model route and do not use the Harness bridge', async t => {
 const f = await mount(t);
 const session = f.ctx.sessions.create(SessionId('native-session'));
 session.append('user/message', user('原生会话'), { surfaceOp: 'append' });
 await settle();
 assert.equal(f.requests.length, 0);
 session.append('request/header', { header: { config: { provider: 'title-explicit', model: 'native-model' } }, reason: 'initial' });
 await settle();
 assert.equal(f.requests.length, 1);
 assert.deepEqual([f.requests[0].provider, f.requests[0].model], ['title-explicit', 'native-model']);
});
