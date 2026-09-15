import type { HostItem, HostItemSnapshot, HostTurnSnapshot } from './contracts.js';
import { hostItemIdSchema, harnessIdSchema } from './contracts.js';
import { z } from 'zod';

export const object = z.record(z.string(), z.unknown());
export const nativeItem = z.object({ id: z.string().min(1), type: z.string().min(1) }).passthrough();
export const nativeTurn = z.object({
  id: z.string().min(1), status: z.string(),
  items: z.array(nativeItem), error: z.unknown().optional(),
}).passthrough();
const text = z.string();
const strings = z.array(text);
const harnessId = harnessIdSchema.parse('codex');

/** Preserve structured native activities; text fields never determine tool identity. */
export function itemOf(value: unknown): HostItem | undefined {
  const item = nativeItem.parse(value);
  const itemId = hostItemIdSchema.parse(item.id);
  switch (item.type) {
    case 'userMessage': return undefined;
    case 'agentMessage':
      return {
        type: 'agentMessage', itemId, text: text.parse(item.text),
        ...(item.phase === 'commentary' || item.phase === 'final_answer' ? { phase: item.phase } : {}),
      };
    case 'plan': return { type: 'agentMessage', itemId, text: text.parse(item.text), phase: 'commentary' };
    case 'reasoning': {
      const summary = strings.parse(item.summary ?? []);
      return { type: 'reasoning', itemId, text: (summary.length ? summary : strings.parse(item.content ?? [])).join('\n') };
    }
    case 'commandExecution':
      return {
        type: 'commandExecution', itemId, command: text.parse(item.command), cwd: text.parse(item.cwd),
        ...(item.aggregatedOutput == null ? {} : { output: text.parse(item.aggregatedOutput) }),
        ...(item.exitCode == null ? {} : { exitCode: z.number().int().parse(item.exitCode) }),
        ...(item.durationMs == null ? {} : { durationMs: z.number().nonnegative().parse(item.durationMs) }),
      };
    case 'fileChange':
      return {
        type: 'fileChange', itemId,
        changes: z.array(z.object({ path: text, diff: text, kind: z.object({ type: z.enum(['add', 'delete', 'update']) }).passthrough() }))
          .parse(item.changes).map(change => ({ path: change.path, kind: change.kind.type, unifiedDiff: change.diff })),
      };
    case 'contextCompaction': return { type: 'contextCompaction', itemId };
    case 'mcpToolCall':
    case 'dynamicToolCall':
    case 'webSearch':
    case 'imageView':
    case 'imageGeneration':
    case 'collabAgentToolCall':
      return {
        type: 'toolExecution', itemId,
        toolName: typeof item.tool === 'string' ? item.tool : item.type,
        ...(typeof item.server === 'string' ? { namespace: item.server } : {}),
        arguments: JSON.parse(JSON.stringify(item.arguments ?? item)),
        output: { content: [{ type: 'text', text: JSON.stringify(item.result ?? item) }], truncated: false },
      };
    default: throw new Error(`Unsupported Codex item type: ${item.type}`);
  }
}

export function snapshotItem(value: unknown): HostItemSnapshot | undefined {
  const native = nativeItem.parse(value);
  const item = itemOf(native);
  if (!item) return undefined;
  return {
    item,
    outcome: native.status === 'failed' || native.success === false
      ? { status: 'failed', error: { code: 'nativeFailure', message: 'Codex activity failed', retryable: false } }
      : native.status === 'declined' ? { status: 'cancelled' } : { status: 'succeeded' },
  };
}

export function turnSnapshot(threadId: string, value: unknown): HostTurnSnapshot {
  const turn = nativeTurn.parse(value);
  return {
    nativeTurnRef: { harnessId, nativeSessionId: threadId, nativeTurnKey: turn.id, formatVersion: 1 },
    input: turn.items.filter(item => item.type === 'userMessage').flatMap(item =>
      z.array(z.object({ type: z.literal('text'), text, text_elements: z.unknown().optional() })).parse(item.content)
        .map(part => ({ type: 'text' as const, text: part.text }))),
    items: turn.items.flatMap(item => { const mapped = snapshotItem(item); return mapped ? [mapped] : []; }),
    outcome: turn.status === 'completed' ? { status: 'succeeded' }
      : turn.status === 'interrupted' ? { status: 'cancelled' }
        : turn.status === 'inProgress' ? { status: 'unknown', reason: 'Native turn is still active' }
          : { status: 'failed', error: { code: 'nativeFailure', message: 'Codex turn failed', retryable: false } },
  };
}
