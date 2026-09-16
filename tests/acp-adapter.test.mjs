import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AcpAdapter, modelRef } from '../dist/acp-adapter.js';

// A stateful ACP agent written with the official SDK: its history survives across processes through a JSON file so
// session/load can replay it, and every host answer it receives is checked before the turn ends.
// The peer runs from the session's cwd, so the SDK is addressed by absolute URL.
const peer = `
import { agent, ndJsonStream } from '${import.meta.resolve('@agentclientprotocol/sdk')}';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
const history = process.env.PEER_HISTORY;
const load = () => { try { return JSON.parse(readFileSync(history, 'utf8')); } catch { return []; } };
const save = entries => writeFileSync(history, JSON.stringify(entries));
const note = value => appendFileSync(process.env.PEER_LOG, JSON.stringify(value) + '\\n');
let ctx, sessionId = 'native-session', current = { mode: 'agent', model: 'gpt-5.5', effort: 'high' }, cancelled = false, steered;
const options = () => [
  { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: current.mode, options: [{ value: 'read-only', name: 'Ask' }, { value: 'agent', name: 'Approve for me' }, { value: 'agent-full-access', name: 'Full access', _meta: { kind: 'full_access' } }] },
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: current.model, options: [{ value: 'gpt-5.5', name: 'GPT-5.5' }, { value: 'gpt-5.5-mini', name: 'Mini' }, { value: 'opus[1m]', name: 'Opus' }], _meta: { jetbrains: { air: { version: 1, recommendedValue: 'gpt-5.5-mini' } } } },
  { id: 'reasoning_effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: current.effort, options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
  { id: 'fast-mode', name: 'Fast', category: 'model_config', type: 'boolean', currentValue: false },
];
const opened = () => ({ modes: { currentModeId: current.mode, availableModes: [{ id: 'read-only', name: 'Ask', _meta: { kind: 'standard' } }, { id: 'agent', name: 'Approve for me' }, { id: 'agent-full-access', name: 'Full access', _meta: { kind: 'full_access' } }] },
  configOptions: options(), models: { availableModels: [{ modelId: 'gpt-5.5[low]', name: '' }, { modelId: 'gpt-5.5[high]', name: '' }, { modelId: 'gpt-5.5-mini[low]', name: '' }], currentModelId: 'gpt-5.5[high]' } });
const update = (update) => ctx.notify('session/update', { sessionId, update });
const commands = () => update({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: '$probe-skill', description: 'probe', input: null }, { name: 'status', description: 'Show status', input: { hint: 'none' } }] });
let counter = 0;
const app = agent({ name: 'peer' })
  .onRequest('initialize', ({ params, client }) => { ctx = client; note({ initialize: params.clientCapabilities }); return { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true }, sessionCapabilities: { fork: {}, resume: {}, close: {} } }, authMethods: [], _meta: { steering: { supported: true } } }; })
  .onRequest('session/new', async ({ params, client }) => { ctx = client; note({ new: params }); if (params._meta?.systemPrompt?.append !== 'PREFIX') process.exit(21); setTimeout(commands, 10); return { sessionId, ...opened() }; })
  .onRequest('session/load', async ({ params, client }) => {
    ctx = client;
    if (params.sessionId !== sessionId) process.exit(22);
    for (const entry of load()) {
      await update({ sessionUpdate: 'user_message_chunk', messageId: entry.userId, content: { type: 'text', text: entry.input } });
      if (entry.reply) await update({ sessionUpdate: 'agent_message_chunk', messageId: entry.replyId, content: { type: 'text', text: entry.reply } });
    }
    setTimeout(commands, 10);
    return opened();
  })
  .onRequest('session/fork', async ({ params }) => { note({ fork: params._meta ?? null }); return { sessionId: 'forked-' + (params._meta?.jetbrains?.air?.fork?.messageId ?? 'all') }; })
  .onRequest('session/close', async () => ({}))
  .onRequest('session/set_config_option', async ({ params }) => { if (params.configId === 'model') current.model = params.value; else if (params.configId === 'reasoning_effort') current.effort = params.value; else if (params.configId === 'mode') current.mode = params.value; else process.exit(23); return { configOptions: options() }; })
  .onRequest('session/set_mode', async ({ params }) => { current.mode = params.modeId; await update({ sessionUpdate: 'current_mode_update', currentModeId: params.modeId }); return {}; })
  .onRequest('_session/steering', value => value, async ({ params }) => { steered = params.prompt[0].text; return { outcome: 'injected' }; })
  .onNotification('session/cancel', () => { cancelled = true; })
  .onRequest('session/prompt', async ({ params, client }) => {
    ctx = client; cancelled = false;
    const raw = params.prompt.filter(b => b.type === 'text').map(b => b.text).join('');
    note({ prompt: raw });
    const text = raw.startsWith('PREFIX ') ? raw.slice(7) : raw;
    const image = params.prompt.find(b => b.type === 'image');
    if (text.startsWith('/rename ')) return { stopReason: 'end_turn' };
    const turn = ++counter, userId = 'u' + turn, replyId = 'm' + turn;
    const entries = load();
    const reply = async body => { await update({ sessionUpdate: 'agent_message_chunk', messageId: replyId, content: { type: 'text', text: body } }); entries.push({ input: raw, userId, reply: body, replyId }); save(entries); };
    const end = usage => ({ stopReason: 'end_turn', usage: usage ?? { inputTokens: 100 * turn, outputTokens: 10 * turn, cachedReadTokens: 5 * turn, totalTokens: 115 * turn } });
    if (text === 'cancel') { entries.push({ input: raw, userId }); save(entries); while (!cancelled) await new Promise(r => setTimeout(r, 10)); return { stopReason: 'cancelled' }; }
    if (text === 'wait') { while (!steered) await new Promise(r => setTimeout(r, 10)); await reply('steered:' + steered); return end(); }
    if (text === 'approve') {
      const answer = await client.request('session/request_permission', { sessionId, toolCall: { toolCallId: 'call-1', title: 'Run npm test', kind: 'execute', status: 'pending', rawInput: { command: 'npm test' } },
        options: [{ optionId: 'allow-once', name: 'Yes', kind: 'allow_once' }, { optionId: 'allow-session', name: 'Yes, this session', kind: 'allow_always' }, { optionId: 'reject', name: 'No', kind: 'reject_once' }], _meta: { permission: { version: 1, title: 'Run command?', description: 'Reason: tests' } } });
      note({ permission: answer });
      await reply('approved:' + answer.outcome.optionId); return end();
    }
    if (text === 'form') {
      const answer = await client.request('elicitation/create', { sessionId, mode: 'form', message: 'Choose region', requestedSchema: { type: 'object', required: ['region', 'token'], properties: {
        region: { type: 'string', title: 'Region', oneOf: [{ const: 'us', title: 'US' }, { const: 'eu', title: 'EU', description: 'Europe' }] },
        features: { type: 'array', title: 'Features', items: { anyOf: [{ const: 'logs', title: 'Logs' }, { const: 'metrics', title: 'Metrics' }] } },
        token: { type: 'string', title: 'Token', _meta: { codex: { isSecret: true } } },
        question_0: { type: 'string', title: 'Pick', oneOf: [{ const: 'A', title: 'A' }, { const: 'B', title: 'B' }] },
        question_0_custom: { type: 'string', title: 'Other', _meta: { _askUserQuestionCustomAnswer: { questionId: 'question_0', isCustomAnswer: true } } },
      } } });
      note({ form: answer });
      await reply('form:' + answer.action); return end();
    }
    if (text === 'url') { const answer = await client.request('elicitation/create', { sessionId, mode: 'url', elicitationId: 'e1', message: 'Sign in', url: 'https://example.com/auth' }); note({ url: answer }); await reply('url:' + answer.action); return end(); }
    if (text === 'tool') {
      await update({ sessionUpdate: 'agent_thought_chunk', messageId: 'th1', content: { type: 'text', text: 'thinking' } });
      await update({ sessionUpdate: 'tool_call', toolCallId: 'cmd', title: 'Terminal', name: 'Bash', kind: 'execute', status: 'pending', rawInput: {} });
      await update({ sessionUpdate: 'tool_call_update', toolCallId: 'cmd', title: 'echo hi', status: 'in_progress', rawInput: { command: 'echo hi', cwd: '/tmp', description: 'Say hi' }, content: [{ type: 'content', content: { type: 'text', text: 'Say hi' } }] });
      await update({ sessionUpdate: 'tool_call_update', toolCallId: 'cmd', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'formatted hi' } }], rawOutput: { output: 'hi\\n', exitCode: 0 } });
      await update({ sessionUpdate: 'tool_call', toolCallId: 'edit', title: 'Edit a.txt', name: 'Edit', kind: 'edit', status: 'in_progress', rawInput: { file_path: '/tmp/a.txt', old_string: 'old', new_string: 'new' } });
      await update({ sessionUpdate: 'tool_call_update', toolCallId: 'edit', status: 'completed', content: [{ type: 'diff', path: '/tmp/a.txt', oldText: 'old', newText: 'new' }] });
      await update({ sessionUpdate: 'tool_call', toolCallId: 'grep', title: 'grep x', name: 'Grep', kind: 'search', status: 'completed', rawInput: { pattern: 'x', path: 'src', glob: '*.ts', output_mode: 'content' } });
      await update({ sessionUpdate: 'tool_call', toolCallId: 'ask', title: 'Pick?', name: 'AskUserQuestion', kind: 'other', status: 'in_progress', rawInput: { questions: [{ question: 'Pick?' }] } });
      await update({ sessionUpdate: 'tool_call_update', toolCallId: 'ask', status: 'completed' });
      await update({ sessionUpdate: 'tool_call', toolCallId: 'read', title: "Read file 'b.txt'", kind: 'read', status: 'completed', locations: [{ path: '/tmp/b.txt' }] });
      await update({ sessionUpdate: 'tool_call', toolCallId: 'search', title: "Search for 'foo' in src", kind: 'search', status: 'completed' });
      await update({ sessionUpdate: 'tool_call', toolCallId: 'web', title: 'Web search: acp', kind: 'search', status: 'completed', rawInput: { type: 'webSearch', id: 'web', query: 'acp', action: { type: 'search', query: 'acp' } } });
      await update({ sessionUpdate: 'tool_call', toolCallId: 'patch', title: 'Editing files', kind: 'edit', status: 'completed', content: [{ type: 'diff', path: '/tmp/c.txt', oldText: null, newText: 'c' }, { type: 'diff', path: '/tmp/d.txt', oldText: 'd0', newText: 'd1' }] });
      await update({ sessionUpdate: 'plan', entries: [{ content: 'step one', priority: 'high', status: 'in_progress' }] });
      await update({ sessionUpdate: 'compaction_update', compactionId: 'c1', status: 'in_progress' });
      await update({ sessionUpdate: 'compaction_update', compactionId: 'c1', status: 'completed' });
      await update({ sessionUpdate: 'usage_update', used: 4200, size: 200000 });
      await reply('tools done'); return end();
    }
    if (text === 'fail') {
      await update({ sessionUpdate: 'session_info_update', _meta: { codex: { error: { message: 'Reconnecting... 1/5', willRetry: true } } } });
      return { stopReason: 'end_turn', _meta: { jetbrains: { air: { version: 1, sessionFailure: { id: 'x', revision: 1, category: 'limit', severity: 'error', title: 'Usage limit reached', actions: [] } } } } };
    }
    if (image) { await reply('image:' + image.mimeType); return end(); }
    await reply('reply:' + text);
    return end();
  });
app.connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
`;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'acp-adapter-'));
  const env = { PATH: process.env.PATH, PEER_HISTORY: join(root, 'history.json'), PEER_LOG: join(root, 'log.jsonl') };
  const profile = {
    harnessId: 'codex',
    spawn: environment => ({ command: process.execPath, args: ['--input-type=module', '-e', peer], env: { ...env, ...environment } }),
    sessionMeta: () => ({ systemPrompt: { append: 'PREFIX' } }),
    firstPromptPrefix: 'PREFIX ',
    titleCommand: title => `/rename ${title}`,
    skillInvocation: command => command.name.startsWith('$') ? command.name : `/${command.name}`,
    legacyPermissionModes: { workspaceWrite: 'agent', dangerFullAccess: 'agent-full-access' },
    legacyThinkingOptions: { auto: 'high' },
    skillName: command => command.name.startsWith('$') ? command.name.slice(1) : command.name,
    inspectAccount: async () => ({ plan: 'pro', credits: { usedPercent: 40, periodType: 'five_hour' } }),
  };
  const notes = async () => (await readFile(env.PEER_LOG, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { root, profile, notes, close: () => rm(root, { recursive: true, force: true }) };
}
const value = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.value; };
async function until(iterator, type) {
  const seen = [];
  while (true) { const next = await iterator.next(); assert.equal(next.done, false); seen.push(next.value); if (next.value.kind === 'event' && next.value.event.type === type) return seen; }
}
const events = (seen, type) => seen.filter(entry => entry.kind === 'event' && entry.event.type === type).map(entry => entry.event);
const interaction = async iterator => { while (true) { const next = await iterator.next(); if (next.value.kind === 'interaction') return next.value.interaction; } };

test('inspection reads catalogs, modes and skills from a throwaway session; quota comes from the profile', { timeout: 20000 }, async () => {
  const f = await fixture();
  const adapter = new AcpAdapter({ profile: f.profile, environment: {} });
  try {
    const inspection = await adapter.inspect({ cwd: f.root });
    assert.equal(inspection.status, 'ready');
    assert.deepEqual(inspection.catalog.models.map(model => model.ref.id), ['gpt-5.5', 'gpt-5.5-mini', 'b64.b3B1c1sxbV0']);
    assert.deepEqual(inspection.catalog.models[0].supportedThinkingOptionIds, ['low', 'high']);
    assert.deepEqual(inspection.catalog.models[1].supportedThinkingOptionIds, ['low']);
    assert.equal(inspection.catalog.models[2].supportedThinkingOptionIds, undefined);
    assert.equal(inspection.catalog.defaultModel.id, 'gpt-5.5-mini'); // AIR recommended value beats the current value
    assert.equal(inspection.catalog.defaultThinkingOptionId, 'high');
    assert.deepEqual(inspection.permissionModes.modes.map(mode => [mode.id, mode.dangerous === true]), [['read-only', false], ['agent', false], ['agent-full-access', true]]);
    assert.equal(inspection.permissionModes.defaultModeId, 'agent');
    assert.deepEqual(inspection.capabilities, { configuration: { selectModel: true, selectThinkingOption: true, selectPermissionMode: true, permissionModeScope: 'live' }, history: { fork: true, forkAcrossCwd: false, rollbackLastTurn: true } });
    assert.deepEqual(await adapter.listSkills({ cwd: f.root }), [{ name: 'probe-skill', description: 'probe', modelInvocable: true }, { name: 'status', description: 'Show status <none>', modelInvocable: true }]);
    assert.equal((await adapter.inspectAccount()).plan, 'pro');
    assert.equal((await f.notes()).find(note => note.initialize).initialize.elicitation.form !== undefined, true);
  } finally { await adapter.close(); await f.close(); }
});

test('turns stream text, apply hints, steer, cancel, and carry cumulative usage and context', { timeout: 20000 }, async () => {
  const f = await fixture();
  const adapter = new AcpAdapter({ profile: f.profile, environment: {} });
  try {
    const session = value(await adapter.open({ kind: 'create', cwd: f.root, model: modelRef('opus[1m]'), thinkingOptionId: 'auto', permissionModeId: 'dangerFullAccess', usage: { inputTokens: 1000, outputTokens: 100, cachedInputTokens: 0, cacheWriteInputTokens: 0 } }));
    assert.equal(session.initialState.nativeRef.nativeSessionId, 'native-session');
    assert.equal(session.initialState.effectiveModel.id, 'b64.b3B1c1sxbV0');
    assert.equal(session.initialState.effectivePermissionModeId, 'agent-full-access');
    assert.equal(session.initialState.effectiveThinkingOptionId, 'high');
    assert.deepEqual(await session.listSkills(), [{ name: 'probe-skill', description: 'probe', modelInvocable: true }, { name: 'status', description: 'Show status <none>', modelInvocable: true }]);
    const output = session.outputs[Symbol.asyncIterator]();
    value(await session.execute({ type: 'turn.start', turnId: 'host-1', input: [{ type: 'text', text: 'first' }] }));
    let seen = await until(output, 'turn.completed');
    assert.equal(events(seen, 'item.updated')[0].update.text, 'reply:first');
    assert.deepEqual((await f.notes()).filter(note => note.prompt).map(note => note.prompt), ['/rename first', 'PREFIX first']); // the session is named, then the prefix rides on the first prompt
    const started = events(seen, 'turn.started')[0];
    assert.match(started.nativeTurnRef.nativeTurnKey, /^[0-9a-f]{16}\.1$/);
    assert.equal(events(seen, 'turn.completed')[0].nativeTurnRef.nativeTurnKey, started.nativeTurnRef.nativeTurnKey);
    const usage = events(seen, 'session.usage.changed').at(-1).usage;
    assert.deepEqual(usage, { inputTokens: 1100, cachedInputTokens: 5, cacheWriteInputTokens: 0, outputTokens: 110, totalTokens: 1210 });
    value(await session.execute({ type: 'turn.start', turnId: 'host-2', input: [{ type: 'text', text: 'second' }] }));
    seen = await until(output, 'turn.completed');
    assert.equal(events(seen, 'item.completed')[0].snapshot.item.text, 'reply:second');
    value(await session.execute({ type: 'turn.start', turnId: 'host-2s', input: [{ type: 'text', text: '/probe-skill go\nmore' }] }));
    assert.equal(events(await until(output, 'turn.completed'), 'item.completed')[0].snapshot.item.text, 'reply:$probe-skill go\nmore');
    value(await session.execute({ type: 'turn.start', turnId: 'host-2t', input: [{ type: 'text', text: '/status now' }] }));
    assert.equal(events(await until(output, 'turn.completed'), 'item.completed')[0].snapshot.item.text, 'reply:/status now');
    value(await session.execute({ type: 'turn.start', turnId: 'host-3', input: [{ type: 'image', mimeType: 'image/png', base64Data: 'aGk=' }] }));
    assert.equal(events(await until(output, 'turn.completed'), 'item.completed')[0].snapshot.item.text, 'image:image/png');
    value(await session.execute({ type: 'turn.start', turnId: 'host-4', input: [{ type: 'text', text: 'wait' }] }));
    value(await session.steer([{ type: 'text', text: 'steer-now' }]));
    assert.equal(events(await until(output, 'turn.completed'), 'item.completed')[0].snapshot.item.text, 'steered:steer-now');
    value(await session.execute({ type: 'turn.start', turnId: 'host-5', input: [{ type: 'text', text: 'cancel' }] }));
    value(await session.execute({ type: 'turn.cancel', turnId: 'host-5' }));
    assert.equal(events(await until(output, 'turn.completed'), 'turn.completed')[0].outcome.status, 'cancelled');
    value(await session.execute({ type: 'model.select', model: modelRef('gpt-5.5-mini') }));
    value(await session.execute({ type: 'thinking.select', thinkingOptionId: 'low' }));
    value(await session.execute({ type: 'permissionMode.select', permissionModeId: 'read-only' }));
    assert.equal((await session.execute({ type: 'permissionMode.select', permissionModeId: 'bogus' })).ok, false);
    const states = [];
    while (states.length < 3) { const next = await output.next(); if (next.value.event?.type === 'session.state.changed') states.push(next.value.event.state); }
    assert.equal(states[0].effectiveModel.id, 'gpt-5.5-mini'); assert.equal(states[0].resolvedModelLabel, 'Mini');
    assert.equal(states[1].effectiveThinkingOptionId, 'low');
    assert.equal(states[2].effectivePermissionModeId, 'read-only');
    const snapshot = value(await session.readSnapshot());
    assert.deepEqual(snapshot.turns.map(turn => [turn.input[0].text, turn.outcome.status]), [['PREFIX first', 'succeeded'], ['second', 'succeeded'], ['$probe-skill go\nmore', 'succeeded'], ['/status now', 'succeeded'], ['', 'succeeded'], ['wait', 'succeeded'], ['cancel', 'unknown']]);
    await session.close();
  } finally { await adapter.close(); await f.close(); }
});

test('permissions, forms (secret + custom answers), URL steps, failures and tool activity project onto the host contract', { timeout: 20000 }, async () => {
  const f = await fixture();
  const adapter = new AcpAdapter({ profile: f.profile, environment: {} });
  try {
    const session = value(await adapter.open({ kind: 'create', cwd: f.root }));
    const output = session.outputs[Symbol.asyncIterator]();
    value(await session.execute({ type: 'turn.start', turnId: 'host-a', input: [{ type: 'text', text: 'approve' }] }));
    let pending = await interaction(output);
    assert.equal(pending.type, 'approval'); assert.equal(pending.title, 'Run command?'); assert.equal(pending.description, 'Reason: tests\nnpm test');
    assert.deepEqual(pending.actions.map(action => [action.id, action.effect]), [['allow-once', 'allowOnce'], ['allow-session', 'allowAlways'], ['reject', 'deny']]);
    assert.equal((await session.execute({ type: 'interaction.respond', interactionId: pending.interactionId, response: { type: 'approval', actionId: 'bogus' } })).ok, false);
    value(await session.execute({ type: 'interaction.respond', interactionId: pending.interactionId, response: { type: 'approval', actionId: 'allow-session' } }));
    let seen = await until(output, 'turn.completed');
    assert.equal(events(seen, 'interaction.closed')[0].reason, 'responded');
    assert.equal(events(seen, 'item.completed')[0].snapshot.item.text, 'approved:allow-session');
    value(await session.execute({ type: 'turn.start', turnId: 'host-b', input: [{ type: 'text', text: 'form' }] }));
    pending = await interaction(output);
    assert.equal(pending.type, 'question'); assert.equal(pending.title, 'Choose region');
    assert.deepEqual(pending.questions.map(question => [question.id, question.type, question.optional, question.secret ?? null, question.multiple ?? null, question.allowOther ?? null]),
      [['region', 'choice', false, null, false, false], ['features', 'choice', true, null, true, false], ['token', 'text', false, true, null, null], ['question_0', 'choice', true, null, false, true]]);
    assert.equal(pending.questions[0].options[1].description, 'Europe');
    value(await session.execute({ type: 'interaction.respond', interactionId: pending.interactionId, response: { type: 'question', answers: { region: ['eu'], features: ['logs', 'metrics'], token: ['s3cret'], question_0: ['my own answer'] } } }));
    seen = await until(output, 'turn.completed');
    assert.equal(events(seen, 'item.completed')[0].snapshot.item.text, 'form:accept');
    assert.deepEqual((await f.notes()).find(note => note.form).form, { action: 'accept', content: { region: 'eu', features: ['logs', 'metrics'], token: 's3cret', question_0_custom: 'my own answer' } });
    value(await session.execute({ type: 'turn.start', turnId: 'host-c', input: [{ type: 'text', text: 'url' }] }));
    pending = await interaction(output);
    assert.equal(pending.type, 'approval'); assert.equal(pending.description, 'https://example.com/auth');
    value(await session.execute({ type: 'interaction.respond', interactionId: pending.interactionId, response: { type: 'approval', actionId: 'decline' } }));
    assert.equal(events(await until(output, 'turn.completed'), 'item.completed')[0].snapshot.item.text, 'url:decline');
    value(await session.execute({ type: 'turn.start', turnId: 'host-d', input: [{ type: 'text', text: 'tool' }] }));
    seen = await until(output, 'turn.completed');
    const completed = events(seen, 'item.completed').map(event => event.snapshot);
    assert.deepEqual(completed.map(snapshot => snapshot.item.type), ['reasoning', 'commandExecution', ...Array(8).fill('toolExecution'), 'contextCompaction', 'agentMessage']);
    assert.deepEqual(completed[1].item, { type: 'commandExecution', itemId: 'cmd', command: 'echo hi', description: 'Say hi', cwd: '/tmp', output: 'hi\n', outputTruncated: false, exitCode: 0 });
    // Claude Code tools, Codex's described commands and bare diffs all land on DSH's own rows; AskUserQuestion is left to the question row.
    assert.deepEqual(completed.slice(2, 10).map(snapshot => [snapshot.item.toolName, snapshot.item.arguments]), [
      ['edit', { file_path: '/tmp/a.txt', old_string: 'old', new_string: 'new' }],
      ['grep', { pattern: 'x', path: 'src', include: '*.ts' }],
      ['read', { file_path: '/tmp/b.txt' }],
      ['grep', { pattern: 'foo', path: 'src' }],
      ['web_search', { queries: ['acp'] }],
      ['write', { file_path: '/tmp/c.txt', content: 'c' }],
      ['edit', { file_path: '/tmp/d.txt', old_string: 'd0', new_string: 'd1' }],
      ['todo_write', { todos: [{ content: 'step one', priority: 'high', status: 'in_progress' }] }],
    ]);
    assert.deepEqual(events(seen, 'session.usage.changed').find(event => event.usage.contextUsedTokens).usage.contextUsedTokens, 4200);
    value(await session.execute({ type: 'turn.start', turnId: 'host-e', input: [{ type: 'text', text: 'fail' }] }));
    seen = await until(output, 'turn.completed');
    assert.equal(events(seen, 'item.completed')[0].snapshot.item.text, 'Reconnecting... 1/5');
    assert.deepEqual(events(seen, 'turn.completed')[0].outcome, { status: 'failed', error: { code: 'nativeFailure', message: 'Usage limit reached', retryable: true } });
    await session.close();
  } finally { await adapter.close(); await f.close(); }
});

test('a new process resumes through session/load, rebuilds the same turn keys, and forks at a message boundary', { timeout: 20000 }, async () => {
  const f = await fixture();
  let adapter = new AcpAdapter({ profile: f.profile, environment: {} });
  let ref, keys;
  try {
    const session = value(await adapter.open({ kind: 'create', cwd: f.root }));
    ref = session.initialState.nativeRef;
    const output = session.outputs[Symbol.asyncIterator]();
    keys = [];
    for (const text of ['first', 'first', 'second']) {
      value(await session.execute({ type: 'turn.start', turnId: 'host-' + keys.length, input: [{ type: 'text', text }] }));
      keys.push(events(await until(output, 'turn.completed'), 'turn.completed')[0].nativeTurnRef.nativeTurnKey);
    }
    assert.notEqual(keys[0], keys[1]);
    await session.close();
  } finally { await adapter.close(); }
  adapter = new AcpAdapter({ profile: f.profile, environment: {} });
  try {
    assert.equal((await adapter.open({ kind: 'resume', cwd: f.root, nativeRef: { ...ref, harnessId: 'claude-code' } })).ok, false);
    const session = value(await adapter.open({ kind: 'resume', cwd: f.root, nativeRef: ref }));
    const snapshot = value(await session.readSnapshot());
    assert.deepEqual(snapshot.turns.map(turn => turn.nativeTurnRef.nativeTurnKey), keys);
    assert.deepEqual(snapshot.turns.map(turn => turn.items[0].item.text), ['reply:first', 'reply:first', 'reply:second']);
    assert.equal(value(await session.fork(keys[1])).nativeSessionId, 'forked-m2');
    assert.equal(value(await session.fork()).nativeSessionId, 'forked-all');
    assert.equal(await session.fork(null).then(result => result.value), undefined);
    assert.equal((await session.fork('missing')).ok, false);
    const output = session.outputs[Symbol.asyncIterator]();
    value(await session.execute({ type: 'turn.start', turnId: 'host-3', input: [{ type: 'text', text: 'third' }] }));
    const seen = await until(output, 'turn.completed');
    assert.equal(events(seen, 'item.completed')[0].snapshot.item.text, 'reply:third');
    assert.equal(value(await session.readSnapshot()).turns.length, 4);
    await session.close();
  } finally { await adapter.close(); await f.close(); }
});

test('an agent that exits mid-turn faults the session without leaking the turn', { timeout: 20000 }, async () => {
  const f = await fixture();
  const profile = { ...f.profile, spawn: environment => ({ command: process.execPath, args: ['--input-type=module', '-e', peer.replace("if (text === 'cancel')", "if (text === 'crash') process.exit(3);\n    if (text === 'cancel')")], env: { PATH: process.env.PATH, PEER_HISTORY: join(f.root, 'h.json'), PEER_LOG: join(f.root, 'l.jsonl'), ...environment } }) };
  const adapter = new AcpAdapter({ profile, environment: {} });
  try {
    const session = value(await adapter.open({ kind: 'create', cwd: f.root }));
    const output = session.outputs[Symbol.asyncIterator]();
    value(await session.execute({ type: 'turn.start', turnId: 'host-x', input: [{ type: 'text', text: 'crash' }] }));
    const seen = await until(output, 'session.faulted');
    assert.equal(events(seen, 'turn.completed')[0].outcome.status, 'failed');
    assert.equal(events(seen, 'session.faulted')[0].error.code, 'processExited');
    assert.equal((await output.next()).done, true);
    assert.equal((await session.execute({ type: 'turn.start', turnId: 'host-y', input: [{ type: 'text', text: 'again' }] })).ok, false);
    await session.close();
  } finally { await adapter.close(); await f.close(); }
});
