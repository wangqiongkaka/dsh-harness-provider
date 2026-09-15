import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { agentEvents, type Agent, type AssistantStreamFrame } from '@deepseek-ai/dsh-agent';
import {
  AssistantStreamAccumulator, createAssistantMessage, createToolResultMessage, createUserMessage, LlmAttemptId, ToolCallId,
  type ContentBlock, type StreamChunk, type TokenUsage,
} from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-attachment';
import type { Context } from '@deepseek-ai/cordis';
import type { SessionEventMap } from '@deepseek-ai/dsh-session';
import type { HostItem, HostItemSnapshot, HostItemUpdate } from './contracts.js';

/** Projects external activities into DSH's existing message/tool/stream contracts. */
export class DshOutput {
  private readonly active = new Map<string, {
    item: HostItem; stream: AssistantStreamAccumulator; attemptId: ReturnType<typeof LlmAttemptId>; index: number;
  }>();
  /** The last agent message waits for the turn's usage so the native stats fold sees tokens on the message that produced them. */
  private deferred?: { data: SessionEventMap['assistant/message']; attemptId: ReturnType<typeof LlmAttemptId>; index: number };
  constructor(private readonly ctx: Context, private readonly agent: Agent,
    private readonly position: { turn: number; step: number },
    private readonly revision: () => number,
    private readonly source: () => { provider: string; model: string }) {}

  start(item: HostItem): void {
    if (this.active.has(item.itemId)) throw new Error('Duplicate Harness item');
    this.flush();
    const entry = { item: structuredClone(item), stream: new AssistantStreamAccumulator(),
      attemptId: LlmAttemptId(`harness:${randomUUID()}`), index: 0 };
    this.active.set(item.itemId, entry);
    if (item.type === 'agentMessage' || item.type === 'reasoning') {
      this.emit({ type: 'start', attemptId: entry.attemptId, revision: this.revision(), ...this.position });
      this.push(item.itemId, { type: 'block-start', index: 0, blockType: item.type === 'reasoning' ? 'reasoning' : 'text' });
      if (item.text) this.push(item.itemId, { type: item.type === 'reasoning' ? 'reasoning-delta' : 'text-delta', index: 0, text: item.text });
    } else if (item.type !== 'contextCompaction' && item.type !== 'subagentDelegation') {
      const call = toolCall(item);
      this.agent.session.append('assistant/message', { ...this.position,
        message: createAssistantMessage({ source: this.source(), content: [call] }), stream: [],
      }, { surfaceOp: 'append' });
      this.agent.session.append('tool/call', { ...this.position, callId: call.id, name: call.name, arguments: call.arguments });
    }
  }

  update(id: string, update: HostItemUpdate): void {
    const entry = this.active.get(id);
    if (!entry) throw new Error('Harness updated an unknown item');
    const item = entry.item;
    if (update.type === 'text.append' && (item.type === 'agentMessage' || item.type === 'reasoning')) {
      item.text += update.text;
      this.push(id, { type: item.type === 'reasoning' ? 'reasoning-delta' : 'text-delta', index: 0, text: update.text });
    } else if (update.type === 'output.append' && item.type === 'commandExecution') item.output = (item.output ?? '') + update.text;
    else if (update.type === 'output.replace' && item.type === 'toolExecution') item.output = update.output;
    else if (update.type === 'fileChanges.replace' && item.type === 'fileChange') item.changes = update.changes;
    else if (update.type === 'subagents.replace' && item.type === 'subagentDelegation') item.subagents = update.subagents;
    else throw new Error('Unsupported Harness item update');
  }

  async complete(snapshot: HostItemSnapshot, interrupted = false): Promise<void> {
    const item = snapshot.item;
    if (!this.active.has(item.itemId)) this.start(item);
    const entry = this.active.get(item.itemId)!;
    if (entry.item.type !== item.type) throw new Error('Harness item changed type');
    if (item.type === 'agentMessage' || item.type === 'reasoning') {
      const block: ContentBlock = { type: item.type === 'reasoning' ? 'reasoning' : 'text', text: item.text };
      this.push(item.itemId, { type: 'block-end', index: 0, block });
      this.push(item.itemId, { type: 'finish', reason: interrupted ? { kind: 'aborted', failure: { code: 'UNKNOWN', message: 'Harness item interrupted' } } : { kind: 'stop' } });
      this.flush();
      this.deferred = { attemptId: entry.attemptId, index: entry.index, data: {
        ...this.position, message: createAssistantMessage({ source: this.source(), content: [block] }),
        stream: [...entry.stream.snapshot()], ...(interrupted ? { interrupted: true as const } : {}),
      } };
      if (item.type === 'reasoning') this.flush();
    } else if (item.type === 'contextCompaction' || item.type === 'subagentDelegation') {
      this.flush();
      this.agent.session.append('user/message', createUserMessage({
        source: { kind: 'plugin', plugin: 'dsh-harness-provider', form: 'notice',
          summary: item.type === 'contextCompaction' ? 'Harness context compaction' : 'Harness subagent activity' },
        content: [{ type: 'text', text: JSON.stringify(snapshot) }],
      }), { surfaceOp: 'append' });
    } else {
      this.flush();
      this.agent.session.append('tool/result', { ...this.position,
        message: createToolResultMessage({ callId: ToolCallId(item.itemId),
          content: await toolOutput(this.ctx, item), isError: snapshot.outcome.status !== 'succeeded' }),
        meta: { harnessItem: JSON.parse(JSON.stringify(item.type === 'toolExecution' && item.output?.content.some(part => part.type !== 'text') ? { ...item, output: undefined } : item)), outcome: JSON.parse(JSON.stringify(snapshot.outcome)) },
      }, { surfaceOp: 'append' });
    }
    this.active.delete(item.itemId);
  }

  async interrupt(): Promise<void> {
    for (const entry of [...this.active.values()]) await this.complete({ item: entry.item, outcome: { status: 'cancelled' } }, true);
  }
  /** Commit the deferred agent message with the turn's token usage; without one, a surface-less attempt still carries the count. */
  async finish(usage?: TokenUsage): Promise<void> {
    await this.interrupt();
    if (this.deferred || !usage) return this.flush(usage);
    const stream = new AssistantStreamAccumulator();
    stream.push({ time: Date.now(), chunk: { type: 'usage', usage } });
    this.agent.session.append('assistant/attempt', { ...this.position, stream: [...stream.snapshot()] });
  }
  private flush(usage?: TokenUsage): void {
    const pending = this.deferred;
    if (!pending) return;
    this.deferred = undefined;
    const event = this.agent.session.append('assistant/message', { ...pending.data, ...(usage ? { usage } : {}) }, { surfaceOp: 'append' });
    this.emit({ type: 'end', attemptId: pending.attemptId, revision: this.revision(), index: pending.index,
      outcome: { kind: 'committed', eventType: 'assistant/message', seq: event.seq } });
  }
  private push(id: string, chunk: StreamChunk): void {
    const entry = this.active.get(id)!;
    const timed = entry.stream.push({ time: Date.now(), chunk });
    this.emit({ type: 'chunk', attemptId: entry.attemptId, revision: this.revision(), index: entry.index++, ...timed });
  }
  private emit(frame: AssistantStreamFrame): void {
    agentEvents(this.ctx, this.agent).emit('agent/assistant-stream', { frame });
  }
}
function toolCall(item: HostItem): Extract<ContentBlock, { type: 'tool-call' }> {
  const name = item.type === 'commandExecution' ? 'bash' : item.type === 'toolExecution' ? item.toolName : item.type;
  const args = item.type === 'toolExecution' ? item.arguments : item;
  return { type: 'tool-call', id: ToolCallId(item.itemId), name, arguments: JSON.stringify(args) };
}
async function toolOutput(ctx: Context, item: HostItem): Promise<ContentBlock[]> {
  if (item.type === 'commandExecution') return [{ type: 'text', text: item.output ?? '' }];
  if (item.type === 'toolExecution' && item.output) {
    const images = await Promise.all(item.output.content.filter(part => part.type !== 'text').map(async part => {
      if (part.type === 'image') return part;
      if (!isAbsolute(part.path)) throw new Error('工具图片需要绝对路径');
      const file = await open(part.path, 'r');
      try {
        const stat = await file.stat(), limit = ctx.attachments.imageLimits.maxImageBytes;
        if (!stat.isFile() || stat.size > limit) throw new Error('工具图片不是普通文件或超过大小限制');
        const bytes = Buffer.alloc(Math.min(stat.size + 1, limit + 1));
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
        if (bytesRead > stat.size) throw new Error('工具图片在读取期间发生变化');
        const data = bytes.subarray(0, bytesRead);
        const mimeType = data[0] === 0x89 ? 'image/png' : data[0] === 0xff ? 'image/jpeg' : data.toString('ascii', 0, 3) === 'GIF' ? 'image/gif' : 'image/webp';
        return { type: 'image' as const, mimeType, base64Data: data.toString('base64') };
      } finally { await file.close(); }
    }));
    const refs = images.length ? await ctx.attachments.admitPromptContent(images.map(part => {
      if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(part.mimeType)) throw new Error('不支持的工具图片格式');
      return { type: 'image' as const, mediaType: part.mimeType as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif', data: part.base64Data };
    })) : [];
    let index = 0;
    return item.output.content.map(part => part.type === 'text' ? { type: 'text' as const, text: part.text } : refs[index++]!);
  }
  return [{ type: 'text', text: JSON.stringify(item) }];
}
