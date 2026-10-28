import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const identity = { GIT_AUTHOR_NAME: 'DSH', GIT_AUTHOR_EMAIL: 'dsh@localhost', GIT_COMMITTER_NAME: 'DSH', GIT_COMMITTER_EMAIL: 'dsh@localhost' };
async function git(cwd: string, args: string[], env: Record<string, string> = {}, raw = false): Promise<string> {
  const { stdout } = await run('git', ['-C', cwd, ...args], { env: { ...process.env, ...identity, ...env }, maxBuffer: 256 * 1024 * 1024 });
  return raw ? stdout : stdout.trim();
}
export type Checkpoint = { repo: string; commit: string };
export type RestorePlan = { repo: string; current: string; merged: string; paths: string[]; conflicts: string[] };
export const repository = (cwd: string): Promise<string> => git(cwd, ['rev-parse', '--show-toplevel']);

/** Snapshots tracked and non-ignored files without changing the user's index. */
export async function checkpoint(cwd: string, retain?: string): Promise<Checkpoint> {
  const repo = await repository(cwd);
  const temp = await mkdtemp(join(tmpdir(), 'dsh-checkpoint-'));
  const env = { GIT_INDEX_FILE: join(temp, 'index') };
  try {
    const head = await git(repo, ['rev-parse', '--verify', '-q', 'HEAD']).catch(() => '');
    await copyFile(resolve(repo, await git(repo, ['rev-parse', '--git-path', 'index'])), env.GIT_INDEX_FILE).catch(cause => { if (cause.code !== 'ENOENT') throw cause; });
    await git(repo, ['add', '-A', '--', '.'], env);
    // Force content reads even when an edit shares the index entry's timestamp and size.
    await git(repo, ['add', '--renormalize', '--', '.'], env);
    const tree = await git(repo, ['write-tree'], env);
    const commit = await git(repo, ['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', 'DSH checkpoint']);
    if (retain !== undefined) await git(repo, ['update-ref', `refs/dsh/checkpoints/${createHash('sha256').update(retain).digest('hex')}`, commit]);
    return { repo, commit };
  } finally { await rm(temp, { recursive: true, force: true }); }
}

/** Undo each completed turn in reverse order, preserving changes that do not conflict. */
export async function previewRestore(cwd: string, turns: Array<{ before: Checkpoint; after: Checkpoint }>, retain?: string): Promise<RestorePlan> {
  const current = await checkpoint(cwd, retain === undefined ? undefined : `${retain}:current`);
  let merged = current.commit;
  for (const { before, after } of [...turns].reverse()) {
    if (before.repo !== current.repo || after.repo !== current.repo) throw new Error('检查点所属仓库与当前工作区不同');
    try {
      const tree = (await git(current.repo, ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', `--merge-base=${after.commit}`, merged, before.commit], {}, true)).split('\0')[0]!;
      merged = await git(current.repo, ['commit-tree', tree, '-p', merged, '-m', 'DSH restore preview']);
    } catch (cause) {
      const failure = cause as { code?: number; stdout?: string };
      if (failure.code !== 1 || failure.stdout === undefined) throw cause;
      return { repo: current.repo, current: current.commit, merged, paths: [], conflicts: failure.stdout.split('\0').slice(1).filter(Boolean) };
    }
  }
  const paths = (await git(current.repo, ['diff', '--name-only', '-z', current.commit, merged], {}, true)).split('\0').filter(Boolean);
  if (retain !== undefined) await git(current.repo, ['update-ref', `refs/dsh/checkpoints/${createHash('sha256').update(`${retain}:merged`).digest('hex')}`, merged]);
  return { repo: current.repo, current: current.commit, merged, paths, conflicts: [] };
}

export async function restorePosition(cwd: string, plan: RestorePlan): Promise<'before' | 'after' | 'changed'> {
  const current = await checkpoint(cwd);
  if (current.repo !== plan.repo) return 'changed';
  const tree = await git(current.repo, ['rev-parse', `${current.commit}^{tree}`]);
  if (tree === await git(current.repo, ['rev-parse', `${plan.current}^{tree}`])) return 'before';
  return tree === await git(current.repo, ['rev-parse', `${plan.merged}^{tree}`]) ? 'after' : 'changed';
}

export async function restoreDiff(plan: RestorePlan): Promise<{ diff: string; truncated: boolean }> {
  const diff = await git(plan.repo, ['diff', '--no-ext-diff', '--no-textconv', plan.current, plan.merged], {}, true);
  return { diff: diff.slice(0, 100_000), truncated: diff.length > 100_000 };
}

/** Apply only the reviewed diff, and fail if the workspace changed since the preview. */
export async function applyRestore(cwd: string, plan: RestorePlan): Promise<void> {
  if (plan.conflicts.length) throw new Error(`存在冲突：${plan.conflicts.join('、')}`);
  const current = await checkpoint(cwd);
  if (current.repo !== plan.repo || await git(current.repo, ['rev-parse', `${current.commit}^{tree}`]) !== await git(current.repo, ['rev-parse', `${plan.current}^{tree}`])) throw new Error('工作区已变化，请重新预览');
  const temp = await mkdtemp(join(tmpdir(), 'dsh-restore-'));
  try {
    const patch = join(temp, 'changes.patch');
    const diff = await git(plan.repo, ['diff', '--no-ext-diff', '--no-textconv', '--binary', plan.current, plan.merged], {}, true);
    if (diff) { await writeFile(patch, diff); await git(plan.repo, ['apply', '--binary', patch]); }
  } finally { await rm(temp, { recursive: true, force: true }); }
}
