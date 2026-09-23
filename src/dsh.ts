import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { TypertRemoteService, RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import { SessionId } from '@deepseek-ai/dsh-session';
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm';
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
import type { FileUploadReceiptId } from '@deepseek-ai/dsh-client-file-upload/types';
import type {} from '@deepseek-ai/dsh-session-title';
import type {} from '@deepseek-ai/dsh-agent-preset-registry/types';
import type {} from '@deepseek-ai/dsh-subagent';
import type {} from '@deepseek-ai/dsh-session-query';
import type {} from '@deepseek-ai/dsh-commands';
import type { CommandDescriptor, CommandExecution, CommandSubmitAttachment } from '@deepseek-ai/dsh-commands/types';
import type {} from '@deepseek-ai/dsh-session-reference';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { HarnessPlugin, HarnessSubagent } from './contracts.js';
import { harnessModelRefSchema, harnessThinkingOptionIdSchema, harnessPermissionModeIdSchema, type HarnessAccountSnapshot } from './contracts.js';
import { z } from 'zod';
import { Bindings, DISCUSSION_PERMISSION, type Binding } from './bindings.js';
import { AcpAdapter, SUBAGENT_ENTRY_LIMIT, SUBAGENT_LIMIT, SUBAGENT_OUTPUT_LIMIT } from './acp-adapter.js';
import { claudeProfile, codexProfile } from './acp-profiles.js';
import { DshRunner, unwrap } from './dsh-runner.js';
import { fetchNativeQuota, nativeQuotaRoute, type NativeRoute, type Quota, type QuotaWindow } from './native-quota.js';
import { address, contribution, selectRequest, modelPick, modelRequest, modelsRequest, thinkingRequest, permissionRequest, configRequest, secretAnswerRequest, recoveryRequest, harnessesRequest, editRequest, delegateFromUserRequest, startDiscussionFromUserRequest } from './remote.js';
import { DelegationBridge, delegationRequest, delegationReadRequest, discussionRequest } from './delegation.js';
import { createWorktree, mergeWorktree, removeWorktree, worktreeChanged } from './worktree.js';
import { Config, defaultSettings, settingsOf, type SettingsSource } from './settings.js';

/** DSH commands a Harness session keeps: the row stays DSH's, the work runs on the Harness's own command or mode. */
const HARNESS_COMMANDS = new Set(['goal', 'plan', 'compact', 'clear']);
const CLEAR_COMMAND: CommandDescriptor = { name: 'clear', description: 'Clear the Harness context' };

export const inject = ['sessionController', 'sessions', 'agents', 'typert', 'userQuestions', 'attachments', 'fileUploads'];
export { Config };
declare module '@deepseek-ai/cordis' { interface Context { harness: HarnessService } }

/** Standalone DSH entry: no replacement of the original client/plugin row. The Loader hands over `Config`-parsed options. */
export async function apply(ctx: Context, config: ReturnType<typeof Config> = Config({})): Promise<void> {
  const settings = settingsOf(config);
  const environment = { ...process.env };
  const adapters = {
    codex: new AcpAdapter({ profile: codexProfile({ environment, settings }), environment }),
    'claude-code': new AcpAdapter({ profile: claudeProfile({ environment, settings }), environment }),
  };
  new HarnessService(ctx, resolve(config.root ?? resolve(process.env.DSH_HOME ?? resolve(homedir(), '.dsh'), 'harness-plugin')), adapters, settings);
  // The plugin ships its own Settings page, so DSH need not build one from the schema; without Settings it runs unchanged.
  ctx.inject(['settings'], scope => { scope.effect(() => scope.settings.configure({ auto: false }, ctx.fiber), 'harness: settings page policy'); });
}

type Ready = Extract<HarnessInspection, { status: 'ready' }>;
type DiscussionResult = { peerReview: boolean; participants: Array<{ sessionId: string; harness: Binding['harness'] | 'dsh'; role?: string; task: string; status: string; text: string }> };

const userMessageAt = (events: readonly SessionEvent[], rpcId: string) => events.findIndex(event =>
  event.type === 'user/message' && event.data.source.kind === 'user' && 'rpcId' in event.data.source && event.data.source.rpcId === rpcId);

/** Replaces a Service method for the scope's lifetime; a later plugin's replacement is left intact on dispose. */
function override<T extends object, K extends keyof T>(scope: Context, target: T, key: K, replacement: T[K], label: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  scope.effect(() => {
    target[key] = replacement;
    return () => {
      if (Object.getOwnPropertyDescriptor(target, key)?.value !== replacement) return;
      if (descriptor) Object.defineProperty(target, key, descriptor); else Reflect.deleteProperty(target, key);
    };
  }, label);
}

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

/** One DSH child session as a sidebar subagent: its first prompt is the task, its messages, reasoning and tool calls the entries. */
export function nativeSubagent(child: { id: string; parentId: string | null; label?: string | undefined; running: boolean }, events: readonly SessionEvent[]): HarnessSubagent {
  const entries: HarnessSubagent['entries'] = [], tools = new Map<string, Extract<HarnessSubagent['entries'][number], { kind: 'tool' }>>();
  let task: string | null = null, end: string | undefined;
  const textOf = (blocks: readonly { type: string; text?: unknown }[]) => blocks.flatMap(block => block.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('\n');
  for (const event of events) {
    if (event.type === 'user/message' && task === null) task = textOf(event.data.content).trim() || null;
    else if (event.type === 'assistant/message') for (const block of event.data.message.content) {
      if ((block.type === 'text' || block.type === 'reasoning') && 'text' in block && typeof block.text === 'string' && block.text.trim()) entries.push({ kind: block.type === 'text' ? 'message' : 'thought', text: block.text });
      else if (block.type === 'tool-call') {
        const args = (() => { try { return JSON.parse(block.arguments) as Record<string, unknown>; } catch { return {}; } })();
        const detail = ['description', 'command', 'file_path', 'path', 'pattern', 'query', 'url'].map(key => args[key]).find(value => typeof value === 'string' && value.trim());
        const entry = { kind: 'tool' as const, title: (detail ? `${block.name} · ${String(detail)}` : block.name).slice(0, 200), status: 'running' as const, output: null };
        tools.set(block.id, entry); entries.push(entry);
      }
    } else if (event.type === 'tool/result') {
      const result = event.data.message, entry = tools.get(result.toolCallId);
      if (entry) Object.assign(entry, { status: result.isError ? 'failed' : 'completed', output: textOf(result.content).slice(0, SUBAGENT_OUTPUT_LIMIT) || null });
    } else if (event.type === 'turn/end') end = event.data.reason.kind;
  }
  const status = child.running || end === undefined ? 'running' : end === 'completed' || end === 'max-tokens' ? 'completed' : end === 'aborted' ? 'cancelled' : 'failed';
  if (status !== 'running') for (const entry of tools.values()) if (entry.status === 'running') entry.status = 'failed';
  return { id: child.id, parentId: child.parentId, name: child.label ?? task?.split('\n')[0]!.slice(0, 80) ?? 'Subagent', task, status, entries: entries.slice(-SUBAGENT_ENTRY_LIMIT) };
}

export class HarnessService extends TypertRemoteService {
  readonly bindings: Bindings;
  readonly runner: DshRunner;
  readonly delegation: DelegationBridge;
  private stopped = false;
  // ponytail: per-cwd catalog cache; each inspect spawns a native process. In-flight probes are shared, failures kept 10s.
  private readonly catalogs = new Map<string, { until: number; work: Promise<Ready | { error: string }> }>();
  // ponytail: per-session automatic recovery check; each check loads native history in a new agent process.
  private readonly checks = new Map<string, { until: number; work: Promise<void> }>();
  // ponytail: per-Harness+cwd plugin catalog cache for the `@` menu; installs show up within 30s, failures are not kept.
  private readonly pluginCatalogs = new Map<string, { until: number; plugins: Promise<HarnessPlugin[]> }>();
  // ponytail: per-source quota cache; account probes are rate-limited upstream and identical across sessions.
  private readonly quotas = new Map<string, { until: number; work: Promise<Quota> }>();
  // External Harness account quota, one per harness: probing spawns a throwaway CLI process, so it goes stale-while-revalidate.
  private readonly harnessQuotas = new Map<Binding['harness'], HarnessQuotaCache>();
  // One user-authorized discussion per source turn; retries share the same work instead of spawning more sessions.
  private readonly discussions = new Map<string, { requestId: string; content: ContentBlock[]; harnesses?: Binding['harness'][]; inputHash?: string; work?: Promise<DiscussionResult> }>();
  // ponytail: in memory; a restart while the source runs the skill drops the hand-off, and the user delegates again.
  private readonly handoffs = new Map<string, { request: z.infer<typeof delegateFromUserRequest>; skill: string; content: ContentBlock[] }>();
  private readonly worktrees: string;
  constructor(ctx: Context, root: string, private readonly adapters: Record<Binding['harness'], HarnessAdapter>, private readonly settings: SettingsSource = defaultSettings) {
    super(ctx, 'harness');
    this.worktrees = resolve(root, 'worktrees');
    this.bindings = new Bindings(root);
    this.delegation = new DelegationBridge((source, method, input) => method === 'create' ? this.delegate(source, input) : method === 'discuss' ? this.discuss(source, input)
      : method === 'models' ? this.delegationModels(source) : this.readDelegation(source, input), () => settings().discussionTimeoutMinutes * 60_000);
    this.runner = new DshRunner(ctx, this.bindings, adapters, this.delegation, undefined, () => settings().idleCloseSeconds * 1000, () => settings().branchContextChars);
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
    }, { prepend: true }); // Own the step before native middleware can append context to the empty completion.
    ctx.on('agent/inbox/inserted', ({ agent }) => { this.runner.drainSteering(agent); });
    ctx.on('session/event', (session, event) => {
      if (event.type === 'turn/end') {
        this.discussions.delete(session.id);
        void this.finishHandoff(session.id).catch(error => console.error('[harness] delegation after skill failed:', error));
        void this.notifyDelegation(session.id).catch(() => {});
        void this.offerWorktreeMerge(session.id).catch(() => {});
        void this.refreshHarnessQuota(session.id).catch(() => {});
      }
    });
    ctx.on('agent/created', async ({ agent }) => { void agent.whenIdle().then(() => this.notifyDelegation(agent.id)).catch(() => {}); });
    ctx.inject(['tools'], scope => {
      scope.tools.register(defineTool({
        name: 'harness_delegate_read', description: '收到完成通知后，分页读取本会话创建的委派结果；运行中不要定时读取。首次省略 offset/throughSeq；按 nextOffset 和 throughSeq 读到末尾。状态为 not-started 或 interrupted 时提醒用户进入目标会话处理，不要自动重发。',
        parameters: { sessionId: { type: 'string', required: true }, offset: { type: 'integer' }, throughSeq: { type: 'integer' } },
        output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
        execute: async (args, exec) => { if (!exec.agent) throw new Error('查询需要来源会话'); return JSON.stringify(await this.readDelegation(exec.agent.id, args)); },
      }));
      scope.tools.register(defineTool({
        name: 'harness_discussion_dispatch', description: '仅当用户在当前轮明确使用 /discuss 开启讨论模式时调用一次。根据任务并发性选择 1–4 个 Codex 或 Claude Code 只读参与者并给出各自分工；DSH 原生暂不支持。1 个直接执行，多个会话会自动互评一轮。等待返回后由你综合最终答案。普通委派不得调用此入口。可按每项分工的复杂度填写 model 与 thinking（取值先用 harness_models 查询；简单分工选较轻的模型或较低强度，复杂分工选更强的模型或更高强度），省略时沿用该 Harness 上次的选择。',
        parameters: { assignments: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
          harness: { type: 'string', required: true, enum: ['dsh', 'codex', 'claude-code'] }, role: { type: 'string' }, task: { type: 'string', required: true },
          model: { type: 'string' }, thinking: { type: 'string' },
        } } } },
        output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
        execute: async (args, exec) => { if (!exec.agent) throw new Error('讨论需要来源会话'); return JSON.stringify(await this.discuss(exec.agent.id, args)); },
      }));
      scope.tools.register(defineTool({
        name: 'harness_models', description: '查询 Codex / Claude Code 在当前工作区可用的模型与推理强度，供 harness_discussion_dispatch 为参与者填写 model 与 thinking。',
        parameters: {},
        output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
        execute: async (_args, exec) => { if (!exec.agent) throw new Error('查询需要来源会话'); return JSON.stringify(await this.delegationModels(exec.agent.id)); },
      }));
    });
    this.wrapCommands(ctx);
    ctx.inject(['sessionSkillCatalog'], scope => {
      const catalog = scope.sessionSkillCatalog;
      const original = catalog.list.bind(catalog);
      override(scope, catalog, 'list', async (request, signal) => {
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
          // The kept DSH rows already carry these; the native entries would list them twice.
          return { skills: skills.filter(skill => !HARNESS_COMMANDS.has(skill.name)) };
        });
      }, 'harness: session skill catalog');
    });
    // A Harness session keeps only the DSH commands every Harness can carry out (`/goal`, `/plan`, `/compact`, `/clear`), run on the
    // Harness itself; the rest act on DSH's agent loop and stay hidden, so their `/…` line reaches the Harness as a prompt.
    // The Remote gateway awaits these methods, so the async overrides keep their wire shape.
    ctx.inject(['commands'], scope => {
      const commands = scope.commands;
      const list = commands.list.bind(commands), execute = commands.execute.bind(commands);
      override(scope, commands, 'list', (async (agent: Parameters<typeof list>[0]) => {
        const original = list(agent);
        return await this.boundHarness(agent.id) ? [...original.filter(command => HARNESS_COMMANDS.has(command.name)), ...(original.some(command => command.name === 'clear') ? [] : [CLEAR_COMMAND])] : original;
      }) as unknown as typeof list, 'harness: DSH commands');
      override(scope, commands, 'execute', async (agent, line, attachments, signal) => {
        if (!await this.boundHarness(agent.id)) return execute(agent, line, attachments, signal);
        const [, name = '', args = ''] = /^\/(\S+)\s*([\s\S]*)$/.exec(line.trim()) ?? [];
        if (!HARNESS_COMMANDS.has(name)) return undefined;
        await this.harnessCommand(agent.id, name, line.trim(), args.trim(), attachments, signal);
        return { commandId: brandString<CommandExecution['commandId']>(`harness-${randomUUID()}`), result: { kind: 'success' } };
      }, 'harness: DSH command execution');
    });
    // `@` session mentions are expanded only by DSH's own agent loop; a Harness would get an unreadable link.
    ctx.inject(['sessionReferenceResolver'], scope => {
      const resolver = scope.sessionReferenceResolver;
      const candidates = resolver.remoteExportCandidates.bind(resolver);
      override(scope, resolver, 'remoteExportCandidates', async (agent, query, signal) =>
        await this.boundHarness(agent.id) ? [] : candidates(agent, query, signal), 'harness: session references');
    });
    void this.bindings.delegated().then(bindings => Promise.allSettled(bindings.map(binding => this.notifyDelegation(binding.sessionId)))).catch(() => {});
  }

  private async withSession<T>(binding: Binding, work: (session: import('./contracts.js').HarnessSession) => Promise<T>): Promise<T> {
    const live = this.runner.live.get(binding.sessionId);
    if (live) return work(live.session);
    if (!binding.nativeRef) throw new Error('尚未保存原生会话身份，无法读取或分支');
    const session = unwrap(await this.adapters[binding.harness].open({ kind: 'resume', cwd: binding.cwd, nativeRef: binding.nativeRef,
      ...(binding.delegation?.discussion ? { discussion: true as const } : {}),
      ...(binding.model ? { model: binding.model } : {}), ...(binding.thinking ? { thinkingOptionId: binding.thinking } : {}),
      ...(binding.delegation?.discussion ? { permissionModeId: harnessPermissionModeIdSchema.parse(DISCUSSION_PERMISSION[binding.harness]) }
        : { ...(binding.permission ? { permissionModeId: binding.permission } : {}), ...(binding.configs ? { configValues: binding.configs } : {}) }) }));
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
          const unsettled = tail.find(turn => turn.outcome.status === 'unknown')?.outcome;
          if (unsettled?.status === 'unknown') detail = `无法确认原请求的执行结果（${unsettled.reason}）；没有重发任何请求。`;
          if (turn && !unsettled) {
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
        if (!agent.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.source.kind === 'dsh-harness-provider' && event.data.source.form === 'notice' && event.data.source.summary === marker)) {
          agent.session.append('user/message', createUserMessage({ source: { kind: 'dsh-harness-provider', form: 'notice', summary: marker },
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

  /** Moves the native context back to just before `binding.turns[index]` (the last turn when absent); workspace files stay. */
  private async rewind(agent: Awaited<ReturnType<HarnessService['agent']>>, binding: Binding, index?: number) {
    if (binding.pending || agent.status === 'running' || agent.inbox.nextTurn.length || agent.inbox.nextStep.length) throw new Error('请先结束当前请求并处理未确认结果');
    const ref = await this.withSession(binding, async session => {
      if (!session.fork || !session.readSnapshot) throw new Error('Harness 未提供历史操作');
      const snapshot = unwrap(await session.readSnapshot());
      if (!snapshot.turns.length) throw new Error('没有可回滚的对话');
      const key = binding.turns?.[index ?? binding.turns.length - 1]?.key;
      const native = key ? snapshot.turns.findIndex(turn => turn.nativeTurnRef.nativeTurnKey === key) : index === undefined ? snapshot.turns.length - 1 : -1;
      if (native < 0) throw new Error('无法确认该轮的原生边界');
      const previous = snapshot.turns[native - 1]?.nativeTurnRef.nativeTurnKey;
      return unwrap(await session.fork(previous ?? null));
    });
    const live = this.runner.live.get(binding.sessionId);
    if (live) { await live.session.close(); this.runner.live.delete(binding.sessionId); }
    if (ref) binding.nativeRef = ref; else delete binding.nativeRef;
    binding.turns = (binding.turns ?? []).slice(0, index ?? -1);
    delete binding.usage;
    await this.bindings.write(binding);
  }
  private async notice(agent: Awaited<ReturnType<HarnessService['agent']>>, summary: string, text: string, rewindFromSeq?: number) {
    agent.session.append('user/message', createUserMessage({ source: { kind: 'dsh-harness-provider', form: 'notice', summary,
      ...(rewindFromSeq === undefined ? {} : { rewindFromSeq }) },
      content: [{ type: 'text', text }] }), { surfaceOp: 'append' });
    await this.ctx.sessions.flush(agent.session);
  }

  async rollback(raw: unknown) {
    const { sessionId } = address.parse(raw);
    return this.bindings.serial(sessionId, async () => {
      const agent = await this.agent(sessionId), binding = await this.bindings.read(sessionId);
      if (!binding) throw new Error('请先结束当前请求并处理未确认结果');
      const fromTurn = binding.turns?.at(-1)?.turn;
      const fromSeq = agent.session.snapshotEvents().find(event => event.type === 'turn/start' && event.data.turn === fromTurn)?.seq;
      await this.rewind(agent, binding);
      await this.notice(agent, '对话已回滚', '已撤销最后一轮原生对话上下文，工作区文件保持原状。上方原记录保留供查阅，后续对话从回滚位置继续。', fromSeq);
      return this.view(binding);
    });
  }

  /** Reruns a user prompt with new text: the native context goes back to before its turn, the old transcript stays above a notice. */
  async edit(raw: unknown) {
    const { sessionId, seq, text, requestId } = editRequest.parse(raw);
    return this.bindings.serial(sessionId, async () => {
      const agent = await this.agent(sessionId), binding = await this.bindings.read(sessionId);
      if (!binding) throw new Error('只有 Codex / Claude Code 会话支持编辑消息');
      const events = agent.session.snapshotEvents();
      const typed = (event: SessionEvent | undefined): event is Extract<SessionEvent, { type: 'user/message' }> => event?.type === 'user/message' && event.data.source.kind === 'user';
      if (events.some(event => typed(event) && (event.data.source as { rpcId?: string }).rpcId === requestId)) return this.view(binding);
      // A turn's prompt is the run of user messages right after its step/start; steering arrives later and cannot be edited alone.
      let start = events.findIndex(event => event.seq === seq);
      const target = events[start];
      while (typed(events[start - 1])) start--;
      const head = events[start - 1];
      if (!typed(target) || head?.type !== 'step/start') throw new Error('只能编辑一轮对话开头的用户消息');
      const prompt: Array<Extract<SessionEvent, { type: 'user/message' }>> = [];
      for (let i = start; typed(events[i]); i++) prompt.push(events[i] as Extract<SessionEvent, { type: 'user/message' }>);
      const index = (binding.turns ?? []).findIndex(entry => entry.turn === head.data.turn);
      if (index < 0) throw new Error('该消息所在轮次的原生边界无法确认（可能已被回滚或编辑过），无法编辑');
      const content = [...(text.trim() ? [{ type: 'text' as const, text }] : []), ...target.data.content.filter(part => part.type !== 'text')];
      if (!content.length) throw new RemoteError('gateway/bad-request', '请输入文字或保留附件', {});
      await this.rewind(agent, binding, index);
      const fromSeq = events.find(event => event.type === 'turn/start' && event.data.turn === head.data.turn)?.seq ?? head.seq;
      await this.notice(agent, '消息已编辑', '已撤销该消息及之后的原生对话上下文，并按编辑后的内容重新执行；工作区文件保持原状。上方原记录保留供查阅。', fromSeq);
      prompt.forEach((event, offset) => {
        agent.followup(createUserMessage({ content: event === target ? content : event.data.content,
          source: { kind: 'user', rpcId: event === target ? requestId : `${requestId}#${offset}` } }));
      });
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

  async harnesses(raw: unknown) {
    const { sessionIds } = harnessesRequest.parse(raw);
    return Object.fromEntries(await Promise.all(sessionIds.map(async id => {
      const delegated = await this.bindings.readDelegated(id).catch(() => undefined);
      const harness = delegated?.harness ?? (await this.bindings.read(id).catch(() => undefined))?.harness ?? 'dsh';
      // Running: an external Harness has a live process; a DSH session is loaded as an agent.
      const running = harness === 'dsh' ? !!this.ctx.agents.get(SessionId(id)) : this.runner.live.has(id);
      return [id, { harness, delegated: !!delegated, running }] as const;
    })));
  }

  async state(raw: unknown) {
    const { sessionId } = address.parse(raw);
    const agent = await this.agent(sessionId); // Same authorization/ownership rules as native Session commands.
    const binding = await this.bindings.read(sessionId);
    if (binding?.pending && agent.status !== 'running' && !agent.inbox.nextTurn.length && !agent.inbox.nextStep.length) {
      await this.autoCheck(sessionId);
      return this.view(await this.bindings.read(sessionId));
    }
    this.checks.delete(sessionId);
    const nativeDelegation = binding ? undefined : await this.bindings.readDelegated(sessionId);
    if (binding || nativeDelegation || !this.fresh(agent)) return this.view(binding, nativeDelegation?.locked || (!binding && !this.unstarted(agent)));
    // A fresh session starts on the Harness picked last time; failures fall back to native silently.
    const remembered = (await this.bindings.readDefaults()).harness;
    if (!remembered || remembered === 'dsh' || !agent.session.header.cwd) return this.view();
    return this.bindings.serial(sessionId, async () => this.view(await this.bindings.read(sessionId) ?? await this.bind(agent, sessionId, remembered).catch(() => undefined)));
  }

  /**
   * State reads from several UI parts share one recovery check, and a finished check is not repeated for 30 seconds;
   * the user's own check / unlock always runs. A failed automatic check leaves the session paused for the user to act.
   */
  private autoCheck(sessionId: string): Promise<void> {
    const cached = this.checks.get(sessionId);
    if (cached && cached.until > Date.now()) return cached.work;
    const entry = { until: Infinity, work: this.recover({ sessionId, action: 'check' }).then(() => {}, () => {}).finally(() => { entry.until = Date.now() + this.settings().recoveryCheckSeconds * 1000; }) };
    this.checks.set(sessionId, entry);
    return entry.work;
  }

  /** Creates an ordinary DSH session, with a stable identity for admission retries. */
  async delegate(source: string, raw: unknown, admitted?: { content: ContentBlock[]; requestHash: string; worktree?: boolean; discussion?: true }) {
    const request = delegationRequest.parse(raw);
    if ((await this.bindings.readDelegated(source))?.delegation.discussion) throw new Error('讨论会话不能创建子会话');
    if (admitted?.discussion && request.harness === 'dsh') throw new Error('DSH 原生暂不支持强制只读讨论');
    if (request.harness === 'dsh' && (request.model || request.thinking)) throw new Error('DSH 原生委派使用宿主当前模型，不能单独指定模型或推理强度');
    const parent = await this.agent(source);
    const cwd = parent.session.header.cwd;
    if (!cwd) throw new Error('请先连接工作目录');
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    const sessionId = SessionId(`session-${hash(JSON.stringify([source, request.requestId]))}`);
    const requestHash = admitted?.requestHash ?? hash(JSON.stringify(request));
    return this.bindings.serial(`delegate:${sessionId}`, async () => {
      try {
        const existing = await this.bindings.readDelegated(sessionId);
        if (existing && (existing.delegation.parentSessionId !== source || existing.delegation.requestHash !== requestHash || existing.delegation.discussion !== admitted?.discussion)) {
          throw new Error('requestId 已用于不同任务，请为新任务提供新标识');
        }
        // Admission locks before followup; while the runner opens its native session, the inbox is already empty
        // but user/message is not persisted yet. Never resend through that gap (or after uncertain cold admission).
        // A native agent writes turn/start before claiming its inbox, so a fresh native child never ran the prompt and resending is safe.
        if (existing?.harness === 'dsh' && !existing.locked && !this.fresh(await this.agent(sessionId))) {
          existing.locked = true;
          await this.bindings.writeDelegated(existing);
          return { sessionId, harness: request.harness, accepted: true };
        }
        if (existing?.locked) {
          if (!this.fresh(await this.agent(sessionId))) return { sessionId, harness: request.harness, accepted: true };
          if (existing.harness !== 'dsh') throw new Error('上次提交结果未确认，请在目标会话检查，禁止自动重发');
        }
        if (!existing) {
          let external: { inspection: Ready; permission?: string; starting?: Pick<Binding, 'model' | 'thinking'> } | undefined;
          let preset: string | undefined;
          const presets = this.ctx.get('permissionPresets');
          if (request.harness === 'dsh') {
            if (!presets) throw new Error('DSH 原生权限预设服务不可用');
            // The native child takes the preset matching the source's permission, never a wider host default.
            const parentBinding = await this.bindings.read(source);
            const current = parentBinding ? undefined : presets.current(parent.session);
            const sandbox = parentBinding ? (parentBinding.permission === FULL_ACCESS[parentBinding.harness] ? 'danger-full-access'
              : parentBinding.permission === 'read-only' || parentBinding.permission === 'plan' ? 'read-only' : 'workspace-write')
              : this.ctx.get('sessionProjections')?.stateOf(parent.session, 'permissions')?.sandbox ?? this.ctx.get('shell')?.sandboxMode;
            preset = current && presets.names.includes(current) ? current : presets.names.find(name => presets.resolve(name).sandbox === sandbox);
            if (!preset) throw new Error('DSH 原生不支持来源会话的权限模式');
          }
          if (admitted?.worktree && request.harness === 'dsh') throw new Error('独立 worktree 仅支持 Codex / Claude Code');
          if (request.harness !== 'dsh') {
            const inspection = await this.inspection({ version: 1, sessionId, harness: request.harness, cwd, locked: false });
            if ('error' in inspection) throw new Error(inspection.error);
            const parentBinding = await this.bindings.read(source);
            const nativeSandbox = this.ctx.get('sessionProjections')?.stateOf(parent.session, 'permissions')?.sandbox ?? this.ctx.get('shell')?.sandboxMode;
            const permission = admitted?.discussion ? DISCUSSION_PERMISSION[request.harness] : !parentBinding && nativeSandbox ? NATIVE_PERMISSION_MODES[request.harness][nativeSandbox]
              : parentBinding?.harness === request.harness ? parentBinding.permission
              : parentBinding && parentBinding.permission === FULL_ACCESS[parentBinding.harness] ? FULL_ACCESS[request.harness] : DELEGATED[request.harness];
            if (permission && !inspection.permissionModes?.modes.some(mode => mode.id === permission)) throw new Error('目标 Harness 不支持来源会话的权限模式');
            const starting = await this.startingModel(request.harness, cwd, request);
            external = { inspection, ...(permission ? { permission } : {}), ...(starting ? { starting } : {}) };
          }
          // Made before the session so a non-git directory leaves nothing behind; the DSH session stays in the source workspace.
          const worktree = admitted?.worktree ? await createWorktree(cwd, resolve(this.worktrees, sessionId)) : undefined;
          const workspace = this.ctx.get('workspaceRegistry')?.list().find(workspace => workspace.sessionIds.includes(parent.id));
          // Hold the same lock as state/select/prompt so the UI cannot auto-bind the new session to its remembered Harness.
          await this.bindings.serial(sessionId, async () => {
            await this.ctx.sessionController.create({ sessionId, ...(workspace ? { workspaceId: workspace.id } : { cwd }) });
            const child = await this.agent(sessionId);
            if (!this.fresh(child)) throw new Error('目标会话已有内容，拒绝重复创建');
            if (preset) presets!.set(child.session, preset);
            if (request.harness === 'dsh') await this.bindings.writeDelegated({ version: 1, sessionId, harness: 'dsh', cwd, locked: false, delegation: { parentSessionId: source, requestHash, reportBack: request.reportBack } });
            else await this.bind(child, sessionId, request.harness, {
              ...external?.starting,
              permission: external?.permission ? harnessPermissionModeIdSchema.parse(external.permission) : external?.inspection.permissionModes?.defaultModeId,
              delegation: { parentSessionId: source, requestHash, reportBack: request.reportBack,
                ...(admitted?.discussion ? { discussion: true as const } : {}),
                ...(worktree ? { worktree: { repo: worktree.repo, path: worktree.path, base: worktree.base } } : {}) },
              ...(worktree ? { cwd: worktree.cwd } : {}),
            });
            if (this.ctx.get('sessionTitle')) await this.ctx.sessionController.rename({ sessionId,
              title: request.title ?? `${request.harness === 'dsh' ? 'DSH 原生' : request.harness === 'codex' ? 'Codex' : 'Claude Code'} · ${request.prompt.split('\n').find(line => line.trim())!.trim().slice(0, 40)}` });
          });
        }
        if (request.harness === 'dsh') {
          const native = await this.bindings.readDelegated(sessionId);
          if (native?.harness !== 'dsh') throw new Error('DSH 原生委派状态缺失');
          native.locked = true;
          await this.bindings.writeDelegated(native);
        }
        if (admitted) {
          const child = await this.agent(sessionId);
          child.followup(createUserMessage({ content: admitted.content, source: { kind: 'user', rpcId: request.requestId } }));
          await this.ctx.sessions.flush(child.session);
        } else await this.ctx.sessionController.prompt({ sessionId, requestId: brandString<SessionRequestId>(request.requestId), mode: 'queue',
          content: [{ type: 'text', text: request.prompt }] }, new AbortController().signal);
        return { sessionId, harness: request.harness, accepted: true };
      } catch (error) {
        throw new Error(`会话 ${sessionId}：${error instanceof Error ? error.message : '委派失败'}。重试请保持 requestId 和参数不变。`, { cause: error });
      }
    });
  }

  async delegateFromUser(raw: unknown) {
    const request = delegateFromUserRequest.parse(raw);
    // Checked before a leading skill runs or any target exists, so a bad pick never leaves a partial multi-target delegation.
    const picked = request.harnesses.flatMap(harness => harness !== 'dsh' && request.picks[harness] ? [[harness, request.picks[harness]] as const] : []);
    if (picked.length) {
      const cwd = (await this.agent(request.sessionId)).session.header.cwd;
      if (!cwd) throw new Error('请先连接工作目录');
      await Promise.all(picked.map(([harness, pick]) => this.startingModel(harness, cwd, pick)));
    }
    const skill = await this.leadingSkill(request.sessionId, request.prompt);
    if (skill) return this.handOffAfterSkill(request, skill);
    const { content, binding } = await this.admitUserPrompt(request);
    try {
      const result = await this.delegateToSelected(request, content);
      binding?.commit();
      return result;
    } finally { binding?.[Symbol.dispose](); }
  }

  private async delegateToSelected(request: z.infer<typeof delegateFromUserRequest>, content: ContentBlock[], prompt = request.prompt.trim() || '处理附件任务') {
    const requestHash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    const sessions = [];
    for (const harness of request.harnesses) {
      const requestId = request.harnesses.length === 1 ? request.requestId
        : `multi-${createHash('sha256').update(JSON.stringify([request.requestId, harness])).digest('hex')}`;
      const result = await this.delegate(request.sessionId, {
        requestId, harness, reportBack: request.reportBack, prompt, ...(request.title ? { title: request.title } : {}), ...(harness === 'dsh' ? {} : request.picks[harness]),
      }, { content, requestHash, worktree: request.worktree });
      sessions.push({ sessionId: result.sessionId, harness: result.harness });
    }
    return { ...sessions[0]!, sessions, accepted: true as const };
  }

  /** The name of the source session's skill that `prompt` starts with, if any. */
  private async leadingSkill(sessionId: string, prompt: string) {
    const name = /^\/(\S+)/u.exec(prompt.trim())?.[1];
    const catalog = this.ctx.get('sessionSkillCatalog');
    if (!name || !catalog) return undefined;
    const { skills } = await catalog.list({ sessionId: SessionId(sessionId) }, new AbortController().signal);
    return skills.some(skill => skill.name === name) ? name : undefined;
  }

  /** `/delegate /skill task`: the source session runs the skill; its reply goes to the delegated Harness when that turn completes. */
  private async handOffAfterSkill(request: z.infer<typeof delegateFromUserRequest>, skill: string) {
    const accepted = { harness: request.harnesses[0]!, accepted: true as const };
    const source = await this.agent(request.sessionId);
    if (userMessageAt(source.session.snapshotEvents(), request.requestId) >= 0) return accepted;
    const pending = this.handoffs.get(request.sessionId);
    if (pending) {
      if (pending.request.requestId === request.requestId) return accepted;
      throw new Error('上一个委派仍在当前会话执行 skill，请等待完成后再委派');
    }
    const admitted = await this.admitUserPrompt(request);
    this.handoffs.set(request.sessionId, { request, skill, content: admitted.content });
    try {
      // The skill line leads so every Harness recognizes it; attachments follow.
      const attachments = admitted.content.slice(0, -1);
      admitted.source.followup(createUserMessage({ content: [admitted.content.at(-1)!, ...attachments], source: { kind: 'user', rpcId: request.requestId } }));
      await this.ctx.sessions.flush(admitted.source.session);
      admitted.binding?.commit();
      return accepted;
    } catch (error) {
      this.handoffs.delete(request.sessionId);
      throw error;
    } finally { admitted.binding?.[Symbol.dispose](); }
  }

  private async finishHandoff(sessionId: string) {
    const handoff = this.handoffs.get(sessionId);
    if (!handoff) return;
    const events = (await this.agent(sessionId)).session.snapshotEvents();
    const start = userMessageAt(events, handoff.request.requestId);
    const end = events.findIndex((event, index) => start >= 0 && index > start && event.type === 'turn/end');
    // An earlier turn ended while the skill line was still queued.
    if (end < 0) return;
    this.handoffs.delete(sessionId);
    const outcome = events[end]!;
    if (outcome.type !== 'turn/end' || outcome.data.reason.kind !== 'completed') return;
    const { request, skill, content } = handoff;
    const reply = events.slice(start, end).flatMap(event => event.type === 'assistant/message'
      ? event.data.message.content.flatMap(part => part.type === 'text' ? [part.text] : []) : []).join('\n\n').trim();
    const task = request.prompt.trim().slice(skill.length + 1).trim();
    const prompt = `${task || `按 /${skill} 的结果继续`}\n\n[来源会话 /${skill} 的结果]\n${reply || '（无文字回复）'}`.slice(0, 64_000);
    await this.delegateToSelected(request, [...content.slice(0, -1), { type: 'text', text: prompt }], prompt);
  }

  private async admitUserPrompt(request: z.infer<typeof delegateFromUserRequest> | z.infer<typeof startDiscussionFromUserRequest>) {
    const source = await this.agent(request.sessionId);
    const receiptIds = request.attachments.flatMap(part => part.type === 'file' ? [brandString<FileUploadReceiptId>(part.receiptId)] : []);
    const admission = request.attachments.map(part => {
      if (part.type === 'image') return part;
      const attachment = this.ctx.fileUploads.resolve(source, brandString<FileUploadReceiptId>(part.receiptId));
      if (!attachment) throw new RemoteError('session/attachment-invalid', '附件不属于当前会话或上传已过期', { reason: 'FILE_NOT_STAGED' });
      return { type: 'file' as const, attachment };
    });
    const content = await this.ctx.attachments.admitPromptContent([
      ...admission,
      ...(request.prompt.trim() ? [{ type: 'text' as const, text: request.prompt.trim() }] : []),
    ]);
    const binding = receiptIds.length ? this.ctx.fileUploads.bindPrompt(source, receiptIds, request.requestId) : undefined;
    return { source, content, binding };
  }

  async startDiscussionFromUser(raw: unknown) {
    const request = startDiscussionFromUserRequest.parse(raw);
    if ((await this.bindings.readDelegated(request.sessionId))?.delegation.discussion) throw new Error('讨论会话不能创建新讨论');
    const source = await this.agent(request.sessionId);
    if (source.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.source.kind === 'user' && 'rpcId' in event.data.source && event.data.source.rpcId === request.requestId)) return { accepted: true as const };
    const active = this.discussions.get(request.sessionId);
    if (active) {
      if (active.requestId === request.requestId) return { accepted: true as const };
      throw new Error('当前轮次的讨论仍在进行，请等待完成后再开启新讨论');
    }
    const admitted = await this.admitUserPrompt(request);
    this.discussions.set(request.sessionId, { requestId: request.requestId, content: admitted.content, ...(request.harnesses ? { harnesses: request.harnesses } : {}) });
    try {
      const sourceContent = [...admitted.content];
      if (request.prompt.trim() && sourceContent.at(-1)?.type === 'text') sourceContent.pop();
      const selection = request.harnesses ? `\n\n参与 Harness：${request.harnesses.join('、')}；每个选中的 Harness 至少分配一个参与者，只使用这些 Harness。` : '';
      admitted.source.followup(createUserMessage({ content: [{ type: 'text', text: `/discuss ${request.prompt.trim() || '处理附件任务'}${selection}` }, ...sourceContent], source: { kind: 'user', rpcId: request.requestId } }));
      await this.ctx.sessions.flush(admitted.source.session);
      admitted.binding?.commit();
      return { accepted: true as const };
    } catch (error) {
      this.discussions.delete(request.sessionId);
      throw error;
    } finally { admitted.binding?.[Symbol.dispose](); }
  }

  async discuss(source: string, raw: unknown): Promise<DiscussionResult> {
    const request = discussionRequest.parse(raw);
    if ((await this.bindings.readDelegated(source))?.delegation.discussion) throw new Error('讨论会话不能创建新讨论');
    await this.agent(source);
    const authorization = this.discussions.get(source);
    if (!authorization) throw new Error('请先由用户使用 /discuss 明确开启讨论模式');
    if (authorization.harnesses && (request.assignments.some(assignment => !authorization.harnesses!.some(harness => harness === assignment.harness))
      || authorization.harnesses.some(harness => !request.assignments.some(assignment => assignment.harness === harness)))) {
      throw new Error('讨论分工必须覆盖每个选中的 Harness，且不能使用未选中的 Harness');
    }
    const inputHash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    if (authorization.work) {
      if (authorization.inputHash !== inputHash) throw new Error('本轮讨论已使用不同分工启动，不能再次创建会话');
      return authorization.work;
    }
    authorization.inputHash = inputHash;
    // Every pick is checked before any participant exists; a rejected pick frees the turn's authorization for corrected assignments.
    // `work` is set synchronously so a concurrent retry joins it instead of starting a second discussion.
    const work: Promise<DiscussionResult> = (async () => {
      const cwd = (await this.agent(source)).session.header.cwd;
      await Promise.all(request.assignments.map(assignment => assignment.harness !== 'dsh' && cwd ? this.startingModel(assignment.harness, cwd, assignment) : undefined));
    })().then(() => this.runDiscussion(source, authorization, request.assignments), error => {
      if (authorization.work === work) { delete authorization.work; delete authorization.inputHash; }
      throw error;
    });
    return authorization.work = work;
  }

  private async runDiscussion(source: string, authorization: { requestId: string; content: ContentBlock[] }, assignments: z.infer<typeof discussionRequest>['assignments']): Promise<DiscussionResult> {
    if (assignments.some(assignment => assignment.harness === 'dsh')) throw new Error('DSH 原生暂不支持强制只读讨论');
    const participants: Array<{ sessionId: SessionId; harness: 'dsh' | Binding['harness']; role?: string; task: string }> = [];
    for (const [index, assignment] of assignments.entries()) {
      const requestId = `${authorization.requestId}:participant:${index}`;
      const role = assignment.role ? `角色：${assignment.role}\n` : '';
      const prompt = `${role}分工：${assignment.task}`;
      const requestHash = createHash('sha256').update(JSON.stringify([authorization.requestId, index, assignment])).digest('hex');
      const created = await this.delegate(source, { requestId, harness: assignment.harness, prompt, title: `讨论 · ${assignment.role ?? assignment.task}`.slice(0, 80), reportBack: false,
        model: assignment.model, thinking: assignment.thinking }, {
        content: [...authorization.content, { type: 'text', text: `\n\n[讨论分工]\n${prompt}\n独立完成本轮分析；不要等待或联系其他参与者。` }], requestHash, discussion: true,
      });
      participants.push({ sessionId: created.sessionId, harness: created.harness, ...(assignment.role ? { role: assignment.role } : {}), task: assignment.task });
    }
    await Promise.all(participants.map(async participant => (await this.agent(participant.sessionId)).whenIdle()));
    const first = await Promise.all(participants.map(async participant => ({ ...participant, ...await this.readDiscussionResult(source, participant.sessionId) })));
    if (participants.length > 1) {
      await Promise.all(participants.map(async (participant, index) => {
        if (first[index]?.status !== 'completed') return;
        const peers = first.filter((_, peer) => peer !== index).map((entry, peer) => `参与者 ${peer + 1}${entry.role ? `（${entry.role}）` : ''}：\n${entry.text.slice(0, this.settings().peerReviewChars)}`).join('\n\n');
        await this.ctx.sessionController.prompt({ sessionId: participant.sessionId, requestId: brandString<SessionRequestId>(`${authorization.requestId}:review:${index}`), mode: 'queue',
          content: [{ type: 'text', text: `[讨论互评 · 第 2/2 轮]\n请审阅其他参与者的结果，指出冲突、遗漏或可合并之处，并给出修正后的结论。不要创建新会话。\n\n${peers}` }] }, new AbortController().signal);
      }));
      await Promise.all(participants.map(async participant => (await this.agent(participant.sessionId)).whenIdle()));
    }
    const results = await Promise.all(participants.map(async participant => {
      const result = await this.readDiscussionResult(source, participant.sessionId);
      return { sessionId: participant.sessionId, harness: participant.harness, ...(participant.role ? { role: participant.role } : {}), task: participant.task, status: result.status, text: result.text };
    }));
    return { peerReview: participants.length > 1, participants: results };
  }

  private async readDiscussionResult(source: string, sessionId: string) {
    const summary = await this.readDelegation(source, { sessionId, limit: 1 });
    const chars = this.settings().discussionResultChars;
    const result = await this.readDelegation(source, { sessionId, offset: Math.max(0, summary.totalChars - chars), limit: chars, throughSeq: summary.throughSeq });
    return result.status === 'completed' ? result : { ...result, text: `${result.text}\n\n[讨论参与者未完成：${result.status}]\n${JSON.stringify(result.outcome)}` };
  }

  async readDelegation(source: string, raw: unknown) {
    await this.agent(source);
    const { sessionId, offset, limit, throughSeq } = delegationReadRequest.parse(raw);
    const binding = await this.bindings.readDelegated(sessionId);
    if (binding?.delegation.parentSessionId !== source) throw new Error('只能读取由本会话创建的委派会话');
    const agent = await this.agent(sessionId);
    const all = agent.session.snapshotEvents();
    const boundary = throughSeq ?? all.at(-1)?.seq ?? 0;
    const events = all.filter(event => event.seq <= boundary);
    const end = events.findLast(event => event.type === 'turn/end');
    const queued = agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0;
    const text = events.flatMap(event => event.type === 'assistant/message' ? event.data.message.content.flatMap(part => part.type === 'text' ? [part.text] : []) : []).join('\n\n');
    // Native children have no recovery flow: an unstarted prompt is resent by retrying create; an interrupted turn needs the user.
    const unsettled = binding.harness === 'dsh' ? (binding.locked && !end ? (this.fresh(agent) ? 'not-started' : 'interrupted') : undefined)
      : binding.pending || (binding.locked && !end) ? 'recovery-required' : undefined;
    return { sessionId, harness: binding.harness, status: agent.status === 'running' ? 'running' : queued ? 'queued'
      : unsettled ?? (end?.type === 'turn/end' ? end.data.reason.kind : 'idle'),
      outcome: end?.type === 'turn/end' ? end.data.reason : null,
      text: text.slice(offset, offset + limit), truncated: offset + limit < text.length, totalChars: text.length, throughSeq: boundary,
      nextOffset: offset + limit < text.length ? offset + limit : null,
    };
  }

  private async notifyDelegation(id: string): Promise<void> {
    await this.bindings.serial(`notify:${id}`, async () => {
      if (!(await this.bindings.readDelegated(id))) return;
      const child = await this.agent(id);
      await child.whenIdle();
      const binding = await this.bindings.readDelegated(id);
      if (!binding) return;
      const end = child.session.snapshotEvents().findLast(event => event.type === 'turn/end');
      if (!end || binding.delegation.notifiedSeq !== undefined) return;
      if (binding.delegation.reportBack === false) {
        binding.delegation.notifiedSeq = end.seq;
        await this.bindings.writeDelegated(binding);
        return;
      }
      const parentId = binding.delegation.parentSessionId;
      if ((await this.bindings.read(parentId))?.pending && this.ctx.agents.get(SessionId(parentId))?.status !== 'running') return;
      const parent = await this.agent(parentId);
      if (this.stopped) return;
      const marker = `DSH delegation ${id}:${end.seq}`;
      const delivered = (message: { source: unknown }) => { const source = message.source as { kind?: string; summary?: string }; return source.kind === 'dsh-harness-provider' && source.summary === marker; };
      if (!parent.inbox.nextTurn.some(delivered) && !parent.inbox.nextStep.some(delivered)
        && !parent.session.snapshotEvents().some(event => event.type === 'user/message' && delivered(event.data))) {
        parent.followup(createUserMessage({ source: { kind: 'dsh-harness-provider', form: 'notice', summary: marker },
          content: [{ type: 'text', text: `委派会话 ${id} 已结束，状态：${end.data.reason.kind}。请使用委派查询入口分页读取完整结果，然后继续原任务。不要重复创建该任务。` }] }));
        await this.ctx.sessions.flush(parent.session);
      }
      binding.delegation.notifiedSeq = end.seq;
      await this.bindings.writeDelegated(binding);
    });
  }

  /** After a worktree delegation's turn, asks in that session whether to merge its changes back and remove the worktree. */
  private async offerWorktreeMerge(id: string): Promise<void> {
    // ponytail: a question left open when the host stops is not restored; the next finished turn asks again.
    await this.bindings.serial(`worktree:${id}`, async () => {
      const worktree = (await this.bindings.read(id))?.delegation?.worktree;
      if (!worktree || worktree.removed || !await worktreeChanged(worktree)) return;
      const agent = await this.agent(id);
      const [merge, discard, later] = ['合并并删除 worktree', '放弃改动并删除 worktree', '暂不处理'];
      const answer = await this.ctx.userQuestions.ask({ agent, questions: [{ id: 'worktree', question: '委派任务在独立 worktree 中有未合并的改动，如何处理？',
        detail: `worktree：${worktree.path}\n合并会把改动作为未提交修改应用到 ${worktree.repo}，不会创建提交；有冲突时不应用任何改动。`,
        options: [{ label: merge, description: '三方合并到主目录后删除 worktree' }, { label: discard, description: '丢弃全部改动' }, { label: later, description: '保留 worktree，下一轮结束时再问' }] }] });
      const choice = answer.answers.find(entry => entry.id === 'worktree')?.selected[0];
      if (choice !== merge && choice !== discard) return;
      if (choice === merge) {
        const conflicts = await mergeWorktree(worktree);
        if (conflicts.length) {
          await this.notice(agent, 'worktree 合并冲突', `合并冲突，未应用任何改动，worktree 已保留：\n${conflicts.map(path => `- ${path}`).join('\n')}\n请处理冲突后在下一轮结束时再合并，或选择放弃。`);
          return;
        }
      }
      const live = this.runner.live.get(id);
      if (live) { await live.session.close(); this.runner.live.delete(id); }
      await removeWorktree(worktree);
      await this.bindings.serial(id, async () => {
        const binding = await this.bindings.read(id);
        if (!binding?.delegation?.worktree) return;
        binding.delegation.worktree.removed = true;
        await this.bindings.write(binding);
      });
      await this.notice(agent, choice === merge ? 'worktree 已合并' : 'worktree 已删除', choice === merge
        ? `改动已作为未提交修改应用到 ${worktree.repo}，worktree 已删除。` : '已放弃 worktree 中的改动并删除 worktree。');
    });
  }

  async select(raw: unknown) {
    const request = selectRequest.parse(raw);
    return this.bindings.serial(request.sessionId, async () => {
      const agent = await this.agent(request.sessionId);
      const current = await this.bindings.read(request.sessionId);
      if (await this.bindings.readDelegated(request.sessionId) || current?.locked || !this.unstarted(agent)) throw new Error('开始对话后不能切换 Harness，请新建会话或从消息新建分支');
      const defaults = await this.bindings.readDefaults();
      await this.bindings.writeDefaults({ ...defaults, harness: request.harness });
      // A branch keeps its forked native session while it stays on the source's Harness; on another Harness the inherited
      // history goes along as a transcript, and native DSH reads the inherited events directly.
      const inherited = agent.session.inheritedEventCount ?? 0;
      let binding: Binding | undefined = current?.harness === request.harness ? current : undefined;
      if (request.harness === 'dsh') await this.bindings.remove(request.sessionId);
      else binding ??= await this.bind(agent, request.sessionId, request.harness, inherited ? { carry: { throughSeq: inherited } } : {});
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
  /** No prompt of its own yet: a new session, or a branch that has only its inherited history; its Harness can still change. */
  private unstarted(agent: Awaited<ReturnType<HarnessService['agent']>>): boolean {
    const inherited = agent.session.inheritedEventCount ?? 0;
    return agent.status !== 'running' && agent.inbox.nextTurn.length === 0 && agent.inbox.nextStep.length === 0
      && !agent.session.snapshotEvents().some(event => event.seq >= inherited && (event.type === 'turn/start' || event.type === 'user/message'));
  }

  /** Bind a fresh session to a Harness, seeding permission from the native sandbox and model / thinking from the last pick. */
  private async bind(agent: Awaited<ReturnType<HarnessService['agent']>>, sessionId: string, harness: Binding['harness'], overrides: Partial<Pick<Binding, 'permission' | 'delegation' | 'cwd' | 'model' | 'thinking' | 'carry'>> = {}): Promise<Binding> {
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
    const { sessionId, harness } = modelsRequest.parse(raw);
    const cwd = (await this.agent(sessionId)).session.header.cwd;
    const empty = { models: [], defaultModel: null, thinkingOptions: [], defaultThinkingOptionId: null, permissionModes: [], defaultPermissionModeId: null, configOptions: [] };
    if (harness && !cwd) return { ...empty, error: '请先连接工作目录' };
    // A delegation target reads its catalog without binding this session to it.
    const binding: Binding | undefined = harness ? { version: 1, sessionId, harness, cwd: cwd!, locked: false } : await this.bindings.read(sessionId);
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
      configOptions: (catalog.configOptions ?? []).map(option => ({ id: option.id, label: option.label, description: option.description ?? null,
        currentValue: binding.configs?.[option.id] ?? option.currentValue,
        choices: option.choices?.map(choice => ({ value: choice.value, label: choice.label, description: choice.description ?? null })) ?? null })),
      error: null,
    };
  }

  private inspection(binding: Binding): Promise<Ready | { error: string }> {
    const key = `${binding.harness}\0${binding.cwd}`;
    const cached = this.catalogs.get(key);
    if (cached && cached.until > Date.now()) return cached.work;
    const entry = { until: Infinity, work: this.adapters[binding.harness].inspect({ cwd: binding.cwd }).then(result => {
      entry.until = Date.now() + (result.status === 'ready' ? this.settings().catalogCacheSeconds * 1000 : 10_000);
      return result.status === 'ready' ? result : { error: result.error.message };
    }, error => { if (this.catalogs.get(key) === entry) this.catalogs.delete(key); throw error; }) };
    this.catalogs.set(key, entry);
    return entry.work;
  }
  private async catalog(binding: Binding) {
    const inspection = await this.inspection(binding);
    return 'error' in inspection ? inspection : inspection.catalog;
  }

  /**
   * The model / thinking a delegated session starts with when the delegation picks one: checked against the catalog before
   * anything is created, filled from the Harness's last pick where omitted, and never written back as that last pick.
   */
  private async startingModel(harness: Binding['harness'], cwd: string, pick: z.infer<typeof modelPick>): Promise<Pick<Binding, 'model' | 'thinking'> | undefined> {
    if (!pick.model && !pick.thinking) return undefined;
    const name = harness === 'codex' ? 'Codex' : 'Claude Code';
    const catalog = await this.catalog({ version: 1, sessionId: '', harness, cwd, locked: false });
    if ('error' in catalog) throw new Error(catalog.error);
    if (pick.model && !catalog.models.some(model => model.ref.id === pick.model)) {
      throw new Error(`${name} 没有模型 ${pick.model}；可用模型：${catalog.models.map(model => model.ref.id).join('、') || '无'}`);
    }
    const remembered = (await this.bindings.readDefaults())[harness];
    const modelId = pick.model ?? (remembered?.model && catalog.models.some(model => model.ref.id === remembered.model!.id) ? remembered.model.id : undefined);
    const entry = catalog.models.find(model => model.ref.id === (modelId ?? catalog.defaultModel?.id));
    const allowed: string[] = catalog.thinkingOptions.map(option => option.id).filter(id => !entry?.supportedThinkingOptionIds || entry.supportedThinkingOptionIds.includes(id));
    if (pick.thinking && !allowed.includes(pick.thinking)) {
      throw new Error(`${name} 的模型 ${entry?.ref.id ?? '默认模型'} 不支持推理强度 ${pick.thinking}；可用推理强度：${allowed.join('、') || '无'}`);
    }
    const thinking = pick.thinking ?? (remembered?.thinking && allowed.includes(remembered.thinking) ? remembered.thinking : undefined);
    // Both keys are set so a last-picked thinking level the picked model lacks cannot come back through `bind`.
    return { model: modelId ? harnessModelRefSchema.parse({ id: modelId }) : undefined, thinking: thinking ? harnessThinkingOptionIdSchema.parse(thinking) : undefined };
  }

  /** What a discussion can pick per participant: each external Harness's models and thinking levels in the source workspace. */
  async delegationModels(source: string) {
    const cwd = (await this.agent(source)).session.header.cwd;
    if (!cwd) throw new Error('请先连接工作目录');
    return Object.fromEntries(await Promise.all((['codex', 'claude-code'] as const).map(async harness => {
      const catalog = await this.catalog({ version: 1, sessionId: source, harness, cwd, locked: false })
        .catch(error => ({ error: error instanceof Error ? error.message : String(error) }));
      if ('error' in catalog) return [harness, { error: catalog.error }];
      const levels = catalog.thinkingOptions.map(option => option.id);
      return [harness, { models: catalog.models.map(model => ({ id: model.ref.id, label: model.label,
        thinking: model.supportedThinkingOptionIds ? levels.filter(id => model.supportedThinkingOptionIds!.includes(id)) : levels })) }];
    })));
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
      if (binding.delegation?.discussion) throw new Error('讨论会话权限已锁定，不能切换权限模式');
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

  async selectConfig(raw: unknown) {
    const request = configRequest.parse(raw);
    return this.bindings.serial(request.sessionId, async () => {
      const agent = await this.agent(request.sessionId);
      const binding = await this.bindings.read(request.sessionId);
      if (!binding) throw new Error('请使用 DSH 原生配置');
      if (binding.delegation?.discussion) throw new Error('讨论会话不能修改 Harness 配置');
      if (agent.status === 'running' || agent.inbox.nextTurn.length || agent.inbox.nextStep.length || binding.pending) throw new Error('请等待当前请求结束');
      const catalog = await this.catalog(binding);
      if ('error' in catalog) throw new Error(catalog.error);
      const option = catalog.configOptions?.find(entry => entry.id === request.configId);
      if (!option || typeof option.currentValue !== typeof request.value
        || (option.choices && !option.choices.some(choice => choice.value === request.value))) throw new Error('Harness 未提供这个配置值');
      const live = this.runner.live.get(request.sessionId);
      if (live) unwrap(await live.session.execute({ type: 'config.select', configId: option.id, value: request.value }));
      binding.configs = { ...binding.configs, [option.id]: request.value };
      await this.bindings.write(binding);
      return this.view(binding);
    });
  }

  /**
   * `/goal` and `/compact` reach the Harness as typed, so its own command runs. `/clear` starts a fresh native context.
   * `/plan` switches the Harness's plan mode
   * (Claude Code's `plan` permission mode, Codex's plan collaboration mode): bare toggles, `off` leaves, text enters and sends it.
   */
  private async harnessCommand(sessionId: string, name: string, line: string, args: string, attachments: readonly CommandSubmitAttachment[], signal: AbortSignal): Promise<void> {
    // Command attachments are the prompt's own image / file-receipt parts; only the receipt id's brand differs.
    type Content = Parameters<Context['sessionController']['prompt']>[0]['content'];
    const send = (content: readonly ({ type: 'text'; text: string } | CommandSubmitAttachment)[]) => this.ctx.sessionController.prompt({
      sessionId: SessionId(sessionId), requestId: brandString<SessionRequestId>(`harness-${randomUUID()}`), mode: 'queue', content: content as Content }, signal);
    if (name === 'clear') {
      if (args || attachments.length) throw new Error('用法：/clear（不接受参数或附件）');
      await this.bindings.serial(sessionId, async () => {
        const agent = await this.agent(sessionId), binding = await this.bindings.read(sessionId);
        if (!binding) throw new Error('请使用 DSH 原生上下文管理');
        if (binding.pending || agent.status === 'running' || agent.inbox.nextTurn.length || agent.inbox.nextStep.length) throw new Error('请先结束当前请求并处理未确认结果');
        const live = this.runner.live.get(sessionId);
        if (live) { await live.session.close(); this.runner.live.delete(sessionId); }
        this.runner.retainedSubagents.delete(sessionId);
        delete binding.nativeRef; delete binding.usage; delete binding.turns; delete binding.pendingNative;
        await this.bindings.write(binding);
      });
      return;
    }
    if (name !== 'plan') { await send([{ type: 'text', text: line }, ...attachments]); return; }
    if (args === 'off' && attachments.length) throw new Error('/plan off 不能附带附件');
    const binding = await this.bindings.read(sessionId);
    if (!binding) throw new Error('请使用 DSH 原生计划模式');
    if (binding.delegation?.discussion) throw new Error('讨论会话权限已锁定，不能切换计划模式');
    const inspection = await this.inspection(binding);
    if ('error' in inspection) throw new Error(inspection.error);
    const modes = inspection.permissionModes;
    const collaboration = inspection.catalog.configOptions?.find(option => option.id === 'collaboration_mode' && option.choices?.some(choice => choice.value === 'plan'));
    let active: boolean, enter: () => Promise<unknown>, leave: () => Promise<unknown>;
    if (modes?.modes.some(mode => mode.id === 'plan')) {
      const current = binding.permission ?? modes.defaultModeId;
      active = current === 'plan';
      enter = async () => {
        await this.bindings.serial(sessionId, async () => {
          const latest = await this.bindings.read(sessionId);
          if (latest) { latest.beforePlan = harnessPermissionModeIdSchema.parse(current); await this.bindings.write(latest); }
        });
        return this.selectPermission({ sessionId, permission: 'plan' });
      };
      leave = () => this.selectPermission({ sessionId, permission: binding.beforePlan ?? modes.defaultModeId });
    } else if (collaboration) {
      active = (binding.configs?.[collaboration.id] ?? collaboration.currentValue) === 'plan';
      enter = () => this.selectConfig({ sessionId, configId: collaboration.id, value: 'plan' });
      leave = () => this.selectConfig({ sessionId, configId: collaboration.id, value: collaboration.choices!.find(choice => choice.value !== 'plan')!.value });
    } else throw new Error('这个 Harness 没有计划模式');
    const message = args === 'off' ? '' : args;
    const on = args === 'off' ? false : message || attachments.length ? true : !active;
    if (on !== active) await (on ? enter() : leave());
    if (message || attachments.length) await send([...(message ? [{ type: 'text' as const, text: message }] : []), ...attachments]);
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

  /** The `@` menu queries on every keystroke; a catalog read spawns the Harness program, so one read serves 30 seconds. */
  async plugins(raw: unknown): Promise<HarnessPlugin[]> {
    const { sessionId } = address.parse(raw);
    await this.state({ sessionId });
    const binding = await this.bindings.read(sessionId);
    const adapter = binding && this.adapters[binding.harness];
    if (!binding || !adapter?.listPlugins) return [];
    const key = `${binding.harness}\0${binding.cwd}`, cached = this.pluginCatalogs.get(key);
    if (cached && cached.until > Date.now()) return cached.plugins;
    const plugins = adapter.listPlugins({ cwd: binding.cwd });
    const entry = { until: Infinity, plugins };
    this.pluginCatalogs.set(key, entry);
    plugins.then(() => { entry.until = Date.now() + this.settings().pluginCacheSeconds * 1000; }, () => { if (this.pluginCatalogs.get(key) === entry) this.pluginCatalogs.delete(key); });
    return plugins;
  }

  async subagents(raw: unknown): Promise<HarnessSubagent[]> {
    const { sessionId } = address.parse(raw);
    await this.agent(sessionId);
    if (await this.bindings.read(sessionId)) {
      const live = this.runner.live.get(sessionId);
      return (live ? live.session.subagents?.() : this.runner.retainedSubagents.get(sessionId)) ?? [];
    }
    return this.nativeSubagents(sessionId);
  }

  /** A client shows this session; its Harness process is not reclaimed while it stays on screen. */
  async viewing(raw: unknown): Promise<null> {
    const { sessionId } = address.parse(raw);
    await this.agent(sessionId);
    this.runner.viewed(sessionId);
    return null;
  }

  /** DSH's own subagents: the durable descendant tree, each child's log observed read-only (its parent owns the child Agent). */
  // ponytail: every poll re-lists the tree and observes each child (cold reads are cached by revision); add a change feed if trees grow large.
  private async nativeSubagents(sessionId: string): Promise<HarnessSubagent[]> {
    const runtime = this.ctx.get('subagents'), query = this.ctx.get('sessionQuery');
    if (!runtime || !query) return [];
    const children = (await runtime.listDescendants(SessionId(sessionId))).flatMap(entry => entry.kind === 'child' ? [entry] : []).slice(-SUBAGENT_LIMIT);
    return Promise.all(children.map(async child => {
      const running = this.ctx.agents.get(child.id)?.status === 'running';
      let events: readonly SessionEvent[] = [];
      try {
        const observation = await query.observeSession(child.id, { projectionMode: 'none' });
        try { events = observation.events; } finally { observation[Symbol.dispose](); }
      } catch { /* an unreadable child still lists, without content */ }
      return nativeSubagent({ id: child.id, parentId: child.depth > 1 ? child.parentId : null, label: child.label, running }, events);
    }));
  }

  async quota(raw: unknown): Promise<Quota> {
    const { sessionId } = address.parse(raw);
    const agent = await this.agent(sessionId);
    const binding = await this.bindings.read(sessionId);
    if (binding) {
      // An external Harness probe spawns a throwaway CLI process, so reads answer the cached snapshot and only a
      // missing or reset snapshot, or a finished turn (in the background), starts a probe.
      return this.harnessQuota(binding.harness)?.read() ?? null;
    }
    const route = await this.nativeRoute(agent);
    if (!route) return null;
    return this.cachedQuota(`native\0${route.source}\0${route.baseURL}`, () => fetchNativeQuota(route));
  }

  /** A finished turn is the moment an external Harness's account usage actually changed; refresh its cached quota. */
  private async refreshHarnessQuota(sessionId: string): Promise<void> {
    const harness = (await this.bindings.read(sessionId))?.harness;
    if (harness) this.harnessQuota(harness)?.invalidate();
  }

  /** The shared quota cache of one external Harness; undefined when its adapter cannot inspect the account. */
  private harnessQuota(harness: Binding['harness']): HarnessQuotaCache | undefined {
    const adapter = this.adapters[harness];
    if (!adapter.inspectAccount) return undefined;
    let cache = this.harnessQuotas.get(harness);
    if (!cache) this.harnessQuotas.set(harness, cache = new HarnessQuotaCache(() => adapter.inspectAccount!().then(snapshot => accountQuota(snapshot, harness))));
    return cache;
  }

  private cachedQuota(key: string, probe: () => Promise<Quota>): Promise<Quota> {
    const cached = this.quotas.get(key);
    if (cached && cached.until > Date.now()) return cached.work;
    const work = probe().catch(error => { this.quotas.delete(key); throw error; });
    this.quotas.set(key, { until: Date.now() + this.settings().quotaCacheSeconds * 1000, work });
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
    const registration = ctx.get('llm')?.listConfigurableProviders().find(entry => entry.provider === provider);
    if (!registration) return null;
    let config = settings.describe().find(entry => entry.ns === registration.settingsNs)?.value;
    for (const key of registration.settingsPath) config = (config as Record<string, unknown> | undefined)?.[key];
    const section = config as { baseURL?: string; apiKeyEnv?: string } | undefined;
    const route = nativeQuotaRoute(provider, section);
    // llm-deepseek also accepts DEEPSEEK_BASE_URL, below its own settings section but above the shipped default.
    if (provider === 'deepseek-official' && !section?.baseURL) route.baseURL = process.env.DEEPSEEK_BASE_URL ?? route.baseURL;
    const { baseURL, apiKeyEnv } = route;
    if (!apiKeyEnv) return null;
    const stored = await ctx.get('credentials')?.resolve(apiKeyEnv as never);
    const apiKey = stored?.value ?? process.env[apiKeyEnv];
    return apiKey ? { provider, baseURL, apiKey, source: provider } : null;
  }

  private view(binding?: Binding, nativeLocked = false) {
    return { harness: binding?.harness ?? 'dsh' as const, locked: binding?.locked ?? nativeLocked,
      model: binding?.model?.id ?? null, thinking: binding?.thinking ?? null, permission: binding?.permission ?? null,
      configs: binding?.configs ?? {}, recoveryRequired: !!binding?.pending, editableTurns: binding?.turns?.map(entry => entry.turn) ?? [] };
  }
  /** Whether the session runs on an external Harness, after its remembered Harness selection has been applied. */
  private async boundHarness(sessionId: string): Promise<boolean> {
    await this.state({ sessionId });
    return !!await this.bindings.read(sessionId);
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
      let sent = false;
      const wasLocked = binding.locked;
      try {
        const message = createUserMessage({ content, source: { kind: 'user', rpcId: request.requestId,
          ...(request.clientTimeZone ? { clientTimeZone: request.clientTimeZone } : {}) } });
        if (!binding.locked) { binding.locked = true; await this.bindings.write(binding); }
        if (request.mode === 'steer') agent.steer(message); else agent.followup(message);
        sent = true;
        receiptBinding?.commit();
      } catch (error) {
        if (!sent && !wasLocked) { binding.locked = false; await this.bindings.write(binding); }
        throw error;
      } finally { receiptBinding?.[Symbol.dispose](); }
      return { accepted: true };
    });
    const fork: typeof controller.fork = async request => {
      return this.bindings.serial(request.sessionId, async () => {
        const binding = await this.bindings.read(request.sessionId);
        if (!binding) return native.fork(request);
        if (binding.delegation?.discussion) throw new Error('讨论会话不能创建分支');
        const agent = await this.agent(request.sessionId);
        if (binding.pending || agent.status === 'running' || agent.inbox.nextTurn.length || agent.inbox.nextStep.length) throw new Error('请先等待当前请求结束');
        if (request.atSeq !== undefined && binding.carry && request.atSeq < binding.carry.throughSeq) {
          // This prefix predates the current Harness, so it has no native turn to fork.
          const child = await native.fork(request);
          await this.bindings.serial(child.sessionId, async () => this.bindings.write({ ...binding, sessionId: child.sessionId,
            locked: false, nativeRef: undefined, turns: undefined, usage: undefined, delegation: undefined,
            carry: { throughSeq: request.atSeq! + 1 } }));
          return child;
        }
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
          // Unlocked: until its first message the branch may switch to another Harness.
          await this.bindings.write({ ...binding, sessionId: child.sessionId, locked: false, nativeRef, delegation: undefined, turns: binding.turns?.slice(0, cut) });
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

/** A window past its reset starts over: nothing used, next reset unknown until the next probe. */
const settleResets = (quota: Quota, now: number): Quota => quota?.kind !== 'windows' ? quota : { ...quota,
  windows: quota.windows.map(window => window.resetsAt && Date.parse(window.resetsAt) <= now ? { ...window, usedPercent: 0, resetsAt: null } : window) };

/**
 * Account quota of an external Harness. Every probe spawns a throwaway CLI process (codex app-server or a Claude SDK
 * query), so a probe runs only when a read finds no value (the first one of a run) and after each finished turn in the
 * background — when usage actually changed. A window whose reset time has passed reads as unused instead of probing.
 * Switching sessions and the client's polling interval otherwise only read the cache. A failed probe keeps the
 * previous value, or is remembered as "no data" until the next turn.
 */
export class HarnessQuotaCache {
  #entry?: { value: Quota };
  #refreshing?: Promise<Quota>;
  constructor(private readonly probe: () => Promise<Quota>, private readonly now: () => number = () => Date.now()) {}

  /** The cached quota with passed resets applied; with none, waits for one probe that concurrent reads share. */
  read(): Promise<Quota> {
    if (this.#entry) return Promise.resolve(settleResets(this.#entry.value, this.now()));
    return this.#refreshing ?? this.#refresh();
  }

  /** A finished turn changed the account; re-probe in the background while reads keep answering the old value. */
  invalidate(): void {
    if (!this.#refreshing) void this.#refresh();
  }

  #refresh(): Promise<Quota> {
    const refreshing = this.probe().then(value => { this.#entry = { value }; }, () => { this.#entry ??= { value: null }; })
      .then(() => settleResets(this.#entry!.value, this.now())).finally(() => { if (this.#refreshing === refreshing) this.#refreshing = undefined; });
    return this.#refreshing = refreshing;
  }
}
