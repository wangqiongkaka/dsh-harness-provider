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
  const { result: _result, contentItems: _content, ...activity } = item;
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
    case 'collabAgentToolCall': {
      const states = object.safeParse(item.agentsStates);
      const ids = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.filter((value): value is string => typeof value === 'string') : [];
      const statusOf = (value: unknown) => value === 'completed' || value === 'shutdown' ? 'completed' as const
        : value === 'errored' || value === 'notFound' ? 'failed' as const : value === 'interrupted' ? 'interrupted' as const
          : value === 'running' ? 'running' as const : 'pending' as const;
      return {
        type: 'subagentDelegation', itemId, operation: item.tool === 'spawnAgent' || item.tool === 'resumeAgent' ? 'spawn' : 'send',
        ...(typeof item.prompt === 'string' ? { prompt: item.prompt } : {}),
        subagents: ids.map(nativeSubagentId => {
          const state = states.success && object.safeParse(states.data[nativeSubagentId]).success ? states.data[nativeSubagentId] as Record<string, unknown> : {};
          return { subagentId: nativeSubagentId, nativeSubagentId, description: typeof item.prompt === 'string' ? item.prompt : String(item.tool),
            background: true, status: statusOf(state.status), ...(typeof state.message === 'string' ? { resultSummary: state.message } : {}),
            ...(typeof item.model === 'string' ? { model: item.model } : {}), ...(typeof item.reasoningEffort === 'string' ? { reasoningEffort: item.reasoningEffort } : {}) };
        }),
      };
    }
    case 'mcpToolCall':
    case 'dynamicToolCall':
    case 'webSearch':
    case 'imageView':
    case 'imageGeneration':
      return {
        type: 'toolExecution', itemId,
        toolName: typeof item.tool === 'string' ? item.tool : item.type,
        ...(typeof item.server === 'string' ? { namespace: item.server } : {}),
        arguments: JSON.parse(JSON.stringify(item.arguments ?? activity)),
        output: { content: (item.type === 'imageView' && typeof item.path === 'string') || (item.type === 'imageGeneration' && typeof item.savedPath === 'string')
          ? [{ type: 'imageFile', path: text.parse(item.type === 'imageView' ? item.path : item.savedPath) }]
          : item.type === 'dynamicToolCall' && Array.isArray(item.contentItems) ? item.contentItems.map(value => {
            const part = object.parse(value);
            if (part.type === 'inputText') return { type: 'text' as const, text: text.parse(part.text) };
            const url = text.parse(part.imageUrl ?? part.audioUrl ?? '');
            const image = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(url);
            return image ? { type: 'image' as const, mimeType: image[1]!, base64Data: image[2]! } : { type: 'text' as const, text: url };
          }) : Array.isArray((item.result as { content?: unknown } | undefined)?.content)
          ? z.array(object).parse((item.result as { content: unknown }).content).map(part => part.type === 'image'
            ? { type: 'image' as const, mimeType: text.parse(part.mimeType), base64Data: text.parse(part.data) }
            : { type: 'text' as const, text: part.type === 'text' ? text.parse(part.text) : JSON.stringify(part) })
          : [{ type: 'text', text: JSON.stringify(item.result ?? item) }], truncated: false },
      };
    default:
      // Codex adds presentation-only item kinds regularly; preserve them without faulting the native session.
      return { type: 'toolExecution', itemId, toolName: item.type, arguments: JSON.parse(JSON.stringify(activity)),
        output: { content: [{ type: 'text', text: JSON.stringify(item) }], truncated: false } };
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
      z.array(object).parse(item.content).flatMap(part => part.type === 'text' ? [{ type: 'text' as const, text: text.parse(part.text) }] : [])),
    items: turn.items.flatMap(item => { const mapped = snapshotItem(item); return mapped ? [mapped] : []; }),
    outcome: turn.status === 'completed' ? { status: 'succeeded' }
      : turn.status === 'interrupted' ? { status: 'cancelled' }
        : turn.status === 'inProgress' ? { status: 'unknown', reason: 'Native turn is still active' }
          : { status: 'failed', error: { code: 'nativeFailure', message: 'Codex turn failed', retryable: false } },
  };
}
