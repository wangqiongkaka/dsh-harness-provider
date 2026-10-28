import { execFile } from 'node:child_process';
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

const stores = new Map<string, Promise<string>>();
async function snapshotStore(repo: string): Promise<string> {
  const store = join(await git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']), 'dsh-checkpoints.git');
  const existing = stores.get(store);
  if (existing) return existing;
  const opening = (async () => {
    await git(repo, ['init', '--bare', '--quiet', `--object-format=${await git(repo, ['rev-parse', '--show-object-format'])}`, store]);
    const refs = (await git(repo, ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/dsh/checkpoints/'])).split('\n').filter(Boolean).map(line => line.split(' ') as [string, string]);
    if (refs.length) {
      // Keep legacy hashes readable, without copying the project's entire commit history.
      await git(store, ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--depth=1', repo, ...refs.map(([, ref]) => `${ref}:${ref}`)]);
      for (const [commit, ref] of refs) {
        await git(store, ['cat-file', '-e', `${commit}^{tree}`]);
        await git(repo, ['update-ref', '-d', ref, commit]);
      }
    }
    return store;
  })();
  stores.set(store, opening);
  try { return await opening; }
  catch (cause) { stores.delete(store); throw cause; }
}

async function snapshotCommit(store: string, tree: string, retain?: string): Promise<string> {
  // Parentless commits with fixed metadata deduplicate snapshots by file content.
  const commit = await git(store, ['commit-tree', tree, '-m', 'DSH checkpoint'], { GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' });
  if (retain !== undefined) await git(store, ['update-ref', `refs/dsh/checkpoints/${tree}`, commit]);
  return commit;
}

/** Snapshots tracked and non-ignored files without changing the user's index. */
export async function checkpoint(cwd: string, retain?: string): Promise<Checkpoint> {
  const repo = await repository(cwd);
  const store = await snapshotStore(repo);
  const temp = await mkdtemp(join(tmpdir(), 'dsh-checkpoint-'));
  const env = { GIT_INDEX_FILE: join(temp, 'index'), GIT_OBJECT_DIRECTORY: join(store, 'objects') };
  try {
    await copyFile(resolve(repo, await git(repo, ['rev-parse', '--git-path', 'index'])), env.GIT_INDEX_FILE).catch(cause => { if (cause.code !== 'ENOENT') throw cause; });
    await git(repo, ['add', '-A', '--', '.'], env);
    // Force content reads even when an edit shares the index entry's timestamp and size.
    await git(repo, ['add', '--renormalize', '--', '.'], env);
    const tree = await git(repo, ['write-tree'], env);
    const commit = await snapshotCommit(store, tree, retain);
    return { repo, commit };
  } finally { await rm(temp, { recursive: true, force: true }); }
}

/** Undo each completed turn in reverse order, preserving changes that do not conflict. */
export async function previewRestore(cwd: string, turns: Array<{ before: Checkpoint; after: Checkpoint }>, retain?: string): Promise<RestorePlan> {
  const current = await checkpoint(cwd, retain === undefined ? undefined : `${retain}:current`);
  const store = await snapshotStore(current.repo);
  let merged = current.commit;
  for (const { before, after } of [...turns].reverse()) {
    if (before.repo !== current.repo || after.repo !== current.repo) throw new Error('检查点所属仓库与当前工作区不同');
    try {
      const tree = (await git(store, ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', `--merge-base=${after.commit}`, merged, before.commit], {}, true)).split('\0')[0]!;
      merged = await snapshotCommit(store, tree, retain);
    } catch (cause) {
      const failure = cause as { code?: number; stdout?: string };
      if (failure.code !== 1 || failure.stdout === undefined) throw cause;
      return { repo: current.repo, current: current.commit, merged, paths: [], conflicts: failure.stdout.split('\0').slice(1).filter(Boolean) };
    }
  }
  const paths = (await git(store, ['diff', '--name-only', '-z', current.commit, merged], {}, true)).split('\0').filter(Boolean);
  return { repo: current.repo, current: current.commit, merged, paths, conflicts: [] };
}

export async function restorePosition(cwd: string, plan: RestorePlan): Promise<'before' | 'after' | 'changed'> {
  const current = await checkpoint(cwd);
  if (current.repo !== plan.repo) return 'changed';
  const store = await snapshotStore(current.repo);
  const tree = await git(store, ['rev-parse', `${current.commit}^{tree}`]);
  if (tree === await git(store, ['rev-parse', `${plan.current}^{tree}`])) return 'before';
  return tree === await git(store, ['rev-parse', `${plan.merged}^{tree}`]) ? 'after' : 'changed';
}

export async function restoreDiff(plan: RestorePlan): Promise<{ diff: string; truncated: boolean }> {
  const diff = await git(await snapshotStore(plan.repo), ['diff', '--no-ext-diff', '--no-textconv', plan.current, plan.merged], {}, true);
  return { diff: diff.slice(0, 100_000), truncated: diff.length > 100_000 };
}

/** Apply only the reviewed diff, and fail if the workspace changed since the preview. */
export async function applyRestore(cwd: string, plan: RestorePlan): Promise<void> {
  if (plan.conflicts.length) throw new Error(`存在冲突：${plan.conflicts.join('、')}`);
  const current = await checkpoint(cwd);
  const store = await snapshotStore(current.repo);
  if (current.repo !== plan.repo || await git(store, ['rev-parse', `${current.commit}^{tree}`]) !== await git(store, ['rev-parse', `${plan.current}^{tree}`])) throw new Error('工作区已变化，请重新预览');
  const temp = await mkdtemp(join(tmpdir(), 'dsh-restore-'));
  try {
    const patch = join(temp, 'changes.patch');
    const diff = await git(store, ['diff', '--no-ext-diff', '--no-textconv', '--binary', plan.current, plan.merged], {}, true);
    if (diff) { await writeFile(patch, diff); await git(plan.repo, ['apply', '--binary', patch]); }
  } finally { await rm(temp, { recursive: true, force: true }); }
}
