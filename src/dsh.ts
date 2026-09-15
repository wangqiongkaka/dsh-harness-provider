import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { TypertRemoteService, RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import { SessionId } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller';
import { brandString } from '@deepseek-ai/dsh-brand';
import type {} from '@deepseek-ai/dsh-user-questions';
import type {} from '@deepseek-ai/dsh-typert-registry';
import type { HarnessAdapter, HarnessInspection } from './contracts.js';
import type {} from '@deepseek-ai/dsh-session-projection';
import type {} from '@deepseek-ai/dsh-settings';
import type {} from '@deepseek-ai/dsh-credentials';
import type {} from '@deepseek-ai/dsh-permission-presets';
import type {} from '@deepseek-ai/dsh-shell';
import type {} from '@deepseek-ai/dsh-workspace';
import type {} from '@deepseek-ai/dsh-session-title';
import { harnessModelRefSchema, harnessThinkingOptionIdSchema, harnessPermissionModeIdSchema, type HarnessAccountSnapshot } from './contracts.js';
import { z } from 'zod';
import { Bindings, type Binding } from './bindings.js';
import { CodexAdapter } from './codex-adapter.js';
import { ClaudeCodeAdapter } from './claude-adapter.js';
import { DshRunner, unwrap } from './dsh-runner.js';
import { fetchNativeQuota, type NativeRoute, type Quota, type QuotaWindow } from './native-quota.js';
import { address, contribution, selectRequest, modelRequest, thinkingRequest, permissionRequest } from './remote.js';
import { DelegationBridge, delegationRequest } from './delegation.js';

export const inject = ['sessionController', 'sessions', 'agents', 'typert', 'userQuestions'];
export const configSchema = z.object({
  root: z.string().optional(), codexCommand: z.string().min(1).default('codex'),
}).strict();
declare module '@deepseek-ai/cordis' { interface Context { harness: HarnessService } }

/** Standalone DSH entry: no replacement of the original client/plugin row. */
export async function apply(ctx: Context, rawConfig: unknown = {}): Promise<void> {
  const config = configSchema.parse(rawConfig);
  const claude = new ClaudeCodeAdapter({ environment: { ...process.env } });
  const adapters = {
    codex: new CodexAdapter({ command: config.codexCommand, environment: { ...process.env },
      requestTimeoutMs: 30000, shutdownTimeoutMs: 2000, maxFrameBytes: 16 * 1024 * 1024 }),
    'claude-code': claude,
  };
  new HarnessService(ctx, resolve(config.root ?? resolve(process.env.DSH_HOME ?? resolve(homedir(), '.dsh'), 'harness-plugin')), adapters);
}

type Ready = Extract<HarnessInspection, { status: 'ready' }>;

// DSH native sandbox mode -> the Harness permission mode it most closely matches, so switching Harness keeps the
// permission the user already picked. Claude Code has no sandbox tiers below full access; those fall to its default.
const NATIVE_PERMISSION_MODES: Record<Binding['harness'], Record<string, string>> = {
  codex: { 'read-only': 'readOnly', 'workspace-write': 'workspaceWrite', 'danger-full-access': 'dangerFullAccess' },
  'claude-code': { 'danger-full-access': 'bypassPermissions' },
};

export class HarnessService extends TypertRemoteService {
  readonly bindings: Bindings;
  readonly runner: DshRunner;
  readonly delegation: DelegationBridge;
  // ponytail: per-cwd catalog cache; each inspect spawns a native process.
  private readonly catalogs = new Map<string, { until: number; inspection: Ready }>();
  // ponytail: per-source quota cache; account probes are rate-limited upstream and identical across sessions.
  private readonly quotas = new Map<string, { until: number; work: Promise<Quota> }>();
  constructor(ctx: Context, root: string, private readonly adapters: Record<Binding['harness'], HarnessAdapter>) {
    super(ctx, 'harness');
    this.bindings = new Bindings(root);
    this.delegation = new DelegationBridge((source, method, input) => method === 'create' ? this.delegate(source, input) : this.readDelegation(source, input));
    this.runner = new DshRunner(ctx, this.bindings, adapters, this.delegation);
    ctx.effect(() => ctx.typert.register({ package: contribution.package, face: 'host', schemas: [], invocations: contribution.descriptors, model: { services: [], events: [], objects: [] } }), 'harness: Remote contracts');
    ctx.effect(() => async () => {
      await this.delegation.close();
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
    const agent = await this.agent(sessionId); // Same authorization/ownership rules as native Session commands.
    const binding = await this.bindings.read(sessionId);
    if (binding || !this.fresh(agent)) return this.view(binding);
    // A fresh session starts on the Harness picked last time; failures fall back to native silently.
    const remembered = (await this.bindings.readDefaults()).harness;
    if (!remembered || remembered === 'dsh' || !agent.session.header.cwd) return this.view();
    return this.bindings.serial(sessionId, async () => this.view(await this.bindings.read(sessionId) ?? await this.bind(agent, sessionId, remembered).catch(() => undefined)));
  }

  /** Creates an ordinary DSH session, with a stable identity for admission retries. */
  async delegate(source: string, raw: unknown) {
    const request = delegationRequest.parse(raw);
    const parent = await this.agent(source);
    const cwd = parent.session.header.cwd;
    if (!cwd) throw new Error('请先连接工作目录');
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    const sessionId = SessionId(`session-${hash(JSON.stringify([source, request.requestId]))}`);
    const requestHash = hash(JSON.stringify(request));
    return this.bindings.serial(`delegate:${sessionId}`, async () => {
      try {
        const existing = await this.bindings.read(sessionId);
        if (existing && (existing.delegation?.parentSessionId !== source || existing.delegation.requestHash !== requestHash)) {
          throw new Error('requestId 已用于不同任务，请为新任务提供新标识');
        }
        // Admission locks before followup; while the runner opens its native session, the inbox is already empty
        // but user/message is not persisted yet. Never resend through that gap (or after uncertain cold admission).
        if (existing?.locked) {
          if (this.fresh(await this.agent(sessionId))) throw new Error('上次提交结果未确认，请在目标会话检查，禁止自动重发');
          return { sessionId, harness: request.harness, accepted: true };
        }
        if (!existing) {
          const inspection = await this.inspection({ version: 1, sessionId, harness: request.harness, cwd, locked: false });
          if ('error' in inspection) throw new Error(inspection.error);
          const parentBinding = await this.bindings.read(source);
          const permission = parentBinding?.harness === request.harness ? parentBinding.permission
            : request.harness === 'codex' ? (parentBinding?.permission === 'bypassPermissions' ? 'dangerFullAccess' : 'readOnly')
              : parentBinding?.permission === 'dangerFullAccess' ? 'bypassPermissions' : 'default';
          if (permission && !inspection.permissionModes?.modes.some(mode => mode.id === permission)) throw new Error('目标 Harness 不支持来源会话的权限模式');
          const workspace = this.ctx.get('workspaceRegistry')?.list().find(workspace => workspace.sessionIds.includes(parent.id));
          // Hold the same lock as state/select/prompt so the UI cannot auto-bind the new session to its remembered Harness.
          await this.bindings.serial(sessionId, async () => {
            await this.ctx.sessionController.create({ sessionId, ...(workspace ? { workspaceId: workspace.id } : { cwd }) });
            const child = await this.agent(sessionId);
            if (!this.fresh(child)) throw new Error('目标会话已有内容，拒绝重复创建');
            await this.bind(child, sessionId, request.harness, {
              permission: permission ? harnessPermissionModeIdSchema.parse(permission) : inspection.permissionModes?.defaultModeId,
              delegation: { parentSessionId: source, requestHash },
            });
            if (this.ctx.get('sessionTitle')) await this.ctx.sessionController.rename({ sessionId,
              title: `${request.harness === 'codex' ? 'Codex' : 'Claude Code'} review` });
          });
        }
        await this.ctx.sessionController.prompt({ sessionId, requestId: brandString<SessionRequestId>(request.requestId), mode: 'queue',
          content: [{ type: 'text', text: request.prompt }] }, new AbortController().signal);
        return { sessionId, harness: request.harness, accepted: true };
      } catch (error) {
        throw new Error(`会话 ${sessionId}：${error instanceof Error ? error.message : '委派失败'}。重试请保持 requestId 和参数不变。`);
      }
    });
  }

  async readDelegation(source: string, raw: unknown) {
    await this.agent(source);
    const { sessionId } = address.parse(raw);
    const binding = await this.bindings.read(sessionId);
    if (binding?.delegation?.parentSessionId !== source) throw new Error('只能读取由本会话创建的委派会话');
    const agent = await this.agent(sessionId);
    const events = agent.session.snapshotEvents();
    const end = events.findLast(event => event.type === 'turn/end');
    const queued = agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0;
    const text = events.flatMap(event => event.type === 'assistant/message' ? event.data.message.content.flatMap(part => part.type === 'text' ? [part.text] : []) : []).join('\n\n');
    return { sessionId, harness: binding.harness, status: agent.status === 'running' ? 'running' : queued ? 'queued'
      : binding.pending || (binding.locked && !end) ? 'recovery-required' : end?.type === 'turn/end' ? end.data.reason.kind : 'idle',
      outcome: end?.type === 'turn/end' ? end.data.reason : null,
      // ponytail: return the latest 32k characters; the full transcript stays in the DSH session.
      text: text.slice(-32_000), truncated: text.length > 32_000,
    };
  }

  async select(raw: unknown) {
    const request = selectRequest.parse(raw);
    return this.bindings.serial(request.sessionId, async () => {
      const agent = await this.agent(request.sessionId);
      const current = await this.bindings.read(request.sessionId);
      if (current?.locked || !this.fresh(agent)) throw new Error('开始对话后不能切换 Harness，请新建会话');
      const defaults = await this.bindings.readDefaults();
      await this.bindings.writeDefaults({ ...defaults, harness: request.harness });
      if (request.harness === 'dsh') { await this.bindings.remove(request.sessionId); return this.view(); }
      return this.view(await this.bind(agent, request.sessionId, request.harness));
    });
  }

  private fresh(agent: Awaited<ReturnType<HarnessService['agent']>>): boolean {
    return agent.status !== 'running' && agent.inbox.nextTurn.length === 0 && agent.inbox.nextStep.length === 0
      && !agent.session.snapshotEvents().some(event => event.type === 'turn/start' || event.type === 'user/message');
  }

  /** Bind a fresh session to a Harness, seeding permission from the native sandbox and model / thinking from the last pick. */
  private async bind(agent: Awaited<ReturnType<HarnessService['agent']>>, sessionId: string, harness: Binding['harness'], overrides: Partial<Pick<Binding, 'permission' | 'delegation'>> = {}): Promise<Binding> {
    const cwd = agent.session.header.cwd;
    if (!cwd) throw new Error('请先连接工作目录');
    const binding: Binding = { version: 1, sessionId, harness, cwd, locked: false };
    const sandbox = this.ctx.get('sessionProjections')?.stateOf(agent.session, 'permissions')?.sandbox ?? this.ctx.get('shell')?.sandboxMode;
    const seeded = sandbox && NATIVE_PERMISSION_MODES[harness][sandbox];
    const remembered = (await this.bindings.readDefaults())[harness];
    if (seeded || remembered) {
      const inspection = await this.inspection(binding);
      if (!('error' in inspection)) {
        if (seeded && inspection.permissionModes?.modes.some(mode => mode.id === seeded)) binding.permission = harnessPermissionModeIdSchema.parse(seeded);
        // The last model / thinking picked for this Harness carries into the new session while the catalog still offers it.
        const model = remembered?.model && inspection.catalog.models.find(entry => entry.ref.id === remembered.model!.id);
        if (model) binding.model = remembered!.model;
        const allowed = model?.supportedThinkingOptionIds ?? inspection.catalog.thinkingOptions.map(option => option.id);
        if (remembered?.thinking && inspection.catalog.thinkingOptions.some(option => option.id === remembered.thinking) && allowed.includes(remembered.thinking)) binding.thinking = remembered.thinking;
      }
    }
    Object.assign(binding, overrides);
    await this.bindings.write(binding);
    return binding;
  }

  async models(raw: unknown) {
    const { sessionId } = address.parse(raw);
    await this.agent(sessionId);
    const binding = await this.bindings.read(sessionId);
    const empty = { models: [], defaultModel: null, thinkingOptions: [], defaultThinkingOptionId: null, permissionModes: [], defaultPermissionModeId: null };
    if (!binding) return { ...empty, error: null };
    const inspection = await this.inspection(binding);
    if ('error' in inspection) return { ...empty, error: inspection.error };
    const { catalog } = inspection;
    const fallback = catalog.defaultModel && catalog.models.find(model => model.ref.id === catalog.defaultModel!.id);
    return {
      models: catalog.models.map(model => ({ id: model.ref.id, label: model.label, resolved: model.resolvedModelLabel ?? null, thinkingOptionIds: model.supportedThinkingOptionIds ?? null })),
      defaultModel: catalog.defaultModel ? { id: catalog.defaultModel.id, label: fallback?.label ?? catalog.defaultModel.id, resolved: fallback?.resolvedModelLabel ?? null } : null,
      thinkingOptions: catalog.thinkingOptions.map(option => ({ id: option.id, label: option.label })),
      defaultThinkingOptionId: catalog.defaultThinkingOptionId ?? null,
      permissionModes: (inspection.permissionModes?.modes ?? []).map(mode => ({ id: mode.id, label: mode.label, dangerous: mode.dangerous === true })),
      defaultPermissionModeId: inspection.permissionModes?.defaultModeId ?? null,
      error: null,
    };
  }

  private async inspection(binding: Binding): Promise<Ready | { error: string }> {
    const key = `${binding.harness}\0${binding.cwd}`;
    const cached = this.catalogs.get(key);
    if (cached && cached.until > Date.now()) return cached.inspection;
    const result = await this.adapters[binding.harness].inspect({ cwd: binding.cwd });
    if (result.status !== 'ready') return { error: result.error.message };
    this.catalogs.set(key, { until: Date.now() + 60_000, inspection: result });
    return result;
  }
  private async catalog(binding: Binding) {
    const inspection = await this.inspection(binding);
    return 'error' in inspection ? inspection : inspection.catalog;
  }

  async selectModel(raw: unknown) {
    const request = modelRequest.parse(raw);
    return this.bindings.serial(request.sessionId, async () => {
      const agent = await this.agent(request.sessionId);
      const binding = await this.bindings.read(request.sessionId);
      if (!binding) throw new Error('请使用 DSH 原生模型选择器');
      if (agent.status === 'running' || (agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0) || binding.pending) throw new Error('请等待当前请求结束');
      const catalog = await this.catalog(binding);
      if ('error' in catalog) throw new Error(catalog.error);
      const entry = catalog.models.find(model => model.ref.id === request.model);
      if (!entry) throw new Error('Harness 未提供这个模型');
      const model = harnessModelRefSchema.parse({ id: request.model });
      const live = this.runner.live.get(request.sessionId);
      if (live) unwrap(await live.session.execute({ type: 'model.select', model }));
      binding.model = model;
      // A thinking level the new model does not support falls back to the Harness default.
      if (binding.thinking && entry.supportedThinkingOptionIds && !entry.supportedThinkingOptionIds.includes(binding.thinking)) delete binding.thinking;
      await this.bindings.write(binding);
      await this.remember(binding);
      return this.view(binding);
    });
  }

  async selectThinking(raw: unknown) {
    const request = thinkingRequest.parse(raw);
    return this.bindings.serial(request.sessionId, async () => {
      const agent = await this.agent(request.sessionId);
      const binding = await this.bindings.read(request.sessionId);
      if (!binding) throw new Error('请使用 DSH 原生模型选择器');
      if (agent.status === 'running' || (agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0) || binding.pending) throw new Error('请等待当前请求结束');
      const catalog = await this.catalog(binding);
      if ('error' in catalog) throw new Error(catalog.error);
      const modelId = binding.model?.id ?? catalog.defaultModel?.id;
      const model = catalog.models.find(entry => entry.ref.id === modelId);
      const allowed = model?.supportedThinkingOptionIds ?? catalog.thinkingOptions.map(option => option.id);
      if (!catalog.thinkingOptions.some(option => option.id === request.thinking) || !allowed.includes(harnessThinkingOptionIdSchema.parse(request.thinking))) {
        throw new Error('当前模型不支持这个推理强度');
      }
      const thinkingOptionId = harnessThinkingOptionIdSchema.parse(request.thinking);
      const live = this.runner.live.get(request.sessionId);
      if (live) unwrap(await live.session.execute({ type: 'thinking.select', thinkingOptionId }));
      binding.thinking = thinkingOptionId;
      await this.bindings.write(binding);
      await this.remember(binding);
      return this.view(binding);
    });
  }

  /** Persist the session's model / thinking as the Harness default for future sessions. */
  private async remember(binding: Binding): Promise<void> {
    const defaults = await this.bindings.readDefaults();
    await this.bindings.writeDefaults({ ...defaults, [binding.harness]: { ...(binding.model ? { model: binding.model } : {}), ...(binding.thinking ? { thinking: binding.thinking } : {}) } });
  }

  async selectPermission(raw: unknown) {
    const request = permissionRequest.parse(raw);
    return this.bindings.serial(request.sessionId, async () => {
      const agent = await this.agent(request.sessionId);
      const binding = await this.bindings.read(request.sessionId);
      if (!binding) throw new Error('请使用 DSH 原生权限选择器');
      if (agent.status === 'running' || (agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0) || binding.pending) throw new Error('请等待当前请求结束');
      const inspection = await this.inspection(binding);
      if ('error' in inspection) throw new Error(inspection.error);
      if (!inspection.permissionModes?.modes.some(mode => mode.id === request.permission)) throw new Error('这个 Harness 不支持切换权限模式');
      const permissionModeId = harnessPermissionModeIdSchema.parse(request.permission);
      const live = this.runner.live.get(request.sessionId);
      if (live) unwrap(await live.session.execute({ type: 'permissionMode.select', permissionModeId }));
      binding.permission = permissionModeId;
      await this.bindings.write(binding);
      return this.view(binding);
    });
  }

  async usage(raw: unknown) {
    const { sessionId } = address.parse(raw);
    await this.agent(sessionId);
    const live = this.runner.live.get(sessionId);
    // Claude Code only reads its context window when asked (the adapter rate-limits repeats); the reading lands as a usage event.
    await live?.session.refreshUsage?.().catch(() => {});
    const usage = live?.usage ?? (await this.bindings.read(sessionId))?.usage;
    if (!usage || (usage.contextUsedTokens === undefined && usage.totalTokens === undefined)) return null;
    return { contextUsedTokens: usage.contextUsedTokens ?? null, contextWindowTokens: usage.contextWindowTokens ?? null, totalTokens: usage.totalTokens ?? null };
  }

  async quota(raw: unknown): Promise<Quota> {
    const { sessionId } = address.parse(raw);
    const agent = await this.agent(sessionId);
    const binding = await this.bindings.read(sessionId);
    if (binding) {
      const adapter = this.adapters[binding.harness];
      if (!adapter.inspectAccount) return null;
      return this.cachedQuota(binding.harness, async () => accountQuota(await adapter.inspectAccount!(), binding.harness));
    }
    const route = await this.nativeRoute(agent);
    if (!route) return null;
    return this.cachedQuota(`native\0${route.source}\0${route.baseURL}`, () => fetchNativeQuota(route));
  }

  private cachedQuota(key: string, probe: () => Promise<Quota>): Promise<Quota> {
    const cached = this.quotas.get(key);
    if (cached && cached.until > Date.now()) return cached.work;
    const work = probe().catch(error => { this.quotas.delete(key); throw error; });
    this.quotas.set(key, { until: Date.now() + 60_000, work });
    return work;
  }

  /** Endpoint and key of the native provider the session currently routes to; null when the host exposes neither. */
  private async nativeRoute(agent: Awaited<ReturnType<HarnessService['agent']>>): Promise<NativeRoute | null> {
    const ctx = this.ctx;
    const selection = ctx.get('sessionProjections')?.stateOf(agent.session, 'modelSelection');
    const provider = selection?.pending?.provider ?? selection?.lastUsed?.provider ?? agent.session.requestHeader()?.config.provider
      ?? ctx.get('agentDefaultModel')?.currentSelection().provider;
    const settings = ctx.get('settings');
    if (!provider || !settings) return null;
    let baseURL: string | undefined, apiKeyEnv: string | undefined;
    if (provider === 'deepseek-official') {
      const section = (settings.get('llm-deepseek') ?? {}) as { baseURL?: string; apiKeyEnv?: string };
      baseURL = section.baseURL ?? process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com';
      apiKeyEnv = section.apiKeyEnv ?? 'DEEPSEEK_API_KEY';
    } else {
      const section = (settings.get('llm-pi-ai') ?? {}) as { providers?: Record<string, { baseURL?: string; apiKeyEnv?: string }> };
      baseURL = section.providers?.[provider]?.baseURL;
      apiKeyEnv = section.providers?.[provider]?.apiKeyEnv;
    }
    if (!baseURL || !apiKeyEnv) return null;
    const stored = await ctx.get('credentials')?.resolve(apiKeyEnv as never);
    const apiKey = stored?.value ?? process.env[apiKeyEnv];
    return apiKey ? { baseURL, apiKey, source: provider } : null;
  }

  private view(binding?: Binding) {
    return { harness: binding?.harness ?? 'dsh' as const, locked: binding?.locked ?? false,
      model: binding?.model?.id ?? null, thinking: binding?.thinking ?? null, permission: binding?.permission ?? null, recoveryRequired: !!binding?.pending };
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

/** Flattens the shared account snapshot into quota windows: the primary credits window first, then per-product windows. */
export function accountQuota(snapshot: HarnessAccountSnapshot | null, source: string): Quota {
  if (!snapshot) return null;
  const { credits } = snapshot;
  const windows: QuotaWindow[] = [{ id: credits.periodType, label: credits.label ?? credits.periodType, usedPercent: credits.usedPercent, resetsAt: credits.resetsAt ?? null }];
  for (const product of credits.productUsage ?? []) {
    windows.push({ id: `product:${product.product}`, label: product.product, usedPercent: product.usagePercent, resetsAt: product.resetsAt ?? null });
  }
  return { kind: 'windows', source, plan: snapshot.plan ?? null, windows };
}
