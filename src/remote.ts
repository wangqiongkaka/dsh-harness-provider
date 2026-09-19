import { z } from 'zod';
import type { InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol';

export const selection = z.enum(['dsh', 'codex', 'claude-code']);
export const address = z.object({ sessionId: z.string().min(1) }).strict();
export const stateSchema = z.object({
  harness: selection, locked: z.boolean(), model: z.string().nullable(), thinking: z.string().nullable(), permission: z.string().nullable(),
  configs: z.record(z.string(), z.union([z.string(), z.boolean()])),
  recoveryRequired: z.boolean(),
  /** DSH turns whose native boundary is known, so their prompt can be edited and rerun in place. */
  editableTurns: z.array(z.number().int()),
});
export const selectRequest = address.extend({ harness: selection });
export const modelRequest = address.extend({ model: z.string().min(1) });
export const thinkingRequest = address.extend({ thinking: z.string().min(1) });
export const permissionRequest = address.extend({ permission: z.string().min(1) });
export const configRequest = address.extend({ configId: z.string().min(1), value: z.union([z.string(), z.boolean()]) });
export const modelsSchema = z.object({
  models: z.array(z.object({ id: z.string(), label: z.string(), resolved: z.string().nullable(), thinkingOptionIds: z.array(z.string()).nullable() })),
  /** What the Harness runs when no model is picked here: its own CLI configuration. */
  defaultModel: z.object({ id: z.string(), label: z.string(), resolved: z.string().nullable() }).nullable(),
  thinkingOptions: z.array(z.object({ id: z.string(), label: z.string() })),
  defaultThinkingOptionId: z.string().nullable(),
  /** Selectable permission modes; empty when the Harness only reports its policy (Codex sandbox). */
  permissionModes: z.array(z.object({ id: z.string(), label: z.string(), dangerous: z.boolean() })),
  defaultPermissionModeId: z.string().nullable(),
  configOptions: z.array(z.object({ id: z.string(), label: z.string(), description: z.string().nullable(), currentValue: z.union([z.string(), z.boolean()]),
    choices: z.array(z.object({ value: z.string(), label: z.string(), description: z.string().nullable() })).nullable() })),
  error: z.string().nullable(),
});
/** Context occupancy the Harness reported for the live native session; null until it reports one. */
export const usageSchema = z.object({
  contextUsedTokens: z.number().nullable(), contextWindowTokens: z.number().nullable(), totalTokens: z.number().nullable(),
}).nullable();
export const quotaWindowSchema = z.object({
  id: z.string(), label: z.string(), usedPercent: z.number(), resetsAt: z.string().nullable(),
});
/** Account quota of whatever serves the session's model: rolling windows, a prepaid balance, or nothing known. */
export const quotaSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('windows'), source: z.string(), plan: z.string().nullable(), windows: z.array(quotaWindowSchema) }),
  z.object({ kind: z.literal('balance'), source: z.string(), currency: z.string(), total: z.string(), granted: z.string(), toppedUp: z.string() }),
]).nullable();
/** Sidebar marks: the Harness of each listed session and whether it was delegated, read from bindings only (no agent load, no remembered-Harness binding). */
export const harnessesRequest = z.object({ sessionIds: z.array(z.string().min(1)).max(1000) }).strict();
export const harnessesSchema = z.record(z.string(), z.object({ harness: selection, delegated: z.boolean() }));
const delegationAttachmentSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('image'), mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']), data: z.string().min(1), name: z.string().min(1).max(255).optional() }).strict(),
  z.object({ type: z.literal('file'), receiptId: z.string().min(1) }).strict(),
]);
export const delegateFromUserRequest = address.extend({
  requestId: z.string().min(1).max(128), harness: selection, prompt: z.string().max(64_000), title: z.string().trim().min(1).max(80).optional(),
  reportBack: z.boolean().default(false), attachments: z.array(delegationAttachmentSchema).max(20).default([]),
}).refine(request => request.prompt.trim() || request.attachments.length, { message: '请输入任务或上传附件' });
export const startDiscussionFromUserRequest = address.extend({
  requestId: z.string().min(1).max(128), prompt: z.string().max(64_000), attachments: z.array(delegationAttachmentSchema).max(20).default([]),
}).refine(request => request.prompt.trim() || request.attachments.length, { message: '请输入讨论任务或上传附件' });
export const delegationAcceptedSchema = z.object({ sessionId: z.string(), harness: selection, accepted: z.literal(true) });
export const discussionAcceptedSchema = z.object({ accepted: z.literal(true) });
/** Harness-internal subagents of the live native session, oldest first; empty while no native session runs in this process. */
export const subagentsSchema = z.array(z.object({
  id: z.string(), parentId: z.string().nullable(), name: z.string(), task: z.string().nullable(), status: z.enum(['running', 'completed', 'failed', 'cancelled']),
  entries: z.array(z.discriminatedUnion('kind', [
    z.object({ kind: z.enum(['message', 'thought']), text: z.string() }),
    z.object({ kind: z.literal('tool'), title: z.string(), status: z.enum(['running', 'completed', 'failed']), output: z.string().nullable() }),
  ])),
}));
/** `@` menu entries of the session's Harness; empty for DSH sessions and Harnesses without plugins. */
export const pluginsSchema = z.array(z.object({ name: z.string(), displayName: z.string(), description: z.string().nullable(), mention: z.string() }));
export const editRequest = address.extend({ seq: z.number().int().nonnegative(), text: z.string().max(1_000_000), requestId: z.string().min(1).max(200) });
export const recoveryRequest = address.extend({ action: z.enum(['check', 'unlock']) });
export const recoverySchema = stateSchema.extend({ detail: z.string() });
export const secretAnswerRequest = address.extend({ id: z.string().min(1), answers: z.record(z.string(), z.array(z.string().min(1).max(64_000))), cancelled: z.boolean().optional() });
export const secretStatusSchema = z.object({ id: z.string(), title: z.string(), questions: z.array(z.discriminatedUnion('type', [
  z.object({ id: z.string(), type: z.literal('text'), prompt: z.string(), secret: z.boolean(), multiline: z.boolean(), optional: z.boolean(), placeholder: z.string().optional() }),
  z.object({ id: z.string(), type: z.literal('choice'), prompt: z.string(), multiple: z.boolean(), allowOther: z.boolean(), optional: z.boolean(), options: z.array(z.object({ value: z.string(), label: z.string(), description: z.string().optional() })) }),
])) }).nullable();
const codec = (schema: z.ZodType) => ({ mode: 'strict' as const, typeSymbol: 'dsh-harness-provider#Contract', create: () => schema });
export const descriptors: InvocationDescriptor[] = [
  ['recover', recoveryRequest, recoverySchema], ['rollback', address, stateSchema], ['edit', editRequest, stateSchema],
  ['secretStatus', address, secretStatusSchema], ['answerSecret', secretAnswerRequest, z.object({ accepted: z.boolean() })],
  ['state', address, stateSchema], ['select', selectRequest, stateSchema],
  ['models', address, modelsSchema], ['selectModel', modelRequest, stateSchema],
  ['selectThinking', thinkingRequest, stateSchema], ['selectPermission', permissionRequest, stateSchema], ['selectConfig', configRequest, stateSchema],
  ['usage', address, usageSchema], ['harnesses', harnessesRequest, harnessesSchema], ['quota', address, quotaSchema],
  ['delegateFromUser', delegateFromUserRequest, delegationAcceptedSchema],
  ['startDiscussionFromUser', startDiscussionFromUserRequest, discussionAcceptedSchema],
  ['subagents', address, subagentsSchema], ['plugins', address, pluginsSchema],
].map(([method, request, result]) => ({
  id: `dsh-harness-provider#harness/${method}`, service: 'harness', namespace: 'harness', method: method as string,
  invocation: { kind: 'direct' },
  parameters: [{ name: 'request', wire: 'request', source: 'json', codec: codec(request as z.ZodType) }],
  result: codec(result as z.ZodType),
}));
export const contribution = { package: 'dsh-harness-provider', descriptors };
