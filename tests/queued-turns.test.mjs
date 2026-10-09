import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context, Service } from '@deepseek-ai/cordis';
import Typert from '@deepseek-ai/dsh-typert-registry';
import Agents from '@deepseek-ai/dsh-agent';
import Loop from '@deepseek-ai/dsh-agent-loop';
import Llm, { createUserMessage } from '@deepseek-ai/dsh-llm';
import Sessions, { SessionId } from '@deepseek-ai/dsh-session';
import Projections from '@deepseek-ai/dsh-session-projection';
import Prompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import { HarnessOutputChannel } from '../dist/contracts.js';
import { HarnessService, inject } from '../dist/dsh.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, message, timeout = 1200) {
  const deadline = Date.now() + timeout;
  while (!await predicate()) {
    assert.ok(Date.now() < deadline, typeof message === 'function' ? message() : message);
    await sleep(5);
  }
}

/** Real AgentLoop/inbox with the production HarnessService middleware, not a runner-only hook. */
async function fixture({ bound = true, resumed = false, harness = 'codex', beforeIdle } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'harness-queue-'));
  const ctx = new Context(), starts = [], opens = [], channels = [];
  let active, nativeSteps = 0, closes = 0, whenIdleDescriptor, cancelDescriptor;
  const id = SessionId('queue-fixture');
  class Commands extends Service {
    constructor(scope) { super(scope, 'sessionController'); }
    async resolveAgent(sessionId) { return { agent: ctx.agents.get(sessionId) }; }
    async prompt(request) {
      const { agent } = await this.resolveAgent(request.sessionId);
      const message = createUserMessage({ content: request.content, source: { kind: 'user', rpcId: request.requestId } });
      if (request.mode === 'steer') agent.steer(message); else agent.followup(message);
      return { accepted: true };
    }
    async selectModel() {} async fork() {} updateQueue() {}
  }
  const adapter = {
    async inspect() { return { status: 'ready', capabilities: {}, catalog: { models: [{ ref: { id: 'b64.Zml4dHVyZQ' }, label: 'Fixture' }], defaultModel: { id: 'b64.Zml4dHVyZQ' }, thinkingOptions: [] } }; },
    async open(input) {
      opens.push(input);
      const channel = new HarnessOutputChannel(); channels.push(channel);
      const emit = event => channel.emit({ kind: 'event', event });
      const session = {
        initialState: { nativeRef: { harnessId: harness, nativeSessionId: 'same-native-session', formatVersion: 1 }, effectiveModel: { id: 'b64.Zml4dHVyZQ' }, resolvedModelLabel: 'Fixture' },
        outputs: channel.outputs,
        async execute(command) {
          if (command.type === 'turn.cancel') {
            if (active) emit({ type: 'turn.completed', turnId: command.turnId, outcome: { status: 'cancelled' } });
            active = undefined;
            return { ok: true, value: { cancellationRequested: true } };
          }
          assert.equal(command.type, 'turn.start');
          assert.equal(active, undefined, 'native turns never overlap');
          active = command.turnId;
          starts.push({ turnId: active, input: command.input });
          emit({ type: 'turn.started', turnId: active });
          if (starts.length > 1) finish();
          return { ok: true, value: { turnId: command.turnId } };
        },
        async close() { closes++; channel.end(); },
      };
      function finish(status = 'succeeded') {
        const turnId = active; assert.ok(turnId);
        emit({ type: 'item.completed', turnId, snapshot: { item: { type: 'agentMessage', itemId: 'answer', text: `reply-${starts.length}` }, outcome: { status: 'succeeded' } } });
        emit({ type: 'turn.completed', turnId, outcome: { status } });
        active = undefined;
      }
      session.finish = finish;
      session.fail = () => emit({ type: 'session.faulted', error: { code: 'protocolError', message: 'unconfirmed native request', retryable: false } });
      adapter.session = session;
      return { ok: true, value: session };
    },
    async close() { for (const channel of channels) channel.end(); },
  };
  for (const plugin of [Llm, Sessions, Projections, Prompt, Tools, Agents, Typert, Commands]) await ctx.plugin(plugin);
  ctx.provide('userQuestions', {}); ctx.provide('attachments', {});
  ctx.provide('fileUploads', { resolve: () => undefined });
  ctx.on('agent/created', ({ agent }) => {
    whenIdleDescriptor = Object.getOwnPropertyDescriptor(agent, 'whenIdle');
    cancelDescriptor = Object.getOwnPropertyDescriptor(agent, 'cancel');
  });
  if (beforeIdle) ctx.on('agent/status', ({ agent, status }) => { if (status === 'idle') beforeIdle(agent); });
  await ctx.plugin({ inject, apply(scope) { new HarnessService(scope, join(root, 'bindings'), { codex: adapter, 'claude-code': adapter }); } });
  // An unbound native session still delegates to its host middleware; reject needs no model fixture.
  ctx.on('agent/pre-step', async () => { nativeSteps++; return { kind: 'reject' }; });
  await ctx.plugin(Loop, { agents: [] });
  const handle = await ctx.agents.create({ sessionId: id, meta: { cwd: root } });
  const { agent } = handle;
  if (bound) await ctx.harness.bindings.write({ version: 1, sessionId: id, harness, cwd: root, locked: true,
    ...(resumed ? { nativeRef: { harnessId: harness, nativeSessionId: 'same-native-session', formatVersion: 1 } } : {}) });
  const send = text => ctx.sessionController.prompt({ sessionId: id, requestId: `request-${text}`, mode: 'queue', content: [{ type: 'text', text }] }, new AbortController().signal);
  return { ctx, agent, handle, adapter, starts, opens, send, nativeSteps: () => nativeSteps, closes: () => closes, whenIdleDescriptor: () => whenIdleDescriptor, cancelDescriptor: () => cancelDescriptor,
    async close() { await ctx.fiber.dispose(); await adapter.close(); await rm(root, { recursive: true, force: true }); } };
}

for (const harness of ['codex', 'claude-code']) test(`${harness} queued Harness prompts start separate FIFO turns after native completion without another wakeup`, { timeout: 5000 }, async () => {
  const f = await fixture({ harness });
  try {
    await f.send('first'); await until(() => f.starts.length === 1, 'first native turn did not start');
    await f.send('second'); await f.send('third');
    assert.equal(f.agent.inbox.nextTurn.length, 2);
    await f.send('second');
    assert.equal(f.agent.inbox.nextTurn.length, 2, 'a retried queue RPC is not admitted twice');
    await f.send('removed');
    const removed = f.agent.inbox.nextTurn.find(message => message.content[0].text === 'removed');
    assert.equal(f.agent.inbox.remove(removed.id), true);
    const second = f.agent.inbox.nextTurn[0];
    assert.equal(f.agent.inbox.replace(second.id, { ...second, content: [{ type: 'text', text: 'second-edited' }] }), true);
    const queuedIds = f.agent.inbox.nextTurn.map(message => message.id);
    const before = f.agent.session.snapshotEvents().filter(event => event.type === 'agent/inbox/spliced');
    const admissions = before.reduce((count, event) => count + event.data.inserted.length, 0);
    const cancellations = before.filter(event => event.data.outcome === 'canceled').length;
    const descriptor = Object.getOwnPropertyDescriptor(f.agent.inbox, 'splice');
    f.adapter.session.finish();
    await until(() => f.starts.length === 3 && f.agent.status === 'idle', () => `first host turn=${f.agent.session.snapshotEvents().filter(e => e.type === 'turn/end').at(-1)?.data.reason.kind}; pending=${f.agent.inbox.nextTurn.length}; native completion left the two queued prompts idle instead of starting their turns`);
    await f.agent.whenIdle();
    assert.deepEqual(f.starts.map(start => start.input.map(part => part.text)), [['first'], ['second-edited'], ['third']]);
    assert.equal(new Set(f.starts.map(start => start.turnId)).size, 3);
    const events = f.agent.session.snapshotEvents();
    assert.deepEqual(events.filter(event => event.type === 'user/message').map(event => event.data.content.map(part => part.text)), [['first'], ['second-edited'], ['third']]);
    const splices = events.filter(event => event.type === 'agent/inbox/spliced');
    assert.equal(splices.reduce((count, event) => count + event.data.inserted.length, 0), admissions, 'waking an existing queue does not create duplicate admission events');
    assert.equal(splices.filter(event => event.data.outcome === 'canceled').length, cancellations, 'continuation does not cancel and re-admit pending work');
    assert.deepEqual(Object.getOwnPropertyDescriptor(f.agent.inbox, 'splice'), descriptor, 'transient compatibility wrapper is removed');
    assert.deepEqual(events.filter(event => event.type === 'user/message').slice(1).map(event => event.data.id), queuedIds, 'queued message IDs survive continuation');
    assert.deepEqual(events.filter(event => event.type === 'turn/end').map(event => event.data.reason.kind), ['completed', 'completed', 'completed']);
    assert.equal(f.opens.length, 1);
    const binding = await f.ctx.harness.bindings.read(f.agent.id);
    assert.equal(binding.nativeRef.nativeSessionId, 'same-native-session');
    assert.equal(binding.pending, undefined);
    assert.equal(f.agent.inbox.nextTurn.length, 0);
    assert.equal(f.nativeSteps(), 0, 'Harness work never falls through to the host model');
  } finally { await f.close(); }
});

test('an earlier idle observer owning maintenance delays but does not lose queued continuation', { timeout: 5000 }, async () => {
  const held = Promise.withResolvers(), entered = Promise.withResolvers();
  let owner, idleResolved = false, settledTurns;
  const f = await fixture({ beforeIdle(agent) {
    if (owner) return;
    owner = agent.runMaintenance(async () => { entered.resolve(); await held.promise; });
  } });
  try {
    await f.send('first'); await until(() => f.starts.length === 1, 'first native turn did not start');
    await f.send('second'); await f.send('third');
    f.adapter.session.finish(); await entered.promise;
    const idle = f.agent.whenIdle().then(() => { idleResolved = true; settledTurns = f.starts.length; });
    await sleep(30);
    assert.equal(idleResolved, false, 'whenIdle remains pending while the earlier maintenance owner is active');
    assert.equal(f.starts.length, 1);
    held.resolve();
    await until(() => f.starts.length === 3 && f.agent.status === 'idle', 'queue was lost behind an earlier maintenance reservation');
    await idle; await owner; await f.agent.whenIdle();
    assert.equal(settledTurns, 3, 'whenIdle follows the maintenance owner and the queued continuation it releases');
    assert.deepEqual(f.starts.map(start => start.input.map(part => part.text)), [['first'], ['second'], ['third']]);
    assert.equal(f.agent.session.snapshotEvents().filter(event => event.type === 'agent/inbox/spliced' && event.data.outcome === 'canceled').length, 0);
  } finally { held.resolve(); await f.close(); }
});

test('cancelling continuation maintenance or disposing its agent leaves queued native work parked', { timeout: 5000 }, async () => {
  for (const remove of [false, true]) {
    const f = await fixture();
    let disposal;
    try {
      await f.send('first'); await until(() => f.starts.length === 1, 'first native turn did not start');
      await f.send('second');
      const stop = f.ctx.on('agent/status', ({ agent, status }) => {
        if (agent !== f.agent || status !== 'idle') return;
        stop();
        if (remove) disposal = f.handle.dispose();
        else agent.cancel({ kind: 'user' }, { keepInbox: true });
      });
      f.adapter.session.finish();
      await f.agent.whenIdle(); if (disposal) await disposal;
      await sleep(40);
      assert.equal(f.starts.length, 1);
      if (remove) {
        assert.equal(f.ctx.agents.get(f.agent.id), undefined);
        assert.deepEqual(Object.getOwnPropertyDescriptor(f.agent, 'whenIdle'), f.whenIdleDescriptor(), 'agent disposal restores the original public method descriptor');
        assert.deepEqual(Object.getOwnPropertyDescriptor(f.agent, 'cancel'), f.cancelDescriptor(), 'agent disposal restores the original cancel descriptor');
      }
      else assert.equal(f.agent.inbox.nextTurn.length, 1);
    } finally { await f.close(); }
  }
});

test('cancelling another maintenance owner invalidates a deferred successful-native receipt', { timeout: 5000 }, async () => {
  const held = Promise.withResolvers(), entered = Promise.withResolvers();
  let owner;
  const f = await fixture({ beforeIdle(agent) {
    if (owner) return;
    owner = agent.runMaintenance(async () => { entered.resolve(); await held.promise; });
  } });
  try {
    await f.send('first'); await until(() => f.starts.length === 1, 'first native turn did not start');
    await f.send('second'); await f.send('third');
    f.adapter.session.finish(); await entered.promise;
    f.agent.cancel({ kind: 'user' }, { keepInbox: true });
    held.resolve();
    await f.agent.whenIdle(); await owner;
    assert.equal(f.starts.length, 1, 'cancelling the other owner must retire the deferred receipt rather than wake the preserved queue');
    assert.equal(f.agent.inbox.nextTurn.length, 2);
  } finally { held.resolve(); await f.close(); }
});

test('a resumed native binding retains its identity through queued continuation', { timeout: 5000 }, async () => {
  const f = await fixture({ resumed: true });
  try {
    await f.send('first'); await until(() => f.starts.length === 1, 'first turn did not start');
    await f.send('second'); f.adapter.session.finish();
    await until(() => f.starts.length === 2 && f.agent.status === 'idle', 'resumed queue did not drain');
    await f.agent.whenIdle();
    assert.equal(f.opens.length, 1);
    assert.equal(f.opens[0].kind, 'resume');
    assert.equal(f.opens[0].nativeRef.nativeSessionId, 'same-native-session');
    assert.equal((await f.ctx.harness.bindings.read(f.agent.id)).nativeRef.nativeSessionId, 'same-native-session');
  } finally { await f.close(); }
});

test('an unconfirmed native failure does not automatically submit the queued request', { timeout: 5000 }, async () => {
  const f = await fixture();
  try {
    await f.send('first'); await until(() => f.starts.length === 1, 'first turn did not start');
    await f.send('second'); f.adapter.session.fail();
    await until(() => f.agent.status === 'idle', 'failed native request did not settle');
    await sleep(40);
    assert.equal(f.starts.length, 1);
    assert.equal(f.agent.inbox.nextTurn.length, 1);
    assert.ok((await f.ctx.harness.bindings.read(f.agent.id)).pending);
    assert.equal(f.agent.session.snapshotEvents().filter(event => event.type === 'turn/end').at(-1).data.reason.kind, 'error');
  } finally { await f.close(); }
});

test('user cancellation retaining the inbox does not restart queued native work', { timeout: 5000 }, async () => {
  const f = await fixture();
  try {
    await f.send('first'); await until(() => f.starts.length === 1, 'first turn did not start');
    await f.send('second'); f.agent.cancel({ kind: 'user' }, { keepInbox: true });
    await until(() => f.agent.status === 'idle', 'cancelled request did not settle');
    await sleep(40);
    assert.equal(f.starts.length, 1);
    assert.equal(f.agent.inbox.nextTurn.length, 1);
    assert.equal(f.agent.session.snapshotEvents().filter(event => event.type === 'turn/end').at(-1).data.reason.kind, 'aborted');
  } finally { await f.close(); }
});

test('disposing HarnessService during a turn does not start queued native work', { timeout: 5000 }, async () => {
  const f = await fixture();
  try {
    await f.send('first'); await until(() => f.starts.length === 1, 'first turn did not start');
    await f.send('second'); await f.ctx.fiber.dispose();
    assert.equal(f.starts.length, 1);
    assert.equal(f.agent.status, 'idle');
    assert.deepEqual(Object.getOwnPropertyDescriptor(f.agent, 'whenIdle'), f.whenIdleDescriptor(), 'service disposal restores the original public method descriptor');
    assert.deepEqual(Object.getOwnPropertyDescriptor(f.agent, 'cancel'), f.cancelDescriptor(), 'service disposal restores the original cancel descriptor');
  } finally { await f.close(); }
});

test('an unbound native DSH session retains the host blocked-turn behavior', { timeout: 5000 }, async () => {
  const f = await fixture({ bound: false });
  try {
    await f.send('native'); await f.agent.whenIdle();
    assert.equal(f.nativeSteps(), 1);
    assert.equal(f.starts.length, 0);
    assert.equal(await f.ctx.harness.bindings.read(f.agent.id), undefined);
    assert.equal(f.agent.session.snapshotEvents().filter(event => event.type === 'turn/end').at(-1).data.reason.kind, 'blocked');
  } finally { await f.close(); }
});
