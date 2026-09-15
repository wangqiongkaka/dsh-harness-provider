import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Run against an existing, built DSH checkout without editing its files.
const reference = process.argv[2];
assert.ok(reference, 'Usage: node experiments/dsh-extension-probe.mjs <built DSH checkout>');
const require = createRequire(join(resolve(reference), 'packages/core/agent-loop/package.json'));
const load = name => import(pathToFileURL(require.resolve(name)).href);
const { Context } = await load('@deepseek-ai/cordis');
const { default: AgentRegistry } = await load('@deepseek-ai/dsh-agent');
const { default: AgentLoop } = await load('@deepseek-ai/dsh-agent-loop');
const { default: LlmRuntime, createUserMessage } = await load('@deepseek-ai/dsh-llm');
const { default: SessionStore, SessionId } = await load('@deepseek-ai/dsh-session');
const { default: Projections } = await load('@deepseek-ai/dsh-session-projection');
const { default: SystemPrompt } = await load('@deepseek-ai/dsh-system-prompt');
const { default: Tools } = await load('@deepseek-ai/dsh-tools');
const { default: Persistence } = await load('@deepseek-ai/dsh-session-persistence-jsonl');
const { validateStoredEvents } = await load('@deepseek-ai/dsh-session-persistence');

const root = await mkdtemp(join(tmpdir(), 'dsh-harness-extension-'));
const routes = [];
const received = [];
const contexts = [];

// A replacement Cordis service can delegate to the unchanged native factory.
class RoutedRegistry extends AgentRegistry {
  setFactory(native) {
    return super.setFactory({
      createAgent(owner, options) {
        routes.push(['create', options.sessionId]);
        return native.createAgent(owner, options);
      },
      resume(owner, options) {
        routes.push(['resume', options.resumeSessionId]);
        return native.resume(owner, options);
      },
    });
  }
}

async function mount() {
  const ctx = new Context();
  contexts.push(ctx);
  for (const plugin of [LlmRuntime, SessionStore, Projections, SystemPrompt, Tools, RoutedRegistry]) {
    await ctx.plugin(plugin);
  }
  await ctx.plugin(Persistence, { root, compression: 'none' });
  await ctx.plugin(AgentLoop, { agents: [] });
  return ctx;
}

function intercept(ctx, callback) {
  return ctx.on('agent/pre-step', async (payload, next) => {
    if (payload.agent.id !== 'extension-probe') return next();
    await callback(payload);
    return { kind: 'enter', messages: [] };
  });
}

async function prompt(agent, text) {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }));
  await agent.whenIdle();
}

function endings(agent) {
  return agent.session.snapshotEvents().filter(event => event.type === 'turn/end');
}

try {
  const first = await mount();
  const id = SessionId('extension-probe');
  intercept(first, ({ messages }) => { received.push(messages[0].content[0].text); });
  const handle = await first.agents.create({ sessionId: id, meta: { cwd: root } });
  await prompt(handle.agent, 'first');
  await prompt(handle.agent, 'second');
  assert.deepEqual(received, ['first', 'second']);
  assert.deepEqual(endings(handle.agent).map(event => event.data.reason.kind), ['completed', 'completed']);
  assert.equal(handle.agent.session.snapshotEvents().some(event => event.type === 'request/header'), false);
  await first.fiber.dispose();

  const second = await mount();
  const stop = intercept(second, ({ messages }) => { received.push(messages[0].content[0].text); });
  const resumed = await second.agents.resume({ resumeSessionId: id });
  assert.equal(endings(resumed.agent).length, 2);
  await prompt(resumed.agent, 'after restart');
  assert.deepEqual(received, ['first', 'second', 'after restart']);
  assert.equal(endings(resumed.agent).length, 3);
  assert.deepEqual(routes, [['create', id], ['resume', id]]);
  stop();

  const entered = Promise.withResolvers();
  let cancelled = false;
  intercept(second, async ({ signal }) => {
    signal.throwIfAborted();
    await new Promise(resolve => {
      signal.addEventListener('abort', () => { cancelled = true; resolve(); }, { once: true });
      entered.resolve();
    });
  });
  const running = prompt(resumed.agent, 'cancel this');
  await entered.promise;
  resumed.agent.cancel({ kind: 'user' });
  await running;
  assert.equal(cancelled, true);
  assert.equal(endings(resumed.agent).at(-1).data.reason.kind, 'aborted');

  assert.throws(() => validateStoredEvents(resumed.agent.session.header, [
    { type: 'external-harness/probe', seq: 0, time: 0, data: {} },
  ]), /unknown|unsupported/i);
  console.log('PASS: replaceable registry delegates native create/resume');
  console.log('PASS: pre-step receives two prompts and a prompt after cold resume');
  console.log('PASS: native cancellation reaches the plugin and records an aborted turn');
  console.log('PASS: unknown required log events are refused');
  console.log('NOT TESTED: DSH Loader/profile installation, Web/Desktop UI, or a real external Harness');
} finally {
  try {
    const closed = await Promise.allSettled(contexts.map(ctx => ctx.fiber.dispose()));
    const failures = closed.filter(result => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Probe cleanup failed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
