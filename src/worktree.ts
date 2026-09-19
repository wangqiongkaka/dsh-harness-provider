import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
// Snapshot commits are plumbing objects; they must not depend on the user's git identity.
const identity = { GIT_AUTHOR_NAME: 'DSH', GIT_AUTHOR_EMAIL: 'dsh@localhost', GIT_COMMITTER_NAME: 'DSH', GIT_COMMITTER_EMAIL: 'dsh@localhost' };
async function git(cwd: string, args: string[], env: Record<string, string> = {}, raw = false): Promise<string> {
  const { stdout } = await run('git', ['-C', cwd, ...args], { env: { ...process.env, ...identity, ...env }, maxBuffer: 256 * 1024 * 1024 });
  return raw ? stdout : stdout.trim();
}

/** Where a delegated session works: `path` is checked out at `base`, a snapshot of `repo`'s working tree. */
export type Worktree = { repo: string; path: string; base: string };

/** Commits the working tree (tracked changes and non-ignored new files) without touching the real index. */
async function snapshot(dir: string): Promise<string> {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-worktree-'));
  const env = { GIT_INDEX_FILE: join(temp, 'index') };
  try {
    const head = await git(dir, ['rev-parse', '--verify', '-q', 'HEAD']).catch(() => '');
    // Starting from the real index keeps its stat cache, so unchanged files are not rehashed.
    await copyFile(resolve(dir, await git(dir, ['rev-parse', '--git-path', 'index'])), env.GIT_INDEX_FILE).catch(() => {});
    await git(dir, ['add', '-A', '--', '.'], env);
    const tree = await git(dir, ['write-tree'], env);
    return await git(dir, ['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', 'DSH delegation snapshot']);
  } finally { await rm(temp, { recursive: true, force: true }); }
}

/** Checks out a snapshot of `cwd`'s repository at `path`; returns the worktree and the matching subdirectory to work in. */
export async function createWorktree(cwd: string, path: string): Promise<Worktree & { cwd: string }> {
  const real = await realpath(cwd);
  const repo = await git(real, ['rev-parse', '--show-toplevel']).catch(() => { throw new Error('工作目录不是 git 仓库，无法使用独立 worktree'); });
  const base = await snapshot(repo);
  // A retry after a crash finds the previous attempt at the same path.
  await removeWorktree({ repo, path, base });
  // The ref keeps the base reachable even if the delegated session rewrites its own history.
  await git(repo, ['update-ref', `refs/dsh-worktrees/${basename(path)}`, base]);
  await git(repo, ['worktree', 'add', '--detach', path, base]);
  return { repo, path, base, cwd: join(path, relative(repo, real)) };
}

/** Whether the worktree's content differs from its base, including commits the session made. */
export async function worktreeChanged(worktree: Worktree): Promise<boolean> {
  const [now, base] = await Promise.all([snapshot(worktree.path), git(worktree.repo, ['rev-parse', `${worktree.base}^{tree}`])]);
  return await git(worktree.path, ['rev-parse', `${now}^{tree}`]) !== base;
}

/**
 * Applies the worktree's changes to the repository's working tree as uncommitted edits, merged three-way against
 * the user's own changes since the worktree was made. Returns the conflicting paths; on conflict nothing is applied.
 */
export async function mergeWorktree(worktree: Worktree): Promise<string[]> {
  const [theirs, ours] = [await snapshot(worktree.path), await snapshot(worktree.repo)];
  let output: string;
  try { output = await git(worktree.repo, ['merge-tree', '--write-tree', '--name-only', '--no-messages', `--merge-base=${worktree.base}`, ours, theirs]); }
  catch (error) {
    const failure = error as { code?: number; stdout?: string };
    if (failure.code !== 1 || failure.stdout === undefined) throw error;
    return failure.stdout.trim().split('\n').slice(1).filter(Boolean);
  }
  const merged = output.split('\n')[0]!;
  const temp = await mkdtemp(join(tmpdir(), 'dsh-worktree-'));
  try {
    const patch = join(temp, 'changes.patch'), diff = await git(worktree.repo, ['diff', '--binary', ours, merged], {}, true);
    await writeFile(patch, diff);
    // All-or-nothing: a file the user edits after the snapshot fails the whole apply.
    if (diff) await git(worktree.repo, ['apply', '--binary', patch]);
  } finally { await rm(temp, { recursive: true, force: true }); }
  return [];
}

export async function removeWorktree(worktree: Worktree): Promise<void> {
  await git(worktree.repo, ['worktree', 'remove', '--force', worktree.path]).catch(() => {});
  await rm(worktree.path, { recursive: true, force: true });
  await git(worktree.repo, ['worktree', 'prune']);
  await git(worktree.repo, ['update-ref', '-d', `refs/dsh-worktrees/${basename(worktree.path)}`]).catch(() => {});
}
