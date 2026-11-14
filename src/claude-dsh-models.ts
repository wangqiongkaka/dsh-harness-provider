/** A loopback Anthropic endpoint: Claude owns the agent loop, DSH owns provider calls and credentials. */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { z } from 'zod';
import { createMessage, ToolCallId, type ContentBlock, type GenerateOptions, type LlmRuntime, type LlmResolvedModelInfo, type RequestMessage, type TokenUsage } from '@deepseek-ai/dsh-llm';
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment';
import { harnessModelRefSchema, harnessThinkingOptionIdSchema, type HarnessModelCatalog, type HarnessModelRef } from './contracts.js';

const PREFIX = 'dsh~';
export const isDshModel = (model?: HarnessModelRef) => model?.id.startsWith(PREFIX) === true;
export const dshModelId = (provider: string, model: string) => PREFIX + Buffer.from(JSON.stringify([provider, model])).toString('base64url');
export function dshModelRoute(id: string): [string, string] {
  try {
    if (!id.startsWith(PREFIX)) throw new Error('Invalid external model');
    return z.tuple([z.string().min(1), z.string().min(1)]).parse(JSON.parse(Buffer.from(id.slice(PREFIX.length), 'base64url').toString('utf8')));
  } catch { throw new GatewayError(404, 'DSH 未配置这个模型'); }
}
export const dshThinkingId = (provider: string, model: string, effort: string) => harnessThinkingOptionIdSchema.parse(PREFIX + createHash('sha256').update(JSON.stringify([provider, model, effort])).digest('base64url'));
const blockSchema = z.object({ type: z.string() }).loose();
const requestSchema = z.object({
  model: z.string().min(1), max_tokens: z.number().int().positive(), stream: z.boolean().optional(),
  system: z.union([z.string(), z.array(blockSchema)]).optional(),
  messages: z.array(z.object({ role: z.enum(['user', 'assistant', 'system', 'developer']), content: z.union([z.string(), z.array(blockSchema)]) })),
  tools: z.array(z.object({ name: z.string().min(1), type: z.string().optional(), description: z.string().optional(), input_schema: z.record(z.string(), z.unknown()).optional() }).loose()).optional(),
  temperature: z.number().optional(), stop_sequences: z.array(z.string()).optional(),
  tool_choice: z.object({ type: z.string() }).loose().optional(),
}).loose();
type Block = z.infer<typeof blockSchema>;
class GatewayError extends Error { constructor(readonly status: number, message: string) { super(message); } }
const object = (value: unknown) => z.record(z.string(), z.unknown()).parse(value);
const string = (value: unknown) => z.string().parse(value);
const blocks = (value: string | Block[]) => typeof value === 'string' ? [{ type: 'text', text: value }] : value;
const wireUsage = (usage: TokenUsage) => ({ input_tokens: usage.inputTokens, output_tokens: usage.outputTokens,
  cache_read_input_tokens: usage.cacheReadTokens ?? 0, cache_creation_input_tokens: usage.cacheWriteTokens ?? 0 });

export class ClaudeDshModels {
  readonly #token = randomBytes(32).toString('hex');
  readonly #requests = new Set<AbortController>();
  readonly #server = createServer((request, response) => {
    void this.#handle(request, response).catch(cause => {
      if (response.destroyed) return;
      const status = cause instanceof GatewayError ? cause.status : cause instanceof z.ZodError || cause instanceof SyntaxError ? 400 : 502;
      const error = { type: 'error', error: { type: status === 401 ? 'authentication_error' : status === 400 ? 'invalid_request_error' : 'api_error',
        message: status === 502 ? 'DSH 模型调用失败，请检查服务商配置。' : cause instanceof Error ? cause.message : '请求失败' } };
      if (response.headersSent) { response.write(`event: error\ndata: ${JSON.stringify(error)}\n\n`); response.end(); }
      else { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(error)); }
    });
  });
  #listening?: Promise<string>;
  #closed = false;
  constructor(readonly llm: Pick<LlmRuntime, 'listProviders' | 'listModels' | 'resolveModelInfo' | 'stream'>, readonly attachments?: Pick<AttachmentStore, 'saveImage'>) {}

  async catalog(): Promise<HarnessModelCatalog> {
    const entries = (await Promise.all(this.llm.listProviders().map(async provider => Promise.all((await this.llm.listModels(provider.id)).map(async model => {
      const info = await this.llm.resolveModelInfo(provider.id, model.id);
      const thinkingOptions = (info.reasoning?.efforts ?? []).map(effort => ({ id: dshThinkingId(provider.id, model.id, effort.id), label: effort.name }));
      return { model: {
        ref: harnessModelRefSchema.parse({ id: dshModelId(provider.id, model.id) }), label: model.name,
        resolvedModelLabel: `${provider.name} (DSH) · ${model.id}`, supportedThinkingOptionIds: thinkingOptions.map(option => option.id),
        ...(info.reasoning?.defaultEffort !== undefined ? { defaultThinkingOptionId: dshThinkingId(provider.id, model.id, info.reasoning.defaultEffort) } : {}),
      }, thinkingOptions };
    }))))).flat();
    return { models: entries.map(entry => entry.model), thinkingOptions: entries.flatMap(entry => entry.thinkingOptions) };
  }
  async #model(id: string): Promise<LlmResolvedModelInfo> {
    const [provider, model] = dshModelRoute(id);
    if (!id.startsWith(PREFIX) || !this.llm.listProviders().some(entry => entry.id === provider)
      || !(await this.llm.listModels(provider)).some(entry => entry.id === model)) throw new GatewayError(404, 'DSH 未配置这个模型');
    return this.llm.resolveModelInfo(provider, model);
  }
  #effort(info: LlmResolvedModelInfo, thinking?: string) {
    if (thinking === undefined) return info.reasoning?.defaultEffort;
    const effort = info.reasoning?.efforts.find(effort => dshThinkingId(info.provider, info.id, effort.id) === thinking);
    if (!effort) throw new GatewayError(400, '当前模型不支持这个推理强度');
    return effort.id;
  }
  async environment(id: string, thinking?: string): Promise<NodeJS.ProcessEnv> {
    if (this.#closed) throw new Error('DSH 模型转接已关闭');
    this.#effort(await this.#model(id), thinking);
    if (this.#closed) throw new Error('DSH 模型转接已关闭');
    this.#listening ??= (async () => {
      this.#server.listen(0, '127.0.0.1');
      await once(this.#server, 'listening');
      this.#server.unref();
      const address = this.#server.address();
      if (!address || typeof address === 'string') throw new Error('无法启动 DSH 模型转接');
      return `http://127.0.0.1:${address.port}`;
    })();
    return {
      ANTHROPIC_BASE_URL: await this.#listening + (thinking ? `/thinking/${thinking}` : ''), ANTHROPIC_API_KEY: this.#token, ANTHROPIC_AUTH_TOKEN: this.#token,
      CLAUDE_CODE_OAUTH_TOKEN: '', CLAUDE_CODE_USE_BEDROCK: '', CLAUDE_CODE_USE_VERTEX: '', CLAUDE_CODE_USE_FOUNDRY: '',
      ANTHROPIC_MODEL: id, ANTHROPIC_SMALL_FAST_MODEL: id,
      ANTHROPIC_DEFAULT_OPUS_MODEL: id, ANTHROPIC_DEFAULT_SONNET_MODEL: id, ANTHROPIC_DEFAULT_HAIKU_MODEL: id,
      ANTHROPIC_CUSTOM_MODEL_OPTION: id, ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: 'DSH 外部模型',
      ENABLE_TOOL_SEARCH: 'false', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    };
  }
  async close() {
    this.#closed = true;
    for (const controller of this.#requests) controller.abort();
    if (!this.#listening) return;
    await this.#listening;
    this.#server.closeAllConnections();
    await new Promise<void>((resolve, reject) => this.#server.close(error => error ? reject(error) : resolve()));
  }

  async #content(block: Block): Promise<ContentBlock[]> {
    switch (block.type) {
      case 'text': return [{ type: 'text', text: string(block.text) }];
      case 'thinking': return [{ type: 'reasoning', text: string(block.thinking) }];
      case 'redacted_thinking': return [];
      case 'tool_use': return [{ type: 'tool-call', id: ToolCallId(string(block.id)), name: string(block.name), arguments: JSON.stringify(object(block.input)) }];
      case 'image': {
        const source = object(block.source);
        if (source.type !== 'base64' || !this.attachments) throw new GatewayError(400, 'DSH 转接仅支持内嵌图片');
        const mediaType = z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']).parse(source.media_type);
        return [{ type: 'image', attachment: await this.attachments.saveImage({ data: Buffer.from(string(source.data), 'base64'), mediaType }) }];
      }
      default: throw new GatewayError(400, `DSH 无法转换内容类型：${block.type}`);
    }
  }
  async #options(body: z.infer<typeof requestSchema>, signal: AbortSignal, thinking?: string): Promise<GenerateOptions> {
    const info = await this.#model(body.model);
    const { provider, id: model } = info;
    const reasoningEffort = this.#effort(info, thinking);
    if (body.tool_choice && !['auto', 'none'].includes(body.tool_choice.type)) throw new GatewayError(400, 'DSH 转接不支持强制工具选择');
    const messages: RequestMessage[] = [];
    for (const message of body.messages) {
      let content: ContentBlock[] = [];
      const flush = () => {
        if (!content.length) return;
        if (message.role === 'user') messages.push({ role: 'user', content });
        else if (message.role === 'assistant') messages.push(createMessage({ role: 'assistant', content, source: { kind: 'model', provider, model } }));
        else messages.push(createMessage({ role: message.role, content, source: { kind: 'system-prompt' } }));
        content = [];
      };
      for (const block of blocks(message.content)) {
        if (block.type === 'tool_result' && message.role === 'user') {
          flush();
          const result = block.content === undefined ? [] : blocks(z.union([z.string(), z.array(blockSchema)]).parse(block.content));
          const toolCallId = ToolCallId(string(block.tool_use_id));
          messages.push(createMessage({ role: 'tool', toolCallId, source: { kind: 'tool', callId: toolCallId },
            content: (await Promise.all(result.map(value => this.#content(blockSchema.parse(value))))).flat(),
            ...(block.is_error === true ? { isError: true } : {}) }));
        } else content.push(...await this.#content(block));
      }
      flush();
    }
    const tools = (body.tools ?? []).map(tool => {
      if ((tool.type && tool.type !== 'custom') || !tool.input_schema) throw new GatewayError(400, `DSH 无法转换工具：${tool.name}`);
      return { name: tool.name, description: tool.description ?? '', parameters: tool.input_schema };
    });
    const system = body.system === undefined ? undefined : blocks(body.system).map(block => {
      if (block.type !== 'text') throw new GatewayError(400, 'DSH 系统提示仅支持文本');
      return string(block.text);
    }).join('\n\n');
    return { provider, model, messages, signal, ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      ...(system !== undefined ? { system } : {}), tools: body.tool_choice?.type === 'none' ? [] : tools,
      maxTokens: body.max_tokens, ...(body.temperature !== undefined ? { temperature: body.temperature } : {}), ...(body.stop_sequences ? { stop: body.stop_sequences } : {}) };
  }

  async #handle(request: import('node:http').IncomingMessage, response: ServerResponse) {
    const credential = request.headers['x-api-key'] ?? request.headers.authorization?.replace(/^Bearer /, '');
    if (typeof credential !== 'string' || !/^[a-f0-9]{64}$/.test(credential) || !timingSafeEqual(Buffer.from(credential), Buffer.from(this.#token))) throw new GatewayError(401, '无效的本机转接凭据');
    const path = /^(?:\/thinking\/([A-Za-z0-9._~-]+))?\/v1\/messages$/.exec(request.url?.split('?')[0] ?? '');
    if (request.method !== 'POST' || !path) throw new GatewayError(404, '不支持的本机转接接口');
    const controller = new AbortController();
    this.#requests.add(controller);
    const abort = () => controller.abort();
    response.on('close', abort);
    try {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 32 * 1024 * 1024) throw new GatewayError(413, 'DSH 转接请求超过 32 MiB');
        chunks.push(chunk);
      }
      const body = requestSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      const options = await this.#options(body, controller.signal, path[1]);
      const id = 'msg_' + randomUUID();
      const content: Record<string, unknown>[] = [];
      let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 }, stop: string | undefined;
      const opened = new Map<number, { index: number; text: string }>();
      const event = (name: string, value: unknown) => { if (body.stream) response.write(`event: ${name}\ndata: ${JSON.stringify({ type: name, ...object(value) })}\n\n`); };
      if (body.stream) {
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        event('message_start', { message: { id, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: wireUsage(usage) } });
      }
      const delta = (index: number, text: string) => {
        let entry = opened.get(index);
        if (!entry) {
          entry = { index: content.length, text: '' }; opened.set(index, entry);
          const block = { type: 'text', text: '' };
          content.push(block); event('content_block_start', { index: entry.index, content_block: block });
        }
        entry.text += text;
        content[entry.index]!.text = entry.text;
        event('content_block_delta', { index: entry.index, delta: { type: 'text_delta', text } });
      };
      for await (const chunk of this.llm.stream(options)) {
        if (controller.signal.aborted) return;
        if (chunk.type === 'text-delta') delta(chunk.index, chunk.text);
        else if (chunk.type === 'block-end') {
          const block = chunk.block;
          // External reasoning has no Claude signature and must not poison history when switching back to Claude.
          if (block.type === 'reasoning') continue;
          if (block.type === 'text') {
            const entry = opened.get(chunk.index);
            if (!entry) delta(chunk.index, block.text);
            else if (entry.text !== block.text) throw new GatewayError(502, 'DSH 模型返回的流式内容不一致');
            event('content_block_stop', { index: opened.get(chunk.index)!.index });
          } else if (block.type === 'tool-call') {
            let input: Record<string, unknown>;
            try { input = object(JSON.parse(block.arguments)); }
            catch { throw new GatewayError(502, 'DSH 模型返回了无效的工具参数'); }
            const index = content.length, tool = { type: 'tool_use', id: block.id, name: block.name, input };
            content.push(tool);
            event('content_block_start', { index, content_block: { ...tool, input: {} } });
            event('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: block.arguments } });
            event('content_block_stop', { index });
          } else throw new GatewayError(502, `DSH 无法转换响应类型：${block.type}`);
        } else if (chunk.type === 'usage') usage = chunk.usage;
        else if (chunk.type === 'finish') {
          if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') throw new GatewayError(chunk.reason.failure.status ?? 502, 'DSH 模型请求失败：' + chunk.reason.failure.code);
          stop = chunk.reason.kind === 'tool-calls' ? 'tool_use' : chunk.reason.kind === 'max-tokens' ? 'max_tokens' : 'end_turn';
        }
      }
      if (!stop) throw new GatewayError(502, 'DSH 模型响应意外中断');
      if (body.stream) {
        event('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: wireUsage(usage) });
        event('message_stop', {}); response.end();
      } else {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id, type: 'message', role: 'assistant', model: body.model, content, stop_reason: stop, stop_sequence: null, usage: wireUsage(usage) }));
      }
    } finally { response.off('close', abort); this.#requests.delete(controller); }
  }
}
