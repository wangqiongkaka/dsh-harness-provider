import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AcpAdapter, modelRef } from '../dist/acp-adapter.js';
import { codexTurnOutcomes } from '../dist/acp-profiles.js';

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
let ctx, sessionId = 'native-session', current = { mode: 'agent', model: 'gpt-5.5', effort: 'high', collaboration: 'default', fast: false }, cancelled = false, steered;
const options = () => [
  { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: current.mode, options: [{ value: 'read-only', name: 'Ask' }, { value: 'agent', name: 'Approve for me' }, { value: 'agent-full-access', name: 'Full access', _meta: { kind: 'full_access' } }] },
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: current.model, options: [{ value: 'gpt-5.5', name: 'GPT-5.5' }, { value: 'gpt-5.5-mini', name: 'Mini' }, { value: 'opus[1m]', name: 'Opus' }], _meta: { jetbrains: { air: { version: 1, recommendedValue: 'gpt-5.5-mini' } } } },
  { id: 'reasoning_effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: current.effort, options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
  { id: 'collaboration_mode', name: 'Collaboration mode', category: 'collaboration_mode', type: 'select', currentValue: current.collaboration, options: [{ value: 'default', name: 'Default' }, { value: 'plan', name: 'Plan' }] },
  { id: 'fast-mode', name: 'Fast', category: 'model_config', type: 'boolean', currentValue: current.fast },
];
const opened = () => ({ modes: { currentModeId: current.mode, availableModes: [{ id: 'read-only', name: 'Ask', _meta: { kind: 'standard' } }, { id: 'agent', name: 'Approve for me' }, { id: 'agent-full-access', name: 'Full access', _meta: { kind: 'full_access' } }] },
  configOptions: options(), models: { availableModels: [{ modelId: 'gpt-5.5[low]', name: '' }, { modelId: 'gpt-5.5[high]', name: '' }, { modelId: 'gpt-5.5-mini[low]', name: '' }], currentModelId: 'gpt-5.5[high]' } });
const update = (update) => ctx.notify('session/update', { sessionId, update });
const commands = () => update({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: '$probe-skill', description: 'probe', input: null }, { name: 'status', description: 'Show status', input: { hint: 'none' } }] });
let counter = 0;
const app = agent({ name: 'peer' })
  .onRequest('initialize', ({ params, client }) => { ctx = client; note({ initialize: params.clientCapabilities, instructions: process.env.PEER_INSTRUCTIONS ?? null }); return { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true }, sessionCapabilities: { fork: {}, resume: {}, close: {} } }, authMethods: [], _meta: { steering: { supported: true } } }; })
  .onRequest('session/new', async ({ params, client }) => { ctx = client; note({ new: params }); setTimeout(commands, 10); return { sessionId, ...opened() }; })
  .onRequest('session/load', async ({ params, client }) => {
    ctx = client;
    if (params.sessionId !== sessionId) process.exit(22);
    for (const entry of load()) {
      await update({ sessionUpdate: 'user_message_chunk', messageId: entry.userId, content: { type: 'text', text: entry.input } });
      for (const replayed of entry.updates ?? []) await update(replayed);
      if (entry.reply) await update({ sessionUpdate: 'agent_message_chunk', messageId: entry.replyId, content: { type: 'text', text: entry.reply } });
    }
    setTimeout(commands, 10);
    return opened();
  })
  .onRequest('session/fork', async ({ params }) => { note({ fork: params._meta ?? null }); return { sessionId: 'forked-' + (params._meta?.jetbrains?.air?.fork?.messageId ?? 'all') }; })
  .onRequest('session/close', async () => ({}))
  .onRequest('session/set_config_option', async ({ params }) => { if (params.configId === 'model') current.model = params.value; else if (params.configId === 'reasoning_effort') current.effort = params.value; else if (params.configId === 'mode') current.mode = params.value; else if (params.configId === 'collaboration_mode') current.collaboration = params.value; else if (params.configId === 'fast-mode') current.fast = params.value; else process.exit(23); return { configOptions: options() }; })
  .onRequest('session/set_mode', async ({ params }) => { current.mode = params.modeId; await update({ sessionUpdate: 'current_mode_update', currentModeId: params.modeId }); return {}; })
  .onRequest('_session/steering', value => value, async ({ params }) => { steered = params.prompt[0].text; return { outcome: 'injected' }; })
  .onNotification('session/cancel', () => { cancelled = true; })
  .onRequest('session/prompt', async ({ params, client }) => {
    ctx = client; cancelled = false;
    const raw = params.prompt.filter(b => b.type === 'text').map(b => b.text).join('');
    note({ prompt: raw });
    const text = raw.replace('[HOST]', '');
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
    if (text === 'phases') {
      await update({ sessionUpdate: 'agent_message_chunk', messageId: replyId + '-commentary', content: { type: 'text', text: 'working' }, _meta: { codex: { phase: 'commentary' } } });
      await update({ sessionUpdate: 'agent_message_chunk', messageId: replyId, content: { type: 'text', text: 'done' }, _meta: { codex: { phase: 'final_answer' } } });
      return end();
    }
    if (text === 'codex-command') {
      await update({ sessionUpdate: 'agent_message_chunk', messageId: replyId + '-commentary', content: { type: 'text', text: '先检查当前改动。' }, _meta: { codex: { phase: 'commentary' } } });
      await update({ sessionUpdate: 'tool_call', toolCallId: 'codex-cmd', title: 'git status --short', kind: 'execute', status: 'in_progress', rawInput: { command: 'git status --short', cwd: '/tmp' } });
      await update({ sessionUpdate: 'tool_call_update', toolCallId: 'codex-cmd', status: 'completed', rawOutput: { output: '', exitCode: 0 } });
      await update({ sessionUpdate: 'agent_message_chunk', messageId: replyId, content: { type: 'text', text: '检查完成。' }, _meta: { codex: { phase: 'final_answer' } } });
      return end();
    }
    if (text === 'skill-warning') {
      await update({ sessionUpdate: 'session_info_update', _meta: { jetbrains: { air: { version: 1, sessionFailure: {
        id: sessionId + ':notice:1', revision: 1, category: 'unknown', severity: 'warning',
        title: 'Skill descriptions were shortened to fit the skills context budget. Disable unused skills or plugins to leave more room for the rest.', actions: [],
      } } } } });
      await reply('reply:' + text); return end();
    }
    if (text === 'tool') {
      await update({ sessionUpdate: 'agent_thought_chunk', messageId: 'th1', content: { type: 'text', text: 'thinking' } });
      // Claude streams command before the required description; the client must not freeze the incomplete input.
      await update({ sessionUpdate: 'tool_call', toolCallId: 'cmd', title: 'echo hi', name: 'Bash', kind: 'execute', status: 'pending', rawInput: { command: 'echo hi', cwd: '/tmp' } });
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
    if (text === 'claude-subagent') {
      // Claude Code (no native subagent sessions): the Agent call stays in the main session, the subagent's own events carry its id.
      const tag = { claudeCode: { parentToolUseId: 'agent-1' } };
      const updates = [
        { sessionUpdate: 'tool_call', toolCallId: 'agent-1', name: 'Agent', title: 'Find auth', kind: 'think', status: 'pending', rawInput: { description: 'Find auth', prompt: 'Search auth code', subagent_type: 'Explore' }, _meta: { claudeCode: { toolName: 'Agent', subagent: true } } },
        { sessionUpdate: 'agent_thought_chunk', messageId: 'sub-th', content: { type: 'text', text: 'looking' }, _meta: tag },
        { sessionUpdate: 'agent_message_chunk', messageId: 'sub-m', content: { type: 'text', text: 'Searching ' }, _meta: tag },
        { sessionUpdate: 'agent_message_chunk', messageId: 'sub-m', content: { type: 'text', text: 'now' }, _meta: tag },
        { sessionUpdate: 'tool_call', toolCallId: 'sub-grep', name: 'Grep', title: 'grep auth', kind: 'search', status: 'pending', rawInput: { pattern: 'auth' }, _meta: { claudeCode: { toolName: 'Grep', parentToolUseId: 'agent-1' } } },
        { sessionUpdate: 'tool_call_update', toolCallId: 'sub-grep', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'src/auth.ts' } }], _meta: tag },
        { sessionUpdate: 'tool_call_update', toolCallId: 'agent-1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'auth lives in src/auth.ts' } }], _meta: { claudeCode: { toolName: 'Agent' } } },
      ];
      for (const entry of updates) await update(entry);
      await update({ sessionUpdate: 'agent_message_chunk', messageId: replyId, content: { type: 'text', text: 'found it' } });
      entries.push({ input: raw, userId, reply: 'found it', replyId, updates }); save(entries);
      return end();
    }
    if (text === 'codex-subagent') {
      // Codex with native subagent sessions: lifecycle on the root session, the child's own events and approvals under its id.
      const child = entry => ctx.notify('session/update', { sessionId: 'child-1', update: entry });
      await update({ sessionUpdate: 'subagent_spawned', subagentSessionId: 'child-1', name: 'explorer', task: 'Map the repo', capabilities: {} });
      await child({ sessionUpdate: 'agent_message_chunk', messageId: 'c-m', content: { type: 'text', text: 'mapping' } });
      const answer = await client.request('session/request_permission', { sessionId: 'child-1', toolCall: { toolCallId: 'c-cmd', title: 'ls', kind: 'execute', status: 'pending', rawInput: { command: 'ls' } },
        options: [{ optionId: 'yes', name: 'Yes', kind: 'allow_once' }, { optionId: 'no', name: 'No', kind: 'reject_once' }] });
      await child({ sessionUpdate: 'tool_call', toolCallId: 'c-cmd', title: 'ls', kind: 'execute', status: 'completed', rawInput: { command: 'ls' }, rawOutput: { output: 'src\\n' } });
      await update({ sessionUpdate: 'subagent_state_update', subagentSessionId: 'child-1', state: 'completed' });
      await reply('child-permission:' + (answer.outcome.optionId ?? answer.outcome.outcome)); return end();
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
    // A profile without a session instruction channel takes the Host instructions at launch (Codex's developer instructions).
    spawn: (environment, instructions) => ({ command: process.execPath, args: ['--input-type=module', '-e', peer],
      env: { ...env, ...environment, ...(instructions === undefined ? {} : { PEER_INSTRUCTIONS: 'PREFIX' + instructions }) } }),
    sessionMeta: (_kind, instructions) => ({ systemPrompt: { append: 'PREFIX' + (instructions ?? '') } }),
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
    assert.equal((await f.notes()).find(note => note.new).new._meta.systemPrompt.append, 'PREFIX');
    assert.deepEqual(inspection.catalog.models.map(model => model.ref.id), ['gpt-5.5', 'gpt-5.5-mini', 'b64.b3B1c1sxbV0']);
    assert.deepEqual(inspection.catalog.models[0].supportedThinkingOptionIds, ['low', 'high']);
    assert.deepEqual(inspection.catalog.models[1].supportedThinkingOptionIds, ['low']);
    assert.equal(inspection.catalog.models[2].supportedThinkingOptionIds, undefined);
    assert.equal(inspection.catalog.defaultModel.id, 'gpt-5.5-mini'); // AIR recommended value beats the current value
    assert.equal(inspection.catalog.defaultThinkingOptionId, 'high');
    assert.deepEqual(inspection.catalog.configOptions.map(option => [option.id, option.currentValue, option.choices?.map(choice => choice.value) ?? null]), [
      ['collaboration_mode', 'default', ['default', 'plan']], ['fast-mode', false, null],
    ]);
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
    const session = value(await adapter.open({ kind: 'create', cwd: f.root, model: modelRef('opus[1m]'), thinkingOptionId: 'auto', permissionModeId: 'dangerFullAccess',
      configValues: { collaboration_mode: 'plan', 'fast-mode': true }, usage: { inputTokens: 1000, outputTokens: 100, cachedInputTokens: 0, cacheWriteInputTokens: 0 } }));
    assert.equal(session.initialState.nativeRef.nativeSessionId, 'native-session');
    assert.equal(session.initialState.effectiveModel.id, 'b64.b3B1c1sxbV0');
    assert.equal(session.initialState.effectivePermissionModeId, 'agent-full-access');
    assert.equal(session.initialState.effectiveThinkingOptionId, 'high');
    assert.deepEqual(session.initialState.configValues, { collaboration_mode: 'plan', 'fast-mode': true });
    assert.deepEqual(await session.listSkills(), [{ name: 'probe-skill', description: 'probe', modelInvocable: true }, { name: 'status', description: 'Show status <none>', modelInvocable: true }]);
    const output = session.outputs[Symbol.asyncIterator]();
    value(await session.execute({ type: 'turn.start', turnId: 'host-1', input: [{ type: 'text', text: 'first' }, { type: 'text', text: '[HOST]' }] }));
    let seen = await until(output, 'turn.completed');
    assert.equal(events(seen, 'item.updated')[0].update.text, 'reply:first');
    assert.deepEqual((await f.notes()).filter(note => note.prompt).map(note => note.prompt), ['/rename first', 'first[HOST]']); // the session is named from the user's own block only; the prompt carries the blocks verbatim
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
    value(await session.execute({ type: 'config.select', configId: 'collaboration_mode', value: 'default' }));
    value(await session.execute({ type: 'config.select', configId: 'fast-mode', value: false }));
    assert.equal((await session.execute({ type: 'permissionMode.select', permissionModeId: 'bogus' })).ok, false);
    let state;
    while (state?.effectiveModel?.id !== 'gpt-5.5-mini' || state.effectiveThinkingOptionId !== 'low' || state.effectivePermissionModeId !== 'read-only'
      || state.configValues?.collaboration_mode !== 'default' || state.configValues?.['fast-mode'] !== false) {
      const next = await output.next(); if (next.value.event?.type === 'session.state.changed') state = next.value.event.state;
    }
    assert.equal(state.resolvedModelLabel, 'Mini');
    const snapshot = value(await session.readSnapshot());
    assert.deepEqual(snapshot.turns.map(turn => [turn.input[0].text, turn.outcome.status]), [['first[HOST]', 'succeeded'], ['second', 'succeeded'], ['$probe-skill go\nmore', 'succeeded'], ['/status now', 'succeeded'], ['', 'succeeded'], ['wait', 'succeeded'], ['cancel', 'unknown']]);
    await session.close();
  } finally { await adapter.close(); await f.close(); }
});

test('Codex message phases split messages without leaking internal labels to the host', { timeout: 20000 }, async () => {
  const f = await fixture();
  const adapter = new AcpAdapter({ profile: f.profile, environment: {} });
  try {
    const session = value(await adapter.open({ kind: 'create', cwd: f.root }));
    const output = session.outputs[Symbol.asyncIterator]();
    value(await session.execute({ type: 'turn.start', turnId: 'host-phases', input: [{ type: 'text', text: 'phases' }] }));
    const completed = events(await until(output, 'turn.completed'), 'item.completed').map(event => event.snapshot.item);
    assert.deepEqual(completed.map(item => ({ type: item.type, text: item.text, phase: item.phase })), [
      { type: 'agentMessage', text: 'working', phase: undefined },
      { type: 'agentMessage', text: 'done', phase: undefined },
    ]);
    await session.close();
  } finally { await adapter.close(); await f.close(); }
});

test('Codex reasoning summaries are hidden without hiding tools or the final reply', { timeout: 20000 }, async () => {
  const f = await fixture();
  const adapter = new AcpAdapter({ profile: { ...f.profile, showThoughts: false }, environment: {} });
  try {
    const session = value(await adapter.open({ kind: 'create', cwd: f.root }));
    const output = session.outputs[Symbol.asyncIterator]();
    value(await session.execute({ type: 'turn.start', turnId: 'host-no-thoughts', input: [{ type: 'text', text: 'tool' }] }));
    const completed = events(await until(output, 'turn.completed'), 'item.completed').map(event => event.snapshot.item);
    assert.equal(completed.some(item => item.type === 'reasoning'), false);
    assert.equal(completed.some(item => item.type === 'commandExecution'), true);
    assert.equal(completed.at(-1).text, 'tools done');
    await session.close();
  } finally { await adapter.close(); await f.close(); }
});

test('Codex command does not duplicate the preceding progress message as its description', { timeout: 20000 }, async () => {
  const f = await fixture();
  const adapter = new AcpAdapter({ profile: f.profile, environment: {} });
  try {
    const session = value(await adapter.open({ kind: 'create', cwd: f.root }));
    const output = session.outputs[Symbol.asyncIterator]();
    value(await session.execute({ type: 'turn.start', turnId: 'host-codex-command', input: [{ type: 'text', text: 'codex-command' }] }));
    const completed = events(await until(output, 'turn.completed'), 'item.completed').map(event => event.snapshot.item);
    assert.deepEqual(completed.map(item => item.type), ['agentMessage', 'commandExecution', 'agentMessage']);
    assert.equal(completed[1].description, undefined);
    await session.close();
  } finally { await adapter.close(); await f.close(); }
});

test('Codex skill context budget warning is hidden without hiding the reply', { timeout: 20000 }, async () => {
  const f = await fixture();
  const adapter = new AcpAdapter({ profile: f.profile, environment: {} });
  try {
    const session = value(await adapter.open({ kind: 'create', cwd: f.root }));
    const output = session.outputs[Symbol.asyncIterator]();
    value(await session.execute({ type: 'turn.start', turnId: 'host-skill-warning', input: [{ type: 'text', text: 'skill-warning' }] }));
    assert.deepEqual(events(await until(output, 'turn.completed'), 'item.completed').map(event => event.snapshot.item.text), ['reply:skill-warning']);
    await session.close();
  } finally { await adapter.close(); await f.close(); }
});

test('permissions, forms (secret + custom answers), URL steps, failures and tool activity project onto the host contract', { timeout: 20000 }, async () => {
  const f = await fixture();
  // An agent without a session instruction channel (Codex) gets the Host instructions at launch, never in the prompt.
  const adapter = new AcpAdapter({ profile: { ...f.profile, sessionMeta: undefined }, environment: {} });
  try {
    const session = value(await adapter.open({ kind: 'create', cwd: f.root, instructions: '[HOST]' }));
    const output = session.outputs[Symbol.asyncIterator]();
    value(await session.execute({ type: 'turn.start', turnId: 'host-a', input: [{ type: 'text', text: 'approve' }] }));
    assert.equal((await f.notes()).find(note => note.new).new._meta, undefined);
    let pending = await interaction(output);
    assert.equal(pending.type, 'approval'); assert.equal(pending.title, 'Run command?'); assert.equal(pending.description, 'Reason: tests\nnpm test');
    assert.deepEqual(pending.actions.map(action => [action.id, action.effect]), [['allow-once', 'allowOnce'], ['allow-session', 'allowAlways'], ['reject', 'deny']]);
    assert.equal((await session.execute({ type: 'interaction.respond', interactionId: pending.interactionId, response: { type: 'approval', actionId: 'bogus' } })).ok, false);
    value(await session.execute({ type: 'interaction.respond', interactionId: pending.interactionId, response: { type: 'approval', actionId: 'allow-session' } }));
    let seen = await until(output, 'turn.completed');
    assert.equal(events(seen, 'interaction.closed')[0].reason, 'responded');
    assert.equal(events(seen, 'item.completed')[0].snapshot.item.text, 'approved:allow-session');
    assert.deepEqual((await f.notes()).filter(note => note.prompt).map(note => note.prompt), ['/rename approve', 'approve']);
    assert.equal((await f.notes()).find(note => note.initialize).instructions, 'PREFIX[HOST]');
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

test('Harness subagents leave the main transcript for the sidebar: Claude Code tagged events (live and replayed) and Codex child sessions with their approvals', { timeout: 20000 }, async () => {
  const f = await fixture();
  const expected = [{ id: 'agent-1', parentId: null, name: 'Find auth', task: 'Search auth code', status: 'completed', entries: [
    { kind: 'thought', text: 'looking' }, { kind: 'message', text: 'Searching now' }, { kind: 'tool', title: 'grep auth', status: 'completed', output: 'src/auth.ts' },
  ] }];
  let adapter = new AcpAdapter({ profile: f.profile, environment: {} });
  let ref;
  try {
    const session = value(await adapter.open({ kind: 'create', cwd: f.root }));
    ref = session.initialState.nativeRef;
    const initialize = (await f.notes()).find(note => note.initialize).initialize;
    assert.equal(initialize._meta['subagent-transcript'], true);
    assert.deepEqual(initialize._meta.jetbrains.air.capabilities, ['sessionFailure', 'recommendedValue']);
    const output = session.outputs[Symbol.asyncIterator]();
    value(await session.execute({ type: 'turn.start', turnId: 'host-sub', input: [{ type: 'text', text: 'claude-subagent' }] }));
    const completed = events(await until(output, 'turn.completed'), 'item.completed').map(event => event.snapshot.item);
    assert.deepEqual(completed.map(item => [item.type, item.toolName ?? item.text]), [['toolExecution', 'Agent'], ['agentMessage', 'found it']]);
    assert.deepEqual(session.subagents(), expected);
    await session.close();
  } finally { await adapter.close(); }
  adapter = new AcpAdapter({ profile: f.profile, environment: {} });
  try {
    const session = value(await adapter.open({ kind: 'resume', cwd: f.root, nativeRef: ref }));
    assert.deepEqual(session.subagents(), expected);
    assert.deepEqual(value(await session.readSnapshot()).turns[0].items.map(snapshot => snapshot.item.type), ['toolExecution', 'agentMessage']);
    await session.close();
  } finally { await adapter.close(); await f.close(); }

  const g = await fixture();
  adapter = new AcpAdapter({ profile: { ...g.profile, nativeSubagents: true }, environment: {} });
  try {
    const session = value(await adapter.open({ kind: 'create', cwd: g.root }));
    assert.deepEqual((await g.notes()).find(note => note.initialize).initialize._meta.jetbrains.air.capabilities, ['sessionFailure', 'recommendedValue', 'nativeSubagentSessions']);
    const output = session.outputs[Symbol.asyncIterator]();
    value(await session.execute({ type: 'turn.start', turnId: 'host-codex-sub', input: [{ type: 'text', text: 'codex-subagent' }] }));
    const pending = await interaction(output);
    assert.equal(pending.title, 'ls');
    value(await session.execute({ type: 'interaction.respond', interactionId: pending.interactionId, response: { type: 'approval', actionId: 'yes' } }));
    const completed = events(await until(output, 'turn.completed'), 'item.completed').map(event => event.snapshot.item);
    assert.deepEqual(completed.map(item => item.text), ['child-permission:yes']);
    assert.deepEqual(session.subagents(), [{ id: 'child-1', parentId: null, name: 'explorer', task: 'Map the repo', status: 'completed', entries: [
      { kind: 'message', text: 'mapping' }, { kind: 'tool', title: 'ls', status: 'completed', output: 'src' },
    ] }]);
    await session.close();
  } finally { await adapter.close(); await g.close(); }
});

test('a new process resumes through session/load, rebuilds the same turn keys, and forks at a message boundary', { timeout: 20000 }, async () => {
  const f = await fixture();
  let adapter = new AcpAdapter({ profile: f.profile, environment: {} });
  let ref, keys;
  try {
    // An agent with an instruction channel (Claude Code's system prompt) keeps the Host instructions out of every prompt.
    const session = value(await adapter.open({ kind: 'create', cwd: f.root, instructions: '[HOST]' }));
    ref = session.initialState.nativeRef;
    const output = session.outputs[Symbol.asyncIterator]();
    keys = [];
    for (const text of ['first', 'first', 'second']) {
      value(await session.execute({ type: 'turn.start', turnId: 'host-' + keys.length, input: [{ type: 'text', text }] }));
      keys.push(events(await until(output, 'turn.completed'), 'turn.completed')[0].nativeTurnRef.nativeTurnKey);
    }
    assert.notEqual(keys[0], keys[1]);
    const notes = await f.notes();
    assert.equal(notes.find(note => note.new).new._meta.systemPrompt.append, 'PREFIX[HOST]');
    assert.ok(notes.filter(note => note.prompt).every(note => !note.prompt.includes('[HOST]')));
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

test('launch-time instructions keep every prompt and its replay the user\'s own, and a resumed process receives them again', { timeout: 20000 }, async () => {
  const f = await fixture();
  // Codex: the Host instructions ride on the process launch, so history replays only what the user wrote.
  const profile = { ...f.profile, sessionMeta: undefined };
  const live = async (session, output, text, turnId) => {
    value(await session.execute({ type: 'turn.start', turnId, input: [{ type: 'text', text }] }));
    return events(await until(output, 'turn.completed'), 'turn.completed')[0].nativeTurnRef.nativeTurnKey;
  };
  let adapter = new AcpAdapter({ profile, environment: {} });
  let ref;
  const keys = [];
  try {
    const session = value(await adapter.open({ kind: 'create', cwd: f.root, instructions: '[HOST]' }));
    ref = session.initialState.nativeRef;
    const output = session.outputs[Symbol.asyncIterator]();
    for (const text of ['first', 'first', 'second']) keys.push(await live(session, output, text, 'host-' + keys.length));
    assert.notEqual(keys[0], keys[1]);
    await session.close();
  } finally { await adapter.close(); }
  adapter = new AcpAdapter({ profile, environment: {} });
  try {
    const session = value(await adapter.open({ kind: 'resume', cwd: f.root, nativeRef: ref, instructions: '[HOST]' }));
    const snapshot = value(await session.readSnapshot());
    assert.deepEqual(snapshot.turns.map(turn => turn.input[0].text), ['first', 'first', 'second']);
    assert.deepEqual(snapshot.turns.map(turn => turn.nativeTurnRef.nativeTurnKey), keys);
    keys.push(await live(session, session.outputs[Symbol.asyncIterator](), 'first', 'host-3'));
    await session.close();
    assert.deepEqual((await f.notes()).filter(note => note.initialize).map(note => note.instructions), ['PREFIX[HOST]', 'PREFIX[HOST]']);
    assert.deepEqual((await f.notes()).filter(note => note.prompt && !note.prompt.startsWith('/rename')).map(note => note.prompt), ['first', 'first', 'second', 'first']);
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

test('replayed history keeps tool states and output, and only a turn that ends on the agent\'s message after its tools counts as done', { timeout: 20000 }, async () => {
  const f = await fixture();
  const bash = (id, status, extra = {}) => ({ sessionUpdate: 'tool_call', toolCallId: id, title: 'npm test', name: 'Bash', kind: 'execute', status, rawInput: { command: 'npm test', description: 'Run tests' }, ...extra });
  await writeFile(join(f.root, 'history.json'), JSON.stringify([
    { input: 'done', userId: 'h1', replyId: 'r1', reply: 'all green', updates: [bash('t1', 'pending'), { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', rawOutput: [{ type: 'text', text: 'ok 12' }] }] },
    { input: 'half', userId: 'h2', updates: [{ sessionUpdate: 'agent_message_chunk', messageId: 'r2', content: { type: 'text', text: 'running tests' } }, bash('t2', 'in_progress')] },
    { input: 'tail', userId: 'h3', updates: [bash('t3', 'completed', { rawOutput: { formatted_output: 'exit 1', exitCode: 1 } })] },
    { input: 'failed tool', userId: 'h4', replyId: 'r4', reply: 'the command failed', updates: [bash('t4', 'failed')] },
    { input: 'limit', userId: 'h5', replyId: 'r5', reply: 'partial', updates: [{ sessionUpdate: 'session_info_update', _meta: { jetbrains: { air: { version: 1, sessionFailure: { id: 'l', revision: 1, category: 'limit', severity: 'error', title: 'Usage limit reached', actions: [] } } } } }] },
    { input: 'silent', userId: 'h6' },
  ]));
  const ref = { harnessId: 'codex', nativeSessionId: 'native-session', formatVersion: 1 };
  const snapshotWith = async turnOutcomes => {
    const adapter = new AcpAdapter({ profile: { ...f.profile, ...(turnOutcomes ? { turnOutcomes } : {}) }, environment: {} });
    try { const session = value(await adapter.open({ kind: 'resume', cwd: f.root, nativeRef: ref })); try { return value(await session.readSnapshot()).turns; } finally { await session.close(); } }
    finally { await adapter.close(); }
  };
  try {
    const turns = await snapshotWith();
    assert.deepEqual(turns.map(turn => [turn.input[0].text, turn.outcome.status, turn.outcome.reason ?? turn.outcome.error?.message ?? null]), [
      ['done', 'succeeded', null],
      ['half', 'unknown', '原生记录中该轮有未完成的工具调用'],
      ['tail', 'unknown', '原生记录中该轮停在工具调用，没有收尾回复'],
      ['failed tool', 'succeeded', null],
      ['limit', 'failed', 'Usage limit reached'],
      ['silent', 'unknown', '原生记录没有该轮的回复'],
    ]);
    assert.deepEqual(turns[0].items[0], { item: { type: 'commandExecution', itemId: 't1', command: 'npm test', description: 'Run tests', output: 'ok 12', outputTruncated: false }, outcome: { status: 'succeeded' } });
    assert.equal(turns[2].items[0].item.output, 'exit 1');
    assert.equal(turns[3].items[0].outcome.status, 'failed');
    // The agent program's own record decides; a record that cannot be read changes nothing.
    const native = await snapshotWith(async id => { assert.equal(id, 'native-session'); return new Map([['h2', { status: 'cancelled', reason: 'interrupted' }], ['h3', { status: 'succeeded' }]]); });
    assert.deepEqual(native.slice(1, 3).map(turn => turn.outcome), [{ status: 'cancelled', reason: 'interrupted' }, { status: 'succeeded' }]);
    assert.equal(native[5].outcome.status, 'unknown');
    assert.equal((await snapshotWith(async () => { throw new Error('app-server unavailable'); }))[1].outcome.status, 'unknown');
  } finally { await f.close(); }
});

test('Codex turn outcomes page through app-server thread/turns/list and key each status by its user message', { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-turns-'));
  const command = join(root, 'codex');
  await writeFile(command, `#!${process.execPath}
import { createInterface } from 'node:readline';
const turn = (status, id, error = null) => ({ id: 'turn-' + id, status, error, items: [{ type: 'userMessage', id }, { type: 'agentMessage', id: 'a' + id }], itemsView: 'summary' });
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  let result = {};
  if (request.method === 'thread/turns/list') {
    if (process.argv[2] !== 'app-server' || request.params.threadId !== 'thread-1' || request.params.itemsView !== 'summary') process.exit(3);
    result = request.params.cursor === null
      ? { data: [turn('completed', 'u1'), turn('interrupted', 'u2')], nextCursor: 'page-2', backwardsCursor: null }
      : { data: [turn('failed', 'u3', { message: 'model error' }), turn('inProgress', 'u4')], nextCursor: null, backwardsCursor: null };
  }
  process.stdout.write(JSON.stringify({ id: request.id, result }) + '\\n');
}
`);
  await chmod(command, 0o755);
  try {
    const outcomes = await codexTurnOutcomes(command, { PATH: process.env.PATH }, 'thread-1');
    assert.deepEqual([...outcomes], [
      ['u1', { status: 'succeeded' }],
      ['u2', { status: 'cancelled', reason: 'Codex 原生记录：该轮已中断' }],
      ['u3', { status: 'failed', error: { code: 'nativeFailure', message: 'model error', retryable: true } }],
      ['u4', { status: 'unknown', reason: 'Codex 原生记录显示该轮仍在执行' }],
    ]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
