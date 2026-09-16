import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { TypertRemoteService, RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import { SessionId } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller';
import { defineTool } from '@deepseek-ai/dsh-tools';
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
import type {} from '@deepseek-ai/dsh-attachment';
import type {} from '@deepseek-ai/dsh-client-file-upload';
import type {} from '@deepseek-ai/dsh-session-title';
import type {} from '@deepseek-ai/dsh-agent-presets/types';
import { harnessModelRefSchema, harnessThinkingOptionIdSchema, harnessPermissionModeIdSchema, type HarnessAccountSnapshot } from './contracts.js';
import { z } from 'zod';
import { Bindings, type Binding } from './bindings.js';
import { AcpAdapter } from './acp-adapter.js';
import { claudeProfile, codexProfile } from './acp-profiles.js';
import { DshRunner, unwrap } from './dsh-runner.js';
import { fetchNativeQuota, type NativeRoute, type Quota, type QuotaWindow } from './native-quota.js';
import { address, contribution, selectRequest, modelRequest, thinkingRequest, permissionRequest, secretAnswerRequest, recoveryRequest } from './remote.js';
import { DelegationBridge, delegationRequest, delegationReadRequest } from './delegation.js';

export const inject = ['sessionController', 'sessions', 'agents', 'typert', 'userQuestions', 'attachments', 'fileUploads'];
export const configSchema = z.object({
  root: z.string().optional(), codexCommand: z.string().min(1).default('codex'),
}).strict();
declare module '@deepseek-ai/cordis' { interface Context { harness: HarnessService } }

/** Standalone DSH entry: no replacement of the original client/plugin row. */
export async function apply(ctx: Context, rawConfig: unknown = {}): Promise<void> {
  const config = configSchema.parse(rawConfig);
  const environment = { ...process.env };
  const adapters = {
    codex: new AcpAdapter({ profile: codexProfile({ command: config.codexCommand, environment }), environment }),
    'claude-code': new AcpAdapter({ profile: claudeProfile({ environment }), environment }),
  };
  new HarnessService(ctx, resolve(config.root ?? resolve(process.env.DSH_HOME ?? resolve(homedir(), '.dsh'), 'harness-plugin')), adapters);
}

type Ready = Extract<HarnessInspection, { status: 'ready' }>;

// DSH native sandbox mode -> the Harness permission mode it most closely matches, so switching Harness keeps the
// permission the user already picked. Claude Code has no sandbox tiers below full access; those fall to its default.
const NATIVE_PERMISSION_MODES: Record<Binding['harness'], Record<string, string>> = {
  codex: { 'read-only': 'read-only', 'workspace-write': 'agent', 'danger-full-access': 'agent-full-access' },
  'claude-code': { 'danger-full-access': 'bypassPermissions' },
};
/** Full access on either side maps to full access on the other. */
const FULL_ACCESS: Record<Binding['harness'], string> = { codex: 'agent-full-access', 'claude-code': 'bypassPermissions' };
/** Cross-harness delegation below full access still lets the child work: Codex auto-approves, Claude Code accepts edits. */
const DELEGATED: Record<Binding['harness'], string> = { codex: 'agent', 'claude-code': 'acceptEdits' };

export class HarnessService extends TypertRemoteService {
  readonly bindings: Bindings;
  readonly runner: DshRunner;
  readonly delegation: DelegationBridge;
  private stopped = false;
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
      this.stopped = true;
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
    ctx.on('agent/inbox/inserted', ({ agent }) => { this.runner.drainSteering(agent); });
    ctx.on('session/event', (session, event) => {
      if (event.type === 'turn/end') void this.notifyDelegation(session.id).catch(() => {});
    });
    ctx.on('agent/created', async ({ agent }) => { void agent.whenIdle().then(() => this.notifyDelegation(agent.id)).catch(() => {}); });
    ctx.inject(['tools'], scope => {
      scope.tools.register(defineTool({
        name: 'harness_delegate', description: '用户明确要求把工作（实现、修复、调研、审查等）委派给 Codex 或 Claude Code 时，创建同工作区的可见独立会话。新会话没有本会话历史，prompt 须写全目标、范围、约束和验收要求。完成后自动唤醒来源会话；重试保持 requestId 和所有参数不变。',
        parameters: { requestId: { type: 'string', required: true }, harness: { type: 'string', enum: ['codex', 'claude-code'], required: true }, prompt: { type: 'string', required: true },
          title: { type: 'string', description: '可选的简短任务标题，显示在会话列表' } },
        output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
        execute: async (args, exec) => { if (!exec.agent) throw new Error('委派需要来源会话'); return JSON.stringify(await this.delegate(exec.agent.id, args)); },
      }));
      scope.tools.register(defineTool({
        name: 'harness_delegate_read', description: '分页读取本会话创建的委派结果。首次省略 offset/throughSeq；按 nextOffset 和 throughSeq 读到末尾。',
        parameters: { sessionId: { type: 'string', required: true }, offset: { type: 'integer' }, throughSeq: { type: 'integer' } },
        output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
        execute: async (args, exec) => { if (!exec.agent) throw new Error('查询需要来源会话'); return JSON.stringify(await this.readDelegation(exec.agent.id, args)); },
      }));
    });
    this.wrapCommands(ctx);
    ctx.inject(['sessionSkillCatalog'], scope => {
      const catalog = scope.sessionSkillCatalog;
      const descriptor = Object.getOwnPropertyDescriptor(catalog, 'list');
      const original = catalog.list.bind(catalog);
      const list: typeof catalog.list = async (request, signal) => {
        signal.throwIfAborted();
        // Resolve remembered Harness selection before the composer's scope-birth prewarm.
        await this.state(request);
        return this.bindings.serial(request.sessionId, async () => {
          signal.throwIfAborted();
          const binding = await this.bindings.read(request.sessionId);
          if (!binding) return original(request, signal);
          // A live native session already holds the agent's current command list; otherwise a short probe reads it.
          const live = this.runner.live.get(request.sessionId)?.session;
          const skills = live?.listSkills ? await live.listSkills() : await this.adapters[binding.harness].listSkills({ cwd: binding.cwd });
          signal.throwIfAborted();
          return { skills };
        });
      };
      scope.effect(() => {
        catalog.list = list;
        return () => {
          if (Object.getOwnPropertyDescriptor(catalog, 'list')?.value !== list) return;
          if (descriptor) Object.defineProperty(catalog, 'list', descriptor); else Reflect.deleteProperty(catalog, 'list');
        };
      }, 'harness: session skill catalog');
    });
    void this.bindings.delegated().then(bindings => Promise.allSettled(bindings.map(binding => this.notifyDelegation(binding.sessionId)))).catch(() => {});
  }

  private async withSession<T>(binding: Binding, work: (session: import('./contracts.js').HarnessSession) => Promise<T>): Promise<T> {
    const live = this.runner.live.get(binding.sessionId);
    if (live) return work(live.session);
    if (!binding.nativeRef) throw new Error('尚未保存原生会话身份，无法读取或分支');
    const session = unwrap(await this.adapters[binding.harness].open({ kind: 'resume', cwd: binding.cwd, nativeRef: binding.nativeRef,
      ...(binding.model ? { model: binding.model } : {}), ...(binding.thinking ? { thinkingOptionId: binding.thinking } : {}),
      ...(binding.permission ? { permissionModeId: binding.permission } : {}) }));
    try { return await work(session); } finally { await session.close(); }
  }

  async recover(raw: unknown) {
    const { sessionId, action } = recoveryRequest.parse(raw);
    return this.bindings.serial(sessionId, async () => {
      const agent = await this.agent(sessionId), binding = await this.bindings.read(sessionId);
      if (!binding?.pending) return { ...this.view(binding), detail: '没有待恢复的请求' };
      if (agent.status === 'running' || agent.inbox.nextTurn.length || agent.inbox.nextStep.length) throw new Error('请先等待会话停止');
      let detail = '无法确认原请求的执行结果；没有重发任何请求。';
      let confirmed = false;
      if (binding.nativeRef && binding.pendingNative) {
        try {
          const snapshot = await this.withSession(binding, async session => {
            if (!session.readSnapshot) throw new Error('Harness 不支持读取原生记录');
            return unwrap(await session.readSnapshot());
          });
          const index = snapshot.turns.findIndex(turn => turn.nativeTurnRef.nativeTurnKey === binding.pendingNative);
          const tail = index < 0 ? [] : snapshot.turns.slice(index);
          const turn = tail.at(-1);
          if (turn && tail.every(turn => turn.outcome.status !== 'unknown')) {
            confirmed = true;
            const text = tail.flatMap(turn => turn.items.flatMap(entry => entry.item.type === 'agentMessage' ? [entry.item.text] : [])).join('\n');
            detail = `已核对原生记录：${turn.outcome.status}。${text ? `\n原生回复：\n${text}` : ''}`;
          }
        } catch { /* Unavailable history is not evidence that resubmission is safe. */ }
      }
      if (confirmed || action === 'unlock') {
        const live = this.runner.live.get(sessionId);
        if (live) { await live.session.close(); this.runner.live.delete(sessionId); }
        const marker = `Harness recovery ${binding.pending}`;
        if (!agent.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.source.kind === 'plugin' && event.data.source.form === 'notice' && event.data.source.summary === marker)) {
          agent.session.append('user/message', createUserMessage({ source: { kind: 'plugin', plugin: 'dsh-harness-provider', form: 'notice', summary: marker },
            content: [{ type: 'text', text: confirmed ? detail : '用户已手动解除暂停，保留原生上下文；上次请求结果仍不明确，未重发。' }] }), { surfaceOp: 'append' });
          await this.ctx.sessions.flush(agent.session);
        }
        const turnNumber = Number(binding.pending.split(':').at(-1));
        if (binding.pendingNative && Number.isSafeInteger(turnNumber)) binding.turns = [...(binding.turns ?? []).filter(entry => entry.turn !== turnNumber), { turn: turnNumber, key: binding.pendingNative }];
        delete binding.pending; delete binding.pendingNative;
        await this.bindings.write(binding);
      }
      if (!binding.pending) void this.bindings.delegated().then(bindings => Promise.allSettled(bindings.filter(child => child.delegation?.parentSessionId === sessionId).map(child => this.notifyDelegation(child.sessionId)))).catch(() => {});
      return { ...this.view(binding), detail };
    });
  }

  async rollback(raw: unknown) {
    const { sessionId } = address.parse(raw);
    return this.bindings.serial(sessionId, async () => {
      const agent = await this.agent(sessionId), binding = await this.bindings.read(sessionId);
      if (!binding || binding.pending || agent.status === 'running' || agent.inbox.nextTurn.length || agent.inbox.nextStep.length) throw new Error('请先结束当前请求并处理未确认结果');
      const ref = await this.withSession(binding, async session => {
        if (!session.fork || !session.readSnapshot) throw new Error('Harness 未提供历史操作');
        const snapshot = unwrap(await session.readSnapshot());
        if (!snapshot.turns.length) throw new Error('没有可回滚的对话');
        const currentKey = binding.turns?.at(-1)?.key;
        const index = currentKey ? snapshot.turns.findIndex(turn => turn.nativeTurnRef.nativeTurnKey === currentKey) : snapshot.turns.length - 1;
        if (index < 0) throw new Error('无法确认最后一轮的原生边界');
        const previous = snapshot.turns[index - 1]?.nativeTurnRef.nativeTurnKey;
        return unwrap(await session.fork(previous ?? null));
      });
      const live = this.runner.live.get(sessionId);
      if (live) { await live.session.close(); this.runner.live.delete(sessionId); }
      if (ref) binding.nativeRef = ref; else delete binding.nativeRef;
      binding.turns = (binding.turns ?? []).slice(0, -1);
      delete binding.usage;
      await this.bindings.write(binding);
      agent.session.append('user/message', createUserMessage({ source: { kind: 'plugin', plugin: 'dsh-harness-provider', form: 'notice', summary: '对话已回滚' },
        content: [{ type: 'text', text: '已撤销最后一轮原生对话上下文，工作区文件保持原状。上方原记录保留供查阅，后续对话从回滚位置继续。' }] }), { surfaceOp: 'append' });
      await this.ctx.sessions.flush(agent.session);
      return this.view(binding);
    });
  }

  async secretStatus(raw: unknown) {
    const { sessionId } = address.parse(raw);
    await this.agent(sessionId);
    return this.runner.secrets.read(sessionId);
  }
  async answerSecret(raw: unknown) {
    const { sessionId, id, answers, cancelled } = secretAnswerRequest.parse(raw);
    await this.agent(sessionId);
    this.runner.secrets.answer(sessionId, id, { type: 'question', answers, ...(cancelled ? { cancelled } : {}) });
    return { accepted: true };
  }

  async state(raw: unknown) {
    const { sessionId } = address.parse(raw);
    const agent = await this.agent(sessionId); // Same authorization/ownership rules as native Session commands.
    const binding = await this.bindings.read(sessionId);
    if (binding?.pending && agent.status !== 'running' && !agent.inbox.nextTurn.length && !agent.inbox.nextStep.length) {
      await this.recover({ sessionId, action: 'check' });
      return this.view(await this.bindings.read(sessionId));
    }
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
    if ((await this.bindings.read(source))?.delegation) throw new Error('委派子会话不能再次委派；请返回来源会话继续处理');
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
          const nativeSandbox = this.ctx.get('sessionProjections')?.stateOf(parent.session, 'permissions')?.sandbox ?? this.ctx.get('shell')?.sandboxMode;
          const permission = !parentBinding && nativeSandbox ? NATIVE_PERMISSION_MODES[request.harness][nativeSandbox]
            : parentBinding?.harness === request.harness ? parentBinding.permission
            : parentBinding && parentBinding.permission === FULL_ACCESS[parentBinding.harness] ? FULL_ACCESS[request.harness] : DELEGATED[request.harness];
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
              title: request.title ?? `${request.harness === 'codex' ? 'Codex' : 'Claude Code'} · ${request.prompt.split('\n').find(line => line.trim())!.trim().slice(0, 40)}` });
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
    const { sessionId, offset, limit, throughSeq } = delegationReadRequest.parse(raw);
    const binding = await this.bindings.read(sessionId);
    if (binding?.delegation?.parentSessionId !== source) throw new Error('只能读取由本会话创建的委派会话');
    const agent = await this.agent(sessionId);
    const all = agent.session.snapshotEvents();
    const boundary = throughSeq ?? all.at(-1)?.seq ?? 0;
    const events = all.filter(event => event.seq <= boundary);
    const end = events.findLast(event => event.type === 'turn/end');
    const queued = agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0;
    const text = events.flatMap(event => event.type === 'assistant/message' ? event.data.message.content.flatMap(part => part.type === 'text' ? [part.text] : []) : []).join('\n\n');
    return { sessionId, harness: binding.harness, status: agent.status === 'running' ? 'running' : queued ? 'queued'
      : binding.pending || (binding.locked && !end) ? 'recovery-required' : end?.type === 'turn/end' ? end.data.reason.kind : 'idle',
      outcome: end?.type === 'turn/end' ? end.data.reason : null,
      text: text.slice(offset, offset + limit), truncated: offset + limit < text.length, totalChars: text.length, throughSeq: boundary,
      nextOffset: offset + limit < text.length ? offset + limit : null,
    };
  }

  private async notifyDelegation(id: string): Promise<void> {
    await this.bindings.serial(`notify:${id}`, async () => {
      if (!(await this.bindings.read(id))?.delegation) return;
      const child = await this.agent(id);
      await child.whenIdle();
      const binding = await this.bindings.read(id);
      if (!binding?.delegation) return;
      const end = child.session.snapshotEvents().findLast(event => event.type === 'turn/end');
      if (!end || (binding.delegation.notifiedSeq ?? -1) >= end.seq) return;
      const parentId = binding.delegation.parentSessionId;
      if ((await this.bindings.read(parentId))?.pending && this.ctx.agents.get(SessionId(parentId))?.status !== 'running') return;
      const parent = await this.agent(parentId);
      if (this.stopped) return;
      const marker = `DSH delegation ${id}:${end.seq}`;
      const delivered = (message: { source: unknown }) => { const source = message.source as { kind?: string; summary?: string }; return source.kind === 'plugin' && source.summary === marker; };
      if (!parent.inbox.nextTurn.some(delivered) && !parent.inbox.nextStep.some(delivered)
        && !parent.session.snapshotEvents().some(event => event.type === 'user/message' && delivered(event.data))) {
        parent.followup(createUserMessage({ source: { kind: 'plugin', plugin: 'dsh-harness-provider', form: 'notice', summary: marker },
          content: [{ type: 'text', text: `委派会话 ${id} 已结束，状态：${end.data.reason.kind}。请使用委派查询入口分页读取完整结果，然后继续原任务。不要重复创建该任务。` }] }));
        await this.ctx.sessions.flush(parent.session);
      }
      binding.delegation.notifiedSeq = end.seq;
      await this.bindings.write(binding);
    });
  }

  async select(raw: unknown) {
    const request = selectRequest.parse(raw);
    return this.bindings.serial(request.sessionId, async () => {
      const agent = await this.agent(request.sessionId);
      const current = await this.bindings.read(request.sessionId);
      if (current?.locked || !this.fresh(agent)) throw new Error('开始对话后不能切换 Harness，请新建会话');
      const defaults = await this.bindings.readDefaults();
      await this.bindings.writeDefaults({ ...defaults, harness: request.harness });
      let binding: Binding | undefined;
      if (request.harness === 'dsh') await this.bindings.remove(request.sessionId);
      else binding = await this.bind(agent, request.sessionId, request.harness);
      // ponytail: DSH 0.1.6 only exposes preset-event invalidation; use a skill-specific event when available.
      // Re-announce the unchanged preset; no preset selection or durable event is written.
      const preset = this.ctx.get('sessionProjections')?.stateOf(agent.session, 'agentPreset') ?? agent.session.header.agentPreset;
      this.ctx.emit('agent-preset/selected', SessionId(request.sessionId), preset ?? '');
      return this.view(binding);
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
      if (!request.content.some(part => part.type !== 'text' || part.text.trim())) throw new RemoteError('gateway/bad-request', '请输入文字或上传附件', {});
      const agent = await this.agent(request.sessionId);
      const matches = (message: { source: unknown }) => {
        const source = message.source as { kind?: string; rpcId?: string };
        return source.kind === 'user' && source.rpcId === request.requestId;
      };
      if (this.runner.pendingSteering(request.sessionId).some(matches) || agent.inbox.nextTurn.some(matches) || agent.inbox.nextStep.some(matches)
        || agent.session.snapshotEvents().some(event => event.type === 'user/message' && matches(event.data))) return { accepted: true };
      if (binding.pending && agent.status !== 'running') throw new RemoteError('gateway/bad-request', '上次 Harness 请求结果未确认，已暂停发送以避免重复执行', {});
      if (!binding.locked) { binding.locked = true; await this.bindings.write(binding); }
      signal.throwIfAborted();
      const receiptIds = request.content.flatMap(part => part.type === 'file' ? [part.receiptId] : []);
      const admission = request.content.map(part => {
        if (part.type !== 'file') return part;
        const attachment = ctx.fileUploads.resolve(agent, part.receiptId);
        if (!attachment) throw new RemoteError('session/attachment-invalid', '附件不属于当前会话或上传已过期', { reason: 'FILE_NOT_STAGED' });
        return { type: 'file' as const, attachment };
      });
      const content = admission.every(part => part.type === 'text') ? admission : await ctx.attachments.admitPromptContent(admission);
      signal.throwIfAborted();
      if (ctx.agents.get(agent.id) !== agent) throw new Error('会话已关闭');
      const receiptBinding = receiptIds.length ? ctx.fileUploads.bindPrompt(agent, receiptIds, request.requestId) : undefined;
      try {
        const message = createUserMessage({ content, source: { kind: 'user', rpcId: request.requestId,
          ...(request.clientTimeZone ? { clientTimeZone: request.clientTimeZone } : {}) } });
        if (request.mode === 'steer') agent.steer(message); else agent.followup(message);
        receiptBinding?.commit();
      } finally { receiptBinding?.[Symbol.dispose](); }
      return { accepted: true };
    });
    const fork: typeof controller.fork = async request => {
      return this.bindings.serial(request.sessionId, async () => {
        const binding = await this.bindings.read(request.sessionId);
        if (!binding) return native.fork(request);
        const agent = await this.agent(request.sessionId);
        if (binding.pending || agent.status === 'running' || agent.inbox.nextTurn.length || agent.inbox.nextStep.length) throw new Error('请先等待当前请求结束');
        let throughTurn: string | undefined;
        if (request.atSeq !== undefined) {
          const boundary = agent.session.snapshotEvents().find(event => event.type === 'turn/end' && event.seq >= request.atSeq!);
          throughTurn = boundary?.type === 'turn/end' ? binding.turns?.find(entry => entry.turn === boundary.data.turn)?.key : undefined;
          if (!throughTurn) throw new Error('所选位置没有可确认的原生轮次边界，请选择更新后的已完成轮次');
        }
        const nativeRef = await this.withSession(binding, async session => {
          if (!session.fork) throw new Error('Harness 未提供原生会话分支');
          let nativeBoundary = throughTurn;
          if (throughTurn && session.readSnapshot) {
            const history = unwrap(await session.readSnapshot()).turns;
            const nextKey = binding.turns?.[(binding.turns.findIndex(entry => entry.key === throughTurn)) + 1]?.key;
            const next = nextKey ? history.findIndex(turn => turn.nativeTurnRef.nativeTurnKey === nextKey) : history.length;
            if (next < 1) throw new Error('无法确认分支末尾的原生边界');
            nativeBoundary = history[next - 1]?.nativeTurnRef.nativeTurnKey;
          }
          return unwrap(await session.fork(nativeBoundary));
        });
        const child = await native.fork(request);
        await this.bindings.serial(child.sessionId, async () => {
          const cut = throughTurn ? (binding.turns ?? []).findIndex(entry => entry.key === throughTurn) + 1 : binding.turns?.length;
          await this.bindings.write({ ...binding, sessionId: child.sessionId, nativeRef, delegation: undefined, turns: binding.turns?.slice(0, cut) });
        });
        return child;
      });
    };
    const selectModel: typeof controller.selectModel = async request => {
      if (await this.bindings.read(request.sessionId)) throw new RemoteError('gateway/bad-request', '请使用 Harness 模型选择器', {});
      return native.selectModel(request);
    };
    // Synchronous queue API cannot read a sidecar. For attached external sessions the runner owns this identity.
    const updateQueue: typeof controller.updateQueue = request => {
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
