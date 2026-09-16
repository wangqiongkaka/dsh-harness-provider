/**
 * The Host ⇄ Harness contract this plugin runs on: DshRunner and HarnessService consume it, the Codex and Claude Code
 * adapters implement it. Shapes follow the codexhost adapter contract the plugin started from, trimmed to what is used here.
 */
import { z } from 'zod';

const opaqueId = z.string().refine(value => value.trim().length > 0, 'Identifier must not be empty or whitespace');
export const harnessIdSchema = opaqueId.brand<'HarnessId'>();
export const hostTurnIdSchema = opaqueId.brand<'HostTurnId'>();
export const hostItemIdSchema = opaqueId.brand<'HostItemId'>();
export const hostInteractionIdSchema = opaqueId.brand<'HostInteractionId'>();
export type HarnessId = z.infer<typeof harnessIdSchema>;
export type HostTurnId = z.infer<typeof hostTurnIdSchema>;
export type HostItemId = z.infer<typeof hostItemIdSchema>;
export type HostInteractionId = z.infer<typeof hostInteractionIdSchema>;

const transportSafe = (label: string, max: number) => opaqueId.max(max).regex(/^[A-Za-z0-9._~-]+$/u, `${label} must use transport-safe characters`);
export const harnessModelRefSchema = z.object({ id: transportSafe('Model Ref', 512).brand<'HarnessModelRefId'>() }).strict();
export const harnessThinkingOptionIdSchema = transportSafe('Thinking option ID', 128).brand<'HarnessThinkingOptionId'>();
export const harnessPermissionModeIdSchema = transportSafe('Permission Mode ID', 128).brand<'HarnessPermissionModeId'>();
export type HarnessModelRef = z.infer<typeof harnessModelRefSchema>;
export type HarnessThinkingOptionId = z.infer<typeof harnessThinkingOptionIdSchema>;
export type HarnessPermissionModeId = z.infer<typeof harnessPermissionModeIdSchema>;

export type JsonValue = z.infer<ReturnType<typeof z.json>>;
export const nativeSessionRefSchema = z.strictObject({
  harnessId: harnessIdSchema, nativeSessionId: opaqueId, locator: z.json().optional(), formatVersion: z.literal(1),
});
export type NativeSessionRef = z.infer<typeof nativeSessionRefSchema>;
export interface NativeTurnRef { harnessId: HarnessId; nativeSessionId: string; nativeTurnKey: string; formatVersion: 1 }

export interface HarnessThinkingOption { id: HarnessThinkingOptionId; label: string }
export interface HarnessModel { ref: HarnessModelRef; label: string; resolvedModelLabel?: string; supportedThinkingOptionIds?: HarnessThinkingOptionId[] }
export interface HarnessModelCatalog {
  models: HarnessModel[]; defaultModel?: HarnessModelRef; thinkingOptions: HarnessThinkingOption[]; defaultThinkingOptionId?: HarnessThinkingOptionId;
}
export interface HarnessPermissionMode { id: HarnessPermissionModeId; label: string; description?: string; dangerous?: boolean }
export interface HarnessPermissionModeCatalog { modes: HarnessPermissionMode[]; defaultModeId: HarnessPermissionModeId }
export interface HarnessSessionCapabilities {
  configuration: { selectModel: boolean; selectThinkingOption: boolean; selectPermissionMode: boolean; permissionModeScope: 'live' | 'atCreate' };
  history: { fork: boolean; forkAcrossCwd: boolean; rollbackLastTurn: boolean };
}
export type HarnessInspection =
  | { status: 'ready'; catalog: HarnessModelCatalog; permissionModes?: HarnessPermissionModeCatalog; capabilities: HarnessSessionCapabilities }
  | { status: 'notInstalled' | 'unavailable' | 'error'; error: HarnessError };

/** Read-only quota of the Harness's current native authentication. */
export interface HarnessAccountSnapshot {
  email?: string; plan?: string;
  credits: {
    label?: string; usedPercent: number; resetsAt?: string;
    periodType: 'weekly' | 'monthly' | 'five_hour' | 'seven_day' | 'unknown';
    productUsage?: Array<{ product: string; usagePercent: number; resetsAt?: string }>;
  };
}

export type HarnessErrorCode = 'notInstalled' | 'unavailable' | 'authenticationRequired' | 'sessionNotFound' | 'sessionBusy'
  | 'unsupported' | 'invalidRequest' | 'invalidState' | 'protocolError' | 'processExited' | 'nativeFailure' | 'internalError';
export interface HarnessError { code: HarnessErrorCode; message: string; retryable: boolean; stage?: string; durationMs?: number; stderrTail?: string }
export type HarnessResult<T> = { ok: true; value: T } | { ok: false; error: HarnessError };

/**
 * Cumulative counters are whatever scope the Harness counts in (Codex: the native thread; Claude Code: the native process).
 * `inputTokens` includes cached input; context fields travel together.
 */
export interface HostUsage {
  inputTokens?: number; cachedInputTokens?: number; cacheWriteInputTokens?: number; outputTokens?: number; totalTokens?: number;
  contextWindowTokens?: number; contextUsedTokens?: number;
}

interface SessionHints {
  cwd: string; environment?: Record<string, string | undefined>;
  model?: HarnessModelRef; thinkingOptionId?: HarnessThinkingOptionId; permissionModeId?: HarnessPermissionModeId;
  /** The last usage the Host persisted for this session; each adapter decides what of it still holds after reopening. */
  usage?: HostUsage;
}
export type OpenSessionInput = (SessionHints & { kind: 'create' }) | (SessionHints & { kind: 'resume'; nativeRef: NativeSessionRef });

export interface HarnessSessionState {
  nativeRef?: NativeSessionRef; effectiveModel?: HarnessModelRef; resolvedModelLabel?: string;
  effectiveThinkingOptionId?: HarnessThinkingOptionId; availableThinkingOptions?: HarnessThinkingOption[];
  effectivePermissionModeId?: HarnessPermissionModeId;
}

export interface HostTextInput { type: 'text'; text: string }
export type HostInput = HostTextInput | { type: 'image'; mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; base64Data: string };
export interface TurnStartCommand { type: 'turn.start'; turnId: HostTurnId; input: HostInput[] }
export interface TurnCancelCommand { type: 'turn.cancel'; turnId: HostTurnId }
export interface ModelSelectCommand { type: 'model.select'; model: HarnessModelRef }
export interface ThinkingSelectCommand { type: 'thinking.select'; thinkingOptionId: HarnessThinkingOptionId }
export interface PermissionModeSelectCommand { type: 'permissionMode.select'; permissionModeId: HarnessPermissionModeId }

export interface HostChoiceQuestion {
  id: string; type: 'choice'; prompt: string; options: Array<{ value: string; label: string; description?: string }>;
  multiple: boolean; allowOther: boolean; optional: boolean;
}
export interface HostTextQuestion { id: string; type: 'text'; prompt: string; multiline: boolean; secret: boolean; optional: boolean; placeholder?: string; prefill?: string }
export type HostQuestion = HostChoiceQuestion | HostTextQuestion;
export interface HostQuestionInteraction {
  type: 'question'; interactionId: HostInteractionId; turnId: HostTurnId; itemId?: HostItemId; title?: string; questions: HostQuestion[]; expiresAt?: string;
}
export type HostApprovalEffect = 'allowOnce' | 'allowForSession' | 'allowAlways' | 'deny';
export interface HostApprovalAction { id: string; label: string; effect: HostApprovalEffect }
export interface HostApprovalInteraction {
  type: 'approval'; interactionId: HostInteractionId; turnId: HostTurnId; title: string; description?: string;
  subject: { type: 'nativeAction' }; actions: HostApprovalAction[]; expiresAt?: string;
}
export type HostInteraction = HostQuestionInteraction | HostApprovalInteraction;
export interface HostQuestionResponse { type: 'question'; answers: Record<string, string[]>; cancelled?: boolean }
export interface HostApprovalResponse { type: 'approval'; actionId: string }
export type HostInteractionResponse = HostQuestionResponse | HostApprovalResponse;
export interface InteractionRespondCommand { type: 'interaction.respond'; interactionId: HostInteractionId; response: HostInteractionResponse }
export type HostCommand = TurnStartCommand | TurnCancelCommand | InteractionRespondCommand | ModelSelectCommand | ThinkingSelectCommand | PermissionModeSelectCommand;
export interface TurnStartAccepted { turnId: HostTurnId }
export interface TurnCancelAccepted { cancellationRequested: true }
export interface InteractionRespondAccepted { accepted: true }
export interface ModelSelectCompleted { completed: true }
export interface ThinkingSelectCompleted { completed: true }
export interface PermissionModeSelectCompleted { completed: true }

export interface HostToolOutput { content: Array<{ type: 'text'; text: string } | { type: 'image'; mimeType: string; base64Data: string } | { type: 'imageFile'; path: string }>; truncated?: boolean }
export interface HostFileChange { path: string; kind: 'add' | 'update' | 'delete'; unifiedDiff: string }
export type HostSubagentStatus = 'pending' | 'running' | 'completed' | 'failed' | 'interrupted';
export interface HostSubagentState {
  subagentId: string; nativeSubagentId?: string; description: string; role?: string; model?: string; reasoningEffort?: string;
  background: boolean; status: HostSubagentStatus; resultSummary?: string;
}
export type HostItem =
  | { type: 'agentMessage'; itemId: HostItemId; text: string; phase?: 'commentary' | 'final_answer' }
  | { type: 'reasoning'; itemId: HostItemId; text: string }
  | { type: 'contextCompaction'; itemId: HostItemId }
  | { type: 'commandExecution'; itemId: HostItemId; command: string; description?: string; cwd?: string; output?: string; outputTruncated?: boolean; exitCode?: number | null; durationMs?: number }
  | { type: 'toolExecution'; itemId: HostItemId; toolName: string; namespace?: string; arguments: JsonValue; output?: HostToolOutput; durationMs?: number }
  | { type: 'fileChange'; itemId: HostItemId; changes: HostFileChange[] }
  | { type: 'subagentDelegation'; itemId: HostItemId; operation: 'spawn' | 'send'; prompt?: string; subagents: HostSubagentState[] };
export type HostItemOf<T extends HostItem['type']> = Extract<HostItem, { type: T }>;
export type HostItemUpdate =
  | { type: 'text.append'; text: string } | { type: 'output.append'; text: string } | { type: 'output.replace'; output: HostToolOutput }
  | { type: 'fileChanges.replace'; changes: HostFileChange[] } | { type: 'subagents.replace'; subagents: HostSubagentState[] };
export type HostItemOutcome = { status: 'succeeded' } | { status: 'failed'; error: HarnessError } | { status: 'cancelled'; reason?: string };
export interface HostItemSnapshot { item: HostItem; outcome: HostItemOutcome }
export type TurnOutcome = HostItemOutcome;
export interface HostTurnSnapshot {
  nativeTurnRef: NativeTurnRef; input: HostTextInput[]; items: HostItemSnapshot[];
  outcome: HostItemOutcome | { status: 'unknown'; reason: string };
}

export type HostEvent =
  | { type: 'session.state.changed'; state: HarnessSessionState }
  | { type: 'session.usage.changed'; usage: HostUsage | null; observedForTurnId?: HostTurnId }
  | { type: 'session.faulted'; error: HarnessError }
  | { type: 'turn.started'; turnId: HostTurnId; nativeTurnRef?: NativeTurnRef }
  | { type: 'turn.completed'; turnId: HostTurnId; nativeTurnRef?: NativeTurnRef; outcome: TurnOutcome }
  | { type: 'item.started'; turnId: HostTurnId; item: HostItem }
  | { type: 'item.updated'; turnId: HostTurnId; itemId: HostItemId; update: HostItemUpdate }
  | { type: 'item.completed'; turnId: HostTurnId; snapshot: HostItemSnapshot }
  | { type: 'interaction.closed'; interactionId: HostInteractionId; turnId: HostTurnId; reason: 'responded' | 'cancelled' | 'expired' | 'superseded' };
export type HarnessOutput = { kind: 'event'; event: HostEvent } | { kind: 'interaction'; interaction: HostInteraction };

export interface HarnessSession {
  readonly harnessId: HarnessId;
  readonly capabilities: HarnessSessionCapabilities;
  readonly initialState: HarnessSessionState;
  /** Usage that already holds when the session opens: the baseline the Host subtracts per-turn deltas from. */
  readonly initialUsage: HostUsage | null;
  readonly outputs: AsyncIterable<HarnessOutput>;
  fork?(throughTurn?: string | null): Promise<HarnessResult<NativeSessionRef | undefined>>;
  steer?(input: HostInput[]): Promise<HarnessResult<{ accepted: true }>>;
  refreshUsage?(): Promise<void>;
  readSnapshot?(): Promise<HarnessResult<{ turns: HostTurnSnapshot[]; state: HarnessSessionState }>>;
  execute(command: TurnStartCommand): Promise<HarnessResult<TurnStartAccepted>>;
  execute(command: TurnCancelCommand): Promise<HarnessResult<TurnCancelAccepted>>;
  execute(command: InteractionRespondCommand): Promise<HarnessResult<InteractionRespondAccepted>>;
  execute(command: ModelSelectCommand): Promise<HarnessResult<ModelSelectCompleted>>;
  execute(command: ThinkingSelectCommand): Promise<HarnessResult<ThinkingSelectCompleted>>;
  execute(command: PermissionModeSelectCommand): Promise<HarnessResult<PermissionModeSelectCompleted>>;
  close(): Promise<void>;
}
export interface HarnessAdapter {
  readonly harnessId: HarnessId;
  inspect(input?: { cwd?: string; refresh?: boolean }): Promise<HarnessInspection>;
  /** Fresh, bounded quota read for the current native authentication; null when unavailable. */
  inspectAccount?(): Promise<HarnessAccountSnapshot | null>;
  open(input: OpenSessionInput): Promise<HarnessResult<HarnessSession>>;
  close(): Promise<void>;
}

/** Single-consumer async queue of adapter outputs. */
export class HarnessOutputChannel<T> {
  readonly outputs: AsyncIterable<T>;
  #consumed = false;
  #ended = false;
  readonly #pending: Array<(result: IteratorResult<T>) => void> = [];
  readonly #values: T[] = [];
  constructor() {
    this.outputs = { [Symbol.asyncIterator]: () => {
      if (this.#consumed) throw new Error('Harness outputs allow only one consumer');
      this.#consumed = true;
      return { next: () => this.#next() };
    } };
  }
  emit(value: T): boolean {
    if (this.#ended) return false;
    const resolve = this.#pending.shift();
    if (resolve) resolve({ done: false, value }); else this.#values.push(value);
    return true;
  }
  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    if (!this.#values.length) for (const resolve of this.#pending.splice(0)) resolve({ done: true, value: undefined });
  }
  #next(): Promise<IteratorResult<T>> {
    if (this.#values.length) return Promise.resolve({ done: false, value: this.#values.shift()! });
    if (this.#ended) return Promise.resolve({ done: true, value: undefined });
    return new Promise(resolve => this.#pending.push(resolve));
  }
}

const invalidRequest = (message: string): HarnessError => ({ code: 'invalidRequest', message, retryable: false });
/** Returns the reason a response does not answer the pending interaction, or null when it does. */
export function validateHostInteractionResponse(interaction: HostInteraction | undefined, response: HostInteractionResponse): HarnessError | null {
  if (!interaction) return { code: 'invalidState', message: 'Interaction Response must reference a pending Interaction', retryable: false };
  if (interaction.type !== response.type) return invalidRequest('Interaction Response type does not match the pending Interaction');
  if (response.type === 'approval') {
    return (interaction as HostApprovalInteraction).actions.some(action => action.id === response.actionId) ? null : invalidRequest('Approval Response contains an undeclared action ID');
  }
  const { questions } = interaction as HostQuestionInteraction;
  if (response.cancelled) return Object.keys(response.answers).length ? invalidRequest('Cancelled Question Response must not contain answers') : null;
  if (Object.keys(response.answers).some(id => !questions.some(question => question.id === id))) return invalidRequest('Question Response contains an unknown Question ID');
  for (const question of questions) {
    const answers = response.answers[question.id] ?? [];
    if (!question.optional && !answers.length) return invalidRequest('Question Response omits a required answer');
    if (question.type === 'text') { if (answers.length > 1) return invalidRequest('Text Question accepts at most one answer'); continue; }
    if (!question.multiple && answers.length > 1) return invalidRequest('Single-choice Question accepts at most one answer');
    if (!question.allowOther && answers.some(answer => !question.options.some(option => option.value === answer))) return invalidRequest('Question Response contains an undeclared choice');
  }
  return null;
}
