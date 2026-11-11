import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { AcpAdapter } from '../dist/acp-adapter.js';

// Exercise the converter shipped to users, including the build-time compatibility patch.
const bundle = await readFile(new URL('../dist/claude-agent-acp.mjs', import.meta.url), 'utf8');
const start = bundle.indexOf('function v2SessionUpdate(update) {');
const end = bundle.indexOf('function v2ChildStateUpdate(', start);
assert.ok(start >= 0 && end > start, 'Claude v2 conversion seam must exist');
const source = bundle.slice(start, end);
const translate = runInNewContext(`(${source})`);
const updates = [
 { sessionUpdate: 'async_task_spawned', asyncTaskId: 'bg-1', name: '后台命令', canStop: true, toolCallId: 'cmd-1' },
 { sessionUpdate: 'async_task_progress', asyncTaskId: 'bg-1', outputFilePath: '/tmp/bg-output', summary: '执行中' },
 { sessionUpdate: 'async_task_state_update', asyncTaskId: 'bg-1', state: 'completed' },
];
for (const update of updates) test('Claude v2 打包产物转换后台事件：' + update.sessionUpdate, () => {
 assert.equal(JSON.stringify(translate(update)), JSON.stringify({ ...update, sessionUpdate: '_' + update.sessionUpdate }));
});

test('Claude v2 后台任务启动、进度、结束后会话仍可继续', { timeout: 10000 }, async t => {
 const cwd = await mkdtemp(join(tmpdir(), 'claude-v2-background-'));
 const peer = `
import { createInterface } from 'node:readline';
const translate = ${source};
const updates = ${JSON.stringify(updates)};
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
const update = value => send({ method: 'session/update', params: { sessionId: 'native-bg', update: value } });
let turn = 0;
createInterface({ input: process.stdin }).on('line', line => {
 const { id, method } = JSON.parse(line);
 if (method === 'initialize') return send({ id, result: { protocolVersion: 2, info: { name: 'peer', version: '1' }, capabilities: {}, authMethods: [] } });
 if (method === 'session/new') return send({ id, result: { sessionId: 'native-bg', configOptions: [], availableCommands: [] } });
 if (method === 'session/close') return send({ id, result: {} });
 if (method !== 'session/prompt') return;
 const messageId = 'u-' + ++turn;
 update({ sessionUpdate: 'user_message', messageId, content: [{ type: 'text', text: '执行' }] });
 send({ id, result: { messageId } });
 if (turn === 1) for (const value of updates) update(translate(value));
 update({ sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' });
});`;
 const adapter = new AcpAdapter({ profile: { harnessId: 'claude-code', protocolVersion: 2, spawn: env => ({ command: process.execPath, args: ['--input-type=module', '-e', peer], env }) }, environment: process.env });
 t.after(async () => { await adapter.close(); await rm(cwd, { recursive: true, force: true }); });
 const opened = await adapter.open({ kind: 'create', cwd }); assert.equal(opened.ok, true);
 const session = opened.value, output = session.outputs[Symbol.asyncIterator](), tasks = [];
 for (let turn = 1; turn <= 2; turn++) {
  assert.equal((await session.execute({ type: 'turn.start', turnId: 'host-' + turn, input: [{ type: 'text', text: '执行' }] })).ok, true);
  while (true) {
   const next = await output.next(); assert.equal(next.done, false);
   const event = next.value.event;
   if (event?.type === 'session.task.changed') tasks.push(event.task);
   if (event?.type === 'turn.completed') { assert.equal(event.outcome.status, 'succeeded', JSON.stringify(event)); break; }
  }
 }
 assert.equal(tasks.length, 3);
 assert.equal(tasks[0].status, 'running');
 assert.equal(tasks[1].summary, '执行中');
 assert.equal(tasks[1].outputFilePath, '/tmp/bg-output');
 assert.equal(tasks[2].status, 'completed');
 assert.equal(session.hasBackgroundTasks(), false);
});
