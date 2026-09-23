import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context, Service } from '@deepseek-ai/cordis';
import Typert from '@deepseek-ai/dsh-typert-registry';
import { HarnessService, inject } from '../dist/dsh.js';

/** Sessions as the Host keeps them: a fork copies the source's events up to its cut and records how many it inherited. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'harness-branch-')), ctx = new Context(), agents = new Map(), calls = [];
  const agentOf = (id, events = [], inheritedEventCount = 0) => {
    const agent = { id, status: 'idle', inbox: { nextTurn: [], nextStep: [] }, async whenIdle() {}, session: { header: { cwd: root }, inheritedEventCount,
      snapshotEvents: () => events, append(type, data) { const event = { seq: events.length, type, data }; events.push(event); return event; } } };
    agents.set(id, agent);
    return agent;
  };
  let forks = 0;
  class Commands extends Service {
    constructor(ctx) { super(ctx, 'sessionController'); }
    async resolveAgent(id) { const agent = agents.get(id); return agent ? { agent } : { error: new Error('missing') }; }
    async fork({ sessionId, atSeq }) {
      const source = agents.get(sessionId).session.snapshotEvents();
      const cut = atSeq ?? source.length - 1, id = `branch-${++forks}`;
      agentOf(id, source.slice(0, cut + 1).map(event => ({ ...event })), cut + 1);
      return { sessionId: id };
    }
    async prompt() {} async selectModel() {} updateQueue() {}
  }
  const ref = { harnessId: 'codex', nativeSessionId: 'native', formatVersion: 1 };
  const adapter = { async close() {}, async open(input) { calls.push(input); return { ok: true, value: {
    async close() {}, async readSnapshot() { return { ok: true, value: { turns: [{ nativeTurnRef: { ...ref, nativeTurnKey: 'first' } }] } }; },
    async fork() { return { ok: true, value: { ...ref, nativeSessionId: 'forked' } }; },
  } }; } };
  await ctx.plugin(Typert); await ctx.plugin(Commands);
  ctx.provide('agents', { get: id => agents.get(id) }); ctx.provide('sessions', { async flush() {} }); ctx.provide('userQuestions', {});
  ctx.provide('attachments', {}); ctx.provide('fileUploads', { resolve: () => undefined });
  await ctx.plugin({ inject, apply(scope) { new HarnessService(scope, root, { codex: adapter, 'claude-code': adapter }); } });
  return { ctx, h: ctx.harness, root, agentOf, calls, async close() { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); } };
}
const history = [
  { seq: 0, type: 'user/message', data: { content: [{ type: 'text', text: 'first question' }], source: { kind: 'user', rpcId: 'r1' } } },
  { seq: 1, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
];

test('a branch of a Harness session may switch Harness until its own first message; the switch carries the inherited history', async () => {
  const f = await fixture();
  try {
    const { h } = f;
    f.agentOf('session', history.map(event => ({ ...event })));
    await h.bindings.write({ version: 1, sessionId: 'session', harness: 'codex', cwd: f.root, locked: true, nativeRef: { harnessId: 'codex', nativeSessionId: 'native', formatVersion: 1 }, turns: [{ turn: 1, key: 'first' }] });
    assert.equal((await h.state({ sessionId: 'session' })).locked, true);
    await assert.rejects(h.select({ sessionId: 'session', harness: 'claude-code' }), /开始对话后不能切换/);
    const { sessionId: branch } = await f.ctx.sessionController.fork({ sessionId: 'session', atSeq: 1 });
    // The branch keeps its forked native session on the same Harness, and its selector is open.
    assert.equal((await h.bindings.read(branch)).nativeRef.nativeSessionId, 'forked');
    assert.equal((await h.state({ sessionId: branch })).locked, false);
    assert.equal((await h.select({ sessionId: branch, harness: 'codex' })).harness, 'codex');
    assert.equal((await h.bindings.read(branch)).nativeRef.nativeSessionId, 'forked', 'picking the same Harness keeps the native fork');
    // Another Harness starts a fresh native session that receives the two inherited events as a transcript.
    const claude = await h.select({ sessionId: branch, harness: 'claude-code' });
    assert.deepEqual([claude.harness, claude.locked], ['claude-code', false]);
    const switched = await h.bindings.read(branch);
    assert.deepEqual([switched.nativeRef, switched.turns, switched.carry], [undefined, undefined, { throughSeq: 2 }]);
    // Native DSH continues from the inherited events themselves.
    assert.equal((await h.select({ sessionId: branch, harness: 'dsh' })).harness, 'dsh');
    assert.equal(await h.bindings.read(branch), undefined);
    assert.equal((await h.state({ sessionId: branch })).locked, false);
    // The branch's own first message fixes its Harness.
    f.ctx.get('agents').get(branch).session.append('user/message', { content: [{ type: 'text', text: 'own' }], source: { kind: 'user', rpcId: 'own' } });
    assert.equal((await h.state({ sessionId: branch })).locked, true);
    await assert.rejects(h.select({ sessionId: branch, harness: 'codex' }), /开始对话后不能切换/);
  } finally { await f.close(); }
});

test('a branch of a native DSH session stays native until the user picks a Harness, which then carries the history', async () => {
  const f = await fixture();
  try {
    const { h } = f;
    await h.bindings.writeDefaults({ harness: 'codex' });
    f.agentOf('native', history.map(event => ({ ...event })));
    assert.equal((await h.state({ sessionId: 'native' })).locked, true, 'a started native session stays locked');
    const { sessionId: branch } = await f.ctx.sessionController.fork({ sessionId: 'native', atSeq: 1 });
    // Unlike a new empty session, the branch is not moved onto the remembered Harness.
    assert.deepEqual(await h.state({ sessionId: branch }).then(state => [state.harness, state.locked]), ['dsh', false]);
    assert.equal(await h.bindings.read(branch), undefined);
    await h.select({ sessionId: branch, harness: 'codex' });
    assert.deepEqual((await h.bindings.read(branch)).carry, { throughSeq: 2 });
    // A new empty session still starts on the remembered Harness, with nothing to carry.
    f.agentOf('empty');
    assert.equal((await h.state({ sessionId: 'empty' })).harness, 'codex');
    assert.equal((await h.bindings.read('empty')).carry, undefined);
  } finally { await f.close(); }
});

test('an invalid first attachment does not lock a branch that has sent no message', async () => {
  const f = await fixture();
  try {
    f.agentOf('session', history.map(event => ({ ...event })));
    const { sessionId: branch } = await f.ctx.sessionController.fork({ sessionId: 'session', atSeq: 1 });
    await f.h.select({ sessionId: branch, harness: 'codex' });
    await assert.rejects(f.ctx.sessionController.prompt({ sessionId: branch, requestId: 'bad-file', content: [{ type: 'file', receiptId: 'expired' }] }, new AbortController().signal), /附件不属于当前会话或上传已过期/);
    assert.equal((await f.h.state({ sessionId: branch })).locked, false);
    assert.equal((await f.h.select({ sessionId: branch, harness: 'claude-code' })).harness, 'claude-code');
  } finally { await f.close(); }
});

test('a switched branch can fork again at an inherited message without a native turn', async () => {
  const f = await fixture();
  try {
    f.agentOf('session', history.map(event => ({ ...event })));
    const { sessionId: branch } = await f.ctx.sessionController.fork({ sessionId: 'session', atSeq: 1 });
    await f.h.select({ sessionId: branch, harness: 'codex' });
    const { sessionId: nested } = await f.ctx.sessionController.fork({ sessionId: branch, atSeq: 0 });
    assert.equal((await f.h.bindings.read(nested)).nativeRef, undefined);
    assert.deepEqual((await f.h.bindings.read(nested)).carry, { throughSeq: 1 });
    assert.equal((await f.h.state({ sessionId: nested })).locked, false);
  } finally { await f.close(); }
});

test('rollback records the start of the revoked turn for later cross-Harness branches', async () => {
  const f = await fixture();
  try {
    const agent = f.agentOf('session', [
      { seq: 0, type: 'turn/start', data: { turn: 1 } },
      { seq: 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'old request' }] } },
      { seq: 2, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ]);
    await f.h.bindings.write({ version: 1, sessionId: 'session', harness: 'codex', cwd: f.root, locked: true,
      nativeRef: { harnessId: 'codex', nativeSessionId: 'native', formatVersion: 1 }, turns: [{ turn: 1, key: 'first' }] });
    await f.h.rollback({ sessionId: 'session' });
    assert.equal(agent.session.snapshotEvents().at(-1).data.source.rewindFromSeq, 0);
  } finally { await f.close(); }
});
