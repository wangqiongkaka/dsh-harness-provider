import { z } from 'zod';
import type { InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol';

export const selection = z.enum(['dsh', 'codex', 'claude-code']);
export const address = z.object({ sessionId: z.string().min(1) }).strict();
export const stateSchema = z.object({
  harness: selection, locked: z.boolean(), model: z.string().nullable(),
  recoveryRequired: z.boolean(),
});
export const selectRequest = address.extend({ harness: selection });
export const modelRequest = address.extend({ model: z.string().min(1) });
export const modelsSchema = z.object({
  models: z.array(z.object({ id: z.string(), label: z.string() })), error: z.string().nullable(),
});
const codec = (schema: z.ZodType) => ({ mode: 'strict' as const, typeSymbol: 'dsh-harness-provider#Contract', create: () => schema });
export const descriptors: InvocationDescriptor[] = [
  ['state', address, stateSchema], ['select', selectRequest, stateSchema],
  ['models', address, modelsSchema], ['selectModel', modelRequest, stateSchema],
].map(([method, request, result]) => ({
  id: `dsh-harness-provider#harness/${method}`, service: 'harness', namespace: 'harness', method: method as string,
  invocation: { kind: 'direct' },
  parameters: [{ name: 'request', wire: 'request', source: 'json', codec: codec(request as z.ZodType) }],
  result: codec(result as z.ZodType),
}));
export const contribution = { package: 'dsh-harness-provider', descriptors };
