import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import Agents from '@deepseek-ai/dsh-agent';
import Loop from '@deepseek-ai/dsh-agent-loop';
import Llm from '@deepseek-ai/dsh-llm';
import Sessions, { SessionId } from '@deepseek-ai/dsh-session';
import Projections from '@deepseek-ai/dsh-session-projection';
import Prompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import Jobs from '@deepseek-ai/dsh-jobs-local';
import { BackgroundJobs } from '../dist/background-jobs.js';

async function fixture() {
  const ctx = new Context(), root = await mkdtemp(join(tmpdir(), 'harness-jobs-'));
  for (const plugin of [Llm, Sessions, Projections, Prompt, Tools, Agents]) await ctx.plugin(plugin);
  await ctx.plugin(Loop, { agents: [] });
  await ctx.plugin(Jobs, { pumpPollMs: 5 });
  ctx.jobs.attachController('test');
  const { agent } = await ctx.agents.create({ sessionId: SessionId('jobs-test'), meta: { cwd: root } });
  const events = [], stops = [];
  ctx.jobs.events.subscribe({ owners: 'all' }, event => events.push(event));
  const bridge = new BackgroundJobs(ctx, agent, { async stopBackgroundTask(id) { stops.push(id); return { ok: true, value: { stopped: true } }; } });
  return { ctx, root, agent, bridge, events, stops, close: async () => { bridge.close(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); } };
}
const task = fields => ({ id: 'native-task', sessionId: 'native-session', name: '运行测试', command: 'npm test', toolCallId: 'native-call', status: 'running', ...fields });

test('native tasks use the host roster, stream output once, retain exit codes and suppress duplicate completion notices', async () => {
  const f = await fixture();
  try {
    f.bridge.update(task({ output: 'start\n' }));
    const [row] = f.ctx.jobs.list(f.agent.id);
    assert.equal(row.owner, f.agent.id);
    assert.equal(row.kind, 'bash');
    assert.equal(row.label, 'npm test');
    assert.equal(f.ctx.jobs.list('other-session').length, 0);
    f.bridge.update(task({ status: 'paused' }));
    assert.equal(f.ctx.jobs.get(row.id, f.agent.id).progress, '已暂停');
    f.bridge.update(task({ output: 'start\ndone\n' }));
    assert.ok(!f.ctx.jobs.get(row.id, f.agent.id).progress);
    f.bridge.update(task({ status: 'completed', output: 'start\ndone\n', exitCode: 0 }));
    const result = await f.ctx.jobs.wait(row.id, 1000, f.agent.id);
    assert.equal(result.status, 'completed');
    assert.equal(result.detail, 'exit code: 0');
    assert.ok(result.finishedAt >= result.startedAt);
    assert.equal(f.ctx.jobs.readAt(row.id, 0, f.agent.id).chunks.map(chunk => chunk.text).join(''), 'start\ndone\n');
    assert.equal(f.events.find(event => event.type === 'settled').awaited, true);
    f.bridge.update(task({ status: 'completed', exitCode: 0 }));
    assert.equal(f.ctx.jobs.list(f.agent.id).length, 1);
  } finally { await f.close(); }
});

test('human stop addresses the native task; failures and a lost harness process settle the host records', async () => {
  const f = await fixture();
  try {
    f.bridge.update(task({}));
    const [row] = f.ctx.jobs.list(f.agent.id);
    f.ctx.jobs.kill(row.id, f.agent.id, 'cancelled by the user');
    await Promise.resolve();
    assert.deepEqual(f.stops, ['native-task']);
    assert.equal(f.ctx.jobs.get(row.id, f.agent.id).status, 'stopping');
    f.bridge.update(task({ status: 'stopped' }));
    assert.equal((await f.ctx.jobs.wait(row.id, 1000, f.agent.id)).status, 'killed');
    f.bridge.update(task({ id: 'failed', status: 'completed', exitCode: 2 }));
    const failed = f.ctx.jobs.list(f.agent.id).find(job => job.id !== row.id);
    assert.equal((await f.ctx.jobs.wait(failed.id, 1000, f.agent.id)).detail, 'exit code: 2');
    assert.equal(f.ctx.jobs.get(failed.id, f.agent.id).status, 'failed');
    f.bridge.update(task({ id: 'orphan' }));
    const orphan = f.ctx.jobs.list(f.agent.id).at(-1);
    f.bridge.close();
    assert.equal((await f.ctx.jobs.wait(orphan.id, 1000, f.agent.id)).status, 'failed');
  } finally { await f.close(); }
});

test('Claude task logs arrive after spawn, retain UTF-8 across reads and drain before settlement', async () => {
  const f = await fixture();
  try {
    const outputFilePath = join(f.root, 'task.output');
    f.bridge.update(task({ outputFilePath }));
    const [row] = f.ctx.jobs.list(f.agent.id);
    const bytes = Buffer.from('开始\n');
    await writeFile(outputFilePath, bytes.subarray(0, 2));
    await new Promise(resolve => setTimeout(resolve, 20));
    await appendFile(outputFilePath, bytes.subarray(2));
    await new Promise(resolve => setTimeout(resolve, 20));
    await appendFile(outputFilePath, '结束\n[exited with code 7]\n');
    f.bridge.update(task({ outputFilePath, status: 'failed', exitCode: 0 }));
    const ended = await f.ctx.jobs.wait(row.id, 1000, f.agent.id);
    assert.equal(ended.detail, 'exit code: 7', 'Bash submission success is not the background process exit code');
    assert.equal(f.ctx.jobs.readAt(row.id, 0, f.agent.id).chunks.map(chunk => chunk.text).join(''), '开始\n结束\n[exited with code 7]\n');
    assert.deepEqual(f.ctx.jobs.get(row.id, f.agent.id).output.spillPaths, [outputFilePath]);
  } finally { await f.close(); }
});
