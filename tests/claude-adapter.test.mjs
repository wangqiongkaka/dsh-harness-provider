import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ClaudeCodeAdapter } from '../dist/claude-adapter.js';

/** Scripted stand-in for the Agent SDK query: records control calls, lets the test push native messages. */
function fakeSdk({ models = [{ value: 'default', displayName: 'Default', supportsAutoMode: true }, { value: 'opus', displayName: 'Opus' }] } = {}) {
  const queries = [];
  const factory = ({ prompt, options }) => {
    const buffered = [], waiters = [], calls = [], prompts = [];
    let closed = false;
    const q = {
      options, calls, prompts,
      push(message) { const waiter = waiters.shift(); if (waiter) waiter({ done: false, value: message }); else buffered.push(message); },
      async initializationResult() { return { models }; },
      async interrupt() { calls.push('interrupt'); },
      async setModel(model) { calls.push(['setModel', model]); },
      async applyFlagSettings(settings) { calls.push(['flags', settings]); },
      async setPermissionMode(mode) { calls.push(['permission', mode]); },
      async getContextUsage() { return { totalTokens: 40, maxTokens: 200, model: 'x' }; },
      async accountInfo() { return { email: 'user@example.com' }; },
      async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() {
        return { rate_limits_available: true, subscription_type: 'max', rate_limits: { five_hour: { utilization: 12, resets_at: '2026-09-16T00:00:00Z' }, seven_day: { utilization: 40, resets_at: null } } };
      },
      async stopTask() {},
      close() { closed = true; for (const waiter of waiters.splice(0)) waiter({ done: true, value: undefined }); },
      [Symbol.asyncIterator]() {
        return { next: () => buffered.length ? Promise.resolve({ done: false, value: buffered.shift() })
          : closed ? Promise.resolve({ done: true, value: undefined }) : new Promise(resolve => waiters.push(resolve)) };
      },
    };
    (async () => { for await (const message of prompt) prompts.push(message); })();
    queries.push(q);
    return q;
  };
  return { factory, queries };
}

const environment = { PATH: process.env.PATH };
const unwrap = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.value; };
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
function reader(session) {
  const iterator = session.outputs[Symbol.asyncIterator]();
  const seen = [];
  return {
    seen,
    async until(match) {
      for (;;) {
        const next = await iterator.next();
        assert.equal(next.done, false, 'outputs ended early');
        seen.push(next.value);
        if (match(next.value)) return next.value;
      }
    },
  };
}
const eventOf = type => output => output.kind === 'event' && output.event.type === type;
const result = extra => ({ type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed', ...extra });
const assistant = (id, content, usage) => ({ type: 'assistant', parent_tool_use_id: null, message: { id, model: 'claude-opus-5', content, ...(usage ? { usage } : {}) } });

async function openSession(sdk, input = {}) {
  const adapter = new ClaudeCodeAdapter({ environment, command: process.execPath, queryFactory: sdk.factory });
  const session = unwrap(await adapter.open({ kind: 'create', cwd: '/workspace', ...input }));
  return { adapter, session, out: reader(session) };
}
async function startTurn(sdk, session, turnId, text = 'hello') {
  unwrap(await session.execute({ type: 'turn.start', turnId, input: [{ type: 'text', text }] }));
  await tick();
  return sdk.queries.at(-1);
}

test('streams text, projects Bash and Edit activity, and reports exact per-process usage', async () => {
  const sdk = fakeSdk();
  const { adapter, session, out } = await openSession(sdk);
  const q = await startTurn(sdk, session, 'turn-1');
  assert.equal(q.options.sessionId.length, 36);
  assert.match(q.options.systemPrompt?.append ?? '', /进展反馈/);
  assert.match(q.options.systemPrompt?.append ?? '', /不要讨论或解释.*系统提示.*技能.*代理策略/);
  assert.deepEqual(q.options.settingSources, ['user', 'project', 'local']);
  assert.equal(q.prompts[0].message.content, 'hello');
  q.push({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'm1' } } });
  q.push({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Look' } } });
  q.push(assistant('m1', [{ type: 'text', text: 'Looking' }, { type: 'tool_use', id: 'bash', name: 'Bash', input: { command: 'ls', description: '查看项目文件' } }, { type: 'tool_use', id: 'edit', name: 'Edit', input: { file_path: 'a.txt' } }],
    { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 20, cache_read_input_tokens: 70 }));
  q.push({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'bash', content: 'a.txt' }] } });
  q.push({ type: 'user', parent_tool_use_id: null, tool_use_result: { filePath: '/workspace/a.txt', structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }] },
    message: { content: [{ type: 'tool_result', tool_use_id: 'edit', content: 'ok' }] } });
  q.push(result({ modelUsage: { 'claude-opus-5': { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 70, cacheCreationInputTokens: 20, contextWindow: 200000 } } }));
  const done = await out.until(eventOf('turn.completed'));
  assert.equal(done.event.outcome.status, 'succeeded');
  const completed = out.seen.filter(eventOf('item.completed')).map(output => output.event.snapshot.item);
  assert.deepEqual(completed.map(item => item.type), ['agentMessage', 'commandExecution', 'toolExecution', 'fileChange']);
  assert.equal(completed[0].text, 'Looking');
  assert.equal(completed[1].output, 'a.txt');
  assert.equal(completed[1].description, '查看项目文件');
  assert.equal(completed[3].changes[0].unifiedDiff, '--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n');
  const usage = out.seen.filter(eventOf('session.usage.changed')).at(-1).event.usage;
  assert.deepEqual(usage, { contextUsedTokens: 100, contextWindowTokens: 200000, inputTokens: 100, cachedInputTokens: 70, cacheWriteInputTokens: 20, outputTokens: 5 });
  const state = out.seen.find(eventOf('session.state.changed')).event.state;
  assert.equal(state.nativeRef.nativeSessionId, q.options.sessionId);
  await adapter.close();
});

test('shows native slash-command and hook informational output as assistant text', async () => {
  const sdk = fakeSdk();
  const { adapter, session, out } = await openSession(sdk);
  try {
    const q = await startTurn(sdk, session, 'informational');
    q.push({ type: 'system', subtype: 'informational', content: 'hook blocked this prompt', level: 'warning', prevent_continuation: true, uuid: 'info-1', session_id: q.options.sessionId });
    q.push(result({}));
    await out.until(eventOf('turn.completed'));
    assert.ok(out.seen.filter(eventOf('item.completed')).some(output => output.event.snapshot.item.type === 'agentMessage'
      && output.event.snapshot.item.text === 'hook blocked this prompt'));
  } finally { await adapter.close(); }
});

test('bridges MCP form elicitation through a DSH question interaction', async () => {
  const sdk = fakeSdk();
  const { adapter, session, out } = await openSession(sdk);
  try {
    const q = await startTurn(sdk, session, 'elicitation');
    const nativeResponse = q.options.onElicitation({
      serverName: 'probe', message: 'Configure deployment', mode: 'form',
      requestedSchema: { type: 'object', required: ['region'], properties: {
        region: { type: 'string', title: 'Region', enum: ['us', 'eu'] },
        note: { type: 'string', title: 'Note' },
      } },
    }, { signal: new AbortController().signal });
    const pending = await out.until(output => output.kind === 'interaction');
    assert.equal(pending.interaction.title, 'Configure deployment');
    assert.deepEqual(pending.interaction.questions.map(question => [question.id, question.type, question.optional]), [
      ['region', 'choice', false], ['note', 'text', true],
    ]);
    unwrap(await session.execute({ type: 'interaction.respond', interactionId: pending.interaction.interactionId,
      response: { type: 'question', answers: { region: ['eu'], note: ['ship it'] } } }));
    assert.deepEqual(await nativeResponse, { action: 'accept', content: { region: 'eu', note: 'ship it' } });
    q.push(result({}));
    await out.until(eventOf('turn.completed'));
  } finally { await adapter.close(); }
});

test('answers AskUserQuestion, plan approval, and scoped tool approval through host interactions', async () => {
  const sdk = fakeSdk();
  const { adapter, session, out } = await openSession(sdk, { permissionModeId: 'plan' });
  const q = await startTurn(sdk, session, 'turn-1');
  assert.equal(q.options.permissionMode, 'plan');
  const ask = (tool, input, extra = {}) => q.options.canUseTool(tool, input, { signal: new AbortController().signal, toolUseID: `use-${tool}`, requestId: `req-${tool}`, ...extra });

  const question = ask('AskUserQuestion', { questions: [{ question: 'Which DB?', header: 'DB', multiSelect: false, options: [{ label: 'SQLite', description: '' }, { label: 'Postgres', description: '' }] }] });
  const asked = await out.until(output => output.kind === 'interaction');
  assert.equal(asked.interaction.title, 'DB');
  assert.equal(unwrap(await session.execute({ type: 'interaction.respond', interactionId: asked.interaction.interactionId, response: { type: 'question', answers: { 'question-1': ['Postgres'] } } })).accepted, true);
  assert.deepEqual((await question).updatedInput.answers, { 'Which DB?': 'Postgres' });

  const plan = ask('ExitPlanMode', { plan: 'Step 1' });
  const review = await out.until(output => output.kind === 'interaction');
  assert.deepEqual(review.interaction.questions[0].options.map(option => option.value), ['stay', 'approve']);
  unwrap(await session.execute({ type: 'interaction.respond', interactionId: review.interaction.interactionId, response: { type: 'question', answers: { 'plan-decision': ['approve'] } } }));
  assert.equal((await plan).behavior, 'allow');

  const suggestions = [{ type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'Bash' }] }];
  const approval = ask('Bash', { command: 'rm x' }, { title: 'Run rm x', suggestions });
  const approve = await out.until(output => output.kind === 'interaction');
  assert.deepEqual(approve.interaction.actions.map(action => action.id), ['allowOnce', 'allowForSession', 'deny']);
  const invalid = await session.execute({ type: 'interaction.respond', interactionId: approve.interaction.interactionId, response: { type: 'approval', actionId: 'allowAlways' } });
  assert.equal(invalid.ok, false);
  unwrap(await session.execute({ type: 'interaction.respond', interactionId: approve.interaction.interactionId, response: { type: 'approval', actionId: 'allowForSession' } }));
  assert.deepEqual((await approval).updatedPermissions, suggestions);

  // Approving the plan makes Claude Code leave plan mode; the host sees the native mode.
  q.push({ type: 'system', subtype: 'status', permissionMode: 'default' });
  const changed = await out.until(output => eventOf('session.state.changed')(output) && output.event.state.effectivePermissionModeId === 'default');
  assert.equal(changed.event.state.effectivePermissionModeId, 'default');
  q.push(result({}));
  await out.until(eventOf('turn.completed'));
  await adapter.close();
});

test('cancellation interrupts the native turn and completes it as cancelled', async () => {
  const sdk = fakeSdk();
  const { adapter, session, out } = await openSession(sdk);
  const q = await startTurn(sdk, session, 'turn-1');
  q.push({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } } });
  unwrap(await session.execute({ type: 'turn.cancel', turnId: 'turn-1' }));
  assert.deepEqual(q.calls, ['interrupt']);
  q.push({ type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming' });
  const done = await out.until(eventOf('turn.completed'));
  assert.deepEqual(done.event.outcome, { status: 'cancelled', reason: 'aborted_streaming' });
  assert.equal(out.seen.filter(eventOf('item.completed'))[0].event.snapshot.item.text, 'partial');
  await adapter.close();
});

test('a reopened session keeps only the context reading: Claude Code counts usage per native process', async () => {
  const sdk = fakeSdk();
  const adapter = new ClaudeCodeAdapter({ environment, command: process.execPath, queryFactory: sdk.factory });
  const nativeRef = { harnessId: 'claude-code', nativeSessionId: '00000000-0000-4000-8000-000000000001', formatVersion: 1 };
  const session = unwrap(await adapter.open({ kind: 'resume', cwd: '/workspace', nativeRef,
    usage: { inputTokens: 5000, cachedInputTokens: 4000, outputTokens: 300, contextUsedTokens: 5000, contextWindowTokens: 200000 } }));
  assert.deepEqual(session.initialUsage, { contextUsedTokens: 5000, contextWindowTokens: 200000 });
  assert.equal(session.initialState.nativeRef.nativeSessionId, nativeRef.nativeSessionId);
  const out = reader(session);
  const q = await startTurn(sdk, session, 'turn-1');
  assert.equal(q.options.resume, nativeRef.nativeSessionId);
  q.push(result({ modelUsage: { m: { inputTokens: 7, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } }));
  await out.until(eventOf('turn.completed'));
  const usage = out.seen.filter(eventOf('session.usage.changed')).at(-1).event.usage;
  assert.equal(usage.inputTokens, 7);
  assert.equal(usage.contextUsedTokens, 5000);
  await session.refreshUsage();
  const refreshed = await out.until(output => eventOf('session.usage.changed')(output) && output.event.usage.contextUsedTokens === 40);
  assert.equal(refreshed.event.usage.contextWindowTokens, 200);
  await adapter.close();
});

test('live configuration goes to the native process; model and thinking wait for the turn to end', async () => {
  const sdk = fakeSdk();
  const { adapter, session } = await openSession(sdk);
  const q = await startTurn(sdk, session, 'turn-1');
  assert.equal((await session.execute({ type: 'model.select', model: { id: 'claude-model-v1.b3B1cw' } })).error?.code, 'sessionBusy');
  unwrap(await session.execute({ type: 'permissionMode.select', permissionModeId: 'acceptEdits' }));
  q.push(result({}));
  await tick();
  unwrap(await session.execute({ type: 'model.select', model: { id: 'claude-model-v1.b3B1cw' } }));
  unwrap(await session.execute({ type: 'thinking.select', thinkingOptionId: 'high' }));
  assert.deepEqual(q.calls, [['permission', 'acceptEdits'], ['setModel', 'opus'], ['flags', { alwaysThinkingEnabled: true, effortLevel: 'high' }]]);
  await adapter.close();
});

test('inspection exposes models, thinking and permission catalogs, and plan-limit quota', async () => {
  const sdk = fakeSdk();
  const adapter = new ClaudeCodeAdapter({ environment, command: process.execPath, queryFactory: sdk.factory });
  const inspection = await adapter.inspect({ cwd: '/workspace' });
  assert.equal(inspection.status, 'ready');
  assert.deepEqual(inspection.catalog.models.map(model => model.label), ['Default', 'Opus']);
  assert.equal(inspection.catalog.thinkingOptions.length, 7);
  assert.deepEqual(inspection.permissionModes.modes.map(mode => mode.id), ['plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions']);
  assert.equal(await adapter.inspect({ cwd: '/workspace' }), await adapter.inspect({ cwd: '/workspace' }));
  assert.deepEqual(await adapter.inspectAccount(), { email: 'user@example.com', plan: 'max',
    credits: { usedPercent: 12, periodType: 'five_hour', resetsAt: '2026-09-16T00:00:00Z', productUsage: [{ product: '7-day window', usagePercent: 40 }] } });
  const missing = new ClaudeCodeAdapter({ environment: { PATH: '/nonexistent' }, command: '/nonexistent/claude', queryFactory: sdk.factory });
  assert.equal((await missing.inspect({ cwd: '/workspace' })).status, 'notInstalled');
  await adapter.close();
});


test('public thinking summaries survive snapshots without duplicating streamed text', async () => {
  const sdk = fakeSdk();
  const { adapter, session, out } = await openSession(sdk);
  try {
    const q = await startTurn(sdk, session, 'summaries');
    assert.deepEqual(q.options.thinking, { type: 'adaptive', display: 'summarized' });
    const stream = event => q.push({ type: 'stream_event', parent_tool_use_id: null, event });
    stream({ type: 'message_start', message: { id: 'streamed' } });
    stream({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'Checking' } });
    q.push(assistant('streamed', [{ type: 'thinking', thinking: 'Checking files' }]));
    q.push(assistant('streamed', [{ type: 'thinking', thinking: 'Checking files' }]));
    q.push(assistant('snapshot', [{ type: 'thinking', thinking: 'Reviewing tests' }]));
    q.push(assistant('snapshot', [{ type: 'thinking', thinking: 'Reviewing tests' }]));
    stream({ type: 'message_start', message: { id: 'different' } });
    stream({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'Public streamed summary' } });
    q.push(assistant('different', [{ type: 'thinking', thinking: 'Different snapshot' }]));
    q.push(assistant('hidden', [{ type: 'redacted_thinking', data: 'opaque' }, { type: 'thinking', thinking: '' }]));
    q.push(result({}));
    assert.equal((await out.until(eventOf('turn.completed'))).event.outcome.status, 'succeeded');
    const summaries = out.seen.filter(eventOf('item.completed')).map(o => o.event.snapshot.item).filter(i => i.type === 'reasoning');
    assert.deepEqual(summaries.map(i => i.text), ['Checking files', 'Reviewing tests', 'Public streamed summary']);
  } finally { await adapter.close(); }
});


test('Claude accepts image-only input and appends steering to its active native input stream', async () => {
  const sdk=fakeSdk(), {adapter,session,out}=await openSession(sdk);
  try {
    unwrap(await session.execute({type:'turn.start',turnId:'images',input:[{type:'image',mimeType:'image/png',base64Data:'aGVsbG8='}]}));
    await tick();const q=sdk.queries.at(-1);
    assert.equal(q.prompts[0].message.content[0].source.media_type,'image/png');
    unwrap(await session.steer([{type:'text',text:'Look at the corner'}]));await tick();
    assert.equal(q.prompts[1].message.content[0].text,'Look at the corner');
    q.push(result({}));await tick();
    q.push(assistant('steered',[{type:'text',text:'Steering handled'}]));q.push(result({}));
    await out.until(eventOf('turn.completed'));
    assert.ok(out.seen.filter(eventOf('item.completed')).some(o=>o.event.snapshot.item.text==='Steering handled'));
    assert.equal((await session.steer([{type:'text',text:'late'}])).ok,false);
  } finally {await adapter.close();}
});
