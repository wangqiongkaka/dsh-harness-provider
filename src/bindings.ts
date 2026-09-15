import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { nativeSessionRefSchema, harnessModelRefSchema } from '@codexhost/shared-contracts';

export const harnessChoice = z.enum(['codex', 'claude-code']);
const bindingSchema = z.object({
  version: z.literal(1), sessionId: z.string().min(1), harness: harnessChoice,
  cwd: z.string().min(1), locked: z.boolean(),
  model: harnessModelRefSchema.optional(), nativeRef: nativeSessionRefSchema.optional(),
  pending: z.string().optional(),
}).strict().refine(value => !value.nativeRef || value.nativeRef.harnessId === value.harness, 'Harness identity mismatch');
export type Binding = z.infer<typeof bindingSchema>;

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
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const path = this.path(data.sessionId), temp = `${path}.${randomUUID()}.tmp`;
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
