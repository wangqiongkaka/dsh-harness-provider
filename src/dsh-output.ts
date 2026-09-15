import { randomUUID } from 'node:crypto';
import { agentEvents, type Agent, type AssistantStreamFrame } from '@deepseek-ai/dsh-agent';
import {
  AssistantStreamAccumulator, createAssistantMessage, createToolResultMessage, createUserMessage, LlmAttemptId, ToolCallId,
  type ContentBlock, type StreamChunk,
} from '@deepseek-ai/dsh-llm';
import type { Context } from '@deepseek-ai/cordis';
import type { HostItem, HostItemSnapshot, HostItemUpdate } from '@codexhost/harness-adapter';

/** Projects external activities into DSH's existing message/tool/stream contracts. */
export class DshOutput {
  private readonly active = new Map<string, {
    item: HostItem; stream: AssistantStreamAccumulator; attemptId: ReturnType<typeof LlmAttemptId>; index: number;
  }>();
  constructor(private readonly ctx: Context, private readonly agent: Agent,
    private readonly position: { turn: number; step: number },
    private readonly revision: () => number,
    private readonly source: () => { provider: string; model: string }) {}

  start(item: HostItem): void {
    if (this.active.has(item.itemId)) throw new Error('Duplicate Harness item');
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

  complete(snapshot: HostItemSnapshot, interrupted = false): void {
    const item = snapshot.item;
    if (!this.active.has(item.itemId)) this.start(item);
    const entry = this.active.get(item.itemId)!;
    if (entry.item.type !== item.type) throw new Error('Harness item changed type');
    if (item.type === 'agentMessage' || item.type === 'reasoning') {
      const block: ContentBlock = { type: item.type === 'reasoning' ? 'reasoning' : 'text', text: item.text };
      this.push(item.itemId, { type: 'block-end', index: 0, block });
      this.push(item.itemId, { type: 'finish', reason: interrupted ? { kind: 'aborted', failure: { code: 'UNKNOWN', message: 'Harness item interrupted' } } : { kind: 'stop' } });
      const event = this.agent.session.append('assistant/message', {
        ...this.position, message: createAssistantMessage({ source: this.source(), content: [block] }),
        stream: [...entry.stream.snapshot()], ...(interrupted ? { interrupted: true as const } : {}),
      }, { surfaceOp: 'append' });
      this.emit({ type: 'end', attemptId: entry.attemptId, revision: this.revision(), index: entry.index,
        outcome: { kind: 'committed', eventType: 'assistant/message', seq: event.seq } });
    } else if (item.type === 'contextCompaction' || item.type === 'subagentDelegation') {
      this.agent.session.append('user/message', createUserMessage({
        source: { kind: 'plugin', plugin: 'dsh-harness-plugin', form: 'notice',
          summary: item.type === 'contextCompaction' ? 'Harness context compaction' : 'Harness subagent activity' },
        content: [{ type: 'text', text: JSON.stringify(snapshot) }],
      }), { surfaceOp: 'append' });
    } else {
      this.agent.session.append('tool/result', { ...this.position,
        message: createToolResultMessage({ callId: ToolCallId(item.itemId),
          content: toolOutput(item), isError: snapshot.outcome.status !== 'succeeded' }),
        meta: { harnessItem: JSON.parse(JSON.stringify(item)), outcome: JSON.parse(JSON.stringify(snapshot.outcome)) },
      }, { surfaceOp: 'append' });
    }
    this.active.delete(item.itemId);
  }

  interrupt(): void {
    for (const entry of [...this.active.values()]) this.complete({ item: entry.item, outcome: { status: 'cancelled' } }, true);
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
  const name = item.type === 'toolExecution' ? item.toolName : item.type;
  const args = item.type === 'toolExecution' ? item.arguments : item;
  return { type: 'tool-call', id: ToolCallId(item.itemId), name, arguments: JSON.stringify(args) };
}
function toolOutput(item: HostItem): ContentBlock[] {
  if (item.type === 'commandExecution') return [{ type: 'text', text: item.output ?? '' }];
  if (item.type === 'toolExecution' && item.output) {
    if (item.output.content.some(part => part.type !== 'text')) throw new Error('Harness image output needs an attachment importer');
    return item.output.content.map(part => ({ type: 'text' as const, text: part.type === 'text' ? part.text : '' }));
  }
  return [{ type: 'text', text: JSON.stringify(item) }];
}
