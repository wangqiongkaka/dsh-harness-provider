import { getSessionMessages, forkSession } from '@anthropic-ai/claude-agent-sdk';
import { harnessIdSchema, hostItemIdSchema, nativeSessionRefSchema, type HostTurnSnapshot, type NativeSessionRef } from './contracts.js';

const harnessId = harnessIdSchema.parse('claude-code');
const record = (value: unknown): Record<string, unknown> => typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
const blocks = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.map(record) : typeof value === 'string' ? [{ type: 'text', text: value }] : [];
const human = (entry: { type: string; message: unknown }) => entry.type === 'user' && blocks(record(entry.message).content).some(part => part.type === 'text' || part.type === 'image');

/** Read public transcript messages without resubmitting any prompt. Missing terminal evidence stays unknown. */
export async function claudeHistory(nativeRef: NativeSessionRef, cwd: string): Promise<HostTurnSnapshot[]> {
  const messages = (await getSessionMessages(nativeRef.nativeSessionId, { dir: cwd })).filter(message => !message.parent_tool_use_id);
  const turns: HostTurnSnapshot[] = [];
  for (const message of messages) {
    const body = record(message.message), content = blocks(body.content);
    if (human(message)) turns.push({ nativeTurnRef: { harnessId, nativeSessionId: nativeRef.nativeSessionId, nativeTurnKey: message.uuid, formatVersion: 1 },
      input: content.flatMap(part => part.type === 'text' && typeof part.text === 'string' ? [{ type: 'text' as const, text: part.text }] : []),
      items: [], outcome: { status: 'unknown', reason: '原生记录没有可确认的结束状态' } });
    const turn = turns.at(-1);
    if (!turn || message.type !== 'assistant') continue;
    for (const [index, part] of content.entries()) {
      if (part.type === 'text' && typeof part.text === 'string') turn.items.push({ item: { type: 'agentMessage', itemId: hostItemIdSchema.parse(`${message.uuid}:${index}`), text: part.text }, outcome: { status: 'succeeded' } });
    }
    if (body.stop_reason === 'end_turn') turn.outcome = { status: 'succeeded' };
    else turn.outcome = { status: 'unknown', reason: '原生记录没有可确认的结束状态' };
  }
  return turns;
}

export async function forkClaude(nativeRef: NativeSessionRef, cwd: string, throughTurn?: string | null): Promise<NativeSessionRef | undefined> {
  if (throughTurn === null) return undefined;
  let upToMessageId: string | undefined;
  if (throughTurn !== undefined) {
    const messages = (await getSessionMessages(nativeRef.nativeSessionId, { dir: cwd })).filter(message => !message.parent_tool_use_id);
    const start = messages.findIndex(message => message.uuid === throughTurn && human(message));
    if (start < 0) throw new Error('找不到请求的原生对话边界');
    const next = messages.findIndex((message, index) => index > start && human(message));
    upToMessageId = messages[next < 0 ? messages.length - 1 : next - 1]?.uuid;
    if (!upToMessageId) throw new Error('原生会话没有可分支的记录');
  }
  const fork = await forkSession(nativeRef.nativeSessionId, { dir: cwd, ...(upToMessageId ? { upToMessageId } : {}) });
  return nativeSessionRefSchema.parse({ harnessId, nativeSessionId: fork.sessionId, formatVersion: 1 });
}

const [operation, reference, cwd, boundary] = process.argv.slice(2);
try {
  const ref = nativeSessionRefSchema.parse(JSON.parse(reference!));
  if (!cwd || !['read', 'fork'].includes(operation!)) throw new Error('Invalid history operation');
  const value = operation === 'read' ? await claudeHistory(ref, cwd) : await forkClaude(ref, cwd, boundary === undefined ? undefined : JSON.parse(boundary));
  process.stdout.write(JSON.stringify(value ?? null));
} catch { process.stderr.write('Claude history operation failed'); process.exitCode = 1; }
