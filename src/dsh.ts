import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { TypertRemoteService, RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import { SessionId } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-api-session-controller';
import type {} from '@deepseek-ai/dsh-user-questions';
import type {} from '@deepseek-ai/dsh-typert-registry';
import type { HarnessAdapter } from '@codexhost/harness-adapter';
import { harnessModelRefSchema } from '@codexhost/shared-contracts';
import { z } from 'zod';
import { Bindings, type Binding } from './bindings.js';
import { CodexAdapter } from './codex-adapter.js';
import { DshRunner, unwrap } from './dsh-runner.js';
import { address, contribution, selectRequest, modelRequest } from './remote.js';

export const inject = ['sessionController', 'sessions', 'agents', 'typert', 'userQuestions'];
export const configSchema = z.object({
  root: z.string().optional(), codexCommand: z.string().min(1).default('codex'),
}).strict();
declare module '@deepseek-ai/cordis' { interface Context { harness: HarnessService } }

/** Standalone DSH entry: no replacement of the original client/plugin row. */
export async function apply(ctx: Context, rawConfig: unknown = {}): Promise<void> {
  const config = configSchema.parse(rawConfig);
  // This is the existing self-contained codexhost Claude Code plugin artifact.
  const { createHarnessAdapter } = await import('./claude-code/plugin.mjs');
  const claude = await createHarnessAdapter({ environment: { ...process.env }, platform: process.platform, managedRemoteHost: false });
  const adapters = {
    codex: new CodexAdapter({ command: config.codexCommand, environment: { ...process.env },
      requestTimeoutMs: 30000, shutdownTimeoutMs: 2000, maxFrameBytes: 16 * 1024 * 1024 }),
    'claude-code': claude,
  };
  new HarnessService(ctx, resolve(config.root ?? resolve(process.env.DSH_HOME ?? resolve(homedir(), '.dsh'), 'harness-plugin')), adapters);
}

export class HarnessService extends TypertRemoteService {
  readonly bindings: Bindings;
  readonly runner: DshRunner;
  // ponytail: per-cwd catalog cache; each inspect spawns a native process.
  private readonly catalogs = new Map<string, { until: number; models: { id: string; label: string }[] }>();
  constructor(ctx: Context, root: string, private readonly adapters: Record<Binding['harness'], HarnessAdapter>) {
    super(ctx, 'harness');
    this.bindings = new Bindings(root);
    this.runner = new DshRunner(ctx, this.bindings, adapters);
    ctx.effect(() => ctx.typert.register({ package: contribution.package, face: 'host', schemas: [], invocations: contribution.descriptors, model: { services: [], events: [], objects: [] } }), 'harness: Remote contracts');
    ctx.effect(() => async () => {
      const agents = [...this.runner.live.keys()].flatMap(id => {
        const agent = ctx.agents.get(SessionId(id)); return agent ? [agent] : [];
      });
      for (const agent of agents) agent.cancel({ kind: 'disposed' });
      await Promise.allSettled(agents.map(agent => agent.whenIdle()));
      const results = await Promise.allSettled(Object.values(adapters).map(adapter => adapter.close()));
      const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      if (errors.length) throw new AggregateError(errors, 'Harness shutdown failed');
    }, 'harness: adapters');
    ctx.on('agent/pre-step', async (payload, next) => {
      const binding = await this.bindings.read(payload.agent.id);
      if (!binding) return next();
      await this.runner.run(payload, binding);
      return { kind: 'enter', messages: [] };
    });
    this.wrapCommands(ctx);
  }

  async state(raw: unknown) {
    const { sessionId } = address.parse(raw);
    await this.agent(sessionId); // Same authorization/ownership rules as native Session commands.
    const binding = await this.bindings.read(sessionId);
    return this.view(binding);
  }

  async select(raw: unknown) {
    const request = selectRequest.parse(raw);
    return this.bindings.serial(request.sessionId, async () => {
      const agent = await this.agent(request.sessionId);
      const current = await this.bindings.read(request.sessionId);
      if (agent.status === 'running' || current?.locked || (agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0)
        || agent.session.snapshotEvents().some(event => event.type === 'turn/start' || event.type === 'user/message')) {
        throw new Error('开始对话后不能切换 Harness，请新建会话');
      }
      if (request.harness === 'dsh') { await this.bindings.remove(request.sessionId); return this.view(); }
      const cwd = agent.session.header.cwd;
      if (!cwd) throw new Error('请先连接工作目录');
      const binding: Binding = { version: 1, sessionId: request.sessionId, harness: request.harness, cwd, locked: false };
      await this.bindings.write(binding);
      return this.view(binding);
    });
  }

  async models(raw: unknown) {
    const { sessionId } = address.parse(raw);
    await this.agent(sessionId);
    const binding = await this.bindings.read(sessionId);
    if (!binding) return { models: [], error: null };
    const key = `${binding.harness}\0${binding.cwd}`;
    const cached = this.catalogs.get(key);
    if (cached && cached.until > Date.now()) return { models: cached.models, error: null };
    const result = await this.adapters[binding.harness].inspect({ cwd: binding.cwd });
    if (result.status !== 'ready') return { models: [], error: result.error.message };
    const models = result.catalog.models.map(model => ({ id: model.ref.id, label: model.label }));
    this.catalogs.set(key, { until: Date.now() + 60_000, models });
    return { models, error: null };
  }

  async selectModel(raw: unknown) {
    const request = modelRequest.parse(raw);
    return this.bindings.serial(request.sessionId, async () => {
      const agent = await this.agent(request.sessionId);
      const binding = await this.bindings.read(request.sessionId);
      if (!binding) throw new Error('请使用 DSH 原生模型选择器');
      if (agent.status === 'running' || (agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0) || binding.pending) throw new Error('请等待当前请求结束');
      const catalog = await this.models({ sessionId: request.sessionId });
      if (!catalog.models.some(model => model.id === request.model)) throw new Error(catalog.error ?? 'Harness 未提供这个模型');
      const model = harnessModelRefSchema.parse({ id: request.model });
      const live = this.runner.live.get(request.sessionId);
      if (live) unwrap(await live.session.execute({ type: 'model.select', model }));
      binding.model = model;
      await this.bindings.write(binding);
      return this.view(binding);
    });
  }

  private view(binding?: Binding) {
    return { harness: binding?.harness ?? 'dsh' as const, locked: binding?.locked ?? false,
      model: binding?.model?.id ?? null, recoveryRequired: !!binding?.pending };
  }
  private async agent(id: string) {
    const result = await this.ctx.sessionController.resolveAgent(SessionId(id));
    if ('error' in result) throw result.error;
    return result.agent;
  }

  private wrapCommands(ctx: Context): void {
    const controller = ctx.sessionController;
    const originalDescriptors = Object.fromEntries(['prompt', 'fork', 'selectModel', 'updateQueue'].map(key => [key, Object.getOwnPropertyDescriptor(controller, key)]));
    const native = {
      prompt: controller.prompt.bind(controller), fork: controller.fork.bind(controller),
      selectModel: controller.selectModel.bind(controller), updateQueue: controller.updateQueue.bind(controller),
    };
    const prompt: typeof controller.prompt = (request, signal) => this.bindings.serial(request.sessionId, async () => {
      signal.throwIfAborted();
      const binding = await this.bindings.read(request.sessionId);
      if (!binding) return native.prompt(request, signal);
      if (request.mode === 'steer') throw new RemoteError('gateway/bad-request', '外部 Harness 首版只支持排队发送', {});
      if (!request.content.length || request.content.some(part => part.type !== 'text')
        || !request.content.some(part => part.type === 'text' && part.text.trim())) {
        throw new RemoteError('gateway/bad-request', '外部 Harness 首版只接受非空文本', {});
      }
      const agent = await this.agent(request.sessionId);
      const matches = (message: { source: unknown }) => {
        const source = message.source as { kind?: string; rpcId?: string };
        return source.kind === 'user' && source.rpcId === request.requestId;
      };
      if (agent.inbox.nextTurn.some(matches) || agent.inbox.nextStep.some(matches)
        || agent.session.snapshotEvents().some(event => event.type === 'user/message' && matches(event.data))) return { accepted: true };
      if (binding.pending && agent.status !== 'running') throw new RemoteError('gateway/bad-request', '上次 Harness 请求结果未确认，已暂停发送以避免重复执行', {});
      if (!binding.locked) { binding.locked = true; await this.bindings.write(binding); }
      signal.throwIfAborted();
      agent.followup(createUserMessage({ content: request.content.map(part => {
        if (part.type !== 'text') throw new Error('Text prompt required');
        return { type: 'text', text: part.text };
      }), source: { kind: 'user', rpcId: request.requestId, ...(request.clientTimeZone ? { clientTimeZone: request.clientTimeZone } : {}) } }));
      return { accepted: true };
    });
    const fork: typeof controller.fork = async request => {
      if (await this.bindings.read(request.sessionId)) throw new RemoteError('gateway/bad-request', '此 Harness 尚未实现原生会话分支', {});
      return native.fork(request);
    };
    const selectModel: typeof controller.selectModel = async request => {
      if (await this.bindings.read(request.sessionId)) throw new RemoteError('gateway/bad-request', '请使用 Harness 模型选择器', {});
      return native.selectModel(request);
    };
    // Synchronous queue API cannot read a sidecar. For attached external sessions the runner owns this identity.
    const updateQueue: typeof controller.updateQueue = request => {
      if (request.action.kind === 'steer' && this.runner.live.has(request.sessionId)) throw new RemoteError('gateway/bad-request', '外部 Harness 首版不支持插入当前轮', {});
      return native.updateQueue(request);
    };
    ctx.effect(() => {
      controller.prompt = prompt; controller.fork = fork; controller.selectModel = selectModel; controller.updateQueue = updateQueue;
      return () => {
        // Public API compatibility wrapper; leave a later plugin's replacement intact.
        for (const [key, replacement] of Object.entries({ prompt, fork, selectModel, updateQueue })) {
          if (Object.getOwnPropertyDescriptor(controller, key)?.value !== replacement) continue;
          const descriptor = originalDescriptors[key];
          if (descriptor) Object.defineProperty(controller, key, descriptor);
          else Reflect.deleteProperty(controller, key);
        }
      };
    }, 'harness: original Session command integration');
  }
}
