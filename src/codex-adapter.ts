import { feedbackInstructions } from './feedback.js';
import {
  HarnessOutputChannel, validateHostInteractionResponse,
  type HarnessAdapter, type HarnessOutput, type HarnessSession, type HarnessSessionState,
  type HarnessInspection, type HarnessResult, type HarnessError, type HostCommand,
  type HostEvent, type HostInteraction, type OpenSessionInput, type HostTurnSnapshot,
  type TurnStartCommand, type TurnCancelCommand, type InteractionRespondCommand,
  type ModelSelectCommand, type ThinkingSelectCommand, type PermissionModeSelectCommand,
  type TurnStartAccepted, type TurnCancelAccepted, type InteractionRespondAccepted, type ModelSelectCompleted,
  type ThinkingSelectCompleted, type PermissionModeSelectCompleted, type HostUsage,
} from './contracts.js';
import {
  harnessIdSchema, harnessModelRefSchema, harnessThinkingOptionIdSchema, harnessPermissionModeIdSchema, hostInteractionIdSchema,
  hostItemIdSchema, type HostTurnId, type HarnessAccountSnapshot,
} from './contracts.js';
import { nativeSessionRefSchema, type NativeSessionRef } from './contracts.js';
import { z } from 'zod';
import pkg from '../package.json' with { type: 'json' };
import { CodexRpc, type RpcId, type RpcMessage, type RpcOptions } from './codex-rpc.js';
import { itemOf, snapshotItem, nativeTurn, object, turnSnapshot } from './codex-items.js';
import { parseElicitationSchema, type ClaudeElicitationQuestion } from './claude-native.js';

const id = harnessIdSchema.parse('codex');
const capabilities = {
  configuration: { selectModel: true, selectThinkingOption: true, selectPermissionMode: true, permissionModeScope: 'live' as const },
  history: { fork: true, forkAcrossCwd: false, rollbackLastTurn: true },
};
const opened = z.object({
  thread: z.object({ id: z.string().min(1), cwd: z.string(), ephemeral: z.boolean(), turns: z.array(z.unknown()) }).passthrough(),
  model: z.string().min(1), modelProvider: z.string().min(1),
  // v2/ThreadStartResponse: the sandbox policy Codex applies; surfaced read-only as the permission mode.
  sandbox: z.object({ type: z.string() }).passthrough().optional(),
}).passthrough();
const modelList = z.object({
  data: z.array(z.object({
    model: z.string().min(1), displayName: z.string(), isDefault: z.boolean(), hidden: z.boolean(),
    supportedReasoningEfforts: z.array(z.object({ reasoningEffort: z.string().min(1), description: z.string() }).passthrough()).default([]),
    defaultReasoningEffort: z.string().nullable().default(null),
  }).passthrough()),
  nextCursor: z.string().nullable(),
});
// Official app-server protocol (`codex app-server generate-ts`): v2/GetAccountRateLimitsResponse, RateLimitSnapshot, RateLimitWindow.
const rateLimitWindow = z.object({ usedPercent: z.number(), windowDurationMins: z.number().nullable(), resetsAt: z.number().nullable() }).passthrough();
const rateLimits = z.object({
  rateLimits: z.object({ limitName: z.string().nullable().optional(), primary: rateLimitWindow.nullable(), secondary: rateLimitWindow.nullable(), planType: z.string().nullable().optional() }).passthrough(),
}).passthrough();
// v2/ThreadTokenUsageUpdatedNotification: `last` is the newest request's breakdown, `modelContextWindow` its capacity.
const tokenUsage = z.object({
  total: z.object({ totalTokens: z.number(), inputTokens: z.number(), cachedInputTokens: z.number(), outputTokens: z.number() }).passthrough(),
  last: z.object({ totalTokens: z.number(), inputTokens: z.number(), cachedInputTokens: z.number(), outputTokens: z.number() }).passthrough(),
  modelContextWindow: z.number().nullable(),
}).passthrough();
// Permission modes = Codex sandbox mode + approval policy pairs (v2/SandboxMode, v2/AskForApproval); ids follow the
// `sandbox.type` spelling Codex reports back on thread/start so the reported policy maps onto the same catalog.
const PERMISSION_MODES = [
  { id: 'readOnly', label: 'Read-only', description: 'Sandboxed reads; every write or command asks first.', sandbox: 'read-only', approval: 'on-request' },
  { id: 'workspaceWrite', label: 'Workspace write', description: 'Edit the workspace; other protected actions ask first.', sandbox: 'workspace-write', approval: 'on-request' },
  { id: 'dangerFullAccess', label: 'Full access', description: 'No sandbox and no approval prompts.', sandbox: 'danger-full-access', approval: 'never', dangerous: true },
] as const;
const permissionModeOf = (id: string) => PERMISSION_MODES.find(mode => mode.id === id);
const permissionModeForSandbox = (sandbox: string | null | undefined) => PERMISSION_MODES.find(mode => mode.sandbox === sandbox)?.id ?? 'workspaceWrite';
/** turn/start takes the structured v2/SandboxPolicy, thread/start the plain mode string. */
const sandboxPolicyOf = (id: string) => id === 'dangerFullAccess' ? { type: 'dangerFullAccess' }
  : id === 'readOnly' ? { type: 'readOnly', networkAccess: false }
    : { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
const permissionModeCatalog = (defaultModeId: string) => ({
  modes: PERMISSION_MODES.map(mode => ({ id: harnessPermissionModeIdSchema.parse(mode.id), label: mode.label, description: mode.description, ...('dangerous' in mode ? { dangerous: true } : {}) })),
  defaultModeId: harnessPermissionModeIdSchema.parse(defaultModeId),
});
const configRead = z.object({ config: z.object({ sandbox_mode: z.string().nullable().optional(), model: z.string().nullable().optional() }).passthrough() }).passthrough();
const thinkingOption = (effort: string) => ({ id: harnessThinkingOptionIdSchema.parse(effort), label: effort.charAt(0).toUpperCase() + effort.slice(1) });
/** Codex reports one reset instant per window; the protocol pins the type to int64 without a unit, so seconds are widened to ms. */
const resetIso = (value: number | null) => value === null ? {} : { resetsAt: new Date(value < 1e12 ? value * 1000 : value).toISOString() };
const periodOf = (mins: number | null) => mins === 300 ? 'five_hour' as const : mins === 10080 ? 'seven_day' as const : mins === 43200 ? 'monthly' as const : 'unknown' as const;
const windowLabel = (mins: number | null) => mins === 300 ? '5-hour window' : mins === 10080 ? '7-day window' : mins === null ? 'Rate limit' : `${mins}-minute window`;

function elicitationContent(questions: ClaudeElicitationQuestion[], answers: Record<string, string[]>): Record<string, string | number | boolean | string[]> {
  const content: Record<string, string | number | boolean | string[]> = {};
  for (const question of questions) {
    const values = answers[question.id];
    if (question.valueType === 'stringArray') { if (values) content[question.id] = values; continue; }
    const answer = values?.[0];
    if (answer === undefined) continue;
    if (question.valueType === 'number' || question.valueType === 'integer') {
      const value = Number(answer);
      if (!Number.isFinite(value) || (question.valueType === 'integer' && !Number.isInteger(value))) throw new Error(`${question.prompt} must be a valid ${question.valueType}`);
      content[question.id] = value;
    } else content[question.id] = question.valueType === 'boolean' ? answer === 'true' : answer;
  }
  return content;
}

function formatSlashResult(name: string, value: unknown): string {
  const result = object.safeParse(value);
  const data = result.success && Array.isArray(result.data.data) ? result.data.data : [];
  if (name === '/skills' || name === '/hooks') {
    const key = name === '/skills' ? 'skills' : 'hooks';
    const rows = data.flatMap(entry => {
      const parsed = object.safeParse(entry); return parsed.success && Array.isArray(parsed.data[key]) ? parsed.data[key] : [];
    }).flatMap(entry => {
      const parsed = object.safeParse(entry); if (!parsed.success) return [];
      const label = name === '/skills' ? parsed.data.name : parsed.data.eventName;
      const state = [parsed.data.enabled === false ? 'disabled' : null,
        typeof parsed.data.trustStatus === 'string' ? parsed.data.trustStatus : null].filter(Boolean).join(', ');
      return typeof label === 'string' ? [`${label}${state ? ` (${state})` : ''}`] : [];
    });
    return rows.length ? rows.join('\n') : `No ${key} found.`;
  }
  if (name === '/mcp') {
    const rows = data.flatMap(entry => {
      const parsed = object.safeParse(entry); return parsed.success && typeof parsed.data.name === 'string'
        ? [`${parsed.data.name}: ${String(parsed.data.runtimeStatus ?? 'unknown')} (${String(parsed.data.authStatus ?? 'unknown')})`] : [];
    });
    return rows.length ? rows.join('\n') : 'No MCP servers configured.';
  }
  return JSON.stringify(value, null, 2);
}

/** Maps `account/rateLimits/read` onto the shared account snapshot: primary window as credits, the secondary as product usage. */
export function accountSnapshot(raw: unknown): HarnessAccountSnapshot | null {
  const { rateLimits: limits } = rateLimits.parse(raw);
  const primary = limits.primary ?? limits.secondary;
  if (!primary) return null;
  const secondary = limits.primary ? limits.secondary : null;
  return {
    ...(limits.planType ? { plan: limits.planType } : {}),
    credits: {
      usedPercent: primary.usedPercent, periodType: periodOf(primary.windowDurationMins), ...resetIso(primary.resetsAt),
      ...(secondary ? { productUsage: [{ product: windowLabel(secondary.windowDurationMins), usagePercent: secondary.usedPercent, ...resetIso(secondary.resetsAt) }] } : {}),
    },
  };
}

function errorResult(error: unknown): { ok: false; error: HarnessError } {
  return { ok: false, error: {
    code: error instanceof z.ZodError ? 'protocolError' : 'nativeFailure',
    message: error instanceof z.ZodError ? 'Unsupported Codex protocol response' : error instanceof Error ? error.message : 'Codex operation failed',
    retryable: false,
  } };
}

export interface CodexOptions extends Omit<RpcOptions, 'cwd' | 'onMessage' | 'onFault'> {}

/** Native Codex app-server sessions, with each connection owned by its session. */
export class CodexAdapter implements HarnessAdapter {
  readonly harnessId = id;
  private readonly sessions = new Set<CodexSession>();
  private closing?: Promise<void>;
  private readonly pending = new Set<Promise<unknown>>();

  constructor(private readonly options: CodexOptions) {}

  async inspect(input: { cwd?: string } = {}): Promise<HarnessInspection> {
    if (this.closing) return { status: 'unavailable', error: errorResult(new Error('Codex adapter closed')).error };
    const rpc = new CodexRpc({ ...this.options, cwd: input.cwd ?? process.cwd(), onMessage: () => {}, onFault: () => {} });
    const work = (async (): Promise<HarnessInspection> => {
      try {
        await initialize(rpc);
        const models = [];
        let cursor: string | null = null;
        const cursors = new Set<string>();
        do {
          const page = modelList.parse(await rpc.request('model/list', { cursor, limit: 100 }));
          models.push(...page.data.filter(model => !model.hidden));
          cursor = page.nextCursor;
          if (cursor !== null && cursors.has(cursor)) throw new Error('Codex model pagination repeated');
          if (cursor !== null) cursors.add(cursor);
        } while (cursor !== null);
        const fallback = models.find(model => model.isDefault);
        const efforts = [...new Set(models.flatMap(model => model.supportedReasoningEfforts.map(option => option.reasoningEffort)))];
        const config = configRead.safeParse(await rpc.request('config/read', { cwd: input.cwd ?? process.cwd() }));
        const configured = config.success ? config.data.config.model ?? undefined : undefined;
        return {
          status: 'ready', capabilities,
          permissionModes: permissionModeCatalog(permissionModeForSandbox(config.success ? config.data.config.sandbox_mode : null)),
          catalog: {
            models: models.map(model => ({
              ref: harnessModelRefSchema.parse({ id: model.model }), label: model.displayName,
              supportedThinkingOptionIds: model.supportedReasoningEfforts.map(option => harnessThinkingOptionIdSchema.parse(option.reasoningEffort)),
            })),
            thinkingOptions: efforts.map(thinkingOption),
            // The user's config.toml `model` wins over the catalog's built-in default: that is what Codex would actually run.
            ...(configured || fallback ? { defaultModel: harnessModelRefSchema.parse({ id: configured ?? fallback!.model }) } : {}),
            ...(fallback?.defaultReasoningEffort ? { defaultThinkingOptionId: harnessThinkingOptionIdSchema.parse(fallback.defaultReasoningEffort) } : {}),
          },
        };
      } catch (error) {
        return { status: 'unavailable', error: errorResult(error).error };
      } finally { await rpc.close(); }
    })();
    this.pending.add(work);
    try { return await work; } finally { this.pending.delete(work); }
  }

  /** Rolling ChatGPT rate-limit windows for the signed-in Codex account; null when Codex reports none. */
  async inspectAccount(): Promise<HarnessAccountSnapshot | null> {
    if (this.closing) return null;
    const rpc = new CodexRpc({ ...this.options, cwd: process.cwd(), onMessage: () => {}, onFault: () => {} });
    const work = (async () => {
      try { await initialize(rpc); return accountSnapshot(await rpc.request('account/rateLimits/read', {})); }
      finally { await rpc.close(); }
    })();
    this.pending.add(work);
    try { return await work; } finally { this.pending.delete(work); }
  }

  async open(input: OpenSessionInput): Promise<HarnessResult<HarnessSession>> {
    if (this.closing) return errorResult(new Error('Codex adapter closed'));
    if (input.kind !== 'create' && input.kind !== 'resume') {
      return { ok: false, error: { code: 'unsupported', message: 'Unsupported Codex session open mode', retryable: false } };
    }
    if (input.kind === 'resume' && input.nativeRef.harnessId !== id) return errorResult(new Error('Wrong native Harness identity'));
    const work = CodexSession.open(this.options, input);
    this.pending.add(work);
    try {
      const session = await work;
      if (this.closing) { await session.close(); return errorResult(new Error('Codex adapter closed')); }
      this.sessions.add(session);
      return { ok: true, value: session };
    } catch (error) { return errorResult(error); }
    finally { this.pending.delete(work); }
  }

  close(): Promise<void> {
    return this.closing ??= Promise.resolve().then(async () => {
      await Promise.allSettled([...this.pending]);
      const settled = await Promise.allSettled([...this.sessions].map(session => session.close()));
      const failures = settled.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      this.sessions.clear();
      if (failures.length) throw new AggregateError(failures, 'Codex session cleanup failed');
    });
  }
}

async function initialize(rpc: CodexRpc): Promise<void> {
  await rpc.request('initialize', {
    clientInfo: { name: pkg.name, version: pkg.version, title: 'DSH Harness Plugin' },
    capabilities: { experimentalApi: true, mcpServerOpenaiFormElicitation: true,
      extensions: { 'openai/standard-form-input': {}, 'openai/form': {} } },
  });
  rpc.send({ method: 'initialized', params: {} });
}

type ActiveTurn = { hostId: HostTurnId; nativeId?: string; started: boolean; done: ReturnType<typeof Promise.withResolvers<void>> };
const LOCAL_SLASH_COMMANDS = new Set(['/help', '/status', '/model', '/permissions', '/skills', '/hooks', '/mcp', '/compact', '/review']);

class CodexSession implements HarnessSession {
  readonly harnessId = id;
  readonly capabilities = capabilities;
  /** Codex counts usage per native thread, so the Host's persisted counters still hold after a reopen. */
  initialUsage: HostUsage | null = null;
  readonly channel = new HarnessOutputChannel<HarnessOutput>();
  readonly outputs = this.channel.outputs;
  readonly rpc: CodexRpc;
  initialState: HarnessSessionState = {};
  sourceProvider?: string;
  private threadId?: string;
  private active?: ActiveTurn;
  private fault?: HarnessError;
  private closing?: Promise<void>;
  private start?: Promise<unknown>;
  private readonly interactions = new Map<string, { rpcId: RpcId; interaction: HostInteraction; response(command: InteractionRespondCommand): unknown }>();

  private constructor(private readonly options: CodexOptions, private readonly cwd: string) {
    this.rpc = new CodexRpc({ ...options, cwd, onMessage: message => this.receive(message), onFault: error => this.fail(error) });
  }

  static async open(options: CodexOptions, input: Extract<OpenSessionInput, { kind: 'create' | 'resume' }>): Promise<CodexSession> {
    const session = new CodexSession({ ...options, environment: { ...options.environment, ...input.environment } }, input.cwd);
    try {
      await initialize(session.rpc);
      const requested = input.permissionModeId ? permissionModeOf(input.permissionModeId) : undefined;
      const response = opened.parse(await session.rpc.request(input.kind === 'create' ? 'thread/start' : 'thread/resume', {
        cwd: input.cwd,
        developerInstructions: feedbackInstructions,
        ...(input.model ? { model: input.model.id } : {}),
        ...(requested ? { sandbox: requested.sandbox, approvalPolicy: requested.approval } : {}),
        ...(input.kind === 'create' ? { ephemeral: false } : { threadId: input.nativeRef.nativeSessionId }),
      }));
      if (response.thread.ephemeral || (input.kind === 'resume' && response.thread.id !== input.nativeRef.nativeSessionId)) {
        throw new Error('Codex returned an unexpected native session');
      }
      if (response.thread.cwd !== input.cwd) throw new Error('Codex returned a different workspace');
      session.threadId = response.thread.id;
      session.initialUsage = input.usage ?? null;
      session.sourceProvider = response.modelProvider;
      session.initialState = {
        nativeRef: { harnessId: id, nativeSessionId: session.threadId, formatVersion: 1 },
        effectiveModel: harnessModelRefSchema.parse({ id: response.model }), resolvedModelLabel: response.model,
        ...(input.thinkingOptionId ? { effectiveThinkingOptionId: input.thinkingOptionId } : {}),
        effectivePermissionModeId: harnessPermissionModeIdSchema.parse(requested?.id ?? permissionModeForSandbox(response.sandbox ? PERMISSION_MODES.find(mode => mode.id === response.sandbox!.type)?.sandbox : null)),
      };
      return session;
    } catch (error) { await session.rpc.close(); throw error; }
  }

  async fork(throughTurn?: string | null): Promise<HarnessResult<NativeSessionRef | undefined>> {
    if (this.active || this.fault || this.closing) return errorResult(new Error('请等待原生会话结束后再分支'));
    if (throughTurn === null) return { ok: true, value: undefined };
    // Forking loads a writer in the app-server. A short-lived process guarantees its release before resume.
    const rpc = new CodexRpc({ ...this.options, cwd: this.cwd, onMessage: () => {}, onFault: () => {} });
    try {
      await initialize(rpc);
      const response = opened.parse(await rpc.request('thread/fork', { threadId: this.threadId, ephemeral: false, ...(throughTurn ? { lastTurnId: throughTurn } : {}) }));
      if (response.thread.id === this.threadId || response.thread.cwd !== this.cwd) throw new Error('Codex 返回了错误的分支身份');
      return { ok: true, value: nativeSessionRefSchema.parse({ harnessId: id, nativeSessionId: response.thread.id, formatVersion: 1 }) };
    } catch (error) { return errorResult(error); }
    finally { await rpc.close(); }
  }

  async steer(input: import('./contracts.js').HostInput[]): Promise<HarnessResult<{ accepted: true }>> {
    try {
      await this.start;
      if (!this.active?.nativeId) throw new Error('当前没有可插入的原生轮次');
      await this.rpc.request('turn/steer', { threadId: this.threadId, expectedTurnId: this.active.nativeId,
        input: input.map(part => part.type === 'image' ? { type: 'image', url: `data:${part.mimeType};base64,${part.base64Data}` } : { type: 'text', text: part.text, text_elements: [] }) });
      return { ok: true, value: { accepted: true } };
    } catch (error) { return errorResult(error); }
  }

  async readSnapshot(): Promise<HarnessResult<{ turns: HostTurnSnapshot[]; state: HarnessSessionState }>> {
    try {
      if (this.fault) return { ok: false, error: this.fault };
      const response = z.object({ thread: z.object({ id: z.string(), turns: z.array(z.unknown()) }) })
        .parse(await this.rpc.request('thread/read', { threadId: this.threadId, includeTurns: true }));
      if (response.thread.id !== this.threadId) throw new Error('Codex history identity mismatch');
      return { ok: true, value: { turns: response.thread.turns.map(turn => turnSnapshot(response.thread.id, turn)), state: this.initialState } };
    } catch (error) { return errorResult(error); }
  }

  execute(command: TurnStartCommand): Promise<HarnessResult<TurnStartAccepted>>;
  execute(command: TurnCancelCommand): Promise<HarnessResult<TurnCancelAccepted>>;
  execute(command: InteractionRespondCommand): Promise<HarnessResult<InteractionRespondAccepted>>;
  execute(command: ModelSelectCommand): Promise<HarnessResult<ModelSelectCompleted>>;
  execute(command: ThinkingSelectCommand): Promise<HarnessResult<ThinkingSelectCompleted>>;
  execute(command: PermissionModeSelectCommand): Promise<HarnessResult<PermissionModeSelectCompleted>>;
  async execute(command: HostCommand): Promise<HarnessResult<
    TurnStartAccepted | TurnCancelAccepted | InteractionRespondAccepted | ModelSelectCompleted | ThinkingSelectCompleted | PermissionModeSelectCompleted
  >> {
    try {
      if (this.fault) return { ok: false, error: this.fault };
      if (this.closing) throw new Error('Codex session closed');
      switch (command.type) {
        case 'turn.start': {
          if (this.active) return { ok: false, error: { code: 'sessionBusy', message: 'Codex turn is active', retryable: true } };
          if (!command.input.length || !command.input.some(part => part.type === 'image' ? part.base64Data.length > 0 : part.text.trim())) {
            return { ok: false, error: { code: 'invalidRequest', message: 'A non-empty text prompt is required', retryable: false } };
          }
          if (command.input.length === 1 && command.input[0]!.type === 'text') {
            const [name, ...rest] = command.input[0].text.trim().split(/\s+/u);
            if (name && LOCAL_SLASH_COMMANDS.has(name)) return this.#slash(command, name, rest.join(' '));
          }
          const active: ActiveTurn = { hostId: command.turnId, started: false, done: Promise.withResolvers<void>() };
          this.active = active;
          const work = this.rpc.request('turn/start', {
            threadId: this.threadId,
            input: command.input.map(part => part.type === 'image' ? { type: 'image', url: `data:${part.mimeType};base64,${part.base64Data}` } : { type: 'text', text: part.text, text_elements: [] }),
            ...(this.initialState.effectiveModel ? { model: this.initialState.effectiveModel.id } : {}),
            ...(this.initialState.effectiveThinkingOptionId ? { effort: this.initialState.effectiveThinkingOptionId } : {}),
            ...(this.initialState.effectivePermissionModeId && permissionModeOf(this.initialState.effectivePermissionModeId)
              ? { sandboxPolicy: sandboxPolicyOf(this.initialState.effectivePermissionModeId), approvalPolicy: permissionModeOf(this.initialState.effectivePermissionModeId)!.approval } : {}),
          });
          this.start = work;
          try {
            const response = z.object({ turn: nativeTurn }).parse(await work);
            this.identify(active, response.turn.id);
            return { ok: true, value: { turnId: command.turnId } };
          } catch (error) { this.finish(active, { status: 'failed', error: errorResult(error).error }); throw error; }
          finally { if (this.start === work) this.start = undefined; }
        }
        case 'turn.cancel': {
          const active = this.active;
          if (!active || active.hostId !== command.turnId) throw new Error('Codex turn is not active');
          await this.start?.catch(() => {}); // A rejected turn/start already cleared `active`.
          if (this.active === active) await this.rpc.request('turn/interrupt', { threadId: this.threadId, turnId: active.nativeId });
          return { ok: true, value: { cancellationRequested: true } };
        }
        case 'interaction.respond': {
          const pending = this.interactions.get(command.interactionId);
          if (!pending) throw new Error('Codex interaction is no longer pending');
          const validation = validateHostInteractionResponse(pending.interaction, command.response);
          if (validation) throw new Error('Invalid Codex interaction response');
          this.rpc.send({ id: pending.rpcId, result: pending.response(command) });
          this.interactions.delete(command.interactionId);
          this.emit({ type: 'interaction.closed', interactionId: command.interactionId, turnId: pending.interaction.turnId, reason: 'responded' });
          return { ok: true, value: { accepted: true } };
        }
        case 'model.select':
          if (this.active) throw new Error('Model selection requires an idle Codex session');
          this.initialState = { ...this.initialState, effectiveModel: command.model, resolvedModelLabel: command.model.id };
          this.emit({ type: 'session.state.changed', state: this.initialState });
          return { ok: true, value: { completed: true } };
        case 'permissionMode.select':
          if (this.active) throw new Error('Permission selection requires an idle Codex session');
          if (!permissionModeOf(command.permissionModeId)) throw new Error('Unknown Codex permission mode');
          this.initialState = { ...this.initialState, effectivePermissionModeId: command.permissionModeId };
          this.emit({ type: 'session.state.changed', state: this.initialState });
          return { ok: true, value: { completed: true } };
        case 'thinking.select':
          if (this.active) throw new Error('Thinking selection requires an idle Codex session');
          this.initialState = { ...this.initialState, effectiveThinkingOptionId: command.thinkingOptionId };
          this.emit({ type: 'session.state.changed', state: this.initialState });
          return { ok: true, value: { completed: true } };
        default: return { ok: false, error: { code: 'unsupported', message: 'Codex configuration operation is not implemented', retryable: false } };
      }
    } catch (error) { return errorResult(error); }
  }

  async #slash(command: TurnStartCommand, name: string, argument: string): Promise<HarnessResult<TurnStartAccepted>> {
    const active: ActiveTurn = { hostId: command.turnId, started: true, done: Promise.withResolvers<void>() };
    this.active = active;
    this.emit({ type: 'turn.started', turnId: command.turnId });
    if (name === '/review') {
      const work = this.rpc.request('review/start', { threadId: this.threadId, delivery: 'inline',
        target: argument ? { type: 'custom', instructions: argument } : { type: 'uncommittedChanges' } });
      this.start = work;
      try {
        const response = z.object({ reviewThreadId: z.string(), turn: nativeTurn }).parse(await work);
        if (response.reviewThreadId !== this.threadId) throw new Error('Codex review started in an unexpected thread');
        this.identify(active, response.turn.id);
        return { ok: true, value: { turnId: command.turnId } };
      } catch (cause) {
        this.finish(active, { status: 'failed', error: errorResult(cause).error });
        return errorResult(cause);
      } finally { if (this.start === work) this.start = undefined; }
    }
    const item = { type: 'agentMessage' as const, itemId: hostItemIdSchema.parse(`slash:${command.turnId}`), text: '', phase: 'commentary' as const };
    this.emit({ type: 'item.started', turnId: command.turnId, item });
    try {
      let value: unknown;
      if (name === '/compact') value = await this.rpc.request('thread/compact/start', { threadId: this.threadId });
      else if (name === '/skills') value = await this.rpc.request('skills/list', { cwds: [this.cwd], forceReload: true });
      else if (name === '/hooks') value = await this.rpc.request('hooks/list', { cwds: [this.cwd] });
      else if (name === '/mcp') value = await this.rpc.request('mcpServerStatus/list', { threadId: this.threadId, cursor: null, limit: 100, detail: 'toolsAndAuthOnly' });
      const text = name === '/help' ? 'Codex commands: /status, /model, /permissions, /skills, /hooks, /mcp, /compact, /review [instructions]'
        : name === '/status' ? `Model: ${this.initialState.resolvedModelLabel ?? this.initialState.effectiveModel?.id ?? 'default'}\nReasoning: ${this.initialState.effectiveThinkingOptionId ?? 'default'}\nPermissions: ${this.initialState.effectivePermissionModeId ?? 'default'}\nWorking directory: ${this.cwd}`
          : name === '/model' ? `Current model: ${this.initialState.resolvedModelLabel ?? this.initialState.effectiveModel?.id ?? 'default'}\nUse the DSH model control to change it.`
            : name === '/permissions' ? `Current permissions: ${this.initialState.effectivePermissionModeId ?? 'default'}\nUse the DSH permission control to change them.`
              : name === '/compact' ? 'Codex context compaction completed.' : formatSlashResult(name, value);
      const completed = { ...item, text };
      this.emit({ type: 'item.updated', turnId: command.turnId, itemId: item.itemId, update: { type: 'text.append', text } });
      this.emit({ type: 'item.completed', turnId: command.turnId, snapshot: { item: completed, outcome: { status: 'succeeded' } } });
      this.finish(active, { status: 'succeeded' });
      return { ok: true, value: { turnId: command.turnId } };
    } catch (cause) {
      const failure = errorResult(cause).error;
      this.emit({ type: 'item.completed', turnId: command.turnId, snapshot: { item, outcome: { status: 'failed', error: failure } } });
      this.finish(active, { status: 'failed', error: failure });
      return { ok: false, error: failure };
    }
  }

  private identify(active: ActiveTurn, nativeId: string): void {
    if (active.nativeId && active.nativeId !== nativeId) throw new Error('Codex turn identity mismatch');
    active.nativeId = nativeId;
    if (!active.started) { active.started = true; this.emit({ type: 'turn.started', turnId: active.hostId, nativeTurnRef: { harnessId: id, nativeSessionId: this.threadId!, nativeTurnKey: nativeId, formatVersion: 1 } }); }
  }

  private receive(message: RpcMessage): void {
    const params = object.parse(message.params ?? {});
    if (message.id !== undefined) { this.ask(message.id, message.method!, params); return; }
    if (params.threadId !== this.threadId) return;
    const active = this.active;
    if (!active) return;
    if (message.method === 'thread/tokenUsage/updated') {
      const parsed = tokenUsage.safeParse(params.tokenUsage);
      if (parsed.success) this.emit({ type: 'session.usage.changed', observedForTurnId: active.hostId, usage: {
        inputTokens: parsed.data.total.inputTokens, cachedInputTokens: parsed.data.total.cachedInputTokens,
        outputTokens: parsed.data.total.outputTokens, totalTokens: parsed.data.total.totalTokens,
        // Codex's `inputTokens` already includes the cached share; the newest request's total is what now occupies the window.
        contextUsedTokens: parsed.data.last.totalTokens,
        ...(parsed.data.modelContextWindow !== null ? { contextWindowTokens: parsed.data.modelContextWindow } : {}),
      } });
      return;
    }
    if (message.method === 'turn/started' || message.method === 'turn/completed') {
      const turn = nativeTurn.parse(params.turn);
      this.identify(active, turn.id);
      if (message.method === 'turn/completed') this.finish(active,
        turn.status === 'completed' ? { status: 'succeeded' }
          : turn.status === 'interrupted' ? { status: 'cancelled' }
            : { status: 'failed', error: { code: 'nativeFailure', message: 'Codex turn failed', retryable: false } });
      return;
    }
    if (message.method === 'item/commandExecution/outputDelta' || message.method === 'item/mcpToolCall/progress') {
      if (typeof params.turnId !== 'string' || typeof params.itemId !== 'string') return;
      this.identify(active, params.turnId);
      const delta = message.method === 'item/commandExecution/outputDelta' ? params.delta : params.message;
      if (typeof delta === 'string' && delta) this.emit({ type: 'item.updated', turnId: active.hostId,
        itemId: hostItemIdSchema.parse(params.itemId), update: { type: 'output.append', text: delta } });
      return;
    }
    if (message.method === 'hook/started' || message.method === 'hook/completed') {
      const run = object.safeParse(params.run);
      if (!run.success || typeof run.data.id !== 'string' || typeof run.data.eventName !== 'string') return;
      const itemId = hostItemIdSchema.parse(`hook:${run.data.id}`);
      const item = { type: 'toolExecution' as const, itemId, toolName: `hook:${run.data.eventName}`, arguments: JSON.parse(JSON.stringify(run.data)) };
      if (message.method === 'hook/started') this.emit({ type: 'item.started', turnId: active.hostId, item });
      else {
        const entries = Array.isArray(run.data.entries) ? run.data.entries.flatMap(value => {
          const entry = object.safeParse(value); return entry.success && typeof entry.data.text === 'string' ? [entry.data.text] : [];
        }) : [];
        this.emit({ type: 'item.completed', turnId: active.hostId, snapshot: { item: { ...item, output: { content: [{ type: 'text', text: entries.join('\n') }] },
          ...(typeof run.data.durationMs === 'number' ? { durationMs: run.data.durationMs } : {}) },
          outcome: run.data.status === 'failed' || run.data.status === 'blocked' || run.data.status === 'stopped'
            ? { status: 'failed', error: { code: 'nativeFailure', message: entries.join('\n') || `Codex ${run.data.eventName} hook ${String(run.data.status)}`, retryable: false } }
            : { status: 'succeeded' } } });
      }
      return;
    }
    if (!['item/started', 'item/completed', 'item/agentMessage/delta', 'item/reasoning/summaryTextDelta'].includes(message.method ?? '')) return;
    if (typeof params.turnId !== 'string' || (active.nativeId && params.turnId !== active.nativeId)) return;
    this.identify(active, params.turnId);
    if (message.method === 'item/started') {
      const item = itemOf(params.item);
      if (item) this.emit({ type: 'item.started', turnId: active.hostId, item });
    } else if (message.method === 'item/completed') {
      const snapshot = snapshotItem(params.item);
      if (snapshot) this.emit({ type: 'item.completed', turnId: active.hostId, snapshot });
    } else if (message.method === 'item/agentMessage/delta' || message.method === 'item/reasoning/summaryTextDelta') {
      this.emit({ type: 'item.updated', turnId: active.hostId, itemId: hostItemIdSchema.parse(params.itemId),
        update: { type: 'text.append', text: z.string().parse(params.delta) } });
    }
  }

  private ask(rpcId: RpcId, method: string, params: Record<string, unknown>): void {
    const active = this.active;
    if (!active || params.threadId !== this.threadId || (params.turnId != null && typeof params.turnId !== 'string')) {
      this.rpc.send({ id: rpcId, error: { code: -32601, message: 'Request has no active DSH turn' } });
      return;
    }
    if (typeof params.turnId === 'string') this.identify(active, params.turnId);
    const interactionId = hostInteractionIdSchema.parse(`codex:${typeof rpcId}:${rpcId}`);
    let interaction: HostInteraction;
    let response: (command: InteractionRespondCommand) => unknown;
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      interaction = {
        type: 'approval', interactionId, turnId: active.hostId, subject: { type: 'nativeAction' },
        title: typeof params.command === 'string' ? params.command : 'Codex 请求修改文件',
        ...(typeof params.reason === 'string' ? { description: params.reason } : {}),
        actions: [{ id: 'accept', label: '允许一次', effect: 'allowOnce' },
          { id: 'acceptForSession', label: '本会话允许', effect: 'allowForSession' }, { id: 'decline', label: '拒绝', effect: 'deny' }],
      };
      response = command => ({ decision: command.response.type === 'approval' ? command.response.actionId : 'decline' });
    } else if (method === 'item/tool/requestUserInput') {
      const questions = z.array(z.object({ id: z.string(), header: z.string(), question: z.string(),
        isOther: z.boolean().optional(), isSecret: z.boolean().optional(),
        options: z.array(z.object({ label: z.string(), description: z.string() })).nullable().optional(),
      })).parse(params.questions);
      interaction = { type: 'question', interactionId, turnId: active.hostId, questions: questions.map(question =>
        question.options?.length ? {
          id: question.id, type: 'choice', prompt: question.question,
          options: question.options.map(option => ({ value: option.label, label: option.label, description: option.description })),
          multiple: false, allowOther: question.isOther === true, optional: false,
        } : { id: question.id, type: 'text', prompt: question.question, multiline: true, secret: question.isSecret === true, optional: false }) };
      response = command => ({ answers: command.response.type === 'question'
        ? Object.fromEntries(Object.entries(command.response.answers).map(([key, answers]) => [key, { answers }])) : {} });
    } else if (method === 'mcpServer/elicitation/request') {
      const message = typeof params.message === 'string' && params.message.trim() ? params.message.trim().slice(0, 200) : 'MCP request';
      const meta = object.safeParse(params._meta);
      if (meta.success && meta.data.codex_approval_kind === 'mcp_tool_call') {
        const persist = Array.isArray(meta.data.persist) ? meta.data.persist : [meta.data.persist];
        interaction = { type: 'approval', interactionId, turnId: active.hostId, title: message,
          description: typeof meta.data.tool_description === 'string' ? meta.data.tool_description.slice(0, 500) : undefined,
          subject: { type: 'nativeAction' }, actions: [
            { id: 'accept', label: 'Allow once', effect: 'allowOnce' },
            ...(persist.includes('session') ? [{ id: 'session', label: 'Allow for this conversation', effect: 'allowForSession' as const }] : []),
            ...(persist.includes('always') ? [{ id: 'always', label: 'Always allow', effect: 'allowAlways' as const }] : []),
            { id: 'decline', label: 'Deny', effect: 'deny' },
          ] };
        response = command => command.response.type === 'approval' && command.response.actionId !== 'decline'
          ? { action: 'accept', content: null, ...(command.response.actionId === 'accept' ? {} : { _meta: { persist: command.response.actionId } }) }
          : { action: 'decline', content: null };
      } else if (params.mode === 'url' && typeof params.url === 'string' && params.url.length <= 2048
        && (() => { try { return ['http:', 'https:'].includes(new URL(params.url as string).protocol); } catch { return false; } })()) {
        interaction = { type: 'approval', interactionId, turnId: active.hostId, title: message,
          description: `${String(params.serverName).slice(0, 100)}\n${params.url}`, subject: { type: 'nativeAction' },
          actions: [{ id: 'accept', label: 'Continue after completing the browser step', effect: 'allowOnce' }, { id: 'decline', label: 'Cancel', effect: 'deny' }] };
        response = command => ({ action: command.response.type === 'approval' && command.response.actionId === 'accept' ? 'accept' : 'decline' });
      } else {
        const questions = parseElicitationSchema(params.requestedSchema);
        if (!questions) { this.rpc.send({ id: rpcId, result: { action: 'decline' } }); return; }
        interaction = { type: 'question', interactionId, turnId: active.hostId, title: message, questions: questions.map(question => question.options ? {
          id: question.id, type: 'choice', prompt: question.prompt, multiple: question.valueType === 'stringArray', allowOther: false, optional: question.optional,
          options: question.options.map(option => ({ value: option.value, label: option.label })),
        } : { id: question.id, type: 'text', prompt: question.prompt, multiline: false, secret: question.secret, optional: question.optional }) };
        response = command => command.response.type === 'question' && !command.response.cancelled
          ? { action: 'accept', content: elicitationContent(questions, command.response.answers) } : { action: 'cancel' };
      }
    } else if (method === 'item/permissions/requestApproval') {
      const permissions = object.parse(params.permissions);
      interaction = { type: 'approval', interactionId, turnId: active.hostId, title: 'Codex requests additional permissions',
        description: [typeof params.reason === 'string' ? params.reason : '', JSON.stringify(permissions)].filter(Boolean).join('\n'), subject: { type: 'nativeAction' },
        actions: [{ id: 'turn', label: 'Allow for this turn', effect: 'allowOnce' }, { id: 'session', label: 'Allow for this conversation', effect: 'allowForSession' }, { id: 'deny', label: 'Deny', effect: 'deny' }] };
      response = command => command.response.type === 'approval' && command.response.actionId !== 'deny'
        ? { permissions, scope: command.response.actionId } : { permissions: {}, scope: 'turn' };
    } else {
      this.rpc.send({ id: rpcId, error: { code: -32601, message: 'This Codex interaction is not supported by the DSH plugin' } });
      return;
    }
    this.interactions.set(interactionId, { rpcId, interaction, response });
    this.channel.emit({ kind: 'interaction', interaction });
  }

  private emit(event: HostEvent): void { this.channel.emit({ kind: 'event', event }); }

  private finish(active: ActiveTurn, outcome: Extract<HostEvent, { type: 'turn.completed' }>['outcome']): void {
    if (this.active !== active) return;
    for (const [interactionId, pending] of this.interactions) {
      this.emit({ type: 'interaction.closed', interactionId: pending.interaction.interactionId, turnId: active.hostId, reason: 'cancelled' });
      this.interactions.delete(interactionId);
    }
    this.emit({ type: 'turn.completed', turnId: active.hostId, outcome,
      ...(active.nativeId && this.threadId ? { nativeTurnRef: { harnessId: id, nativeSessionId: this.threadId, nativeTurnKey: active.nativeId, formatVersion: 1 as const } } : {}) });
    this.active = undefined;
    active.done.resolve();
  }

  private fail(error: Error): void {
    if (this.fault) return;
    this.fault = { ...errorResult(error).error, code: 'processExited' };
    if (this.active) this.finish(this.active, { status: 'failed', error: this.fault });
    this.emit({ type: 'session.faulted', error: this.fault });
    this.channel.end();
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = Promise.resolve().then(async () => {
      try {
        const active = this.active;
        if (active) {
          await this.start?.catch(() => {});
          if (this.active === active) await this.rpc.request('turn/interrupt', { threadId: this.threadId, turnId: active.nativeId });
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([active.done.promise, new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error('Codex cancellation was not confirmed')), this.options.requestTimeoutMs);
            })]);
          } finally { clearTimeout(timer); }
        }
      } finally { await this.rpc.close(); this.channel.end(); }
    });
    return this.closing;
  }
}
