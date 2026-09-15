import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { nativeSessionRefSchema, harnessModelRefSchema, harnessThinkingOptionIdSchema, harnessPermissionModeIdSchema } from '@codexhost/shared-contracts';

export const harnessChoice = z.enum(['codex', 'claude-code']);
const bindingSchema = z.object({
  version: z.literal(1), sessionId: z.string().min(1), harness: harnessChoice,
  cwd: z.string().min(1), locked: z.boolean(),
  model: harnessModelRefSchema.optional(), thinking: harnessThinkingOptionIdSchema.optional(), permission: harnessPermissionModeIdSchema.optional(),
  nativeRef: nativeSessionRefSchema.optional(),
  /** Last usage the Harness reported: the context reading a cold-resumed session still shows, and the cumulative baseline for per-turn deltas. */
  usage: z.object({ contextUsedTokens: z.number().optional(), contextWindowTokens: z.number().optional(), totalTokens: z.number().optional(),
    inputTokens: z.number().optional(), cachedInputTokens: z.number().optional(), cacheWriteInputTokens: z.number().optional(), outputTokens: z.number().optional() }).optional(),
  pending: z.string().optional(),
  delegation: z.object({ parentSessionId: z.string(), requestHash: z.string() }).strict().optional(),
}).strict().refine(value => !value.nativeRef || value.nativeRef.harnessId === value.harness, 'Harness identity mismatch');
export type Binding = z.infer<typeof bindingSchema>;

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
  async read(id: string): Promise<Binding | undefined> {
    let text: string;
    try { text = await readFile(this.path(id), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    const binding = bindingSchema.parse(JSON.parse(text));
    if (binding.sessionId !== id) throw new Error('Stored DSH session identity mismatch');
    return binding;
  }
  async write(binding: Binding): Promise<void> {
    const data = bindingSchema.parse(binding);
    await this.save(this.path(data.sessionId), data);
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
