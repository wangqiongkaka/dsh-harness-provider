import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkpoint, previewRestore, applyRestore } from '../dist/checkpoints.js';

async function fixture(t) {
 const cwd = await mkdtemp(join(tmpdir(), 'dsh-checkpoint-test-'));
 t.after(() => rm(cwd, { recursive: true, force: true }));
 const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' } });
 git('init'); await writeFile(join(cwd, 'file.txt'), 'one\ntwo\nthree\n'); git('add', '.'); git('commit', '-m', 'initial');
 return cwd;
}

test('恢复检查点时保留后续不冲突的修改', async t => {
 const cwd = await fixture(t), before = await checkpoint(cwd);
 await writeFile(join(cwd, 'file.txt'), 'ONE\ntwo\nthree\n');
 const after = await checkpoint(cwd);
 await writeFile(join(cwd, 'file.txt'), 'ONE\ntwo\nTHREE\n');
 const plan = await previewRestore(cwd, [{ before, after }]);
 assert.deepEqual(plan.conflicts, []);
 await applyRestore(cwd, plan);
 assert.equal(await readFile(join(cwd, 'file.txt'), 'utf8'), 'one\ntwo\nTHREE\n');
});

test('持久检查点在 Git 垃圾回收后仍可读取', async t => {
 const cwd = await fixture(t);
 await writeFile(join(cwd, 'file.txt'), '未提交的工作');
 const saved = await checkpoint(cwd, 'session:turn:before');
 execFileSync('git', ['-C', cwd, 'gc', '--prune=now'], { stdio: 'ignore' });
 const content = execFileSync('git', ['-C', cwd, 'show', `${saved.commit}:file.txt`], { encoding: 'utf8' });
 assert.equal(content, '未提交的工作');
});

test('恢复冲突时不改动工作区', async t => {
 const cwd = await fixture(t), before = await checkpoint(cwd);
 await writeFile(join(cwd, 'file.txt'), 'agent\ntwo\nthree\n');
 const after = await checkpoint(cwd);
 await writeFile(join(cwd, 'file.txt'), 'user\ntwo\nthree\n');
 const plan = await previewRestore(cwd, [{ before, after }]);
 assert.deepEqual(plan.conflicts, ['file.txt']);
 await assert.rejects(applyRestore(cwd, plan));
 assert.equal(await readFile(join(cwd, 'file.txt'), 'utf8'), 'user\ntwo\nthree\n');
});

test('预览后文件变化时拒绝应用', async t => {
 const cwd = await fixture(t), before = await checkpoint(cwd);
 await writeFile(join(cwd, 'file.txt'), 'agent\ntwo\nthree\n');
 const after = await checkpoint(cwd), plan = await previewRestore(cwd, [{ before, after }]);
 await writeFile(join(cwd, 'file.txt'), 'new user edit\ntwo\nthree\n');
 await assert.rejects(applyRestore(cwd, plan), /工作区已变化/);
 assert.equal(await readFile(join(cwd, 'file.txt'), 'utf8'), 'new user edit\ntwo\nthree\n');
});

test('恢复多轮时保留轮次之间和最后的独立修改', async t => {
 const cwd = await fixture(t), firstBefore = await checkpoint(cwd);
 await writeFile(join(cwd, 'file.txt'), 'ONE\ntwo\nthree\n');
 const firstAfter = await checkpoint(cwd);
 await writeFile(join(cwd, 'separate.txt'), 'user edit');
 const secondBefore = await checkpoint(cwd);
 await writeFile(join(cwd, 'file.txt'), 'ONE\nTWO\nthree\n');
 const secondAfter = await checkpoint(cwd);
 await writeFile(join(cwd, 'last.txt'), 'later edit');
 const plan = await previewRestore(cwd, [{ before: firstBefore, after: firstAfter }, { before: secondBefore, after: secondAfter }]);
 assert.deepEqual(plan.conflicts, []);
 await applyRestore(cwd, plan);
 assert.equal(await readFile(join(cwd, 'file.txt'), 'utf8'), 'one\ntwo\nthree\n');
 assert.equal(await readFile(join(cwd, 'separate.txt'), 'utf8'), 'user edit');
 assert.equal(await readFile(join(cwd, 'last.txt'), 'utf8'), 'later edit');
});

test('恢复冲突列表保留含换行的完整文件名', async t => {
 const cwd = await fixture(t), name = 'name\nwith space.txt';
 await writeFile(join(cwd, name), 'before');
 const before = await checkpoint(cwd);
 await writeFile(join(cwd, name), 'agent');
 const after = await checkpoint(cwd);
 await writeFile(join(cwd, name), 'user');
 const plan = await previewRestore(cwd, [{ before, after }]);
 assert.deepEqual(plan.conflicts, [name]);
});

test('检查点和文件恢复保留用户暂存区并忽略排除文件', async t => {
 const cwd = await fixture(t);
 await writeFile(join(cwd, '.gitignore'), 'secret.txt\n');
 await writeFile(join(cwd, 'secret.txt'), 'secret');
 await writeFile(join(cwd, 'file.txt'), 'staged');
 execFileSync('git', ['-C', cwd, 'add', 'file.txt']);
 const index = execFileSync('git', ['-C', cwd, 'write-tree'], { encoding: 'utf8' });
 await writeFile(join(cwd, 'file.txt'), 'before');
 const before = await checkpoint(cwd);
 await writeFile(join(cwd, 'file.txt'), 'after');
 const after = await checkpoint(cwd);
 assert.equal(execFileSync('git', ['-C', cwd, 'ls-tree', '-r', '--name-only', after.commit], { encoding: 'utf8' }).includes('secret.txt'), false);
 await applyRestore(cwd, await previewRestore(cwd, [{ before, after }]));
 assert.equal(execFileSync('git', ['-C', cwd, 'write-tree'], { encoding: 'utf8' }), index);
 assert.equal(await readFile(join(cwd, 'secret.txt'), 'utf8'), 'secret');
});

test('文件恢复不使用仓库自定义的外部 diff 输出', async t => {
 const cwd = await fixture(t), before = await checkpoint(cwd);
 await writeFile(join(cwd, 'file.txt'), 'after');
 const after = await checkpoint(cwd), plan = await previewRestore(cwd, [{ before, after }]);
 execFileSync('git', ['-C', cwd, 'config', 'diff.external', 'printf external']);
 await applyRestore(cwd, plan);
 assert.equal(await readFile(join(cwd, 'file.txt'), 'utf8'), 'one\ntwo\nthree\n');
});

test('文件恢复覆盖二进制、增删和符号链接', async t => {
 const cwd = await fixture(t), original = Buffer.from([0, 1, 2, 255]);
 await writeFile(join(cwd, 'data.bin'), original); await symlink('file.txt', join(cwd, 'link'));
 const before = await checkpoint(cwd);
 await writeFile(join(cwd, 'data.bin'), Buffer.from([0, 42, 43]));
 await rm(join(cwd, 'file.txt')); await writeFile(join(cwd, 'new.txt'), 'new');
 await rm(join(cwd, 'link')); await symlink('new.txt', join(cwd, 'link'));
 const after = await checkpoint(cwd);
 await applyRestore(cwd, await previewRestore(cwd, [{ before, after }]));
 assert.deepEqual(await readFile(join(cwd, 'data.bin')), original);
 assert.equal(await readFile(join(cwd, 'file.txt'), 'utf8'), 'one\ntwo\nthree\n');
 assert.equal(await readlink(join(cwd, 'link')), 'file.txt');
 await assert.rejects(readFile(join(cwd, 'new.txt')), { code: 'ENOENT' });
});

test('无法读取 Git 索引时拒绝创建不完整检查点', async t => {
 const cwd = await fixture(t);
 await rename(join(cwd, '.git', 'index'), join(cwd, '.git', 'index.backup'));
 await mkdir(join(cwd, '.git', 'index'));
 await assert.rejects(checkpoint(cwd));
});
