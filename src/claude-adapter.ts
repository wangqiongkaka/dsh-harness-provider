/** Claude Code native sessions behind the Host contract: turns, activities, interactions, configuration and usage. */
import { claudeHistoryOperation } from './claude-history.js';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  HarnessOutputChannel, harnessIdSchema, hostInteractionIdSchema, hostItemIdSchema, nativeSessionRefSchema, validateHostInteractionResponse,
  type HarnessAccountSnapshot, type HarnessAdapter, type HarnessError, type HarnessInspection, type HarnessModelRef, type HarnessOutput,
  type HarnessPermissionModeId, type HarnessResult, type HarnessSession, type HarnessSessionState, type HarnessThinkingOptionId, type HostCommand,
  type HostEvent, type HostInteractionId, type HostItem, type HostItemOf, type HostItemOutcome, type HostQuestionInteraction,
  type HostApprovalInteraction, type HostSubagentState, type HostTurnId, type HostUsage, type InteractionRespondCommand, type JsonValue,
  type ModelSelectCommand, type NativeSessionRef, type OpenSessionInput, type PermissionModeSelectCommand, type ThinkingSelectCommand,
  type TurnCancelCommand, type TurnOutcome, type TurnStartCommand,
} from './contracts.js';
import {
  accountSnapshot, DEFAULT_MODEL_REF, DEFAULT_PERMISSION_MODE, DEFAULT_THINKING, decodeModelRef, decodePermissionMode, encodePermissionMode,
  isTaskTool, modelCatalog, parseThinking, permissionModeCatalog, projectFileChange, TaskTracker, THINKING_OPTIONS,
  type ClaudeFailureKind, type ClaudeInteractionRequest, type ClaudePermissionMode, type ClaudeProcessUsage, type ClaudeTurnEvent, type ClaudeTurnResult,
} from './claude-native.js';
import {
  ClaudeInspector, ClaudeNotInstalledError, ClaudeTransport, withUserShellEnvironment,
  type ClaudeInteractionResponse, type QueryFactory, type TransportEvent,
} from './claude-sdk.js';

const harnessId = harnessIdSchema.parse('claude-code');
const capabilities = {
  configuration: { selectModel: true, selectThinkingOption: true, selectPermissionMode: true, permissionModeScope: 'live' as const },
  history: { fork: true, forkAcrossCwd: false, rollbackLastTurn: true },
};
const CLOSE_TIMEOUT_MS = 7_000;
const CANCEL_TIMEOUT_MS = 2_000;
const TOOL_OUTPUT_LIMIT = 64_000;
const CONTEXT_USAGE_TTL_MS = 10_000;
const CONTEXT_USAGE_COOLDOWN_MS = 5_000;
/**
 * Claude opens a background subagent's continuation within milliseconds of the segment that saw it stop, and how many
 * segments it spends on queued notifications is not observable; the task is idle once no segment opens for this long.
 */
const CONTINUATION_QUIESCENCE_MS = 2_000;

const error = (code: HarnessError['code'], message: string, retryable = false): HarnessError => ({ code, message, retryable });
const failed = <T>(code: HarnessError['code'], message: string, retryable = false): HarnessResult<T> => ({ ok: false, error: error(code, message, retryable) });
const faultError = () => error('processExited', 'Claude Code Session became unavailable', true);
function transportFailure(kind: ClaudeFailureKind): HarnessError {
  if (kind === 'authentication') return error('authenticationRequired', 'Claude Code authentication is required', true);
  if (kind === 'protocol') return error('protocolError', 'Claude Code returned an invalid Tool lifecycle');
  return error('nativeFailure', kind === 'textConflict' ? 'Claude Code returned inconsistent streamed text'
    : kind === 'cancellationUnproven' ? 'Claude Code cancellation could not be proven' : 'Claude Code Turn failed', kind !== 'textConflict');
}
function startupFailure(cause: unknown): HarnessError {
  if (cause instanceof ClaudeNotInstalledError) return error('notInstalled', cause.message);
  const text = cause instanceof Error ? cause.message.toLowerCase() : '';
  return text.includes('not logged in') || text.includes('authentication') || text.includes('api key')
    ? error('authenticationRequired', 'Claude Code authentication is required', true) : error('unavailable', 'Claude Code could not start', true);
}
const newItemId = () => hostItemIdSchema.parse(randomUUID());

// ── Activity lifecycles ─────────────────────────────────────────────────────────────────────────────────────────────

type Emit = (event: HostEvent) => void;
type ToolItem = HostItemOf<'commandExecution'> | HostItemOf<'toolExecution'>;

/** Tool calls between their native start and result; Bash becomes a command, Task* calls a todo list, Edit/Write a diff. */
class ToolLifecycle {
  readonly #tools = new Map<string, { item: ToolItem; name: string; args: JsonValue; startedAt: number; elapsedMs: number }>();
  constructor(private readonly turnId: HostTurnId, private readonly cwd: string, private readonly tasks: TaskTracker, private readonly emit: Emit) {}
  get size(): number { return this.#tools.size; }

  start(event: Extract<ClaudeTurnEvent, { type: 'tool.started' }>): void {
    if (this.#tools.has(event.callId)) throw new Error('Claude Code Tool started more than once');
    const args = event.arguments;
    const command = event.toolName === 'Bash' && typeof args === 'object' && args !== null && !Array.isArray(args) && typeof args.command === 'string' ? args.command : undefined;
    const item: ToolItem = command ? { type: 'commandExecution', itemId: newItemId(), command, cwd: this.cwd,
      ...(typeof args === 'object' && args !== null && !Array.isArray(args) && typeof args.description === 'string' && args.description.trim() ? { description: args.description } : {}) }
      : { type: 'toolExecution', itemId: newItemId(), toolName: isTaskTool(event.toolName) ? 'Todo' : event.toolName, arguments: isTaskTool(event.toolName) ? {} : args };
    this.#tools.set(event.callId, { item, name: event.toolName, args, startedAt: Date.now(), elapsedMs: 0 });
    this.emit({ type: 'item.started', turnId: this.turnId, item });
  }

  progress(event: Extract<ClaudeTurnEvent, { type: 'tool.progress' }>): void {
    const tool = this.#tools.get(event.callId);
    if (!tool) throw new Error('Claude Code Tool Progress references an unknown Tool');
    tool.elapsedMs = Math.max(tool.elapsedMs, event.elapsedMs);
  }

  complete(event: Extract<ClaudeTurnEvent, { type: 'tool.completed' }>, cancelled: boolean): void {
    const tool = this.#tools.get(event.callId);
    if (!tool || tool.name !== event.toolName) throw new Error('Claude Code Tool completion references an unknown Tool');
    this.#tools.delete(event.callId);
    const text = event.outputText, truncated = (text?.length ?? 0) > TOOL_OUTPUT_LIMIT;
    const output = text ? truncated ? text.slice(0, TOOL_OUTPUT_LIMIT) : text : undefined;
    const durationMs = Math.max(tool.elapsedMs, Date.now() - tool.startedAt, 0);
    let item: ToolItem = tool.item.type === 'commandExecution'
      ? { ...tool.item, ...(output !== undefined ? { output, outputTruncated: truncated } : {}), durationMs }
      : { ...tool.item, ...(output !== undefined || event.images?.length ? { output: { content: [...(output !== undefined ? [{ type: 'text' as const, text: output }] : []), ...(event.images ?? [])], ...(truncated ? { truncated: true } : {}) } } : {}), durationMs };
    const outcome: HostItemOutcome = cancelled ? { status: 'cancelled', reason: 'Cancelled by user' }
      : event.isError ? { status: 'failed', error: error('nativeFailure', `Claude Code Tool '${event.toolName}' failed`) } : { status: 'succeeded' };
    if (outcome.status === 'succeeded' && item.type === 'toolExecution' && isTaskTool(event.toolName)) {
      const todos = this.tasks.apply(event.toolName, tool.args, event.structuredResult);
      if (todos) item = { ...item, toolName: 'Todo', arguments: todos };
    }
    this.emit({ type: 'item.completed', turnId: this.turnId, snapshot: { item, outcome } });
    const change = outcome.status === 'succeeded' && event.fileChange ? projectFileChange(event.fileChange, this.cwd) : null;
    if (change) {
      const fileItem: HostItem = { type: 'fileChange', itemId: newItemId(), changes: [change] };
      this.emit({ type: 'item.started', turnId: this.turnId, item: fileItem });
      this.emit({ type: 'item.completed', turnId: this.turnId, snapshot: { item: fileItem, outcome } });
    }
  }

  finalize(outcome: HostItemOutcome): void {
    for (const tool of this.#tools.values()) {
      this.emit({ type: 'item.completed', turnId: this.turnId, snapshot: { item: { ...tool.item, durationMs: Math.max(tool.elapsedMs, Date.now() - tool.startedAt, 0) }, outcome } });
    }
    this.#tools.clear();
  }
}

/** Agent/Task/SendMessage delegations, each shown as one subagent item. */
class SubagentLifecycle {
  readonly #items = new Map<string, HostItemOf<'subagentDelegation'>>();
  constructor(private readonly turnId: HostTurnId, private readonly emit: Emit) {}
  get size(): number { return this.#items.size; }

  start(event: Extract<ClaudeTurnEvent, { type: 'subagent.started' }>): void {
    if (this.#items.has(event.callId)) throw new Error('Claude Code Subagent delegation started more than once');
    const item: HostItemOf<'subagentDelegation'> = {
      type: 'subagentDelegation', itemId: newItemId(), operation: event.operation, ...(event.prompt ? { prompt: event.prompt } : {}),
      subagents: [{ subagentId: event.nativeSubagentId ?? event.callId, ...(event.nativeSubagentId ? { nativeSubagentId: event.nativeSubagentId } : {}),
        description: event.description, ...(event.role ? { role: event.role } : {}), background: event.background, status: 'running' }],
    };
    this.#items.set(event.callId, item);
    this.emit({ type: 'item.started', turnId: this.turnId, item });
  }

  update(event: Extract<ClaudeTurnEvent, { type: 'subagent.updated' }>): void {
    const item = this.#items.get(event.callId);
    if (!item) return;
    this.#replace(event.callId, item, { ...item.subagents[0]!, status: event.status, ...(event.nativeSubagentId ? { nativeSubagentId: event.nativeSubagentId } : {}),
      ...(event.description ? { description: event.description } : {}), ...(event.role ? { role: event.role } : {}), ...(event.resultSummary ? { resultSummary: event.resultSummary } : {}) });
  }

  complete(event: Extract<ClaudeTurnEvent, { type: 'subagent.completed' }>, cancelled: boolean): HostSubagentState {
    const item = this.#items.get(event.callId);
    if (!item) throw new Error('Claude Code Subagent completion references an unknown delegation');
    this.#items.delete(event.callId);
    const status = cancelled ? 'interrupted' : event.isError ? 'failed' : item.operation === 'send' || event.continuesInBackground ? 'running' : 'completed';
    const subagent: HostSubagentState = { ...item.subagents[0]!, status, ...(event.nativeSubagentId ? { nativeSubagentId: event.nativeSubagentId } : {}),
      ...(event.resultSummary ? { resultSummary: event.resultSummary } : {}) };
    const done = this.#replace(event.callId, item, subagent);
    this.#items.delete(event.callId);
    this.emit({ type: 'item.completed', turnId: this.turnId, snapshot: { item: done, outcome: cancelled ? { status: 'cancelled', reason: 'Cancelled by user' }
      : event.isError ? { status: 'failed', error: error('nativeFailure', 'Claude Code Subagent delegation failed') } : { status: 'succeeded' } } });
    return subagent;
  }

  finalize(outcome: HostItemOutcome): void {
    for (const item of this.#items.values()) {
      const current = item.subagents[0]!;
      const status = outcome.status === 'succeeded' ? current.status : outcome.status === 'cancelled' ? 'interrupted' : 'failed';
      this.emit({ type: 'item.completed', turnId: this.turnId, snapshot: { item: { ...item, subagents: [{ ...current, status }] }, outcome } });
    }
    this.#items.clear();
  }

  #replace(callId: string, item: HostItemOf<'subagentDelegation'>, subagent: HostSubagentState): HostItemOf<'subagentDelegation'> {
    const next = { ...item, subagents: [subagent] };
    this.#items.set(callId, next);
    this.emit({ type: 'item.updated', turnId: this.turnId, itemId: item.itemId, update: { type: 'subagents.replace', subagents: next.subagents } });
    return next;
  }
}

/**
 * Background subagents of one user task. A stopped subagent still owes a root continuation that arrives in a later
 * native segment, so the task stays occupied until those continuations have run.
 */
class BackgroundOccupancy {
  readonly #tasks = new Map<string, { state: 'running' | 'notified'; callId?: string; agentId?: string }>();
  get unsettled(): boolean { return this.#tasks.size > 0; }
  get awaitingContinuation(): boolean { return [...this.#tasks.values()].some(task => task.state === 'notified'); }
  #find(callId?: string, agentId?: string) {
    for (const [key, task] of this.#tasks) if ((agentId && task.agentId === agentId) || (callId && task.callId === callId)) return [key, task] as const;
    return undefined;
  }
  occupySpawn(callId: string, agentId?: string): void {
    const found = this.#find(callId, agentId);
    if (found) { if (agentId) found[1].agentId = agentId; found[1].callId = callId; return; }
    this.#tasks.set(callId, { state: 'running', callId, ...(agentId ? { agentId } : {}) });
  }
  occupyAgent(agentId: string): void {
    const found = this.#find(undefined, agentId);
    if (found) found[1].state = 'running'; else this.#tasks.set(agentId, { state: 'running', agentId });
  }
  bind(callId: string, agentId: string): void {
    const found = this.#find(callId, agentId);
    if (found) { found[1].callId = callId; found[1].agentId = agentId; }
  }
  notify(callId?: string, agentId?: string): void {
    const found = this.#find(callId, agentId);
    if (!found) return;
    if (callId && agentId) this.bind(callId, agentId);
    found[1].state = 'notified';
  }
  release(callId?: string, agentId?: string): void { const found = this.#find(callId, agentId); if (found) this.#tasks.delete(found[0]); }
  /** Native live task membership replaces the running set: a tracked subagent missing from it has stopped. */
  observeLive(agentIds: readonly string[]): void {
    for (const task of this.#tasks.values()) if (task.state === 'running' && task.agentId && !agentIds.includes(task.agentId)) task.state = 'notified';
  }
  releaseContinuations(): void { for (const [key, task] of [...this.#tasks]) if (task.state === 'notified') this.#tasks.delete(key); }
  clear(): void { this.#tasks.clear(); }
}

// ── Session ─────────────────────────────────────────────────────────────────────────────────────────────────────────

type PendingInteraction = { interaction: HostApprovalInteraction | HostQuestionInteraction; request: ClaudeInteractionRequest };
interface ActiveTurn {
  turnId: HostTurnId;
  nativeTurnKey: string;
  item: HostItemOf<'agentMessage'> | null;
  assistantMessageId: string | null;
  reasoning: Map<string, HostItemOf<'reasoning'>>;
  compaction: HostItemOf<'contextCompaction'> | null;
  tools: ToolLifecycle;
  subagents: SubagentLifecycle;
  interactions: Map<HostInteractionId, PendingInteraction>;
  byRequestId: Map<string, HostInteractionId>;
  cancellationRequested: boolean;
  /** Succeeded natively, but kept open while background subagents still owe root output. */
  held: boolean;
  /** Claude can still produce a native result for the current root segment. */
  rootSegmentActive: boolean;
}
type Counters = { input: number; cacheRead: number; cacheWrite: number; output: number };
const zero = (): Counters => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });

interface SessionOptions {
  cwd: string; environment: NodeJS.ProcessEnv; command?: string; queryFactory?: QueryFactory;
  openMode: 'create' | 'resume'; sessionId: string; initialState: HarnessSessionState; initialUsage: HostUsage | null;
  model?: HarnessModelRef; thinkingOptionId: HarnessThinkingOptionId; permissionModeId: HarnessPermissionModeId; onClosed(): void;
}

class ClaudeSession implements HarnessSession {
  readonly harnessId = harnessId;
  readonly capabilities = capabilities;
  readonly initialState: HarnessSessionState;
  readonly initialUsage: HostUsage | null;
  readonly #channel = new HarnessOutputChannel<HarnessOutput>();
  readonly outputs = this.#channel.outputs;
  readonly #options: SessionOptions;
  readonly #nativeRef: NativeSessionRef;
  readonly #tasks = new TaskTracker();
  readonly #occupancy = new BackgroundOccupancy();
  #phase: 'open' | 'closing' | 'closed' | 'faulted' = 'open';
  #openMode: 'create' | 'resume';
  #model: HarnessModelRef | undefined;
  #thinking: HarnessThinkingOptionId;
  #permission: HarnessPermissionModeId;
  #state: HarnessSessionState;
  #transport: ClaudeTransport | null = null;
  #startup: Promise<ClaudeTransport> | null = null;
  #accepting = false;
  #configuring = false;
  #active: ActiveTurn | null = null;
  #closing: Promise<void> | null = null;
  #hardCancel: Promise<void> | null = null;
  #cancelEscalation: ReturnType<typeof setTimeout> | null = null;
  #quiescence: ReturnType<typeof setTimeout> | null = null;
  #usage: HostUsage | null;
  /** Session counters: totals carried from earlier native processes plus the current process's cumulative usage. */
  #carried = zero();
  #process = zero();
  #contextWindows: Record<string, number> = {};
  #lastModel: string | undefined;
  /** Prompt size of the latest root request: what currently occupies the context window. */
  #lastPrompt = 0;
  #contextFreshUntil = 0;
  #contextCooldownUntil = 0;
  #contextRefresh: Promise<void> | null = null;

  constructor(options: SessionOptions) {
    this.#options = options;
    this.#openMode = options.openMode;
    this.#model = options.model;
    this.#thinking = options.thinkingOptionId;
    this.#permission = options.permissionModeId;
    this.#nativeRef = nativeSessionRefSchema.parse({ harnessId, nativeSessionId: options.sessionId, formatVersion: 1 });
    this.initialState = this.#state = options.initialState;
    this.initialUsage = this.#usage = options.initialUsage;
  }

  execute(command: TurnStartCommand): Promise<HarnessResult<{ turnId: HostTurnId }>>;
  execute(command: TurnCancelCommand): Promise<HarnessResult<{ cancellationRequested: true }>>;
  execute(command: InteractionRespondCommand): Promise<HarnessResult<{ accepted: true }>>;
  execute(command: ModelSelectCommand | ThinkingSelectCommand | PermissionModeSelectCommand): Promise<HarnessResult<{ completed: true }>>;
  async execute(command: HostCommand): Promise<HarnessResult<unknown>> {
    if (this.#phase !== 'open') return failed('invalidState', 'Claude Code Session is not open');
    switch (command.type) {
      case 'turn.cancel': return this.#cancel(command);
      case 'interaction.respond': return this.#respond(command);
      case 'model.select': case 'thinking.select': case 'permissionMode.select': return this.#configure(command);
      case 'turn.start': return this.#start(command);
    }
  }

  /** Reads the live context window occupancy; bounded by a freshness window and a cooldown after failures. */
  refreshUsage(): Promise<void> {
    const transport = this.#transport, now = Date.now();
    if (this.#phase !== 'open' || !transport || this.#contextRefresh || now < this.#contextFreshUntil || now < this.#contextCooldownUntil) return this.#contextRefresh ?? Promise.resolve();
    return this.#contextRefresh = transport.getContextUsage().then(context => {
      if (!context || this.#transport !== transport || this.#phase !== 'open') return;
      this.#contextFreshUntil = Date.now() + CONTEXT_USAGE_TTL_MS;
      this.#publishUsage({ contextUsedTokens: context.usedTokens, contextWindowTokens: context.maxTokens });
    }, () => { this.#contextCooldownUntil = Date.now() + CONTEXT_USAGE_COOLDOWN_MS; }).finally(() => { this.#contextRefresh = null; });
  }

  async readSnapshot() {
    try { return { ok: true as const, value: { turns: await claudeHistoryOperation('read', this.#state.nativeRef!, this.#options.cwd, this.#options.environment) as import('./contracts.js').HostTurnSnapshot[], state: this.#state } }; }
    catch { return failed<{ turns: import('./contracts.js').HostTurnSnapshot[]; state: HarnessSessionState }>('unavailable', '无法读取 Claude 原生会话记录'); }
  }
  async fork(throughTurn?: string | null): Promise<HarnessResult<NativeSessionRef | undefined>> {
    if (this.#active || this.#accepting || this.#configuring) return failed('sessionBusy', '请等待当前轮结束');
    try { return { ok: true, value: (await claudeHistoryOperation('fork', this.#state.nativeRef!, this.#options.cwd, this.#options.environment, throughTurn) ?? undefined) as NativeSessionRef | undefined }; }
    catch { return failed('unavailable', '无法创建 Claude 原生会话分支'); }
  }
  async steer(input: import('./contracts.js').HostInput[]): Promise<HarnessResult<{ accepted: true }>> {
    if (!this.#active || !this.#transport) return failed('invalidState', '当前没有可插入的原生轮次');
    try {
      this.#transport.steer(input.map(part => part.type === 'text' ? { type: 'text' as const, text: part.text }
        : { type: 'image' as const, source: { type: 'base64' as const, media_type: part.mimeType, data: part.base64Data } }));
      return { ok: true, value: { accepted: true } };
    } catch { return failed('unavailable', '原生轮次已结束，插入未被接收'); }
  }

  close(): Promise<void> { return this.#closing ??= this.#close(); }

  async #start(command: TurnStartCommand): Promise<HarnessResult<{ turnId: HostTurnId }>> {
    if (this.#accepting || this.#active || this.#configuring) return failed('sessionBusy', 'Claude Code Session already has an active Turn', true);
    const text = command.input.every(input => input.type === 'text') ? command.input.map(input => input.text).join('\n')
      : command.input.map(input => input.type === 'text' ? { type: 'text' as const, text: input.text }
        : { type: 'image' as const, source: { type: 'base64' as const, media_type: input.mimeType, data: input.base64Data } });
    if (!text.length) return failed('invalidRequest', 'Claude Code text Turn must not be empty');
    this.#accepting = true;
    const starting = !this.#transport;
    let transport: ClaudeTransport;
    try { transport = await this.#ensureTransport(); } catch (cause) { return { ok: false, error: startupFailure(cause) }; } finally { this.#accepting = false; }
    if (this.#phase !== 'open') return failed('invalidState', 'Claude Code Session closed during startup');
    if (starting) this.#publishState(this.#state);
    this.#contextFreshUntil = this.#contextCooldownUntil = 0;
    const nativeTurnKey = randomUUID();
    const active: ActiveTurn = {
      turnId: command.turnId, nativeTurnKey, item: { type: 'agentMessage', itemId: newItemId(), text: '' }, assistantMessageId: null,
      reasoning: new Map(), compaction: null, tools: new ToolLifecycle(command.turnId, this.#options.cwd, this.#tasks, event => this.#event(event)),
      subagents: new SubagentLifecycle(command.turnId, event => this.#event(event)), interactions: new Map(), byRequestId: new Map(),
      cancellationRequested: false, held: false, rootSegmentActive: true,
    };
    this.#active = active;
    this.#event({ type: 'turn.started', turnId: command.turnId, nativeTurnRef: { harnessId, nativeSessionId: this.#options.sessionId, nativeTurnKey, formatVersion: 1 } });
    this.#event({ type: 'item.started', turnId: command.turnId, item: active.item! });
    transport.runTurn(text, nativeTurnKey, event => this.#turnEvent(active, event))
      .then(result => this.#finishResult(active, result), () => {
        if (this.#active !== active) return;
        if (active.cancellationRequested) this.#forceCancel(active); else this.#fault(faultError());
      });
    return { ok: true, value: { turnId: command.turnId } };
  }

  async #configure(command: ModelSelectCommand | ThinkingSelectCommand | PermissionModeSelectCommand): Promise<HarnessResult<{ completed: true }>> {
    // Permission mode may change mid-turn (for example while a tool approval is pending); model and thinking may not.
    if (this.#configuring || (command.type !== 'permissionMode.select' && (this.#accepting || this.#active))) {
      return failed('sessionBusy', 'Claude Code Session cannot change configuration during another operation', true);
    }
    let apply: (transport: ClaudeTransport) => Promise<void>;
    try {
      if (command.type === 'model.select') { const model = decodeModelRef(command.model); apply = transport => transport.setModel(model); }
      else if (command.type === 'thinking.select') { const id = parseThinking(command.thinkingOptionId); apply = transport => transport.setThinking(id); }
      else { const mode = decodePermissionMode(command.permissionModeId); apply = transport => transport.setPermissionMode(mode); }
    } catch { return failed('invalidRequest', 'Claude Code configuration value is invalid'); }
    this.#configuring = true;
    this.#contextFreshUntil = this.#contextCooldownUntil = 0;
    try {
      const transport = this.#transport;
      if (transport) {
        try { await apply(transport); } catch (cause) {
          const autoUnavailable = command.type === 'permissionMode.select' && command.permissionModeId === 'auto'
            && cause instanceof Error && cause.message.toLowerCase().includes('auto mode unavailable');
          return failed('nativeFailure', autoUnavailable ? 'Auto mode is unavailable for the current Claude Code Model' : 'Claude Code rejected the configuration change', true);
        }
      }
      if (command.type === 'model.select') this.#model = command.model;
      else if (command.type === 'thinking.select') this.#thinking = command.thinkingOptionId;
      else this.#permission = transport ? encodePermissionMode(transport.permissionMode) : command.permissionModeId;
      this.#publishState(this.#configuredState());
      return { ok: true, value: { completed: true } };
    } finally { this.#configuring = false; }
  }

  async #respond(command: InteractionRespondCommand): Promise<HarnessResult<{ accepted: true }>> {
    const active = this.#active, pending = active?.interactions.get(command.interactionId), transport = this.#transport;
    if (!active || !pending || !transport) return failed('invalidState', 'Claude Code Interaction Response must reference a pending Interaction');
    const invalid = validateHostInteractionResponse(pending.interaction, command.response);
    if (invalid) return { ok: false, error: invalid };
    const { request } = pending, response = command.response;
    let native: ClaudeInteractionResponse;
    if (response.type === 'approval') {
      const action = (pending.interaction as HostApprovalInteraction).actions.find(candidate => candidate.id === response.actionId)!;
      native = request.type === 'elicitation'
        ? { type: 'elicitation', requestId: request.requestId, result: { action: action.effect === 'deny' ? 'decline' : 'accept' } }
        : { type: 'approval', requestId: request.requestId, decision: action.effect };
    } else if (request.type === 'planApproval') {
      native = { type: 'approval', requestId: request.requestId, decision: !response.cancelled && request.plan && response.answers[PLAN_DECISION]?.[0] === 'approve' ? 'allowOnce' : 'deny' };
    } else if (request.type === 'question') {
      native = response.cancelled ? { type: 'question', requestId: request.requestId, cancelled: true }
        : { type: 'question', requestId: request.requestId, answers: Object.fromEntries(request.questions.map((question, index) => [question.question, response.answers[`question-${index + 1}`]?.join(', ') ?? ''])) };
    } else if (request.type === 'elicitation' && request.mode === 'form') {
      if (response.cancelled) native = { type: 'elicitation', requestId: request.requestId, result: { action: 'cancel' } };
      else {
        const content: Record<string, string | number | boolean | string[]> = {};
        for (const question of request.questions) {
          const answers = response.answers[question.id];
          if (question.valueType === 'stringArray') { if (answers) content[question.id] = answers; continue; }
          const answer = answers?.[0];
          if (answer === undefined) continue;
          if (question.valueType === 'number' || question.valueType === 'integer') {
            const value = Number(answer);
            if (!Number.isFinite(value) || (question.valueType === 'integer' && !Number.isInteger(value))) return failed('invalidRequest', `${question.prompt} must be a valid ${question.valueType}`);
            content[question.id] = value;
          } else content[question.id] = question.valueType === 'boolean' ? answer === 'true' : answer;
        }
        native = { type: 'elicitation', requestId: request.requestId, result: { action: 'accept', content } };
      }
    } else return failed('invalidRequest', 'Claude Code Interaction response type does not match');
    try { transport.respondToInteraction(native); } catch { return failed('nativeFailure', 'Claude Code Interaction response failed'); }
    return { ok: true, value: { accepted: true } };
  }

  async #cancel(command: TurnCancelCommand): Promise<HarnessResult<{ cancellationRequested: true }>> {
    const active = this.#active;
    if (!active || active.turnId !== command.turnId) return failed('invalidState', 'Claude Code Turn Cancel must reference the active Turn');
    const accepted = { ok: true as const, value: { cancellationRequested: true as const } };
    if (active.cancellationRequested) return accepted;
    active.cancellationRequested = true;
    if (active.held) { this.#finish(active, { status: 'cancelled', reason: 'Cancelled by user' }); return accepted; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.#transport?.abort() ?? Promise.resolve(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Claude Code interrupt timed out')), CANCEL_TIMEOUT_MS); })]);
    } catch { this.#forceCancel(active); return accepted; } finally { clearTimeout(timer); }
    // An acknowledged interrupt must still produce a native terminal; escalate if it does not.
    if (this.#active === active) {
      this.#clearCancelEscalation();
      (this.#cancelEscalation = setTimeout(() => { this.#cancelEscalation = null; if (this.#active === active && this.#phase === 'open') this.#forceCancel(active); }, CANCEL_TIMEOUT_MS)).unref();
    }
    return accepted;
  }

  async #close(): Promise<void> {
    if (this.#phase === 'closed') return;
    this.#phase = 'closing';
    this.#clearCancelEscalation();
    this.#clearQuiescence();
    const failures: unknown[] = [];
    const settle = async (task: Promise<unknown> | undefined) => {
      if (!task) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([task, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Claude Code Session close timed out')), CLOSE_TIMEOUT_MS * 4); })]); }
      catch (cause) { failures.push(cause); } finally { clearTimeout(timer); }
    };
    const closing = this.#transport;
    await settle(closing?.close());
    await settle(this.#startup?.catch(() => {}));
    if (this.#transport !== closing) await settle(this.#transport?.close());
    if (this.#active) this.#finish(this.#active, { status: 'failed', error: error('invalidState', 'Claude Code Session closed during active Turn') });
    this.#phase = 'closed';
    this.#channel.end();
    this.#options.onClosed();
    if (failures.length) throw new AggregateError(failures, 'Claude Code Session could not stop safely');
  }

  #ensureTransport(): Promise<ClaudeTransport> {
    if (this.#transport) return Promise.resolve(this.#transport);
    return this.#startup ??= this.#startTransport().finally(() => { this.#startup = null; });
  }

  async #startTransport(): Promise<ClaudeTransport> {
    const options = this.#options;
    const model = this.#model ? decodeModelRef(this.#model) : undefined;
    const transport = new ClaudeTransport({
      ...(options.command ? { command: options.command } : {}), ...(options.queryFactory ? { queryFactory: options.queryFactory } : {}),
      environment: options.environment, cwd: options.cwd, sessionId: options.sessionId, openMode: this.#openMode,
      ...(model ? { model } : {}), thinkingOptionId: this.#thinking, permissionMode: decodePermissionMode(this.#permission),
      closeTimeoutMs: CLOSE_TIMEOUT_MS, abortTimeoutMs: CANCEL_TIMEOUT_MS,
      onPermissionModeChanged: mode => this.#permissionModeChanged(mode),
      onFault: () => this.#fault(faultError()),
      onIdleEvent: event => {
        const active = this.#active;
        if (active) this.#turnEvent(active, event);
        else if (event.type === 'subagent.settled') this.#occupancy.notify(event.callId, event.nativeSubagentId);
      },
      onIdleTerminal: result => { if (this.#active) this.#finishResult(this.#active, result); },
    });
    this.#transport = transport;
    try { await transport.start(); } catch (cause) {
      this.#transport = null;
      try { await transport.close(); } catch (closeError) { this.#fault(faultError()); throw closeError; }
      throw cause;
    }
    // A new native process counts usage from zero; keep what earlier processes of this session already counted.
    this.#carried = this.#counters();
    this.#process = zero();
    this.#state = { ...this.#configuredState(true), effectivePermissionModeId: encodePermissionMode(transport.permissionMode) };
    this.#openMode = 'resume';
    return transport;
  }

  #configuredState(nativeReady = this.#state.nativeRef !== undefined): HarnessSessionState {
    const effectiveModel = this.#model ?? (this.#openMode === 'create' ? DEFAULT_MODEL_REF : this.#state.effectiveModel);
    return {
      ...(nativeReady ? { nativeRef: this.#nativeRef } : {}), ...(effectiveModel ? { effectiveModel } : {}),
      effectiveThinkingOptionId: this.#thinking, availableThinkingOptions: [...THINKING_OPTIONS], effectivePermissionModeId: this.#permission,
    };
  }

  #publishState(state: HarnessSessionState): void {
    this.#state = state;
    this.#event({ type: 'session.state.changed', state });
  }

  #permissionModeChanged(mode: ClaudePermissionMode): void {
    const id = encodePermissionMode(mode);
    if (this.#phase !== 'open' || this.#state.effectivePermissionModeId === id) return;
    this.#permission = id;
    this.#publishState({ ...this.#state, effectivePermissionModeId: id });
  }

  #turnEvent(active: ActiveTurn, event: TransportEvent): void {
    if (this.#active !== active || this.#phase === 'closed' || this.#phase === 'faulted') return;
    const { turnId } = active;
    switch (event.type) {
      case 'segment.started': this.#observeRootOutput(active); return;
      case 'subagents.live': this.#occupancy.observeLive(event.nativeSubagentIds); this.#armQuiescence(active); return;
      case 'compaction.started':
        this.#observeRootOutput(active);
        if (active.compaction) throw new Error('Claude Code Compaction started more than once');
        active.compaction = { type: 'contextCompaction', itemId: newItemId() };
        this.#event({ type: 'item.started', turnId, item: active.compaction });
        return;
      case 'compaction.completed':
        this.#completeCompaction(active, event.outcome === 'succeeded' ? { status: 'succeeded' }
          : { status: 'failed', error: error('nativeFailure', 'Claude Code context compaction failed', true) });
        return;
      case 'text.delta':
        this.#observeRootOutput(active);
        this.#activateMessage(active, event.messageId);
        active.item = { ...active.item!, text: active.item!.text + event.delta };
        this.#event({ type: 'item.updated', turnId, itemId: active.item.itemId, update: { type: 'text.append', text: event.delta } });
        return;
      case 'reasoning.delta': {
        this.#observeRootOutput(active);
        this.#activateMessage(active, event.messageId);
        let item = active.reasoning.get(event.messageId);
        if (!item) {
          item = { type: 'reasoning', itemId: newItemId(), text: '' };
          this.#event({ type: 'item.started', turnId, item });
        }
        active.reasoning.set(event.messageId, { ...item, text: item.text + event.delta });
        this.#event({ type: 'item.updated', turnId, itemId: item.itemId, update: { type: 'text.append', text: event.delta } });
        return;
      }
      case 'reasoning.completed': this.#completeReasoning(active, event.messageId, { status: 'succeeded' }); return;
      case 'message.completed':
        // A continuation may complete a message without text; keep a held turn open until the native result confirms it.
        this.#observeRootOutput(active);
        if (event.requestUsage) {
          const usage = event.requestUsage;
          this.#lastModel = usage.model ?? this.#lastModel;
          const window = this.#lastModel ? this.#contextWindows[this.#lastModel] : undefined;
          const prompt = this.#lastPrompt = usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
          const contextWindowTokens = window ?? this.#usage?.contextWindowTokens;
          if (contextWindowTokens && prompt > 0) this.#publishUsage({ contextUsedTokens: prompt, contextWindowTokens }, turnId);
        }
        this.#completeReasoning(active, event.messageId, { status: 'succeeded' });
        if (!active.tools.size && !active.subagents.size && !active.interactions.size && !active.compaction) this.#completeMessage(active, { status: 'succeeded' }, false);
        return;
      case 'tool.started':
      case 'subagent.started':
        this.#observeRootOutput(active);
        for (const messageId of [...active.reasoning.keys()]) this.#completeReasoning(active, messageId, { status: 'succeeded' });
        this.#completeMessage(active, { status: 'succeeded' }, false);
        if (event.type === 'tool.started') active.tools.start(event);
        else {
          active.subagents.start(event);
          if (event.operation === 'send') { if (event.nativeSubagentId) this.#occupancy.occupyAgent(event.nativeSubagentId); }
          else if (event.background) this.#occupancy.occupySpawn(event.callId, event.nativeSubagentId);
        }
        return;
      case 'tool.progress': active.tools.progress(event); return;
      case 'tool.completed': active.tools.complete(event, active.cancellationRequested); return;
      case 'subagent.updated':
        active.subagents.update(event);
        if (event.nativeSubagentId) this.#occupancy.bind(event.callId, event.nativeSubagentId);
        if (event.status === 'completed' || event.status === 'failed' || event.status === 'interrupted') this.#settleSubagent(event.callId, event.nativeSubagentId);
        return;
      case 'subagent.completed': {
        const subagent = active.subagents.complete(event, active.cancellationRequested);
        if (subagent.status !== 'running') this.#occupancy.release(event.callId, subagent.nativeSubagentId);
        else if (subagent.nativeSubagentId) this.#occupancy.bind(event.callId, subagent.nativeSubagentId);
        return;
      }
      case 'subagent.settled': this.#settleSubagent(event.callId, event.nativeSubagentId); return;
      case 'interaction.requested': this.#observeRootOutput(active); this.#startInteraction(active, event.request); return;
      case 'interaction.closed': {
        const interactionId = active.byRequestId.get(event.requestId);
        if (!interactionId) throw new Error('Claude Code Interaction close references an unknown request');
        active.byRequestId.delete(event.requestId);
        active.interactions.delete(interactionId);
        return;
      }
      case 'usage.result': this.#processUsage(event.processUsage, turnId); return;
    }
  }

  #processUsage(usage: ClaudeProcessUsage, turnId: HostTurnId): void {
    this.#process = { input: usage.inputTokens, cacheRead: usage.cacheReadInputTokens, cacheWrite: usage.cacheCreationInputTokens, output: usage.outputTokens };
    this.#contextWindows = { ...this.#contextWindows, ...usage.contextWindows };
    const counters = this.#counters();
    const window = this.#lastModel ? usage.contextWindows[this.#lastModel] : undefined;
    this.#publishUsage({
      inputTokens: counters.input + counters.cacheRead + counters.cacheWrite, cachedInputTokens: counters.cacheRead,
      cacheWriteInputTokens: counters.cacheWrite, outputTokens: counters.output,
      ...(window && this.#lastPrompt > 0 ? { contextUsedTokens: this.#lastPrompt, contextWindowTokens: window } : {}),
    }, turnId);
  }

  #counters(): Counters {
    const carried = this.#carried, current = this.#process;
    return { input: carried.input + current.input, cacheRead: carried.cacheRead + current.cacheRead, cacheWrite: carried.cacheWrite + current.cacheWrite, output: carried.output + current.output };
  }

  #publishUsage(delta: HostUsage, turnId?: HostTurnId): void {
    const next = { ...this.#usage, ...delta };
    if (this.#usage && Object.entries(next).every(([key, value]) => this.#usage![key as keyof HostUsage] === value)) return;
    this.#usage = next;
    this.#event({ type: 'session.usage.changed', usage: next, ...(turnId ? { observedForTurnId: turnId } : {}) });
  }

  #startInteraction(active: ActiveTurn, request: ClaudeInteractionRequest): void {
    if (active.byRequestId.has(request.requestId)) throw new Error('Claude Code Interaction started more than once');
    const interactionId = hostInteractionIdSchema.parse(randomUUID()), { turnId } = active;
    let interaction: HostApprovalInteraction | HostQuestionInteraction;
    if (request.type === 'approval') {
      interaction = {
        type: 'approval', interactionId, turnId, title: request.title, ...(request.description ? { description: request.description } : {}), subject: { type: 'nativeAction' },
        actions: [
          { id: 'allowOnce', label: 'Allow once', effect: 'allowOnce' },
          ...(request.suggestedScope === 'session' ? [{ id: 'allowForSession', label: 'Allow this conversation', effect: 'allowForSession' as const }]
            : request.suggestedScope === 'always' ? [{ id: 'allowAlways', label: 'Always allow', effect: 'allowAlways' as const }] : []),
          { id: 'deny', label: 'Deny', effect: 'deny' },
        ],
      };
    } else if (request.type === 'elicitation' && request.mode === 'url') {
      interaction = {
        type: 'approval', interactionId, turnId, title: request.title,
        description: `${request.serverName}\n${request.url}`, subject: { type: 'nativeAction' },
        actions: [{ id: 'allowOnce', label: 'Continue after completing the browser step', effect: 'allowOnce' }, { id: 'deny', label: 'Cancel', effect: 'deny' }],
      };
    } else if (request.type === 'planApproval') {
      // Approving a plan changes the session's permission mode, so it is an explicit closed choice rather than a tool approval.
      const warning = 'Approving this plan will exit plan mode, restore the permission mode used before planning, and let Claude begin implementation under that mode. This is not a one-time tool approval.';
      interaction = {
        type: 'question', interactionId, turnId, title: 'Review plan',
        questions: [{
          id: PLAN_DECISION, type: 'choice', multiple: false, allowOther: false, optional: false,
          prompt: request.plan ? `${warning}\n\n${request.plan}` : 'Claude Code did not provide plan text. Stay in plan mode and ask Claude to present the plan before approving it.',
          options: [
            { value: 'stay', label: 'Stay in plan mode', description: 'Do not approve the plan or begin implementation.' },
            ...(request.plan ? [{ value: 'approve', label: 'Approve plan and exit plan mode', description: 'Resume the previous permission mode and begin implementation.' }] : []),
          ],
        }],
      };
    } else if (request.type === 'question') {
      interaction = {
        type: 'question', interactionId, turnId, title: request.questions.length === 1 ? request.questions[0]!.header : 'Claude Code',
        questions: request.questions.map((question, index) => ({
          id: `question-${index + 1}`, type: 'choice' as const, prompt: question.question, multiple: question.multiSelect, allowOther: true, optional: false,
          options: question.options.map(option => ({ value: option.label, label: option.label, description: option.description })),
        })),
      };
    } else {
      interaction = {
        type: 'question', interactionId, turnId, title: request.title,
        questions: request.questions.map(question => question.options ? {
          id: question.id, type: 'choice' as const, prompt: question.prompt, multiple: question.valueType === 'stringArray', allowOther: false, optional: question.optional,
          options: question.options.map(option => ({ value: option.value, label: option.label })),
        } : {
          id: question.id, type: 'text' as const, prompt: question.prompt, multiline: false, secret: question.secret, optional: question.optional,
        }),
      };
    }
    active.interactions.set(interactionId, { interaction, request });
    active.byRequestId.set(request.requestId, interactionId);
    this.#channel.emit({ kind: 'interaction', interaction });
  }

  #activateMessage(active: ActiveTurn, messageId: string): void {
    if (active.assistantMessageId === messageId) return;
    if (active.assistantMessageId !== null) {
      this.#completeReasoning(active, active.assistantMessageId, { status: 'succeeded' });
      this.#completeMessage(active, { status: 'succeeded' }, false);
    }
    if (!active.item) {
      active.item = { type: 'agentMessage', itemId: newItemId(), text: '' };
      this.#event({ type: 'item.started', turnId: active.turnId, item: active.item });
    }
    active.assistantMessageId = messageId;
  }

  #completeMessage(active: ActiveTurn, outcome: HostItemOutcome, completeEmpty: boolean): void {
    active.assistantMessageId = null;
    const item = active.item;
    if (!item || (!completeEmpty && !item.text)) return;
    active.item = null;
    this.#event({ type: 'item.completed', turnId: active.turnId, snapshot: { item, outcome } });
  }

  #completeReasoning(active: ActiveTurn, messageId: string, outcome: HostItemOutcome): void {
    const item = active.reasoning.get(messageId);
    if (!item) return;
    active.reasoning.delete(messageId);
    this.#event({ type: 'item.completed', turnId: active.turnId, snapshot: { item, outcome } });
  }

  #completeCompaction(active: ActiveTurn, outcome: HostItemOutcome): void {
    const item = active.compaction;
    if (!item) throw new Error('Claude Code Compaction completed without starting');
    active.compaction = null;
    this.#event({ type: 'item.completed', turnId: active.turnId, snapshot: { item, outcome } });
  }

  #settleSubagent(callId?: string, nativeSubagentId?: string): void {
    // The subagent stopped, but its root continuation runs in a later segment.
    this.#occupancy.notify(callId, nativeSubagentId);
    if (this.#active?.held) this.#armQuiescence(this.#active);
  }

  #finishResult(active: ActiveTurn, result: ClaudeTurnResult): void {
    // A late native terminal cannot replace the process shutdown already in progress.
    if (this.#active !== active || this.#hardCancel) return;
    active.rootSegmentActive = false;
    if (result.status === 'succeeded' && (active.tools.size || active.subagents.size)) this.#finish(active, { status: 'failed', error: transportFailure('protocol') });
    else if (result.status === 'succeeded') this.#finish(active, { status: 'succeeded' });
    else if (result.status === 'cancelled') this.#finish(active, { status: 'cancelled', reason: result.reason });
    else this.#finish(active, { status: 'failed', error: transportFailure(result.kind) });
  }

  #finish(active: ActiveTurn, outcome: TurnOutcome): void {
    if (this.#active !== active) return;
    this.#clearCancelEscalation();
    this.#clearQuiescence();
    const hold = outcome.status === 'succeeded' && !active.cancellationRequested && this.#occupancy.unsettled;
    active.interactions.clear();
    active.byRequestId.clear();
    if (active.compaction) this.#completeCompaction(active, outcome);
    active.tools.finalize(outcome);
    active.subagents.finalize(outcome);
    for (const messageId of [...active.reasoning.keys()]) this.#completeReasoning(active, messageId, outcome);
    this.#completeMessage(active, outcome, true);
    if (hold) {
      active.held = true;
      this.#armQuiescence(active);
      return;
    }
    this.#event({ type: 'turn.completed', turnId: active.turnId, nativeTurnRef: { harnessId, nativeSessionId: this.#options.sessionId, nativeTurnKey: active.nativeTurnKey, formatVersion: 1 }, outcome });
    this.#active = null;
    this.#occupancy.clear();
  }

  /** Completes held work once the native session stops producing root output. */
  #armQuiescence(active: ActiveTurn): void {
    if (this.#active !== active || !active.held || active.rootSegmentActive || this.#phase !== 'open' || !this.#occupancy.awaitingContinuation) return;
    this.#clearQuiescence();
    (this.#quiescence = setTimeout(() => {
      this.#quiescence = null;
      if (this.#active !== active || !active.held || active.rootSegmentActive || this.#phase !== 'open') return;
      this.#occupancy.releaseContinuations();
      if (!this.#occupancy.unsettled) this.#finish(active, { status: 'succeeded' });
    }, CONTINUATION_QUIESCENCE_MS)).unref();
  }
  #clearQuiescence(): void { if (this.#quiescence) clearTimeout(this.#quiescence); this.#quiescence = null; }
  #observeRootOutput(active: ActiveTurn): void { active.rootSegmentActive = true; this.#clearQuiescence(); }
  #clearCancelEscalation(): void { if (this.#cancelEscalation) clearTimeout(this.#cancelEscalation); this.#cancelEscalation = null; }

  /** Stops the native process when an interrupt is not confirmed; the turn ends only after shutdown is proven. */
  #forceCancel(active: ActiveTurn): void {
    if (this.#active !== active || this.#hardCancel) return;
    this.#clearCancelEscalation();
    const transport = this.#transport;
    this.#hardCancel = Promise.resolve().then(() => transport?.close()).then(() => {
      if (this.#phase !== 'open' || this.#active !== active) return;
      this.#transport = null;
      this.#finish(active, { status: 'cancelled', reason: 'Cancelled by user' });
    }, () => this.#fault(faultError())).finally(() => { this.#hardCancel = null; });
  }

  #fault(cause: HarnessError): void {
    if (this.#phase !== 'open') return;
    this.#clearCancelEscalation();
    if (this.#active) this.#finish(this.#active, { status: 'failed', error: cause });
    this.#phase = 'faulted';
    this.#event({ type: 'session.faulted', error: cause });
    this.#channel.end();
    // Resources stay owned until an explicit close confirms their shutdown.
    void this.#transport?.close().catch(() => {});
  }

  #event(event: HostEvent): void { this.#channel.emit({ kind: 'event', event }); }
}

const PLAN_DECISION = 'plan-decision';

// ── Adapter ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ClaudeAdapterOptions {
  environment: NodeJS.ProcessEnv;
  /** Explicit executable; otherwise CODEXHOST_CLAUDE_COMMAND, PATH and the usual install locations. */
  command?: string;
  queryFactory?: QueryFactory;
}

export class ClaudeCodeAdapter implements HarnessAdapter {
  readonly harnessId = harnessId;
  readonly #options: ClaudeAdapterOptions;
  readonly #sessions = new Set<ClaudeSession>();
  readonly #inspectors = new Set<ClaudeInspector>();
  readonly #inspections = new Map<string, Promise<HarnessInspection>>();
  #account: Promise<HarnessAccountSnapshot | null> | null = null;
  #closing: Promise<void> | null = null;

  constructor(options: ClaudeAdapterOptions) {
    this.#options = { ...options, environment: withUserShellEnvironment({ ...options.environment }) };
  }

  /** Catalogs per working directory; a ready result is kept until refresh, failures are retried on the next call. */
  inspect(input: { cwd?: string; refresh?: boolean } = {}): Promise<HarnessInspection> {
    if (this.#closing) return Promise.resolve({ status: 'unavailable', error: error('invalidState', 'Claude Code Adapter is closing') });
    const cwd = path.resolve(input.cwd ?? process.cwd());
    const cached = this.#inspections.get(cwd);
    if (cached && !input.refresh) return cached;
    const work = this.#inspect(cwd).then(result => { if (result.status !== 'ready' && this.#inspections.get(cwd) === work) this.#inspections.delete(cwd); return result; });
    this.#inspections.set(cwd, work);
    return work;
  }

  inspectAccount(): Promise<HarnessAccountSnapshot | null> {
    if (this.#closing) return Promise.resolve(null);
    return this.#account ??= this.#withInspector(process.cwd(), async inspector => {
      const account = await inspector.account();
      return account && accountSnapshot(account.usage, account.email);
    }).catch(() => null).finally(() => { this.#account = null; });
  }

  async open(input: OpenSessionInput): Promise<HarnessResult<HarnessSession>> {
    if (this.#closing) return failed('invalidState', 'Claude Code Adapter is closing');
    if (!input.cwd) return failed('invalidRequest', 'Claude Code Adapter requires cwd');
    let thinking: HarnessThinkingOptionId, permission: HarnessPermissionModeId;
    try {
      thinking = input.thinkingOptionId ? parseThinking(input.thinkingOptionId) : DEFAULT_THINKING;
      if (input.model) decodeModelRef(input.model);
      permission = input.permissionModeId ?? DEFAULT_PERMISSION_MODE;
      decodePermissionMode(permission);
    } catch { return failed('invalidRequest', 'Claude Code session configuration is invalid'); }
    if (input.kind === 'resume' && (!nativeSessionRefSchema.safeParse(input.nativeRef).success || input.nativeRef.harnessId !== harnessId)) {
      return failed('invalidRequest', "Claude Code Adapter cannot resume another Harness's Native Session");
    }
    const sessionId = input.kind === 'resume' ? input.nativeRef.nativeSessionId : randomUUID();
    const known = input.kind === 'resume' && Boolean(input.model || input.thinkingOptionId);
    // Claude Code counts usage per native process, so only the context reading survives a reopen.
    const { contextUsedTokens, contextWindowTokens } = input.usage ?? {};
    const session: ClaudeSession = new ClaudeSession({
      cwd: path.resolve(input.cwd), environment: { ...this.#options.environment, ...input.environment },
      ...(this.#options.command ? { command: this.#options.command } : {}), ...(this.#options.queryFactory ? { queryFactory: this.#options.queryFactory } : {}),
      openMode: input.kind, sessionId,
      initialState: input.kind === 'resume' ? {
        nativeRef: nativeSessionRefSchema.parse({ harnessId, nativeSessionId: sessionId, formatVersion: 1 }),
        ...(known ? { ...(input.model ? { effectiveModel: input.model } : {}), effectiveThinkingOptionId: thinking, effectivePermissionModeId: permission } : {}),
      } : {},
      initialUsage: contextUsedTokens !== undefined && contextWindowTokens ? { contextUsedTokens, contextWindowTokens } : null,
      ...(input.model ? { model: input.model } : {}), thinkingOptionId: thinking, permissionModeId: permission,
      onClosed: () => this.#sessions.delete(session),
    });
    this.#sessions.add(session);
    return { ok: true, value: session };
  }

  close(): Promise<void> {
    return this.#closing ??= Promise.allSettled([
      ...[...this.#inspectors].map(inspector => inspector.close()), ...[...this.#sessions].map(session => session.close()), ...this.#inspections.values(),
    ]).then(results => {
      this.#inspections.clear();
      const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      if (failures.length) throw new AggregateError(failures, 'Claude Code cleanup failed');
    });
  }

  async #inspect(cwd: string): Promise<HarnessInspection> {
    const startedAt = Date.now();
    try {
      return await this.#withInspector(cwd, async inspector => {
        const snapshot = await inspector.models();
        if (!snapshot.canSelectModel) return { status: 'unavailable', error: { ...error('unavailable', 'Claude Code did not expose a selectable Model catalog'), durationMs: Date.now() - startedAt } };
        return {
          status: 'ready', catalog: modelCatalog(snapshot.models),
          ...(snapshot.canSelectPermissionMode ? { permissionModes: permissionModeCatalog(snapshot.models) } : {}),
          capabilities: { ...capabilities, configuration: { ...capabilities.configuration, selectPermissionMode: snapshot.canSelectPermissionMode } },
        };
      });
    } catch (cause) {
      const catalog = cause instanceof Error && cause.message.startsWith('Claude Code Model');
      const failure = catalog || cause instanceof Error && cause.name === 'ZodError' ? error('protocolError', 'Claude Code returned an invalid Model catalog') : startupFailure(cause);
      return { status: failure.code === 'notInstalled' ? 'notInstalled' : 'error', error: { ...failure, durationMs: Date.now() - startedAt } };
    }
  }

  async #withInspector<T>(cwd: string, work: (inspector: ClaudeInspector) => Promise<T>): Promise<T> {
    const inspector = new ClaudeInspector({ environment: this.#options.environment, cwd, closeTimeoutMs: CLOSE_TIMEOUT_MS,
      ...(this.#options.command ? { command: this.#options.command } : {}), ...(this.#options.queryFactory ? { queryFactory: this.#options.queryFactory } : {}) });
    this.#inspectors.add(inspector);
    try { return await work(inspector); } finally {
      await inspector.close().catch(() => {});
      this.#inspectors.delete(inspector);
    }
  }
}
