import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AcpAdapter } from '../dist/acp-adapter.js';
import { codexProfile, claudeProfile } from '../dist/acp-profiles.js';

test('两个生产 Harness 配置默认使用 ACP v2', () => {
 for (const profile of [codexProfile({ environment: process.env }), claudeProfile({ environment: process.env })]) assert.equal(profile.protocolVersion, 2);
});

const peer = `
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync } from 'node:fs';
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
const update = (update, sessionId = 'v2-session') => send({ method: 'session/update', params: { sessionId, update } });
let model = 'model-a', mode = 'read-only', busy = false;
const options = () => [
 { configId: 'model', name: '模型', category: 'model', type: 'select', currentValue: model, options: [{ value: 'model-a', name: '模型 A' }, { value: 'model-b', name: '模型 B' }] },
 { configId: 'mode', name: '权限', category: 'mode', type: 'select', currentValue: mode, options: [{ value: 'read-only', name: '只读' }, { value: 'agent', name: '执行' }] },
];
createInterface({ input: process.stdin }).on('line', line => {
 const { id, method, params, result } = JSON.parse(line);
 if (id === 777 && !method) {
  update({ sessionUpdate: 'agent_message_chunk', messageId: 'reply-1', content: { type: 'text', text: '选择:' + result?.outcome?.optionId } });
  update({ sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' });
  return;
 }
 if (method === 'initialize') return params.protocolVersion === 2
  ? send({ id, result: { protocolVersion: 2, info: { name: 'v2-peer', version: '1' }, capabilities: { session: { fork: {} } }, authMethods: [] } })
  : send({ id, error: { code: -32602, message: '需要 ACP v2' } });
 if (method === 'session/new') return send({ id, result: { sessionId: 'v2-session', configOptions: options(), availableCommands: [{ name: 'test-skill', description: '测试技能' }] } });
 if (method === 'session/set_config_option') {
  if (params.type !== 'id') return send({ id, error: { code: -32602, message: '需要 id 类型' } });
  if (params.configId === 'model') model = params.value;
  else if (params.configId === 'mode') mode = params.value;
  else return send({ id, error: { code: -32602, message: '未知配置' } });
  return send({ id, result: { configOptions: options() } });
 }
 if (method === 'session/resume') {
  if (params.replayFrom?.type !== 'start') return send({ id, error: { code: -32602, message: '需要完整回放' } });
  const content = JSON.parse(readFileSync(process.env.V2_HISTORY, 'utf8'));
  update({ sessionUpdate: 'user_message', messageId: 'user-1', content });
  if (content[0].text === '完整回放') {
   update({ sessionUpdate: 'user_message', messageId: 'user-1' });
   update({ sessionUpdate: 'agent_message', messageId: 'reply-1', content: [{ type: 'text', text: '旧内容' }] });
   update({ sessionUpdate: 'agent_message', messageId: 'reply-1', content: [{ type: 'text', text: '新内容' }] });
   update({ sessionUpdate: 'agent_message', messageId: 'reply-1' });
   update({ sessionUpdate: 'agent_message_chunk', messageId: 'reply-1', content: { type: 'text', text: '追加' } });
   return send({ id, result: { configOptions: [], availableCommands: [] } });
  }
  if (content[0].text === '终端' || content[0].text === '终端直接完成') {
   update({ sessionUpdate: 'terminal_update', terminalId: 'terminal-1', output: { data: Buffer.from('hello😀').toString('base64') }, exitStatus: { exitCode: 0 } });
   update({ sessionUpdate: 'tool_call_update', toolCallId: 'command-1', title: '运行', kind: 'execute', status: content[0].text === '终端' ? 'in_progress' : 'completed', rawInput: { command: 'echo test' }, content: [{ type: 'terminal', terminalId: 'terminal-1' }] });
   if (content[0].text === '终端') update({ sessionUpdate: 'tool_call_update', toolCallId: 'command-1', status: 'completed' });
  }
  update({ sessionUpdate: 'agent_message_chunk', messageId: 'reply-1', content: { type: 'text', text: '完成' } });
  update({ sessionUpdate: 'state_update', state: 'idle' });
  return send({ id, result: { configOptions: [], availableCommands: [] } });
 }
 if (method === 'session/prompt') {
  if (busy) return send({ id, error: { code: -32600, message: '上一轮仍在运行' } });
  if (params.prompt[0].text.startsWith('/rename ')) {
   busy = true;
   update({ sessionUpdate: 'user_message', messageId: 'rename-1', content: params.prompt });
   update({ sessionUpdate: 'state_update', state: 'running' });
   send({ id, result: { messageId: 'rename-1' } });
   setTimeout(() => { busy = false; update({ sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' }); }, 50);
   return;
  }
  if (process.env.V2_HISTORY) writeFileSync(process.env.V2_HISTORY, JSON.stringify(params.prompt));
  if (params.prompt[0].text === '片段') for (const content of params.prompt) update({ sessionUpdate: 'user_message_chunk', messageId: 'user-1', content });
  else update({ sessionUpdate: 'user_message', messageId: 'user-1', content: params.prompt });
  update({ sessionUpdate: 'state_update', state: 'running' });
  send({ id, result: { messageId: 'user-1' } });
  if (params.prompt[0].text === '批准') {
   setTimeout(() => send({ id: 777, method: 'session/request_permission', params: { sessionId: 'v2-session', title: '允许执行？', description: '用于验证', subject: { type: 'command', command: 'npm test', cwd: '/tmp' }, options: [{ optionId: 'yes', name: '允许', kind: 'allow_once' }, { optionId: 'no', name: '拒绝', kind: 'reject_once' }] } }), 20);
   return;
  }
  if (params.prompt[0].text === '文件改动') {
   setTimeout(() => update({ sessionUpdate: 'tool_call_update', toolCallId: 'edit-1', title: '修改文件', kind: 'edit', status: 'completed', content: [{ type: 'diff', changes: [{ operation: 'modify', path: '/tmp/a.txt ' }], patch: { format: 'git_patch', text: 'diff --git a/a.txt b/a.txt\\n-old\\n+new\\n' } }] }), 10);
   setTimeout(() => update({ sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' }), 60);
   return;
  }
  if (params.prompt[0].text === '终端') {
   const bytes = Buffer.from('😀');
   setTimeout(() => update({ sessionUpdate: 'terminal_update', terminalId: 'terminal-1', command: 'echo test', output: { data: Buffer.from('hello').toString('base64') } }), 5);
   setTimeout(() => update({ sessionUpdate: 'tool_call_update', toolCallId: 'command-1', title: '运行', kind: 'execute', status: 'in_progress', rawInput: { command: 'echo test' }, content: [{ type: 'terminal', terminalId: 'terminal-1' }] }), 10);
   setTimeout(() => update({ sessionUpdate: 'terminal_output_chunk', terminalId: 'terminal-1', data: bytes.subarray(0, 2).toString('base64') }), 15);
   setTimeout(() => update({ sessionUpdate: 'terminal_output_chunk', terminalId: 'terminal-1', data: bytes.subarray(2).toString('base64') }), 20);
   setTimeout(() => update({ sessionUpdate: 'terminal_update', terminalId: 'terminal-1', exitStatus: { exitCode: 0 } }), 25);
   setTimeout(() => update({ sessionUpdate: 'tool_call_update', toolCallId: 'command-1', status: 'completed' }), 30);
   setTimeout(() => update({ sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' }), 60);
   return;
  }
  if (params.prompt[0].text === '坏终端') {
   setTimeout(() => update({ sessionUpdate: 'terminal_output_chunk', terminalId: 'terminal-1', data: '%%%invalid' }), 10);
   setTimeout(() => update({ sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' }), 60);
   return;
  }
  if (params.prompt[0].text === '完整实时' || params.prompt[0].text === '完整思考') {
   const thought = params.prompt[0].text === '完整思考';
   const kind = thought ? 'agent_thought' : 'agent_message';
   setTimeout(() => update({ sessionUpdate: kind, messageId: 'full-1', content: [{ type: 'text', text: '旧文本' }] }), 5);
   setTimeout(() => update({ sessionUpdate: kind, messageId: 'full-1', content: [{ type: 'text', text: '新文本' }] }), 10);
   setTimeout(() => update({ sessionUpdate: kind, messageId: 'full-1' }), 15);
   setTimeout(() => update({ sessionUpdate: kind + '_chunk', messageId: 'full-1', content: { type: 'text', text: '追加' } }), 20);
   setTimeout(() => update({ sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' }), 60);
   return;
  }
  if (params.prompt[0].text === '终端直接完成') {
   setTimeout(() => update({ sessionUpdate: 'terminal_update', terminalId: 'terminal-1', output: { data: Buffer.from('hello😀').toString('base64') }, exitStatus: { exitCode: 0 } }), 5);
   setTimeout(() => update({ sessionUpdate: 'tool_call_update', toolCallId: 'command-1', title: '运行', kind: 'execute', status: 'completed', rawInput: { command: 'echo test' }, content: [{ type: 'terminal', terminalId: 'terminal-1' }] }), 10);
   setTimeout(() => update({ sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' }), 60);
   return;
  }
  if (params.prompt[0].text === '子代理' || params.prompt[0].text === 'Codex子代理' || params.prompt[0].text === '子代理未知') {
   const codex = params.prompt[0].text === 'Codex子代理';
   setTimeout(() => update(codex ? { sessionUpdate: '_subagent_update', subagentSessionId: 'child-1', name: '调查', task: '检查' } : { sessionUpdate: 'subagent_update', sessionId: 'child-1', title: '调查', description: '检查', state: { state: 'running' } }), 10);
   setTimeout(() => update({ sessionUpdate: 'agent_message_chunk', messageId: 'child-message', content: { type: 'text', text: '正在检查' } }, 'child-1'), 20);
   setTimeout(() => update(codex ? { sessionUpdate: '_subagent_update', subagentSessionId: 'child-1', state: 'completed' } : { sessionUpdate: 'subagent_update', sessionId: 'child-1', state: { state: 'idle', ...(params.prompt[0].text === '子代理未知' ? {} : { stopReason: 'end_turn' }) } }), 30);
   setTimeout(() => update({ sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' }), 60);
   return;
  }
  setTimeout(() => update({ sessionUpdate: 'agent_message_chunk', messageId: 'reply-1', content: { type: 'text', text: '完成' } }), 30);
  const value = params.prompt[0].text;
  const outcome = value === '失败' ? { stopReason: 'error', error: { code: -32001, message: '模型失败' } }
    : value === '未知' ? {} : value === '取消' ? { stopReason: 'cancelled' } : { stopReason: 'end_turn' };
  setTimeout(() => update({ sessionUpdate: 'state_update', state: 'idle', ...outcome }), 60);
  return;
 }
 if (method === 'session/close') return send({ id, result: {} });
 if (id !== undefined) send({ id, error: { code: -32601, message: 'method not found' } });
});


`;

for (const [input, expected] of [['你好', 'succeeded'], ['片段', 'succeeded'], ['失败', 'failed'], ['未知', 'failed'], ['取消', 'cancelled']]) test('ACP v2 在 idle 后结束轮次：' + input, { timeout: 10000 }, async t => {
 const cwd = await mkdtemp(join(tmpdir(), 'dsh-acp-v2-'));
 const adapter = new AcpAdapter({ profile: { harnessId: 'codex', protocolVersion: 2, spawn: env => ({ command: process.execPath, args: ['--input-type=module', '-e', peer], env }) }, environment: process.env });
 t.after(async () => { await adapter.close(); await rm(cwd, { recursive: true, force: true }); });
 const opened = await adapter.open({ kind: 'create', cwd });
 assert.equal(opened.ok, true, JSON.stringify(opened));
 const session = opened.value, output = session.outputs[Symbol.asyncIterator]();
 assert.equal((await session.execute({ type: 'turn.start', turnId: 'turn-1', input: [{ type: 'text', text: input }] })).ok, true);
 const seen = [];
 while (true) { const next = await output.next(); assert.equal(next.done, false); if (next.value.kind === 'event') { seen.push(next.value.event); if (next.value.event.type === 'turn.completed') break; } }
 assert.ok(seen.some(event => event.type === 'item.updated' && event.update.text === '完成'));
 assert.equal(seen.at(-1).outcome.status, expected);
 if (input === '失败') assert.match(seen.at(-1).outcome.error.message, /模型失败/);
 if (input === '未知') assert.equal(seen.at(-1).outcome.error.code, 'internalError');
});

test('ACP v2 技能探测读取创建会话响应中的命令', { timeout: 10000 }, async t => {
 const cwd = await mkdtemp(join(tmpdir(), 'dsh-acp-v2-'));
 const adapter = new AcpAdapter({ profile: { harnessId: 'codex', protocolVersion: 2, spawn: env => ({ command: process.execPath, args: ['--input-type=module', '-e', peer], env }) }, environment: process.env });
 t.after(async () => { await adapter.close(); await rm(cwd, { recursive: true, force: true }); });
 assert.deepEqual((await adapter.listSkills({ cwd })).map(skill => skill.name), ['test-skill']);
});

test('ACP v2 权限请求显示标题并转交用户选择', { timeout: 10000 }, async t => {
 const cwd = await mkdtemp(join(tmpdir(), 'dsh-acp-v2-'));
 const adapter = new AcpAdapter({ profile: { harnessId: 'codex', protocolVersion: 2, spawn: env => ({ command: process.execPath, args: ['--input-type=module', '-e', peer], env }) }, environment: process.env });
 t.after(async () => { await adapter.close(); await rm(cwd, { recursive: true, force: true }); });
 const opened = await adapter.open({ kind: 'create', cwd }); assert.equal(opened.ok, true);
 const session = opened.value, output = session.outputs[Symbol.asyncIterator]();
 assert.equal((await session.execute({ type: 'turn.start', turnId: 'turn-1', input: [{ type: 'text', text: '批准' }] })).ok, true);
 let pending;
 while (!pending) { const next = await output.next(); assert.equal(next.done, false); if (next.value.kind === 'interaction') pending = next.value.interaction; }
 assert.equal(pending.title, '允许执行？');
 assert.match(pending.description, /npm test/);
 assert.equal((await session.execute({ type: 'interaction.respond', interactionId: pending.interactionId, response: { type: 'approval', actionId: 'yes' } })).ok, true);
 let completed;
 while (!completed) { const next = await output.next(); assert.equal(next.done, false); if (next.value.kind === 'event' && next.value.event.type === 'turn.completed') completed = next.value.event; }
 assert.equal(completed.outcome.status, 'succeeded');
});

test('ACP v2 模型和权限模式使用配置项切换', { timeout: 10000 }, async t => {
 const cwd = await mkdtemp(join(tmpdir(), 'dsh-acp-v2-'));
 const adapter = new AcpAdapter({ profile: { harnessId: 'codex', protocolVersion: 2, spawn: env => ({ command: process.execPath, args: ['--input-type=module', '-e', peer], env }) }, environment: process.env });
 t.after(async () => { await adapter.close(); await rm(cwd, { recursive: true, force: true }); });
 const opened = await adapter.open({ kind: 'create', cwd }); assert.equal(opened.ok, true, JSON.stringify(opened));
 const session = opened.value;
 assert.equal(session.initialState.effectiveModel.id, 'model-a');
 const modelResult = await session.execute({ type: 'model.select', model: { id: 'model-b' } });
 assert.equal(modelResult.ok, true, JSON.stringify(modelResult));
 const modeResult = await session.execute({ type: 'permissionMode.select', permissionModeId: 'agent' });
 assert.equal(modeResult.ok, true, JSON.stringify(modeResult));
});

test('ACP v2 自动命名完成后才发送用户首轮', { timeout: 10000 }, async t => {
 const cwd = await mkdtemp(join(tmpdir(), 'dsh-acp-v2-'));
 const adapter = new AcpAdapter({ profile: { harnessId: 'codex', protocolVersion: 2, titleCommand: title => '/rename ' + title, spawn: env => ({ command: process.execPath, args: ['--input-type=module', '-e', peer], env }) }, environment: process.env });
 t.after(async () => { await adapter.close(); await rm(cwd, { recursive: true, force: true }); });
 const opened = await adapter.open({ kind: 'create', cwd }); assert.equal(opened.ok, true);
 const session = opened.value, output = session.outputs[Symbol.asyncIterator]();
 assert.equal((await session.execute({ type: 'turn.start', turnId: 'turn-1', input: [{ type: 'text', text: '用户首轮' }] })).ok, true);
 let completed;
 while (!completed) { const next = await output.next(); assert.equal(next.done, false); if (next.value.kind === 'event' && next.value.event.type === 'turn.completed') completed = next.value.event; }
 assert.equal(completed.outcome.status, 'succeeded');
});

test('ACP v2 文件差异保留路径、操作和补丁', { timeout: 10000 }, async t => {
 const cwd = await mkdtemp(join(tmpdir(), 'dsh-acp-v2-'));
 const adapter = new AcpAdapter({ profile: { harnessId: 'codex', protocolVersion: 2, spawn: env => ({ command: process.execPath, args: ['--input-type=module', '-e', peer], env }) }, environment: process.env });
 t.after(async () => { await adapter.close(); await rm(cwd, { recursive: true, force: true }); });
 const opened = await adapter.open({ kind: 'create', cwd }); assert.equal(opened.ok, true);
 const session = opened.value, output = session.outputs[Symbol.asyncIterator]();
 assert.equal((await session.execute({ type: 'turn.start', turnId: 'turn-1', input: [{ type: 'text', text: '文件改动' }] })).ok, true);
 const items = [];
 while (true) { const next = await output.next(); assert.equal(next.done, false); if (next.value.kind === 'event' && next.value.event.type === 'item.completed') items.push(next.value.event.snapshot.item); if (next.value.kind === 'event' && next.value.event.type === 'turn.completed') break; }
 const changed = items.find(item => item.type === 'fileChange');
 assert.deepEqual(changed?.changes, [{ path: '/tmp/a.txt ', kind: 'update', unifiedDiff: 'diff --git a/a.txt b/a.txt\n-old\n+new\n' }]);
});

for (const input of ['终端', '终端直接完成']) test('ACP v2 终端事件关联工具并保留输出与退出码：' + input, { timeout: 10000 }, async t => {
 const cwd = await mkdtemp(join(tmpdir(), 'dsh-acp-v2-'));
 const adapter = new AcpAdapter({ profile: { harnessId: 'codex', protocolVersion: 2, spawn: env => ({ command: process.execPath, args: ['--input-type=module', '-e', peer], env: { ...env, V2_HISTORY: join(cwd, 'history.json') } }) }, environment: process.env });
 t.after(async () => { await adapter.close(); await rm(cwd, { recursive: true, force: true }); });
 const opened = await adapter.open({ kind: 'create', cwd }); assert.equal(opened.ok, true);
 const session = opened.value, output = session.outputs[Symbol.asyncIterator]();
 assert.equal((await session.execute({ type: 'turn.start', turnId: 'turn-1', input: [{ type: 'text', text: input }] })).ok, true);
 const items = [];
 while (true) { const next = await output.next(); assert.equal(next.done, false); if (next.value.kind === 'event' && next.value.event.type === 'item.completed') items.push(next.value.event.snapshot.item); if (next.value.kind === 'event' && next.value.event.type === 'turn.completed') break; }
 const command = items.find(item => item.type === 'commandExecution');
 assert.equal(command?.output, 'hello😀'); assert.equal(command?.exitCode, 0);
 const nativeRef = session.initialState.nativeRef; await session.close();
 const resumed = await adapter.open({ kind: 'resume', cwd, nativeRef }); assert.equal(resumed.ok, true, JSON.stringify(resumed));
 const snapshot = await resumed.value.readSnapshot(); assert.equal(snapshot.ok, true);
 const replayed = snapshot.value.turns[0].items.find(entry => entry.item.type === 'commandExecution')?.item;
 assert.equal(replayed?.output, 'hello😀'); assert.equal(replayed?.exitCode, 0);
});

test('ACP v2 拒绝损坏的终端输出', { timeout: 10000 }, async t => {
 const cwd = await mkdtemp(join(tmpdir(), 'dsh-acp-v2-'));
 const adapter = new AcpAdapter({ profile: { harnessId: 'codex', protocolVersion: 2, spawn: env => ({ command: process.execPath, args: ['--input-type=module', '-e', peer], env }) }, environment: process.env });
 t.after(async () => { await adapter.close(); await rm(cwd, { recursive: true, force: true }); });
 const opened = await adapter.open({ kind: 'create', cwd }); assert.equal(opened.ok, true);
 const session = opened.value, output = session.outputs[Symbol.asyncIterator]();
 assert.equal((await session.execute({ type: 'turn.start', turnId: 'turn-1', input: [{ type: 'text', text: '坏终端' }] })).ok, true);
 let completed;
 while (!completed) { const next = await output.next(); assert.equal(next.done, false); if (next.value.kind === 'event' && next.value.event.type === 'turn.completed') completed = next.value.event; }
 assert.equal(completed.outcome.status, 'failed');
});

for (const input of ['完整实时', '完整思考']) test('ACP v2 完整内容替换后保留分片追加：' + input, { timeout: 10000 }, async t => {
 const cwd = await mkdtemp(join(tmpdir(), 'dsh-acp-v2-'));
 const adapter = new AcpAdapter({ profile: { harnessId: 'codex', protocolVersion: 2, spawn: env => ({ command: process.execPath, args: ['--input-type=module', '-e', peer], env }) }, environment: process.env });
 t.after(async () => { await adapter.close(); await rm(cwd, { recursive: true, force: true }); });
 const opened = await adapter.open({ kind: 'create', cwd }); assert.equal(opened.ok, true);
 const session = opened.value, output = session.outputs[Symbol.asyncIterator]();
 assert.equal((await session.execute({ type: 'turn.start', turnId: 'turn-1', input: [{ type: 'text', text: input }] })).ok, true);
 const items = [];
 while (true) { const next = await output.next(); assert.equal(next.done, false); if (next.value.kind === 'event' && next.value.event.type === 'item.completed') items.push(next.value.event.snapshot.item); if (next.value.kind === 'event' && next.value.event.type === 'turn.completed') break; }
 assert.deepEqual(items.filter(item => item.type === (input === '完整思考' ? 'reasoning' : 'agentMessage')).map(item => item.text), ['新文本追加']);
});

for (const input of ['子代理', 'Codex子代理', '子代理未知']) test('ACP v2 子代理状态和消息归属子会话：' + input, { timeout: 10000 }, async t => {
 const cwd = await mkdtemp(join(tmpdir(), 'dsh-acp-v2-'));
 const adapter = new AcpAdapter({ profile: { harnessId: 'codex', protocolVersion: 2, spawn: env => ({ command: process.execPath, args: ['--input-type=module', '-e', peer], env }) }, environment: process.env });
 t.after(async () => { await adapter.close(); await rm(cwd, { recursive: true, force: true }); });
 const opened = await adapter.open({ kind: 'create', cwd }); assert.equal(opened.ok, true);
 const session = opened.value, output = session.outputs[Symbol.asyncIterator]();
 assert.equal((await session.execute({ type: 'turn.start', turnId: 'turn-1', input: [{ type: 'text', text: input }] })).ok, true);
 while (true) { const next = await output.next(); assert.equal(next.done, false); if (next.value.kind === 'event' && next.value.event.type === 'turn.completed') break; }
 const [child] = session.subagents();
 assert.equal(child.name, '调查'); assert.equal(child.task, '检查'); assert.equal(child.status, input === '子代理未知' ? 'running' : 'completed');
 assert.equal(child.entries[0].text, '正在检查');
});

test('ACP v2 恢复会话时回放完整历史并保留轮次键', { timeout: 10000 }, async t => {
 const cwd = await mkdtemp(join(tmpdir(), 'dsh-acp-v2-'));
 const adapter = new AcpAdapter({ profile: { harnessId: 'codex', protocolVersion: 2, spawn: env => ({ command: process.execPath, args: ['--input-type=module', '-e', peer], env: { ...env, V2_HISTORY: join(cwd, 'history.json') } }) }, environment: process.env });
 t.after(async () => { await adapter.close(); await rm(cwd, { recursive: true, force: true }); });
 const opened = await adapter.open({ kind: 'create', cwd }); assert.equal(opened.ok, true);
 const session = opened.value, output = session.outputs[Symbol.asyncIterator]();
 assert.equal((await session.execute({ type: 'turn.start', turnId: 'turn-1', input: [{ type: 'text', text: '第一块' }, { type: 'text', text: '第二块' }] })).ok, true);
 let done;
 while (!done) { const next = await output.next(); assert.equal(next.done, false); if (next.value.kind === 'event' && next.value.event.type === 'turn.completed') done = next.value.event; }
 const key = done.nativeTurnRef.nativeTurnKey, nativeRef = session.initialState.nativeRef;
 await session.close();
 const resumed = await adapter.open({ kind: 'resume', cwd, nativeRef }); assert.equal(resumed.ok, true, JSON.stringify(resumed));
 const history = await resumed.value.readSnapshot(); assert.equal(history.ok, true);
 assert.equal(history.value.turns[0].nativeTurnRef.nativeTurnKey, key);
 assert.equal(history.value.turns[0].input[0].text, '第一块第二块');
});

test('ACP v2 回放完整消息替换内容并保留元数据更新前的文本', { timeout: 10000 }, async t => {
 const cwd = await mkdtemp(join(tmpdir(), 'dsh-acp-v2-'));
 const adapter = new AcpAdapter({ profile: { harnessId: 'codex', protocolVersion: 2, spawn: env => ({ command: process.execPath, args: ['--input-type=module', '-e', peer], env: { ...env, V2_HISTORY: join(cwd, 'history.json') } }) }, environment: process.env });
 t.after(async () => { await adapter.close(); await rm(cwd, { recursive: true, force: true }); });
 const opened = await adapter.open({ kind: 'create', cwd }); assert.equal(opened.ok, true);
 const session = opened.value, output = session.outputs[Symbol.asyncIterator]();
 assert.equal((await session.execute({ type: 'turn.start', turnId: 'turn-1', input: [{ type: 'text', text: '完整回放' }] })).ok, true);
 while (true) { const next = await output.next(); assert.equal(next.done, false); if (next.value.kind === 'event' && next.value.event.type === 'turn.completed') break; }
 const nativeRef = session.initialState.nativeRef; await session.close();
 const resumed = await adapter.open({ kind: 'resume', cwd, nativeRef }); assert.equal(resumed.ok, true, JSON.stringify(resumed));
 const snapshot = await resumed.value.readSnapshot(); assert.equal(snapshot.ok, true);
 assert.equal(snapshot.value.turns[0].input[0].text, '完整回放');
 assert.equal(snapshot.value.turns[0].items.find(entry => entry.item.type === 'agentMessage')?.item.text, '新内容追加');
});


