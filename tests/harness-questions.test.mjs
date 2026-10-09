import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { build } from 'esbuild';
import ts from 'typescript';
import { DshRunner } from '../dist/dsh-runner.js';
import { DshOutput } from '../dist/dsh-output.js';
import { Context } from '@deepseek-ai/cordis';
import Agents from '@deepseek-ai/dsh-agent';
import Loop from '@deepseek-ai/dsh-agent-loop';
import Llm from '@deepseek-ai/dsh-llm';
import Sessions from '@deepseek-ai/dsh-session';
import Projections from '@deepseek-ai/dsh-session-projection';
import Prompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import { validateStoredEvents } from '@deepseek-ai/dsh-session-persistence';

// Read the Host implementation without modifying it; only transport and store services are simulated.
async function questionClient() {
  const root = resolve('node_modules/@deepseek-ai/dsh-client-ui-user-questions/src/client');
  const [slots, source, drafts] = await Promise.all([
    readFile(resolve(root, 'contract/slots.ts'), 'utf8'),
    readFile(resolve(root, 'index.ts'), 'utf8'),
    readFile(resolve(root, 'draft-store.ts'), 'utf8'),
  ]);
  const start = source.indexOf('class QuestionCards {'), end = source.indexOf('export function apply(', start);
  assert.ok(start >= 0 && end > start, 'Host question-card seam must exist');
  const module = { exports: {} };
  const code = ts.transpileModule(`${slots}\n${source.slice(start, end)}\n${drafts}\nexport { QuestionCards, answerQuestion, publishContinuedQuestions };`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  runInNewContext(code, { exports: module.exports, module, crypto: webcrypto, AbortController, AbortSignal,
    setInterval, clearInterval, brandString: value => value, require: () => ({ defineStore: config => config }) });
  const bundle = await build({ entryPoints: ['node_modules/@deepseek-ai/dsh-user-questions/src/projection.ts'],
    bundle: true, write: false, platform: 'node', format: 'cjs', external: ['@deepseek-ai/*'] });
  const projection = { exports: {} };
  runInNewContext(bundle.outputFiles[0].text, { module: projection, exports: projection.exports, require: createRequire(import.meta.url) });
  return { ...module.exports, fold: projection.exports.foldUserQuestions };
}

test('Harness question survives disconnect and projection refresh with its draft, then answers once', { timeout: 10000 }, async () => {
  const { QuestionCards, answerQuestion, publishContinuedQuestions, createQuestionDraftStore, fold } = await questionClient();
  const records = [], visible = new Map(), updates = new Set(), requests = [], responses = [];
  const cardEvents = [];
  const cards = new QuestionCards(pending => {
    visible.set(pending.key, pending); cardEvents.push(['show', pending.key]);
    return () => { visible.delete(pending.key); cardEvents.push(['hide', pending.key]); };
  });
  const subscribe = listener => { updates.add(listener); return () => updates.delete(listener); };
  const refresh = () => { for (const listener of updates) listener(); };
  const binding = { session: { projections: { faceOf: name => ({ subscribe,
    getSnapshot: () => name === 'userQuestions' ? fold(records) : {} }) } } };
  const client = { sessions: { scopeOf: () => 'agent', list: { getSnapshot: () => ({ byId: { agent: { id: 'agent' } } }), subscribe },
    binding: () => binding }, remote: { userQuestions: { answer() { throw new Error('blocking questions must answer the live request'); } } } };
  const stop = publishContinuedQuestions(client, cards);
  const first = new AbortController(), resumed = new AbortController();
  const delivered = Promise.withResolvers(), disconnected = Promise.withResolvers();
  const controller = new AbortController();
  const ctx = { effect() {}, userQuestions: { async ask(request) {
    requests.push(request); delivered.resolve();
    const initial = answerQuestion(client, client, { ...request, signal: AbortSignal.any([first.signal, request.signal]) }, () => assert.fail('unexpected delegation'), cards);
    await assert.rejects(initial, { code: 'ASK_ABORTED' });
    disconnected.resolve();
    await reconnect.promise;
    return answerQuestion(client, client, { ...request, signal: AbortSignal.any([resumed.signal, request.signal]) }, () => assert.fail('unexpected delegation'), cards);
  } } };
  const reconnect = Promise.withResolvers();
  const agent = { id: 'agent', session: { requestHeader: () => records.findLast(event => event.type === 'request/header')?.data.header,
    append(type, data) { const event = { type, data, seq: records.length + 1 }; records.push(event); refresh(); return event; } } };
  const output = new DshOutput(ctx, agent, { turn: 1, step: 1 }, () => 1, () => ({ provider: 'codex', model: 'fixture' }));
  const runner = new DshRunner(ctx, { readDelegated: async () => null }, {});
  const interaction = { type: 'question', interactionId: 'input-1', turnId: 'turn', questions: [{
    id: 'scope', type: 'choice', prompt: '选择范围', options: [{ label: '全部', value: 'all' }], multiple: true,
  }] };
  const work = runner.answer(agent, interaction, controller.signal, { async execute(command) { responses.push(command); return { ok: true, value: { accepted: true } }; } }, output);
  // Attach rejection handling now so failed assertions can still cancel and clean up the request.
  void work.catch(() => {});
  try {
    await delivered.promise;
    const pending = [...visible.values()][0];
    const store = createQuestionDraftStore(), state = store.init();
    const progress = { index: 0, drafts: [{ selected: ['全部'], custom: '保留草稿', skipped: false }] };
    store.actions.replace(state, pending.key, progress);
    pending.engage();
    first.abort(); await disconnected.promise;
    assert.equal(visible.get(pending.key), pending, 'disconnect must not withdraw the unanswered card');
    refresh();
    assert.equal(visible.get(pending.key), pending, 'projection refresh must retain the unanswered card');
    assert.equal(pending.snapshot().closed, false);
    store.actions.prune(state, pending.liveKeys());
    assert.equal(state.progressByRequest[pending.key], progress, 'the same draft remains reachable');
    const call = records.find(event => event.type === 'tool/call');
    assert.equal(fold(records).active[0].questions[0].multiSelect, true, 'reconstructed questions retain multi-select');
    assert.equal(requests[0].wait.callId, call.data.callId, 'answer channel and transcript must name the same call');
    assert.equal(requests[0].wait.timed, undefined, 'no timed claim for an indefinite Harness question');
    reconnect.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal([...visible.values()][0], pending, 'replay must reuse the original card');
    const answer = { answers: [{ id: 'scope', selected: ['全部'] }] };
    await pending.answer(answer);
    await work;
    assert.deepEqual(responses.map(command => command.response), [{ type: 'question', answers: { scope: ['all'] } }]);
    await assert.rejects(pending.answer(answer), /no channel/);
    refresh();
    assert.equal(visible.size, 0, 'settled calls must release their cards');
    assert.equal(records.filter(event => event.type === 'tool/result').length, 1);
    assert.deepEqual(cardEvents.map(([kind]) => kind), ['show', 'hide'], 'no intermediate hide/recreate');
  } finally { stop(); reconnect.resolve(); first.abort(); resumed.abort(); controller.abort(); cards.dispose(); await Promise.allSettled([work]); }
});

test('projected Harness questions preserve the route and other tools, persist valid events, and close on cancellation', async () => {
  const { fold } = await questionClient();
  const ctx = new Context();
  try {
    for (const plugin of [Llm, Sessions, Projections, Prompt, Tools, Agents, Loop]) await ctx.plugin(plugin);
    const { agent } = await ctx.agents.create({ sessionId: 'question-records', meta: { cwd: '/tmp' } });
    agent.session.append('turn/start', { turn: 1 });
    agent.session.append('step/start', { turn: 1, step: 1 });
    const header = { config: { provider: 'native', model: 'previous', reasoningEffort: 'high' }, tools: [
      { name: 'read', description: 'read', parameters: { type: 'object' } },
      { name: 'ask_user_question', description: 'legacy', parameters: { type: 'object', properties: { questions: { type: 'array' } } } },
    ] };
    agent.session.append('request/header', { header, reason: 'initial' });
    const output = new DshOutput(ctx, agent, { turn: 1, step: 1 }, () => 1, () => ({ provider: 'codex', model: 'fixture' }));
    const questions = [{ id: 'scope', question: '选择范围' }];
    await output.question('answered', questions, async callId => {
      assert.equal(fold(agent.session.snapshotEvents()).active[0].callId, callId);
      assert.deepEqual(agent.session.requestHeader().config, header.config);
      assert.deepEqual(agent.session.requestHeader().tools[0], header.tools[0]);
      return { answers: [{ id: 'scope', selected: [], custom: '全部' }] };
    });
    const aborted = Object.assign(new Error('cancelled'), { name: 'AbortError' });
    await assert.rejects(output.question('cancelled', questions, async () => { throw aborted; }), aborted);
    assert.equal(fold(agent.session.snapshotEvents()).active.length, 0);
    const events = agent.session.snapshotEvents();
    assert.equal(events.filter(event => event.type === 'request/header').length, 2, 'only the initial schema change is logged');
    assert.equal(events.filter(event => event.type === 'tool/result').at(-1).data.error.code, 'ASK_ABORTED');
    agent.session.append('step/end', { turn: 1, step: output.step });
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    validateStoredEvents(agent.session.header, structuredClone(agent.session.snapshotEvents()));
  } finally { await ctx.fiber.dispose(); }
});

const codexSource = readFile('dist/codex-acp.mjs', 'utf8');
async function userInputHandler() {
  const source = await codexSource;
  const start = source.indexOf('  async handleUserInput(params) {'), end = source.indexOf('  createMcpElicitationContext(', start);
  assert.ok(start >= 0 && end > start, 'shipped Codex input-handler seam must exist');
  const timers = new Map();
  const handler = runInNewContext(`new (class { ${source.slice(start, end)} })()`, {
    AbortController, clientSupportsFormElicitation: () => true,
    methods: { client: { elicitation: { create: 'elicitation/create' } } }, logger: { error() {} },
    setTimeout(callback, ms) { const token = {}; timers.set(token, { callback, ms }); return token; },
    clearTimeout: token => timers.delete(token),
  });
  const request = Promise.withResolvers(), calls = [];
  handler.buildUserInputRequest = params => params;
  handler.convertUserInputResponse = response => response;
  handler.cancellationSignal = new AbortController().signal;
  handler.connection = { request(method, params, options) {
    assert.equal(method, 'elicitation/create'); calls.push({ params, signal: options?.cancellationSignal });
    const signal = options?.cancellationSignal;
    signal?.addEventListener('abort', () => request.reject(new Error('cancelled')), { once: true });
    if (signal?.aborted) request.reject(new Error('cancelled'));
    return request.promise;
  } };
  return { handler, timers, request, calls };
}

test('Codex omitted/null timers and blocking requests wait for the human answer', async () => {
  for (const params of [{}, { autoResolutionMs: null }, { isBlocking: false }, { isBlocking: false, autoResolutionMs: null },
    { isBlocking: true }, { isBlocking: true, autoResolutionMs: 0 }]) {
    const { handler, timers, request, calls } = await userInputHandler();
    const result = handler.handleUserInput(params);
    const scheduled = timers.size;
    const answer = { answers: { scope: { answers: ['all'] } } };
    request.resolve(answer);
    assert.deepEqual(await result, answer);
    assert.equal(scheduled, 0, JSON.stringify(params));
    assert.equal(calls[0].signal.aborted, false);
  }
});

test('Codex legacy explicit timers still expire, accept early answers, and respect cancellation', async () => {
  for (const params of [{ autoResolutionMs: 0 }, { autoResolutionMs: 80 }, { isBlocking: false, autoResolutionMs: 80 }]) {
    const { handler, timers, calls } = await userInputHandler();
    const result = handler.handleUserInput(params);
    const timer = [...timers.values()][0];
    assert.equal(timer.ms, params.autoResolutionMs); timer.callback();
    assert.equal(JSON.stringify(await result), '{"answers":{}}');
    assert.equal(calls[0].signal.aborted, true); assert.equal(timers.size, 0);
  }
  for (const params of [{}, { isBlocking: true }, { isBlocking: false }, { autoResolutionMs: 80 }]) {
    const { handler, timers, request, calls } = await userInputHandler();
    const abort = new AbortController(); handler.cancellationSignal = abort.signal;
    const result = handler.handleUserInput(params);
    abort.abort();
    assert.equal(JSON.stringify(await result), '{"answers":{}}');
    assert.equal(calls[0].signal.aborted, true); assert.equal(timers.size, 0);
    request.resolve({ answers: { scope: { answers: ['too late'] } } });
  }
  const { handler, timers, request } = await userInputHandler();
  const result = handler.handleUserInput({ autoResolutionMs: 80 });
  const answer = { answers: { scope: { answers: ['early'] } } };
  request.resolve(answer); assert.deepEqual(await result, answer); assert.equal(timers.size, 0);
});
