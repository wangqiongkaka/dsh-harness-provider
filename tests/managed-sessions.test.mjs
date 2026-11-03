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
  const adapter = { async close() {} };
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
    await h.releaseManagedSession('worker', 'superagent');
    assert.equal(h.runner.managed.has('worker'), false);
    await assert.rejects(h.runner.run({ agent: agent('worker'), signal: new AbortController().signal }, await h.bindings.read('worker')), /未恢复/);
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); }
});
