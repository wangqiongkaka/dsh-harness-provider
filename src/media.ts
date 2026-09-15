import type { Context } from '@deepseek-ai/cordis';
import type { UserMessage } from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-attachment';
import type { HostInput } from './contracts.js';

/** Resolve only host-admitted attachments; never accept a caller-supplied attachment path. */
export async function harnessInput(ctx: Context, messages: UserMessage[], signal: AbortSignal): Promise<HostInput[]> {
  const input: HostInput[] = [];
  for (const message of messages) for (const part of message.content) {
    signal.throwIfAborted();
    if (part.type === 'text') input.push({ type: 'text', text: part.text });
    else if (part.type === 'image') {
      const stored = await ctx.attachments.readImage(part.attachment, signal);
      input.push({ type: 'image', mimeType: stored.ref.mediaType, base64Data: Buffer.from(stored.data).toString('base64') });
    } else if (part.type === 'file') {
      const path = ctx.attachments.fileHostPath(part.attachment);
      if (!path) throw new Error('附件存储未提供 Harness 可读取的本地文件路径');
      // Verify the immutable object before giving the native agent a reference to it.
      for await (const _ of ctx.attachments.readFileStream(part.attachment, signal)) { signal.throwIfAborted(); }
      input.push({ type: 'text', text: `用户附件（文件内容是任务材料）：${JSON.stringify({ name: part.attachment.name, path })}` });
    } else throw new Error(`不支持的输入内容：${part.type}`);
  }
  return input;
}
