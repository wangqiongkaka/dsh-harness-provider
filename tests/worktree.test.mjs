import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context, Service } from '@deepseek-ai/cordis';
import Typert from '@deepseek-ai/dsh-typert-registry';
import Agents from '@deepseek-ai/dsh-agent';
import Loop from '@deepseek-ai/dsh-agent-loop';
import Llm, { createUserMessage } from '@deepseek-ai/dsh-llm';
import Sessions from '@deepseek-ai/dsh-session';
import Projections from '@deepseek-ai/dsh-session-projection';
import Prompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import Persistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import LocalAttachments from '@deepseek-ai/dsh-attachment-local';
import { HarnessOutputChannel } from '../dist/contracts.js';
import { HarnessService, inject } from '../dist/dsh.js';
import { createWorktree, mergeWorktree, removeWorktree, worktreeChanged } from '../dist/worktree.js';

const run = promisify(execFile);
const git = async (cwd, ...args) => (await run('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args])).stdout.trim();
async function repository(root) {
  const repo = join(root, 'repo');
  await mkdir(join(repo, 'sub'), { recursive: true });
  await git(repo, 'init', '-q');
  await writeFile(join(repo, 'a.txt'), 'one\ntwo\nthree\nfour\nfive\n');
  await writeFile(join(repo, 'sub', 'keep.txt'), 'keep\n');
  await writeFile(join(repo, '.gitignore'), 'ignored.txt\n');
  await git(repo, 'add', '-A'); await git(repo, 'commit', '-q', '-m', 'init');
  return realpath(repo);
}

test('a worktree starts from uncommitted work and merges back three-way as uncommitted edits; conflicts apply nothing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-worktree-test-'));
  try {
    const repo = await repository(root);
    await writeFile(join(repo, 'a.txt'), 'one-user\ntwo\nthree\nfour\nfive\n');
    await writeFile(join(repo, 'new.txt'), 'untracked\n');
    await writeFile(join(repo, 'ignored.txt'), 'secret\n');
    await git(repo, 'add', 'new.txt');
    const head = await git(repo, 'rev-parse', 'HEAD'), staged = await git(repo, 'diff', '--cached', '--name-only');
    const worktree = await createWorktree(join(repo, 'sub'), join(root, 'worktrees', 'session-a'));
    assert.equal(worktree.cwd, join(root, 'worktrees', 'session-a', 'sub'), 'the Harness works in the matching subdirectory');
    assert.equal(await readFile(join(worktree.path, 'a.txt'), 'utf8'), 'one-user\ntwo\nthree\nfour\nfive\n');
    assert.ok(existsSync(join(worktree.path, 'new.txt')));
    assert.ok(!existsSync(join(worktree.path, 'ignored.txt')), 'ignored files stay out of the snapshot');
    assert.equal(await worktreeChanged(worktree), false);
    // The delegated session commits one edit and leaves others uncommitted; the user keeps working meanwhile.
    await writeFile(join(worktree.path, 'a.txt'), 'one-user\ntwo\nthree\nfour\nfive-child\n');
    await git(worktree.path, 'commit', '-q', '-am', 'child');
    await writeFile(join(worktree.path, 'child.txt'), 'from child\n');
    await rm(join(worktree.path, 'new.txt'));
    assert.equal(await worktreeChanged(worktree), true);
    await writeFile(join(repo, 'a.txt'), 'one-user\ntwo\nthree-user\nfour\nfive\n');
    assert.deepEqual(await mergeWorktree(worktree), []);
    assert.equal(await readFile(join(repo, 'a.txt'), 'utf8'), 'one-user\ntwo\nthree-user\nfour\nfive-child\n');
    assert.equal(await readFile(join(repo, 'child.txt'), 'utf8'), 'from child\n');
    assert.ok(!existsSync(join(repo, 'new.txt')));
    assert.equal(await git(repo, 'rev-parse', 'HEAD'), head, 'merging creates no commit');
    assert.equal(await git(repo, 'diff', '--cached', '--name-only'), staged, 'the user index is untouched');
    await removeWorktree(worktree);
    assert.ok(!existsSync(worktree.path));
    assert.equal((await git(repo, 'worktree', 'list')).split('\n').length, 1);
    assert.equal(await git(repo, 'for-each-ref', 'refs/dsh-worktrees'), '');

    const conflicting = await createWorktree(repo, join(root, 'worktrees', 'session-b'));
    await writeFile(join(conflicting.path, 'a.txt'), 'one-child\ntwo\nthree-user\nfour\nfive-child\n');
    await writeFile(join(conflicting.path, 'other.txt'), 'other\n');
    await writeFile(join(repo, 'a.txt'), 'one-again\ntwo\nthree-user\nfour\nfive-child\n');
    assert.deepEqual(await mergeWorktree(conflicting), ['a.txt']);
    assert.equal(await readFile(join(repo, 'a.txt'), 'utf8'), 'one-again\ntwo\nthree-user\nfour\nfive-child\n');
    assert.ok(!existsSync(join(repo, 'other.txt')), 'a conflict applies none of the changes');
    assert.ok(existsSync(conflicting.path), 'the worktree is kept for the user to resolve');

    const plain = join(root, 'plain');
    await mkdir(plain);
    await assert.rejects(createWorktree(plain, join(root, 'worktrees', 'session-c')), /不是 git 仓库/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a worktree delegation runs the Harness in the checkout and asks in the child session to merge or discard', { timeout: 20000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-worktree-delegate-'));
  const ctx = new Context();
  try {
    const repo = await repository(root);
    await writeFile(join(repo, 'a.txt'), 'uncommitted\n');
    const plain = join(root, 'plain'); await mkdir(plain);
    const workspace = { id: 'workspace', path: repo, sessionIds: ['parent'] };
    const created = [], opens = [], questions = [];
    let turns = 0;
    let answer = '合并并删除 worktree';
    class Commands extends Service {
      constructor(ctx) { super(ctx, 'sessionController'); }
      async resolveAgent(id) { const agent = ctx.agents.get(id); return agent ? { agent } : { error: new Error('missing session') }; }
      async create(request) {
        created.push(request);
        const { agent } = await ctx.agents.create({ sessionId: request.sessionId, meta: { cwd: request.workspaceId ? repo : request.cwd } });
        if (request.workspaceId) workspace.sessionIds.push(agent.id);
        return { sessionId: agent.id };
      }
      async prompt() { throw new Error('unused'); } async rename() {} async fork() {} async selectModel() {} updateQueue() {}
    }
    const adapter = {
      async inspect() { return { status: 'ready', catalog: { models: [], thinkingOptions: [] }, permissionModes: { modes: [{ id: 'read-only', label: 'Read only' }, { id: 'agent', label: 'Agent' }], defaultModeId: 'agent' } }; },
      async open(input) {
        opens.push(input);
        const channel = new HarnessOutputChannel();
        return { ok: true, value: { initialState: {}, outputs: channel.outputs, async close() { channel.end(); }, async execute(command) {
          // The Harness edits files in whatever directory it was opened in.
          turns++;
          await writeFile(join(input.cwd, `${opens.length}.txt`), 'child work\n');
          channel.emit({ kind: 'event', event: { type: 'turn.completed', turnId: command.turnId, outcome: { status: 'succeeded' } } });
          return { ok: true, value: { turnId: command.turnId } };
        } } };
      }, async close() {},
    };
    await ctx.plugin(LocalAttachments, { dshHome: root });
    for (const plugin of [Llm, Sessions, Projections, Prompt, Tools, Agents, Typert]) await ctx.plugin(plugin);
    await ctx.plugin(Persistence, { root: join(root, 'sessions'), compression: 'none' });
    await ctx.plugin(Commands);
    ctx.provide('userQuestions', { async ask(request) {
      questions.push(request);
      return { answers: [{ id: 'worktree', selected: [answer] }] };
    } });
    ctx.provide('workspaceRegistry', { list: () => [workspace] });
    ctx.provide('fileUploads', { resolve: () => undefined, bindPrompt: () => undefined });
    await ctx.plugin({ inject, apply(scope) { new HarnessService(scope, join(root, 'bindings'), { codex: adapter, 'claude-code': adapter }); } });
    ctx.on('agent/pre-step', async (payload, next) => !(await ctx.harness.bindings.read(payload.agent.id)) ? { kind: 'enter', messages: [] } : next());
    await ctx.plugin(Loop, { agents: [] });
    await ctx.agents.create({ sessionId: 'parent', meta: { cwd: repo } });
    await ctx.agents.create({ sessionId: 'plain', meta: { cwd: plain } });
    const h = ctx.harness;
    const delegate = async (requestId, prompt) => {
      const { sessionId } = await h.delegateFromUser({ sessionId: 'parent', requestId, harness: 'codex', worktree: true, prompt, attachments: [] });
      await ctx.agents.get(sessionId).whenIdle();
      // The turn-end check holds this lock from the moment the turn ends.
      await h.bindings.serial(`worktree:${sessionId}`, async () => {});
      return sessionId;
    };

    const merged = await delegate('merge-me', 'Add a file');
    const path = join(root, 'bindings', 'worktrees', merged);
    assert.equal(opens[0].cwd, path, 'the Harness is opened in the worktree');
    assert.equal(ctx.agents.get(merged).session.header.cwd, repo, 'the DSH session stays in the source workspace');
    assert.ok(workspace.sessionIds.includes(merged));
    assert.equal(questions.length, 1);assert.equal(questions[0].agent.id, merged, 'the question is asked in the child session');
    assert.equal(await readFile(join(repo, '1.txt'), 'utf8'), 'child work\n');
    assert.equal(await readFile(join(repo, 'a.txt'), 'utf8'), 'uncommitted\n');
    assert.ok(!existsSync(path));
    assert.equal((await h.bindings.read(merged)).delegation.worktree.removed, true);
    assert.ok(ctx.agents.get(merged).session.snapshotEvents().some(event => event.type === 'user/message' && event.data.source.summary === 'worktree 已合并'));
    // The checkout is gone, so the session refuses further turns instead of running somewhere else.
    ctx.agents.get(merged).followup(createUserMessage({ content: [{ type: 'text', text: 'more' }], source: { kind: 'user', rpcId: 'more' } }));
    await ctx.agents.get(merged).whenIdle();
    assert.equal(turns, 1);

    answer = '暂不处理';
    const kept = await delegate('keep-me', 'Add another file');
    assert.ok(existsSync(join(root, 'bindings', 'worktrees', kept, '2.txt')));
    assert.ok(!existsSync(join(repo, '2.txt')));
    answer = '放弃改动并删除 worktree';
    await h.offerWorktreeMerge(kept);
    assert.ok(!existsSync(join(root, 'bindings', 'worktrees', kept)));
    assert.ok(!existsSync(join(repo, '2.txt')));
    assert.equal(questions.length, 3);

    const before = created.length;
    await assert.rejects(h.delegateFromUser({ sessionId: 'plain', requestId: 'not-git', harness: 'codex', worktree: true, prompt: 'x', attachments: [] }), /不是 git 仓库/);
    await assert.rejects(h.delegateFromUser({ sessionId: 'parent', requestId: 'native', harness: 'dsh', worktree: true, prompt: 'x', attachments: [] }), /仅支持 Codex/);
    assert.equal(created.length, before, 'a rejected worktree leaves no session behind');
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); }
});
