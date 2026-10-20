import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HarnessService } from '../dist/dsh.js';
import { Bindings } from '../dist/bindings.js';
import { DelegationBridge, delegationInstructions } from '../dist/delegation.js';

const exec = promisify(execFile);
const request = async (env, input) => {
  const response = await fetch(`${env.DSH_DELEGATE_ENDPOINT}/directory`, { method: 'POST',
    headers: { authorization: `Bearer ${env.DSH_DELEGATE_TOKEN}` }, body: JSON.stringify(input) });
  return { status: response.status, result: await response.json() };
};

test('directory bridge and CLI bind the caller, reject invalid paths and stay out of the agent instructions', { timeout: 10000 }, async () => {
  const calls = [];
  const bridge = new DelegationBridge(async (source, method, input) => { calls.push({ source, method, input }); return { cwd: input.path }; });
  try {
    const first = await bridge.environment('first'), second = await bridge.environment('second');
    for (const env of [first, second]) assert.deepEqual(await request(env, { path: '/work/tree' }), { status: 200, result: { cwd: '/work/tree' } });
    assert.deepEqual(calls.map(call => [call.source, call.method]), [['first', 'directory'], ['second', 'directory']]);
    for (const input of [{}, { path: '' }, { path: 'relative' }, { path: '--exec=bad' }, { path: '/work/tree', sessionId: 'other' }, null]) {
      assert.equal((await request(first, input)).status, 400);
    }
    assert.equal(calls.length, 2);
    const cli = value => exec(process.execPath, [resolve('dist/delegate-cli.mjs'), 'directory', value], { env: { ...process.env, ...first }, timeout: 3000 });
    assert.deepEqual(JSON.parse((await cli('{"path":"/work/tree"}')).stdout), { cwd: '/work/tree' });
    await assert.rejects(cli('{"path":"relative"}'), error => { assert.equal(error.code, 1); assert.ok(!(error.stdout + error.stderr).includes(first.DSH_DELEGATE_TOKEN)); return true; });
    // Agents enter a Worktree only through a new session opened there; the entry stays for the Git sidebar.
    assert.doesNotMatch(delegationInstructions(), /directory|Worktree/);
  } finally { await bridge.close(); }
});

test('switching directory preserves project, history and other sessions, and leaves failures unchanged', { timeout: 10000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'harness-directory-')));
  const original = join(root, 'original'), target = join(root, 'worktree');
  await Promise.all([mkdir(original), mkdir(target)]);
  const bindings = new Bindings(join(root, 'bindings'));
  const current = new Map(), agents = new Map();
  let available = true, background = false, rejected = false, restoreRejected = false;
  const directory = { get: session => current.get(session) ?? session.header.cwd,
    set: async (agent, path) => { if (rejected || (restoreRejected && path === original)) throw new Error('directory rejected'); current.set(agent.session, path); return path; } };
  const service = Object.create(HarnessService.prototype);
  Object.assign(service, { bindings, runner: { live: new Map() }, agent: async id => {
    const agent = agents.get(id); if (!agent) throw new Error('session unavailable'); return agent;
  } });
  try {
    for (const harness of ['codex', 'claude-code']) {
      const agent = { id: harness, session: { header: { cwd: original } }, ctx: { get: () => available ? directory : undefined } };
      agents.set(harness, agent);
      const binding = { version: 1, sessionId: harness, harness, cwd: original, locked: true,
        nativeRef: { harnessId: harness, nativeSessionId: 'native-' + harness, formatVersion: 1 }, turns: [{ turn: 1, key: 'history' }], pending: 'current-turn' };
      await bindings.write(binding);
      service.runner.live.set(harness, { session: { hasBackgroundTasks: () => background } });
      assert.deepEqual(await service.changeWorkingDirectory(harness, { path: target }), { cwd: target });
      assert.equal(directory.get(agent.session), target);
      assert.equal(agent.session.header.cwd, original);
      assert.deepEqual(await bindings.read(harness), { ...binding, cwd: target });
      assert.deepEqual(await service.changeWorkingDirectory(harness, { path: original }), { cwd: original });
      for (const input of [{ path: join(root, 'missing') }, { path: 'relative' }, { path: target, sessionId: 'other' }]) await assert.rejects(service.changeWorkingDirectory(harness, input));
      available = false;
      await assert.rejects(service.changeWorkingDirectory(harness, { path: target }), /工作目录/);
      available = true; background = true;
      await assert.rejects(service.changeWorkingDirectory(harness, { path: target }), /后台任务/);
      background = false; rejected = true;
      await assert.rejects(service.changeWorkingDirectory(harness, { path: target }), /directory rejected/);
      rejected = false;
      const write = bindings.write.bind(bindings);
      bindings.write = async value => { if (value.cwd === target) throw new Error('storage rejected'); return write(value); };
      await assert.rejects(service.changeWorkingDirectory(harness, { path: target }), /storage rejected/);
      restoreRejected = true;
      await assert.rejects(service.changeWorkingDirectory(harness, { path: target }), error => error instanceof AggregateError && error.errors.length === 2);
      restoreRejected = false;
      await directory.set(agent, original);
      bindings.write = write;
      assert.equal(directory.get(agent.session), original);
      assert.deepEqual(await bindings.read(harness), binding);
    }
    const before = await bindings.read('claude-code');
    await service.changeWorkingDirectory('codex', { path: target });
    assert.deepEqual(await bindings.read('claude-code'), before);
    assert.equal(directory.get(agents.get('claude-code').session), original);
  } finally { await rm(root, { recursive: true, force: true }); }
});
