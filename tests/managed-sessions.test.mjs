import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context, Service } from '@deepseek-ai/cordis';
import Typert from '@deepseek-ai/dsh-typert-registry';
import { HarnessService, inject } from '../dist/dsh.js';

test('工单绑定不修改个人默认值，主会话固定原生，停止接入后拒绝继续', async () => {
  const root = await mkdtemp(join(tmpdir(), 'managed-harness-')), ctx = new Context();
  const agents = new Map();
  const agent = id => { if (!agents.has(id)) agents.set(id, { id, status: 'idle', inbox: { nextTurn: [], nextStep: [] },
    session: { header: { cwd: root }, snapshotEvents: () => [] } }); return agents.get(id); };
  class Commands extends Service {
    constructor(scope) { super(scope, 'sessionController'); }
    async resolveAgent(id) { return { agent: agent(id) }; }
    async prompt() {} async fork() {} async selectModel() {} updateQueue() {}
  }
  const configOptions = [{ id: 'fast-mode', label: 'Fast', currentValue: false }];
  const adapter = { async close() {}, async inspect() { return { status: 'ready', catalog: {
    models: [{ ref: { id: 'deep' }, label: 'Deep', supportedThinkingOptionIds: ['low', 'high'] },
      { ref: { id: 'small' }, label: 'Small', supportedThinkingOptionIds: ['low'] }],
    thinkingOptions: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }], defaultModel: { id: 'deep' },
    configOptions,
  } }; } };
  try {
    await ctx.plugin(Typert); await ctx.plugin(Commands);
    for (const [name, value] of Object.entries({ agents: { get: agent }, sessions: {}, userQuestions: {}, attachments: {}, fileUploads: {} })) ctx.provide(name, value);
    await ctx.plugin({ inject, apply(scope) { new HarnessService(scope, root, { codex: adapter, 'claude-code': adapter }); } });
    const h = ctx.harness;
    await h.bindings.writeDefaults({ harness: 'claude-code' });
    assert.equal((await h.state({ sessionId: 'main' })).harness, 'claude-code');
    await h.manageSession('main', { owner: 'superagent', harness: 'dsh' });
    assert.equal((await h.state({ sessionId: 'main' })).harness, 'dsh');
    assert.equal((await h.state({ sessionId: 'main' })).locked, true);
    await assert.rejects(h.select({ sessionId: 'main', harness: 'codex' }), /受控/);
    const context = async () => ({ instructions: '工单说明', mcpServers: [] });
    await h.manageSession('worker', { owner: 'superagent', harness: 'codex', context });
    assert.equal((await h.bindings.read('worker')).managedBy, 'superagent');
    assert.equal((await h.bindings.readDefaults()).harness, 'claude-code');
    await assert.rejects(h.select({ sessionId: 'worker', harness: 'claude-code' }), /受控/);
    await assert.rejects(h.manageSession('worker', { owner: 'other', harness: 'codex', context }), /受控/);
    assert.equal(h.managedSessionOptionsVersion, 1);
    const defaults = await h.bindings.readDefaults();
    await h.manageSession('picked', { owner: 'superagent', harness: 'codex', context,
      selection: { model: 'deep', thinking: 'high', fast: true } });
    const picked = await h.bindings.read('picked');
    assert.deepEqual(picked.model, { id: 'deep' });
    assert.equal(picked.thinking, 'high');
    assert.deepEqual(picked.configs, { 'fast-mode': true });
    await h.manageSession('picked', { owner: 'superagent', harness: 'codex', context,
      selection: { model: 'small', thinking: 'low', fast: false } });
    assert.deepEqual(await h.bindings.read('picked'), picked);
    assert.deepEqual(await h.bindings.readDefaults(), defaults);
    for (const selection of [{ model: 'missing' }, { model: 'small', thinking: 'high' }, { fast: 'true' }, { unknown: true }]) {
      await assert.rejects(h.manageSession('invalid', { owner: 'superagent', harness: 'codex', context, selection }));
      assert.equal(await h.bindings.read('invalid'), undefined);
    }
    await h.validateManagedSessionSelection('main', 'codex', { model: 'small', thinking: 'low', fast: false });
    await assert.rejects(h.validateManagedSessionSelection('main', 'codex', { model: 'small', thinking: 'high' }));
    configOptions.splice(0, 1, { id: 'fast', label: 'Fast', currentValue: 'off', choices: [{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }] });
    for (const fast of [true, false]) {
      await h.manageSession(`claude-${fast}`, { owner: 'superagent', harness: 'claude-code', context, selection: { fast } });
      assert.deepEqual((await h.bindings.read(`claude-${fast}`)).configs, { fast: fast ? 'on' : 'off' });
    }
    configOptions.length = 0;
    await assert.rejects(h.manageSession('no-fast', { owner: 'superagent', harness: 'codex', context, selection: { fast: true } }), /不支持快速模式/);
    assert.equal(await h.bindings.read('no-fast'), undefined);
    await h.manageSession('no-fast-default', { owner: 'superagent', harness: 'codex', context });
    assert.equal((await h.bindings.read('no-fast-default')).configs, undefined);
    assert.deepEqual(await h.bindings.readDefaults(), defaults);
    await h.releaseManagedSession('worker', 'superagent');
    assert.equal(h.runner.managed.has('worker'), false);
    await assert.rejects(h.runner.run({ agent: agent('worker'), signal: new AbortController().signal }, await h.bindings.read('worker')), /未恢复/);
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); }
});
