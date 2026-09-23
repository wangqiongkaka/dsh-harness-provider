import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { nativeSessionRefSchema, harnessModelRefSchema, harnessThinkingOptionIdSchema, harnessPermissionModeIdSchema } from './contracts.js';

export const harnessChoice = z.enum(['codex', 'claude-code']);
const delegationSchema = z.object({ parentSessionId: z.string(), requestHash: z.string(), reportBack: z.boolean().optional(), notifiedSeq: z.number().int().optional(),
  discussion: z.literal(true).optional(),
  /** The isolated checkout the Harness works in (binding `cwd`); `removed` once merged or discarded. */
  worktree: z.object({ repo: z.string(), path: z.string(), base: z.string(), removed: z.boolean().optional() }).strict().optional(),
}).strict();
type Delegation = z.infer<typeof delegationSchema>;
const bindingSchema = z.object({
  version: z.literal(1), sessionId: z.string().min(1), harness: harnessChoice,
  cwd: z.string().min(1), locked: z.boolean(),
  model: harnessModelRefSchema.optional(), thinking: harnessThinkingOptionIdSchema.optional(), permission: harnessPermissionModeIdSchema.optional(),
  /** Permission mode `/plan` left; leaving plan mode returns to it. */
  beforePlan: harnessPermissionModeIdSchema.optional(),
  configs: z.record(z.string(), z.union([z.string(), z.boolean()])).optional(),
  nativeRef: nativeSessionRefSchema.optional(),
  /** Last usage the Harness reported: the context reading a cold-resumed session still shows, and the cumulative baseline for per-turn deltas. */
  usage: z.object({ contextUsedTokens: z.number().optional(), contextWindowTokens: z.number().optional(), totalTokens: z.number().optional(),
    inputTokens: z.number().optional(), cachedInputTokens: z.number().optional(), cacheWriteInputTokens: z.number().optional(), outputTokens: z.number().optional() }).optional(),
  pending: z.string().optional(),
  pendingNative: z.string().optional(),
  turns: z.array(z.object({ turn: z.number().int(), key: z.string() })).optional(),
  delegation: delegationSchema.optional(),
  /**
   * A branch switched to this Harness from its source's: the DSH history before `throughSeq` goes to the Harness as a
   * transcript in its session instructions, rebuilt from the session on every open, since no native session carries it.
   */
  carry: z.object({ throughSeq: z.number().int().nonnegative() }).strict().optional(),
}).strict().refine(value => !value.nativeRef || value.nativeRef.harnessId === value.harness, 'Harness identity mismatch');
export type Binding = z.infer<typeof bindingSchema>;
export const DISCUSSION_PERMISSION = { codex: 'read-only', 'claude-code': 'plan' } as const;
const nativeDelegationSchema = z.object({
  version: z.literal(1), sessionId: z.string().min(1), harness: z.literal('dsh'), cwd: z.string().min(1), locked: z.boolean(), delegation: delegationSchema,
}).strict();
const storedBindingSchema = z.union([bindingSchema, nativeDelegationSchema]);
type StoredBinding = z.infer<typeof storedBindingSchema>;
export type DelegatedBinding = (Omit<Binding, 'delegation'> & { delegation: Delegation }) | z.infer<typeof nativeDelegationSchema>;

/** Last model / thinking picked per Harness; seeds the next session that binds to that Harness. */
const defaultsSchema = z.object({
  /** Harness the user picked last; new sessions start bound to it ('dsh' = native, nothing to bind). */
  harness: z.enum(['dsh', ...harnessChoice.options]).optional(),
  codex: z.object({ model: harnessModelRefSchema.optional(), thinking: harnessThinkingOptionIdSchema.optional() }).strict().optional(),
  'claude-code': z.object({ model: harnessModelRefSchema.optional(), thinking: harnessThinkingOptionIdSchema.optional() }).strict().optional(),
}).strict();
export type HarnessDefaults = z.infer<typeof defaultsSchema>;

/** One atomically replaced sidecar per DSH session; no credentials or transcript copies. */
export class Bindings {
  private readonly locks = new Map<string, Promise<unknown>>();
  constructor(private readonly root: string) {}
  private path(id: string): string { return join(this.root, `${createHash('sha256').update(id).digest('hex')}.json`); }
  private async stored(id: string): Promise<StoredBinding | undefined> {
    let text: string;
    try { text = await readFile(this.path(id), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    const binding = storedBindingSchema.parse(JSON.parse(text));
    if (binding.sessionId !== id) throw new Error('Stored DSH session identity mismatch');
    return binding;
  }
  async read(id: string): Promise<Binding | undefined> {
    const binding = await this.stored(id);
    return binding?.harness === 'dsh' ? undefined : binding;
  }
  async readDelegated(id: string): Promise<DelegatedBinding | undefined> {
    const binding = await this.stored(id);
    return binding?.delegation ? binding as DelegatedBinding : undefined;
  }
  /** Callers that can race with native delegation creation must hold serial(sessionId). */
  async write(binding: Binding): Promise<void> {
    const data = bindingSchema.parse(binding);
    // read() hides native delegation records, so a racing remembered-Harness bind must not replace one.
    if ((await this.stored(data.sessionId))?.harness === 'dsh') throw new Error('DSH 原生委派会话不能绑定外部 Harness');
    await this.save(this.path(data.sessionId), data);
  }
  async writeDelegated(binding: DelegatedBinding): Promise<void> {
    const data = storedBindingSchema.parse(binding);
    if (!data.delegation) throw new Error('Missing delegation metadata');
    await this.save(this.path(data.sessionId), data);
  }
  async delegated(): Promise<DelegatedBinding[]> {
    let names: string[];
    try { names = await readdir(this.root); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const result: DelegatedBinding[] = [];
    for (const name of names) if (/^[a-f0-9]{64}\.json$/.test(name)) {
      const binding = storedBindingSchema.parse(JSON.parse(await readFile(join(this.root, name), 'utf8')));
      if (binding.delegation) result.push(binding as DelegatedBinding);
    }
    return result;
  }
  async readDefaults(): Promise<HarnessDefaults> {
    try { return defaultsSchema.parse(JSON.parse(await readFile(join(this.root, 'defaults.json'), 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
  }
  async writeDefaults(defaults: HarnessDefaults): Promise<void> {
    await this.save(join(this.root, 'defaults.json'), defaultsSchema.parse(defaults));
  }
  private async save(path: string, data: unknown): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify(data)}\n`, { mode: 0o600, flag: 'wx', flush: true });
      await rename(temp, path);
    } finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  async remove(id: string): Promise<void> {
    await unlink(this.path(id)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  async serial<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id);
    const current = (async () => { await previous?.catch(() => {}); return work(); })();
    this.locks.set(id, current);
    try { return await current; } finally { if (this.locks.get(id) === current) this.locks.delete(id); }
  }
}
