/**
 * Agent Client Protocol (ACP v1) sessions behind the Host contract. One adapter per agent program; each session owns
 * one agent process. Codex and Claude Code differ only by the profile in acp-profiles.ts.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { client, ndJsonStream, RequestError, type ClientConnection, type ClientContext } from '@agentclientprotocol/sdk';
import type * as acp from '@agentclientprotocol/sdk';
import pkg from '../package.json' with { type: 'json' };
import {
  HarnessOutputChannel, harnessIdSchema, harnessModelRefSchema, harnessPermissionModeIdSchema, harnessThinkingOptionIdSchema,
  hostInteractionIdSchema, hostItemIdSchema, nativeSessionRefSchema, validateHostInteractionResponse,
  type HarnessAccountSnapshot, type HarnessAdapter, type HarnessError, type HarnessId, type HarnessInspection, type HarnessModelCatalog,
  type HarnessModelRef, type HarnessOutput, type HarnessPermissionModeCatalog, type HarnessResult, type HarnessSession,
  type HarnessSessionCapabilities, type HarnessSessionState, type HarnessSkill, type HostApprovalInteraction, type HostChoiceQuestion,
  type HostCommand, type HostEvent, type HostInput, type HostInteraction, type HostInteractionId, type HostItem, type HostItemOf,
  type HostItemOutcome, type HostItemSnapshot, type HostQuestion, type HostQuestionInteraction, type HostTurnId, type HostTurnSnapshot,
  type HostUsage, type HarnessSubagent, type HarnessSubagentEntry, type InteractionRespondCommand, type JsonValue, type ModelSelectCommand, type NativeSessionRef, type OpenSessionInput,
  type PermissionModeSelectCommand, type ThinkingSelectCommand, type TurnCancelCommand, type TurnOutcome, type TurnStartCommand,
} from './contracts.js';

// ── Profile ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface AcpProfile {
  harnessId: string;
  /** Whether ACP thought chunks should be exposed as DSH reasoning rows. */
  showThoughts?: boolean;
  /**
   * Subagents as their own ACP sessions (AIR `nativeSubagentSessions`; the adapters' schemas drop a bare `subagents` capability):
   * Codex streams child threads only this way. Without
   * it the agent tags a subagent's events in the main session (Claude Code, which keeps the Agent call and report there).
   */
  nativeSubagents?: boolean;
  /**
   * The agent program; throws a HarnessError-like `{ code, message }` when its executable is missing. A session's process
   * gets the Host's session instructions for agents that only take them at launch (Codex's developer instructions).
   */
  spawn(environment: NodeJS.ProcessEnv, instructions?: string): { command: string; args: string[]; env: NodeJS.ProcessEnv };
  /**
   * `_meta` for session/new and session/load: the agent's own options channel (system prompt, SDK options). A profile
   * that defines it carries the Host's session instructions there. Instructions never enter the user's prompt.
   */
  sessionMeta?(kind: 'create' | 'resume', instructions?: string): Record<string, unknown> | undefined;
  /** Ids persisted by the previous, non-ACP adapters mapped onto the agent's ids. */
  legacyPermissionModes?: Record<string, string>;
  legacyThinkingOptions?: Record<string, string>;
  /** Slash-menu name of an available command; null hides it. */
  skillName?(command: acp.AvailableCommand): string | null;
  /** How a slash-menu pick of `command` is spelled in the prompt when the agent needs another form (Codex: `$skill`). */
  skillInvocation?(command: acp.AvailableCommand): string;
  /** A local command that names a new session; it pre-empts the agent's own model-driven title generation. */
  titleCommand?(title: string): string;
  /** Turn end states the agent program records natively, keyed by the user message id its history replays; ACP carries none. */
  turnOutcomes?(nativeSessionId: string): Promise<Map<string, HostTurnSnapshot['outcome']>>;
  /** Native quota probe; ACP carries no account windows. */
  inspectAccount?(): Promise<HarnessAccountSnapshot | null>;
}

const clientCapabilities = (profile: AcpProfile): acp.ClientCapabilities => ({
  session: { compaction: {}, configOptions: { boolean: {} } }, elicitation: { form: {}, url: {} }, plan: {},
  // `subagent-transcript`: Claude Code forwards a tagged subagent's text and reasoning too, not only its tool calls.
  _meta: { steering: { supported: true }, 'subagent-transcript': true,
    jetbrains: { air: { version: 1, capabilities: ['sessionFailure', 'recommendedValue', ...(profile.nativeSubagents ? ['nativeSubagentSessions'] : [])] } } },
});
/** Subagent lifecycle updates the ACP SDK's schema does not know yet; they are renamed on the wire so its validation lets them through. */
const SUBAGENT_LIFECYCLE = new Set(['subagent_spawned', 'subagent_state_update']);
const SUBAGENT_UPDATE = '_dsh/subagent_update';
type SubagentLifecycle = { sessionUpdate: 'subagent_spawned'; subagentSessionId: string; name?: unknown; task?: unknown } | { sessionUpdate: 'subagent_state_update'; subagentSessionId: string; state: unknown };
const REQUEST_TIMEOUT_MS = 60_000;
const CLOSE_TIMEOUT_MS = 5_000;
const TITLE_TIMEOUT_MS = 30_000;
const TOOL_OUTPUT_LIMIT = 64_000;
const SKILLS_CONTEXT_BUDGET_NOTICE = 'Skill descriptions were shortened to fit the skills context budget.';
const record = (value: unknown): Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown, max = 500): string | undefined => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
const error = (code: HarnessError['code'], message: string, retryable = false): HarnessError => ({ code, message, retryable });
const failed = <T>(code: HarnessError['code'], message: string, retryable = false): HarnessResult<T> => ({ ok: false, error: error(code, message, retryable) });
function toError(cause: unknown, fallback: string): HarnessError {
  if (cause instanceof RequestError) {
    const detail = cause.data === undefined ? '' : ` ${JSON.stringify(cause.data).slice(0, 500)}`;
    return error(cause.code === -32000 ? 'authenticationRequired' : 'nativeFailure', `${cause.message || fallback}${detail}`, cause.code === -32000);
  }
  const known = record(cause);
  if (typeof known.code === 'string' && typeof known.message === 'string') return error(known.code as HarnessError['code'], known.message);
  return error('nativeFailure', cause instanceof Error && cause.message ? cause.message : fallback);
}
const newItemId = () => hostItemIdSchema.parse(randomUUID());

// ── Ids: model refs must be transport-safe; ACP config values are not ────────────────────────────────────────────────

const SAFE = /^[A-Za-z0-9._~-]+$/u;
const B64 = 'b64.', LEGACY_CLAUDE = 'claude-model-v1.';
export const modelRef = (value: string): HarnessModelRef => harnessModelRefSchema.parse({ id: SAFE.test(value) ? value : B64 + Buffer.from(value, 'utf8').toString('base64url') });
export function modelValue(ref: HarnessModelRef): string {
  if (ref.id.startsWith(B64)) return Buffer.from(ref.id.slice(B64.length), 'base64url').toString('utf8');
  if (ref.id.startsWith(LEGACY_CLAUDE)) return Buffer.from(ref.id.slice(LEGACY_CLAUDE.length), 'base64url').toString('utf8');
  return ref.id;
}
const turnHash = (input: string) => createHash('sha256').update(input).digest('hex').slice(0, 16);
const promptText = (blocks: acp.ContentBlock[]) => blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('');

// ── Catalogs from session/new ───────────────────────────────────────────────────────────────────────────────────────

type Opened = acp.NewSessionResponse | acp.LoadSessionResponse;
interface Catalogs {
  catalog: HarnessModelCatalog; permissionModes?: HarnessPermissionModeCatalog;
  modelConfigId?: string; thinkingConfigId?: string; currentModel?: string; currentThinking?: string; currentMode?: string;
  configOptions: Map<string, acp.SessionConfigOption>;
}
const recommended = (option: acp.SessionConfigOption): string | undefined => text(record(record(record(option._meta).jetbrains).air).recommendedValue, 512);
type SelectOption = acp.SessionConfigOption & { type: 'select' };
const isSelect = (option: acp.SessionConfigOption): option is SelectOption => option.type === 'select';
const selectOptions = (option: acp.SessionConfigOption): acp.SessionConfigSelectOption[] =>
  isSelect(option) ? option.options.flatMap(entry => 'group' in entry ? entry.options : [entry]) : [];
/** Model, thought-level and mode selectors of the session; per-model effort support comes from the `models` extension. */
export function catalogsOf(opened: Opened): Catalogs {
  const options = opened.configOptions ?? [];
  const model = options.filter(isSelect).find(option => option.category === 'model');
  const thinking = options.filter(isSelect).find(option => option.category === 'thought_level');
  const auxiliary = options.filter(option => option !== model && option !== thinking && option.category !== 'mode');
  const modes = opened.modes;
  const efforts = new Map<string, Set<string>>();
  for (const entry of record(record(opened as unknown).models).availableModels as unknown[] ?? []) {
    const match = /^(.+)\[([^\]]+)\]$/u.exec(String(record(entry).modelId ?? ''));
    if (match) (efforts.get(match[1]!) ?? efforts.set(match[1]!, new Set()).get(match[1]!)!).add(match[2]!);
  }
  const thinkingOptions = thinking ? selectOptions(thinking).map(option => ({ id: harnessThinkingOptionIdSchema.parse(option.value), label: option.name })) : [];
  const models = model ? selectOptions(model).map(option => ({
    ref: modelRef(option.value), label: option.name, ...(text(option.description, 256) ? { resolvedModelLabel: text(option.description, 256)! } : {}),
    ...(efforts.has(option.value) ? { supportedThinkingOptionIds: thinkingOptions.filter(entry => efforts.get(option.value)!.has(entry.id)).map(entry => entry.id) } : {}),
  })) : [];
  const defaultModel = model ? recommended(model) ?? model.currentValue : undefined;
  const defaultThinking = thinking ? recommended(thinking) ?? thinking.currentValue : undefined;
  return {
    catalog: { models, thinkingOptions, ...(defaultModel ? { defaultModel: modelRef(defaultModel) } : {}),
      ...(defaultThinking ? { defaultThinkingOptionId: harnessThinkingOptionIdSchema.parse(defaultThinking) } : {}),
      configOptions: auxiliary.map(option => ({ id: option.id, label: option.name, ...(text(option.description, 256) ? { description: text(option.description, 256)! } : {}),
        currentValue: option.currentValue, ...(isSelect(option) ? { choices: selectOptions(option).map(entry => ({ value: entry.value, label: entry.name,
          ...(text(entry.description, 256) ? { description: text(entry.description, 256)! } : {}) })) } : {}) })) },
    ...(modes ? { permissionModes: { modes: modes.availableModes.map(mode => ({ id: harnessPermissionModeIdSchema.parse(mode.id), label: mode.name,
      ...(text(mode.description) ? { description: text(mode.description)! } : {}), ...(record(mode._meta).kind === 'full_access' ? { dangerous: true } : {}) })),
      defaultModeId: harnessPermissionModeIdSchema.parse(modes.currentModeId) } } : {}),
    ...(model ? { modelConfigId: model.id, currentModel: model.currentValue } : {}),
    ...(thinking ? { thinkingConfigId: thinking.id, currentThinking: thinking.currentValue } : {}),
    ...(modes ? { currentMode: modes.currentModeId } : {}), configOptions: new Map(auxiliary.map(option => [option.id, option])),
  };
}
const capabilitiesOf = (agent: acp.AgentCapabilities | undefined, catalogs: Catalogs): HarnessSessionCapabilities => ({
  configuration: { selectModel: !!catalogs.modelConfigId, selectThinkingOption: !!catalogs.thinkingConfigId, selectPermissionMode: !!catalogs.permissionModes, permissionModeScope: 'live' },
  history: { fork: !!agent?.sessionCapabilities?.fork, forkAcrossCwd: false, rollbackLastTurn: !!agent?.sessionCapabilities?.fork },
});

// ── Elicitation forms → Host questions ──────────────────────────────────────────────────────────────────────────────

const CUSTOM_ANSWER = '_askUserQuestionCustomAnswer';
interface FormField { id: string; kind: 'string' | 'number' | 'integer' | 'boolean' | 'array'; customFor?: string }
interface Form { questions: HostQuestion[]; fields: FormField[] }
/** Primitive object fields the DSH question UI can represent; null when the form needs something else. */
export function formOf(schema: acp.ElicitationSchema): Form | null {
  if (schema.type && schema.type !== 'object') return null;
  const required = new Set(schema.required ?? []);
  const questions: HostQuestion[] = [], fields: FormField[] = [];
  for (const [id, raw] of Object.entries(schema.properties ?? {})) {
    const property = raw as Record<string, unknown> & { type: string };
    const meta = record(property._meta);
    const custom = record(meta[CUSTOM_ANSWER]);
    if (custom.isCustomAnswer === true && typeof custom.questionId === 'string') { fields.push({ id, kind: 'string', customFor: custom.questionId }); continue; }
    const prompt = text(property.title, 200) ?? text(property.description, 200) ?? id;
    const enumOptions = (value: unknown) => Array.isArray(value) && value.every(entry => record(entry).const !== undefined && typeof record(entry).title === 'string')
      ? value.map(entry => ({ value: String(record(entry).const), label: record(entry).title as string, ...(text(record(entry).description) ? { description: text(record(entry).description)! } : {}) })) : null;
    const plain = (value: unknown) => Array.isArray(value) && value.length && value.every(entry => ['string', 'number'].includes(typeof entry)) ? value.map(entry => ({ value: String(entry), label: String(entry) })) : null;
    const choice = (options: HostChoiceQuestion['options'], multiple: boolean): HostChoiceQuestion => ({ id, type: 'choice', prompt, options, multiple, allowOther: false, optional: !required.has(id) });
    if (property.type === 'array') {
      const items = record(property.items);
      const options = enumOptions(items.anyOf) ?? plain(items.enum);
      if (!options) return null;
      questions.push(choice(options, true)); fields.push({ id, kind: 'array' }); continue;
    }
    if (!['string', 'number', 'integer', 'boolean'].includes(property.type)) return null;
    const options = enumOptions(property.oneOf) ?? plain(property.enum) ?? (property.type === 'boolean' ? [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }] : null);
    fields.push({ id, kind: property.type as FormField['kind'] });
    if (options) { questions.push(choice(options, false)); continue; }
    const secret = property.writeOnly === true || property.format === 'password' || record(meta.codex).isSecret === true;
    questions.push({ id, type: 'text', prompt, multiline: false, secret, optional: !required.has(id),
      ...(text(property.description, 200) && text(property.description, 200) !== prompt ? { placeholder: text(property.description, 200)! } : {}),
      ...(typeof property.default === 'string' && !secret ? { prefill: property.default } : {}) });
  }
  for (const field of fields) if (field.customFor) { const question = questions.find(entry => entry.id === field.customFor); if (question?.type === 'choice') question.allowOther = true; }
  return questions.length ? { questions, fields } : null;
}
/** Answers back into the schema's value types; free-text "other" answers of a choice go to its companion custom field. */
export function formContent(form: Form, answers: Record<string, string[]>): Record<string, acp.ElicitationContentValue> {
  const content: Record<string, acp.ElicitationContentValue> = {};
  for (const field of fields(form)) {
    const question = form.questions.find(entry => entry.id === field.id);
    const given = answers[field.id] ?? [];
    const values = question?.type === 'choice' ? given.filter(answer => question.options.some(option => option.value === answer)) : given;
    const custom = question?.type === 'choice' ? given.filter(answer => !question.options.some(option => option.value === answer)) : [];
    const companion = form.fields.find(entry => entry.customFor === field.id);
    if (companion && custom.length) content[companion.id] = custom.join(', ');
    if (!values.length) { if (!companion && custom.length) content[field.id] = custom.join(', '); continue; }
    if (field.kind === 'array') content[field.id] = values;
    else if (field.kind === 'number' || field.kind === 'integer') {
      const value = Number(values[0]);
      if (!Number.isFinite(value) || (field.kind === 'integer' && !Number.isInteger(value))) throw new Error(`${question?.prompt ?? field.id} must be a valid ${field.kind}`);
      content[field.id] = value;
    } else if (field.kind === 'boolean') content[field.id] = values[0] === 'true';
    else content[field.id] = values[0]!;
  }
  return content;
}
const fields = (form: Form) => form.fields.filter(field => !field.customFor);

// ── Process ─────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Handlers {
  update(notification: acp.SessionNotification): void;
  permission(request: acp.RequestPermissionRequest, signal: AbortSignal): Promise<acp.RequestPermissionResponse>;
  elicitation(request: acp.CreateElicitationRequest, signal: AbortSignal): Promise<acp.CreateElicitationResponse>;
  elicitationComplete(notification: acp.CompleteElicitationNotification): void;
  fault(cause: unknown): void;
}
/** One agent process and its connection; `initialize` has already succeeded when `connect` resolves. */
class AcpProcess {
  readonly agent: ClientContext;
  initialized!: acp.InitializeResponse;
  private closing?: Promise<void>;
  private live = true;
  private constructor(private readonly child: ChildProcess, private readonly connection: ClientConnection, private readonly exited: Promise<void>) {
    this.agent = connection.agent;
  }
  static async connect(profile: AcpProfile, environment: NodeJS.ProcessEnv, cwd: string, handlers: Handlers, instructions?: string): Promise<AcpProcess> {
    const { command, args, env } = profile.spawn(environment, instructions);
    // stderr is not a protocol channel and may carry prompt text or credentials; it is discarded unless debugging asks for it.
    const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', process.env.DSH_HARNESS_ACP_STDERR === '1' ? 'inherit' : 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
    child.stderr?.resume();
    const exited = new Promise<void>(resolve => { child.once('close', () => resolve()); child.once('error', () => resolve()); });
    const wire = ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>);
    const stream = { writable: wire.writable, readable: wire.readable.pipeThrough(new TransformStream<acp.AnyMessage, acp.AnyMessage>({ transform(message, controller) {
      const update = 'method' in message && message.method === 'session/update' ? record(record(message.params).update).sessionUpdate : undefined;
      controller.enqueue(typeof update === 'string' && SUBAGENT_LIFECYCLE.has(update) ? { ...message, method: SUBAGENT_UPDATE } as acp.AnyMessage : message);
    } })) };
    const app = client({ name: pkg.name })
      .onNotification('session/update', ({ params }) => handlers.update(params))
      .onNotification(SUBAGENT_UPDATE, params => params as acp.SessionNotification, ({ params }) => handlers.update(params))
      .onNotification('elicitation/complete', ({ params }) => handlers.elicitationComplete(params))
      .onNotification('_auth/status_update', params => params, () => {})
      .onRequest('session/request_permission', ({ params, signal }) => handlers.permission(params, signal))
      .onRequest('elicitation/create', ({ params, signal }) => handlers.elicitation(params, signal));
    const process_ = new AcpProcess(child, app.connect(stream), exited);
    void Promise.race([process_.connection.closed, exited]).then(() => { if (process_.live) { process_.live = false; handlers.fault(new Error(`${profile.harnessId} agent exited`)); } });
    try {
      process_.initialized = await request<acp.InitializeResponse>(process_.agent, 'initialize', { protocolVersion: 1, clientCapabilities: clientCapabilities(profile),
        clientInfo: { name: pkg.name, version: pkg.version, title: 'DSH Harness Plugin' } });
      return process_;
    } catch (cause) { await process_.close(); throw cause; }
  }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.live = false;
      this.connection.close();
      const child = this.child;
      if (child.exitCode !== null || child.signalCode !== null) return;
      const signal = (value: NodeJS.Signals) => { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, value); else child.kill(value); } catch { /* already gone */ } };
      signal('SIGTERM');
      const settled = await Promise.race([this.exited.then(() => true), new Promise<false>(resolve => setTimeout(() => resolve(false), CLOSE_TIMEOUT_MS).unref())]);
      if (!settled) { signal('SIGKILL'); await this.exited; }
    })();
  }
}
/** Handlers for processes that never run a turn: catalog probes and forks. */
const IDLE_HANDLERS: Handlers = {
  update: () => {}, permission: async () => ({ outcome: { outcome: 'cancelled' } }), elicitation: async () => ({ action: 'cancel' }), elicitationComplete: () => {}, fault: () => {},
};
function request<T = unknown>(agent: ClientContext, method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
  return agent.request<T>(method, params, { cancellationSignal: AbortSignal.timeout(timeoutMs) });
}
async function waitFor<T>(work: () => T | undefined, timeoutMs: number): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const value = work(); if (value !== undefined) return value; await new Promise(resolve => setTimeout(resolve, 25)); }
  return work();
}

// ── Transcript: replayed history plus live turns, the source of snapshots and fork points ───────────────────────────

interface TranscriptTurn {
  hash: string; input: string; items: HostItemSnapshot[]; lastAgentMessageId?: string; hasOutput: boolean; userMessageId?: string;
  /** Replayed tool calls by id (their merged updates), and the ones history never shows finished. */
  tools?: Map<string, { call: acp.ToolCallUpdate; snapshot: HostItemSnapshot }>; openTools?: Set<string>;
  /** A failure the agent restored into history (Claude Code's usage-limit notice). */
  failure?: string;
}
class Transcript {
  readonly turns: TranscriptTurn[] = [];
  private agentMessageId?: string;
  /** Prompt hash plus its occurrence: stable for a finished turn, and the same for a replayed history. */
  key(turn: TranscriptTurn): string {
    const index = this.turns.indexOf(turn);
    return `${turn.hash}.${this.turns.slice(0, index).filter(entry => entry.hash === turn.hash).length + 1}`;
  }
  begin(input: string, userMessageId?: string): TranscriptTurn {
    const turn: TranscriptTurn = { hash: turnHash(input), input, items: [], hasOutput: false, ...(userMessageId ? { userMessageId } : {}) };
    this.turns.push(turn);
    this.agentMessageId = undefined;
    return turn;
  }
  /** Replayed updates rebuild turns; a user chunk with a new message id opens the next one. */
  replay(update: acp.SessionUpdate): void {
    const last = this.turns.at(-1);
    if (update.sessionUpdate === 'user_message_chunk') {
      const chunk = update.content.type === 'text' ? update.content.text : '';
      if (last && update.messageId && last.userMessageId === update.messageId) { last.input += chunk; last.hash = turnHash(last.input); return; }
      this.begin(chunk, update.messageId ?? undefined);
      return;
    }
    if (!last) return;
    if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
      const previous = last.items.at(-1);
      if (previous?.item.type === 'agentMessage' && update.messageId && this.agentMessageId === update.messageId) previous.item.text += update.content.text;
      else last.items.push({ item: { type: 'agentMessage', itemId: newItemId(), text: update.content.text }, outcome: { status: 'succeeded' } });
      this.agentMessageId = update.messageId ?? undefined;
      last.hasOutput = true;
      if (update.messageId) last.lastAgentMessageId = update.messageId;
    } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      const tools = last.tools ??= new Map(), open = last.openTools ??= new Set();
      const entry = tools.get(update.toolCallId);
      const call = { ...entry?.call, ...Object.fromEntries(Object.entries(update).filter(([, value]) => value !== undefined && value !== null)) } as acp.ToolCallUpdate;
      if (call.name === 'AskUserQuestion') return;
      let item = toolItem(call);
      const output = replayedOutput(call);
      if (output) {
        const truncated = output.length > TOOL_OUTPUT_LIMIT, text = truncated ? output.slice(0, TOOL_OUTPUT_LIMIT) : output;
        item = item.type === 'commandExecution' ? { ...item, output: text, outputTruncated: truncated } : { ...item, output: { content: [{ type: 'text', text }], ...(truncated ? { truncated } : {}) } };
      }
      const outcome: HostItemOutcome = call.status === 'completed' ? { status: 'succeeded' } : call.status === 'failed' ? { status: 'failed', error: error('nativeFailure', 'Tool failed') }
        : { status: 'cancelled', reason: '原生记录未显示该工具完成' };
      if (call.status === 'completed' || call.status === 'failed') open.delete(update.toolCallId); else open.add(update.toolCallId);
      if (entry) { entry.call = call; entry.snapshot.item = item; entry.snapshot.outcome = outcome; }
      else { const snapshot = { item, outcome }; tools.set(update.toolCallId, { call, snapshot }); last.items.push(snapshot); }
      last.hasOutput = true;
    } else if (update.sessionUpdate === 'session_info_update') {
      const failure = sessionFailure(update._meta);
      if (failure?.severity === 'error') last.failure = failure.title;
    }
  }
  /** `native` holds turn outcomes the agent program recorded itself, by user message id; they beat inference from replayed content. */
  snapshot(harnessId: HarnessId, nativeSessionId: string, native?: Map<string, HostTurnSnapshot['outcome']>): HostTurnSnapshot[] {
    return this.turns.map(turn => ({
      nativeTurnRef: { harnessId, nativeSessionId, nativeTurnKey: this.key(turn), formatVersion: 1 },
      input: [{ type: 'text', text: turn.input }], items: turn.items,
      outcome: (turn.userMessageId ? native?.get(turn.userMessageId) : undefined) ?? inferredOutcome(turn),
    }));
  }
}
/**
 * ACP history carries no turn end state, so it is inferred conservatively: only a turn that ends on the agent's own
 * message after every tool finished counts as done. Anything else stays unknown for the user to judge.
 */
function inferredOutcome(turn: TranscriptTurn): HostTurnSnapshot['outcome'] {
  if (turn.failure) return { status: 'failed', error: error('nativeFailure', turn.failure) };
  if (!turn.hasOutput) return { status: 'unknown', reason: '原生记录没有该轮的回复' };
  if (turn.openTools?.size) return { status: 'unknown', reason: '原生记录中该轮有未完成的工具调用' };
  if (turn.items.at(-1)?.item.type !== 'agentMessage') return { status: 'unknown', reason: '原生记录中该轮停在工具调用，没有收尾回复' };
  return { status: 'succeeded' };
}
/** Tool output as history replays it: Codex's formatted or aggregated text, Claude Code's result blocks, or text content. */
function replayedOutput(call: acp.ToolCallUpdate): string {
  const raw = call.rawOutput, fields = record(raw);
  const direct = typeof raw === 'string' ? raw : [fields.formatted_output, fields.aggregatedOutput, fields.output].find(value => typeof value === 'string');
  if (typeof direct === 'string') return direct;
  if (Array.isArray(raw)) return raw.flatMap(part => record(part).type === 'text' && typeof record(part).text === 'string' ? [record(part).text as string] : []).join('\n');
  return (call.content ?? []).flatMap(part => part.type === 'content' && part.content.type === 'text' ? [part.content.text] : []).join('');
}
const commandOf = (raw: unknown): string | undefined => {
  const value = record(raw).command;
  return typeof value === 'string' && value.trim() ? value : Array.isArray(value) && value.every(part => typeof part === 'string') && value.length ? value.join(' ') : undefined;
};
const hasInput = (value: unknown) => value !== undefined && value !== null && (typeof value !== 'object' || Object.keys(record(value)).length > 0);
const jsonOf = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
function toolItem(call: acp.ToolCall | acp.ToolCallUpdate): HostItemOf<'commandExecution'> | HostItemOf<'toolExecution'> {
  const command = call.kind === 'execute' ? commandOf(call.rawInput) : undefined;
  const title = text(call.title, 200);
  // Claude Code's Bash carries the user-facing purpose in `description`; the activity card shows it ahead of the command.
  const description = text(record(call.rawInput).description, 200) ?? (title && title !== command ? title : undefined);
  if (command) return { type: 'commandExecution', itemId: hostItemIdSchema.parse(call.toolCallId), command,
    ...(description ? { description } : {}), ...(text(record(call.rawInput).cwd, 1000) ? { cwd: text(record(call.rawInput).cwd, 1000)! } : {}) };
  const native = dshTool(call);
  return { type: 'toolExecution', itemId: hostItemIdSchema.parse(call.toolCallId), toolName: native?.toolName ?? text(call.name, 120) ?? title ?? call.kind ?? 'tool',
    ...(call.kind ? { namespace: call.kind } : {}), arguments: native?.arguments ?? jsonOf(call.rawInput) };
}
/**
 * DSH renders `read`, `grep`, `glob`, `edit`, `write`, `web_fetch` and `web_search` as dedicated rows keyed by those names and
 * their DSH arguments. Claude Code names its tools with inputs of nearly the same shape; Codex describes read/search commands
 * only by kind, title and locations.
 */
function dshTool(call: acp.ToolCall | acp.ToolCallUpdate): { toolName: string; arguments: JsonValue } | undefined {
  const input = record(call.rawInput);
  const row = (toolName: string, args: Record<string, unknown>) => ({ toolName, arguments: jsonOf(args) });
  switch (call.name) {
    case 'Read': return text(input.file_path) ? row('read', { file_path: input.file_path, offset: input.offset, limit: input.limit }) : undefined;
    case 'Grep': return typeof input.pattern === 'string' ? row('grep', { pattern: input.pattern, path: input.path, include: input.glob }) : undefined;
    case 'Glob': return typeof input.pattern === 'string' ? row('glob', { pattern: input.pattern, path: input.path }) : undefined;
    case 'Edit': return text(input.file_path) && typeof input.new_string === 'string'
      ? row('edit', { file_path: input.file_path, old_string: input.old_string, new_string: input.new_string, replace_all: input.replace_all }) : undefined;
    case 'Write': return text(input.file_path) && typeof input.content === 'string' ? row('write', { file_path: input.file_path, content: input.content }) : undefined;
    case 'WebFetch': return text(input.url) ? row('web_fetch', { url: input.url }) : undefined;
    case 'WebSearch': return text(input.query) ? row('web_search', { queries: [input.query] }) : undefined;
  }
  if (input.type === 'webSearch') {
    const action = record(input.action);
    if (text(action.url)) return row('web_fetch', { url: action.url });
    const queries = (Array.isArray(action.queries) && action.queries.length ? action.queries : [action.query ?? input.query]).filter(query => text(query));
    return queries.length ? row('web_search', { queries }) : undefined;
  }
  const title = typeof call.title === 'string' ? call.title : '';
  const read = call.kind === 'read' && /^Read file '(.+)'$/s.exec(title);
  if (read) return row('read', { file_path: call.locations?.[0]?.path ?? read[1] });
  const search = call.kind === 'search' && /^Search for '(.+)'(?: in (.+))?$/s.exec(title);
  if (search) return row('grep', { pattern: search[1], path: search[2] });
  return undefined;
}
// ── Subagents: what each one said and did, for the sidebar; never part of the main transcript ─────────────────────────

export const SUBAGENT_LIMIT = 200, SUBAGENT_ENTRY_LIMIT = 300, SUBAGENT_OUTPUT_LIMIT = 4_000;
type ToolEntry = Extract<HarnessSubagentEntry, { kind: 'tool' }>;
/** One session's subagents, bounded: the oldest subagent, and a subagent's oldest entries, give way first. */
class Subagents {
  readonly #byId = new Map<string, HarnessSubagent>();
  /** Merged tool call per `subagent\0toolCallId`, and the message id of each subagent's trailing text entry. */
  readonly #tools = new Map<string, { call: acp.ToolCallUpdate; entry: ToolEntry }>();
  readonly #messageIds = new Map<string, string | undefined>();
  has(id: string): boolean { return this.#byId.has(id); }
  list(): HarnessSubagent[] { return [...this.#byId.values()].map(agent => ({ ...agent, entries: agent.entries.map(entry => ({ ...entry })) })); }
  upsert(id: string, fields: { name?: string | undefined; task?: string | undefined; parentId?: string | undefined }): void {
    const agent = this.#byId.get(id);
    if (agent) { if (fields.name) agent.name = fields.name; if (fields.task) agent.task = fields.task; return; }
    if (this.#byId.size >= SUBAGENT_LIMIT) this.#drop(this.#byId.keys().next().value!);
    this.#byId.set(id, { id, parentId: fields.parentId ?? null, name: fields.name ?? 'Subagent', task: fields.task ?? null, status: 'running', entries: [] });
  }
  finish(id: string, status: HarnessSubagent['status']): void { const agent = this.#byId.get(id); if (agent?.status === 'running') agent.status = status; }
  /** A turn that did not end normally ends every subagent still running. */
  settle(status: 'failed' | 'cancelled'): void { for (const agent of this.#byId.values()) if (agent.status === 'running') agent.status = status; }
  append(id: string, update: acp.SessionUpdate, showThoughts: boolean): void {
    const agent = this.#byId.get(id);
    if (!agent) return;
    if (update.sessionUpdate === 'agent_message_chunk' || update.sessionUpdate === 'agent_thought_chunk') {
      if (update.content.type !== 'text' || (update.sessionUpdate === 'agent_thought_chunk' && !showThoughts)) return;
      const kind = update.sessionUpdate === 'agent_message_chunk' ? 'message' : 'thought', last = agent.entries.at(-1), messageId = update.messageId ?? undefined;
      if (last?.kind === kind && this.#messageIds.get(id) === messageId) { last.text += update.content.text; return; }
      this.#messageIds.set(id, messageId);
      this.#push(agent, { kind, text: update.content.text });
    } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      const key = `${id}\0${update.toolCallId}`, known = this.#tools.get(key);
      const call = { ...known?.call, ...Object.fromEntries(Object.entries(update).filter(([, value]) => value !== undefined && value !== null)) } as acp.ToolCallUpdate;
      const status = call.status === 'completed' || call.status === 'failed' ? call.status : 'running';
      const fields = { title: text(record(call.rawInput).description, 200) ?? text(call.title, 200) ?? commandOf(call.rawInput)?.slice(0, 200) ?? text(call.name, 120) ?? 'tool',
        status, output: status === 'running' ? null : text(replayedOutput(call), SUBAGENT_OUTPUT_LIMIT) ?? null } as const;
      if (known) { known.call = call; Object.assign(known.entry, fields); return; }
      const entry: ToolEntry = { kind: 'tool', ...fields };
      this.#tools.set(key, { call, entry });
      this.#push(agent, entry);
    }
  }
  #push(agent: HarnessSubagent, entry: HarnessSubagentEntry): void {
    agent.entries.push(entry);
    if (agent.entries.length <= SUBAGENT_ENTRY_LIMIT) return;
    const dropped = agent.entries.shift();
    for (const [key, tool] of this.#tools) if (tool.entry === dropped) this.#tools.delete(key);
  }
  #drop(id: string): void {
    this.#byId.delete(id); this.#messageIds.delete(id);
    for (const key of this.#tools.keys()) if (key.startsWith(`${id}\0`)) this.#tools.delete(key);
  }
}
const subagentStatus = (state: unknown): HarnessSubagent['status'] => state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'failed';

/** A reported diff as DSH's own edit row (or write row for a new file); the edit card reads its hunk from these arguments. */
const diffTool = (itemId: string, diff: acp.Diff): HostItemOf<'toolExecution'> => ({ type: 'toolExecution', itemId: hostItemIdSchema.parse(itemId), namespace: 'edit',
  ...(diff.oldText ? { toolName: 'edit', arguments: { file_path: diff.path, old_string: diff.oldText, new_string: diff.newText } }
    : { toolName: 'write', arguments: { file_path: diff.path, content: diff.newText } }) });

// ── Session ─────────────────────────────────────────────────────────────────────────────────────────────────────────

type Pending = { interaction: HostInteraction; settle(response: acp.RequestPermissionResponse | acp.CreateElicitationResponse): void; kind: 'permission' | 'form' | 'url'; form?: Form; elicitationId?: string };
interface ActiveTurn {
  hostId: HostTurnId; transcript: TranscriptTurn; cancelled: boolean;
  message?: HostItemOf<'agentMessage'>; messageId?: string;
  thought?: HostItemOf<'reasoning'>; thoughtId?: string;
  tools: Map<string, HostItemOf<'commandExecution'> | HostItemOf<'toolExecution'>>;
  announced: Map<string, acp.ToolCallUpdate>;
  compaction: Map<string, HostItemOf<'contextCompaction'>>;
  interactions: Map<HostInteractionId, Pending>;
  done: PromiseWithResolvers<void>;
}
interface SessionOptions { profile: AcpProfile; environment: NodeJS.ProcessEnv; input: OpenSessionInput; onClosed(): void }

class AcpSession implements HarnessSession {
  readonly harnessId: HarnessId;
  readonly capabilities: HarnessSessionCapabilities;
  readonly initialUsage: HostUsage | null;
  readonly #channel = new HarnessOutputChannel<HarnessOutput>();
  readonly outputs = this.#channel.outputs;
  readonly #transcript = new Transcript();
  readonly #subagents = new Subagents();
  readonly #process: AcpProcess;
  readonly #sessionId: string;
  readonly #cwd: string;
  readonly #profile: AcpProfile;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #catalogs: Catalogs;
  readonly #onClosed: () => void;
  #state: HarnessSessionState;
  #usage: HostUsage | null;
  #totals = { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0 };
  #commands: HarnessSkill[] = [];
  #rawCommands: acp.AvailableCommand[] = [];
  #titlePending: boolean;
  #active: ActiveTurn | null = null;
  #fault: HarnessError | null = null;
  #closing: Promise<void> | null = null;

  private constructor(options: SessionOptions, process_: AcpProcess, sessionId: string, opened: Opened, catalogs: Catalogs, commands: HarnessSkill[]) {
    this.#profile = options.profile; this.#environment = options.environment; this.#process = process_; this.#sessionId = sessionId; this.#cwd = options.input.cwd; this.#onClosed = options.onClosed;
    this.harnessId = harnessIdSchema.parse(options.profile.harnessId);
    this.#catalogs = catalogs;
    this.#commands = commands;
    this.capabilities = capabilitiesOf(process_.initialized.agentCapabilities, catalogs);
    this.#titlePending = options.input.kind === 'create' && !!options.profile.titleCommand;
    this.#state = {
      nativeRef: nativeSessionRefSchema.parse({ harnessId: this.harnessId, nativeSessionId: sessionId, formatVersion: 1 }),
      ...(catalogs.currentModel ? { effectiveModel: modelRef(catalogs.currentModel), resolvedModelLabel: selectOptions(opened.configOptions!.find(option => option.id === catalogs.modelConfigId)!).find(option => option.value === catalogs.currentModel)?.name ?? catalogs.currentModel } : {}),
      ...(catalogs.currentThinking ? { effectiveThinkingOptionId: harnessThinkingOptionIdSchema.parse(catalogs.currentThinking), availableThinkingOptions: catalogs.catalog.thinkingOptions } : {}),
      ...(catalogs.currentMode ? { effectivePermissionModeId: harnessPermissionModeIdSchema.parse(catalogs.currentMode) } : {}),
      ...(catalogs.configOptions.size ? { configValues: Object.fromEntries([...catalogs.configOptions].map(([id, option]) => [id, option.currentValue])) } : {}),
    };
    // Counters restart with each agent process; the persisted totals stay the baseline the Host subtracts from.
    this.initialUsage = this.#usage = options.input.usage ?? null;
    if (this.#usage) this.#totals = { inputTokens: this.#usage.inputTokens ?? 0, cachedInputTokens: this.#usage.cachedInputTokens ?? 0, cacheWriteInputTokens: this.#usage.cacheWriteInputTokens ?? 0, outputTokens: this.#usage.outputTokens ?? 0 };
  }

  static async open(options: SessionOptions): Promise<AcpSession> {
    const { profile, input } = options;
    let session: AcpSession | undefined;
    const replay: acp.SessionNotification[] = [];
    let commands: acp.AvailableCommand[] | undefined;
    let sessionId = input.kind === 'resume' ? input.nativeRef.nativeSessionId : undefined;
    const process_ = await AcpProcess.connect(profile, options.environment, input.cwd, {
      update: notification => {
        if (session) { session.#notify(notification); return; }
        if (sessionId === undefined) return;
        if (notification.sessionId === sessionId && notification.update.sessionUpdate === 'available_commands_update') commands = notification.update.availableCommands;
        else replay.push(notification);
      },
      permission: (params, signal) => session ? session.#permission(params, signal) : Promise.resolve({ outcome: { outcome: 'cancelled' } }),
      elicitation: (params, signal) => session ? session.#elicitation(params, signal) : Promise.resolve({ action: 'cancel' }),
      elicitationComplete: params => { if (session) session.#elicitationComplete(params); },
      fault: cause => { if (session) session.#faulted(toError(cause, 'ACP agent exited')); },
    }, input.instructions);
    try {
      const meta = profile.sessionMeta?.(input.kind, input.instructions);
      let opened: Opened;
      if (input.kind === 'create') {
        const created = await request<acp.NewSessionResponse>(process_.agent, 'session/new', { cwd: input.cwd, mcpServers: [], ...(meta ? { _meta: meta } : {}) });
        sessionId = created.sessionId; opened = created;
      } else {
        sessionId = input.nativeRef.nativeSessionId;
        opened = await request<acp.LoadSessionResponse>(process_.agent, 'session/load', { sessionId, cwd: input.cwd, mcpServers: [], ...(meta ? { _meta: meta } : {}) }, 120_000);
      }
      const catalogs = catalogsOf(opened);
      const skills = (await waitFor(() => commands, 3_000)) ?? [];
      session = new AcpSession(options, process_, sessionId, opened, catalogs, skillsOf(profile, skills));
      session.#rawCommands = skills;
      for (const { sessionId: owner, update } of replay) if (!session.#routeSubagent(owner, update)) session.#transcript.replay(update);
      await session.#applyHints(input);
      return session;
    } catch (cause) { await process_.close(); throw cause; }
  }

  /** Requested model / thinking / permission that differ from the agent's current values are applied before the first turn. */
  async #applyHints(input: OpenSessionInput): Promise<void> {
    const { profile } = this;
    if (input.model && this.#catalogs.modelConfigId && modelValue(input.model) !== this.#catalogs.currentModel) await this.#setConfig(this.#catalogs.modelConfigId, modelValue(input.model));
    const thinking = input.thinkingOptionId ? profile.legacyThinkingOptions?.[input.thinkingOptionId] ?? input.thinkingOptionId : undefined;
    if (thinking && this.#catalogs.thinkingConfigId && thinking !== this.#catalogs.currentThinking && this.#catalogs.catalog.thinkingOptions.some(option => option.id === thinking)) await this.#setConfig(this.#catalogs.thinkingConfigId, thinking);
    const mode = input.permissionModeId ? profile.legacyPermissionModes?.[input.permissionModeId] ?? input.permissionModeId : undefined;
    if (mode && this.#catalogs.permissionModes?.modes.some(entry => entry.id === mode) && mode !== this.#catalogs.currentMode) await this.#setMode(mode);
    for (const [id, value] of Object.entries(input.configValues ?? {})) {
      const option = this.#catalogs.configOptions.get(id);
      if (option && option.currentValue !== value) await this.#setConfig(id, value);
    }
  }
  get profile(): AcpProfile { return this.#profile; }
  /** State once the requested model / thinking / permission have been applied. */
  get initialState(): HarnessSessionState { return this.#state; }

  async listSkills(): Promise<HarnessSkill[]> { return this.#commands; }
  subagents(): HarnessSubagent[] { return this.#subagents.list(); }

  async readSnapshot(): Promise<HarnessResult<{ turns: HostTurnSnapshot[]; state: HarnessSessionState }>> {
    if (this.#fault) return { ok: false, error: this.#fault };
    // A native record that cannot be read leaves the inferred outcomes; it never makes a turn look settled.
    const native = await this.#profile.turnOutcomes?.(this.#sessionId).catch(() => undefined);
    return { ok: true, value: { turns: this.#transcript.snapshot(this.harnessId, this.#sessionId, native), state: this.#state } };
  }

  /**
   * `session/fork`; a boundary forks through that turn's last agent message (AIR fork point extension). The fork runs in
   * its own short-lived agent process: the agent keeps a fork it created open (Codex holds its writer), and the child
   * session must be loadable by another process while this one lives on.
   */
  async fork(throughTurn?: string | null): Promise<HarnessResult<NativeSessionRef | undefined>> {
    if (this.#active || this.#fault || this.#closing) return failed('sessionBusy', '请等待原生会话结束后再分支');
    if (throughTurn === null) return { ok: true, value: undefined };
    if (!this.capabilities.history.fork) return failed('unsupported', 'Harness 未提供原生会话分支');
    let meta: Record<string, unknown> | undefined;
    if (throughTurn !== undefined) {
      const turn = this.#transcript.turns.find(entry => this.#transcript.key(entry) === throughTurn);
      if (!turn?.lastAgentMessageId) return failed('invalidRequest', '无法确认分支末尾的原生边界');
      meta = { jetbrains: { air: { fork: { version: 1, messageId: turn.lastAgentMessageId } } } };
    }
    try {
      const process_ = await AcpProcess.connect(this.#profile, this.#environment, this.#cwd, IDLE_HANDLERS);
      try {
        const forked = await request<acp.ForkSessionResponse>(process_.agent, 'session/fork', { sessionId: this.#sessionId, cwd: this.#cwd, ...(meta ? { _meta: meta } : {}) }, 120_000);
        if (!forked.sessionId || forked.sessionId === this.#sessionId) throw new Error('Harness 返回了错误的分支身份');
        return { ok: true, value: nativeSessionRefSchema.parse({ harnessId: this.harnessId, nativeSessionId: forked.sessionId, formatVersion: 1 }) };
      } finally { await process_.close(); }
    } catch (cause) { return { ok: false, error: toError(cause, '无法创建原生会话分支') }; }
  }

  async steer(input: HostInput[]): Promise<HarnessResult<{ accepted: true }>> {
    if (!this.#active || this.#fault) return failed('invalidState', '当前没有可插入的原生轮次');
    try {
      const result = record(await request(this.#process.agent, '_session/steering', { sessionId: this.#sessionId, prompt: blocksOf(input) }));
      if (result.outcome !== 'injected') throw new Error('原生轮次已结束，插入未被接收');
      return { ok: true, value: { accepted: true } };
    } catch (cause) { return { ok: false, error: toError(cause, '插入未被接收') }; }
  }

  execute(command: TurnStartCommand): Promise<HarnessResult<{ turnId: HostTurnId }>>;
  execute(command: TurnCancelCommand): Promise<HarnessResult<{ cancellationRequested: true }>>;
  execute(command: InteractionRespondCommand): Promise<HarnessResult<{ accepted: true }>>;
  execute(command: ModelSelectCommand | ThinkingSelectCommand | PermissionModeSelectCommand): Promise<HarnessResult<{ completed: true }>>;
  execute(command: import('./contracts.js').ConfigSelectCommand): Promise<HarnessResult<{ completed: true }>>;
  async execute(command: HostCommand): Promise<HarnessResult<unknown>> {
    if (this.#fault) return { ok: false, error: this.#fault };
    if (this.#closing) return failed('invalidState', 'ACP session closed');
    try {
      switch (command.type) {
        case 'turn.start': return this.#start(command);
        case 'turn.cancel': {
          const active = this.#active;
          if (!active || active.hostId !== command.turnId) return failed('invalidState', 'Turn is not active');
          active.cancelled = true;
          await this.#process.agent.notify('session/cancel', { sessionId: this.#sessionId });
          return { ok: true, value: { cancellationRequested: true } };
        }
        case 'interaction.respond': return this.#respond(command);
        case 'model.select': {
          if (this.#active) return failed('sessionBusy', 'Model selection requires an idle session', true);
          if (!this.#catalogs.modelConfigId) return failed('unsupported', 'Harness does not select models');
          const value = modelValue(command.model);
          await this.#setConfig(this.#catalogs.modelConfigId, value);
          return { ok: true, value: { completed: true } };
        }
        case 'thinking.select': {
          if (this.#active) return failed('sessionBusy', 'Thinking selection requires an idle session', true);
          if (!this.#catalogs.thinkingConfigId) return failed('unsupported', 'Harness does not select thinking levels');
          await this.#setConfig(this.#catalogs.thinkingConfigId, command.thinkingOptionId);
          return { ok: true, value: { completed: true } };
        }
        case 'permissionMode.select': {
          if (!this.#catalogs.permissionModes?.modes.some(mode => mode.id === command.permissionModeId)) return failed('invalidRequest', 'Unknown permission mode');
          await this.#setMode(command.permissionModeId);
          return { ok: true, value: { completed: true } };
        }
        case 'config.select': {
          if (this.#active) return failed('sessionBusy', 'Configuration selection requires an idle session', true);
          const option = this.#catalogs.configOptions.get(command.configId);
          if (!option || typeof option.currentValue !== typeof command.value
            || (isSelect(option) && !selectOptions(option).some(entry => entry.value === command.value))) return failed('invalidRequest', 'Unknown configuration value');
          await this.#setConfig(command.configId, command.value);
          return { ok: true, value: { completed: true } };
        }
      }
    } catch (cause) { return { ok: false, error: toError(cause, 'ACP operation failed') }; }
  }

  async #setConfig(configId: string, value: string | boolean): Promise<void> {
    const response = await request<acp.SetSessionConfigOptionResponse>(this.#process.agent, 'session/set_config_option', {
      sessionId: this.#sessionId, configId, value, ...(typeof value === 'boolean' ? { type: 'boolean' as const } : {}),
    });
    this.#configChanged(response.configOptions);
  }
  async #setMode(modeId: string): Promise<void> {
    await request(this.#process.agent, 'session/set_mode', { sessionId: this.#sessionId, modeId });
    this.#publish({ ...this.#state, effectivePermissionModeId: harnessPermissionModeIdSchema.parse(modeId) });
  }
  #configChanged(options: acp.SessionConfigOption[]): void {
    let state = this.#state;
    for (const option of options) {
      if (isSelect(option) && option.id === this.#catalogs.modelConfigId) state = { ...state, effectiveModel: modelRef(option.currentValue), resolvedModelLabel: selectOptions(option).find(entry => entry.value === option.currentValue)?.name ?? option.currentValue };
      else if (isSelect(option) && option.id === this.#catalogs.thinkingConfigId) state = { ...state, effectiveThinkingOptionId: harnessThinkingOptionIdSchema.parse(option.currentValue) };
      else if (isSelect(option) && option.category === 'mode') state = { ...state, effectivePermissionModeId: harnessPermissionModeIdSchema.parse(option.currentValue) };
      else if (this.#catalogs.configOptions.has(option.id)) state = { ...state, configValues: { ...state.configValues, [option.id]: option.currentValue } };
    }
    if (state !== this.#state) this.#publish(state);
  }
  #publish(state: HarnessSessionState): void { this.#state = state; this.#emit({ type: 'session.state.changed', state }); }

  async #start(command: TurnStartCommand): Promise<HarnessResult<{ turnId: HostTurnId }>> {
    if (this.#active) return failed('sessionBusy', 'Turn is active', true);
    if (!command.input.some(part => part.type === 'image' ? part.base64Data.length > 0 : part.text.trim())) return failed('invalidRequest', 'A non-empty prompt is required');
    const blocks = blocksOf(command.input);
    const lead = blocks[0];
    if (lead?.type === 'text' && this.#profile.skillInvocation) {
      // A slash-menu pick arrives as `/name …`; the agent may need its own spelling for an explicit skill mention.
      const match = /^\/([^\s]+)(?=\s|$)/u.exec(lead.text);
      const picked = match && this.#rawCommands.find(entry => this.#profile.skillName?.(entry) === match[1] && this.#profile.skillInvocation!(entry) !== `/${match[1]}`);
      if (picked) lead.text = this.#profile.skillInvocation(picked) + lead.text.slice(match![0].length);
    }
    if (this.#titlePending) {
      this.#titlePending = false;
      // Only the user's own leading text names the session.
      const lead = blocks.find(block => block.type === 'text');
      const title = text(lead?.type === 'text' ? lead.text.split('\n').find(line => line.trim()) : undefined, 60);
      // A local command that hangs must not hold the turn; the timeout cancels the request on the agent.
      if (title) await request(this.#process.agent, 'session/prompt', { sessionId: this.#sessionId, prompt: [{ type: 'text', text: this.#profile.titleCommand!(title) }] }, TITLE_TIMEOUT_MS).catch(() => {});
    }
    const transcript = this.#transcript.begin(promptText(blocks));
    const active: ActiveTurn = { hostId: command.turnId, transcript, cancelled: false, tools: new Map(), announced: new Map(), compaction: new Map(), interactions: new Map(), done: Promise.withResolvers() };
    this.#active = active;
    this.#emit({ type: 'turn.started', turnId: command.turnId, nativeTurnRef: this.#turnRef(this.#transcript.key(transcript)) });
    this.#process.agent.request<acp.PromptResponse>('session/prompt', { sessionId: this.#sessionId, prompt: blocks })
      .then(response => this.#finishPrompt(active, response), cause => this.#finish(active, active.cancelled ? { status: 'cancelled', reason: 'Cancelled by user' } : { status: 'failed', error: toError(cause, 'Turn failed') }));
    return { ok: true, value: { turnId: command.turnId } };
  }
  #turnRef(key: string) { return { harnessId: this.harnessId, nativeSessionId: this.#sessionId, nativeTurnKey: key, formatVersion: 1 as const }; }

  #finishPrompt(active: ActiveTurn, response: acp.PromptResponse): void {
    if (response.usage) {
      this.#totals = { inputTokens: this.#totals.inputTokens + response.usage.inputTokens, cachedInputTokens: this.#totals.cachedInputTokens + (response.usage.cachedReadTokens ?? 0),
        cacheWriteInputTokens: this.#totals.cacheWriteInputTokens + (response.usage.cachedWriteTokens ?? 0), outputTokens: this.#totals.outputTokens + response.usage.outputTokens };
      this.#publishUsage({ ...this.#totals, totalTokens: this.#totals.inputTokens + this.#totals.outputTokens }, active.hostId);
    }
    const failure = sessionFailure(response._meta);
    if (failure?.severity === 'error') { this.#finish(active, { status: 'failed', error: error('nativeFailure', failure.title, true) }); return; }
    if (response.stopReason === 'cancelled') this.#finish(active, { status: 'cancelled', reason: 'Cancelled by user' });
    else if (response.stopReason === 'refusal') this.#finish(active, { status: 'failed', error: error('nativeFailure', 'The agent refused the request') });
    else this.#finish(active, { status: 'succeeded' });
  }

  #finish(active: ActiveTurn, outcome: TurnOutcome): void {
    if (this.#active !== active) return;
    for (const pending of [...active.interactions.values()]) pending.settle(pending.kind === 'permission' ? { outcome: { outcome: 'cancelled' } } : { action: 'cancel' });
    this.#completeMessage(active, outcome);
    this.#completeThought(active, outcome);
    if (outcome.status !== 'succeeded') this.#subagents.settle(outcome.status === 'cancelled' ? 'cancelled' : 'failed');
    for (const [id, item] of active.tools) { active.tools.delete(id); this.#emit({ type: 'item.completed', turnId: active.hostId, snapshot: { item, outcome: outcome.status === 'succeeded' ? { status: 'succeeded' } : outcome } }); }
    for (const [id, item] of active.compaction) { active.compaction.delete(id); this.#emit({ type: 'item.completed', turnId: active.hostId, snapshot: { item, outcome } }); }
    this.#emit({ type: 'turn.completed', turnId: active.hostId, nativeTurnRef: this.#turnRef(this.#transcript.key(active.transcript)), outcome });
    this.#active = null;
    active.done.resolve();
  }

  // ── session/update ────────────────────────────────────────────────────────────────────────────────────────────────

  #notify(notification: acp.SessionNotification): void {
    if (!this.#routeSubagent(notification.sessionId, notification.update)) this.#update(notification.update);
  }
  /** The main session or one of its Codex subagent sessions; their approvals and questions reach the user alike. */
  #owns(sessionId: string): boolean { return sessionId === this.#sessionId || this.#subagents.has(sessionId); }
  /**
   * Takes what belongs to subagents; false leaves the update to the main transcript. Codex announces child sessions and
   * streams each under its own id; Claude Code tags a subagent's events with its Agent call, which itself stays in the main transcript.
   */
  #routeSubagent(sessionId: string, update: acp.SessionUpdate): boolean {
    const lifecycle = update as unknown as SubagentLifecycle;
    if (lifecycle.sessionUpdate === 'subagent_spawned') {
      this.#subagents.upsert(lifecycle.subagentSessionId, { name: text(lifecycle.name, 200), task: text(lifecycle.task, 4000), ...(sessionId !== this.#sessionId ? { parentId: sessionId } : {}) });
      return true;
    }
    if (lifecycle.sessionUpdate === 'subagent_state_update') { this.#subagents.finish(lifecycle.subagentSessionId, subagentStatus(lifecycle.state)); return true; }
    const showThoughts = this.#profile.showThoughts !== false;
    if (sessionId !== this.#sessionId) { this.#subagents.append(sessionId, update, showThoughts); return true; }
    const claude = record(record((update as { _meta?: unknown })._meta).claudeCode);
    const parent = text(claude.parentToolUseId, 200);
    if ((update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') && (claude.subagent === true || claude.toolName === 'Agent' || claude.toolName === 'Task')) {
      const input = record(update.rawInput);
      this.#subagents.upsert(update.toolCallId, { name: text(input.description, 200) ?? text(update.title, 200), task: text(input.prompt, 4000), ...(parent ? { parentId: parent } : {}) });
      if (update.status === 'completed' || update.status === 'failed') this.#subagents.finish(update.toolCallId, update.status);
    }
    if (!parent) return false;
    this.#subagents.upsert(parent, {});
    this.#subagents.append(parent, update, showThoughts);
    return true;
  }

  #update(update: acp.SessionUpdate): void {
    if (update.sessionUpdate === 'available_commands_update') { this.#rawCommands = update.availableCommands; this.#commands = skillsOf(this.#profile, update.availableCommands); return; }
    if (update.sessionUpdate === 'config_option_update') { this.#configChanged(update.configOptions); return; }
    if (update.sessionUpdate === 'current_mode_update') { this.#publish({ ...this.#state, effectivePermissionModeId: harnessPermissionModeIdSchema.parse(update.currentModeId) }); return; }
    if (update.sessionUpdate === 'usage_update') {
      if (update.size > 0) this.#publishUsage({ contextUsedTokens: update.used, contextWindowTokens: update.size }, this.#active?.hostId);
      return;
    }
    const active = this.#active;
    if (!active) return;
    active.transcript.hasOutput ||= ['agent_message_chunk', 'tool_call'].includes(update.sessionUpdate);
    const { hostId: turnId } = active;
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        if (update.content.type !== 'text') return;
        if (update.messageId) active.transcript.lastAgentMessageId = update.messageId;
        if (active.message && update.messageId && active.messageId && update.messageId !== active.messageId) this.#completeMessage(active, { status: 'succeeded' });
        this.#completeThought(active, { status: 'succeeded' });
        if (!active.message) {
          active.message = { type: 'agentMessage', itemId: newItemId(), text: '' };
          active.messageId = update.messageId ?? undefined;
          this.#emit({ type: 'item.started', turnId, item: active.message });
        }
        active.message.text += update.content.text;
        this.#emit({ type: 'item.updated', turnId, itemId: active.message.itemId, update: { type: 'text.append', text: update.content.text } });
        return;
      }
      case 'agent_thought_chunk': {
        if (this.#profile.showThoughts === false) return;
        if (update.content.type !== 'text') return;
        this.#completeMessage(active, { status: 'succeeded' });
        if (active.thought && update.messageId && active.thoughtId && update.messageId !== active.thoughtId) this.#completeThought(active, { status: 'succeeded' });
        if (!active.thought) {
          active.thought = { type: 'reasoning', itemId: newItemId(), text: '' };
          active.thoughtId = update.messageId ?? undefined;
          this.#emit({ type: 'item.started', turnId, item: active.thought });
        }
        active.thought.text += update.content.text;
        this.#emit({ type: 'item.updated', turnId, itemId: active.thought.itemId, update: { type: 'text.append', text: update.content.text } });
        return;
      }
      case 'tool_call': case 'tool_call_update': {
        this.#completeMessage(active, { status: 'succeeded' });
        this.#completeThought(active, { status: 'succeeded' });
        let item = active.tools.get(update.toolCallId);
        if (!item) {
          // Agents announce a call before its input has streamed (Claude Code's Bash); the card waits for the input or a terminal status.
          const merged = { ...active.announced.get(update.toolCallId), ...Object.fromEntries(Object.entries(update).filter(([, value]) => value !== undefined && value !== null)) } as acp.ToolCallUpdate;
          active.announced.set(update.toolCallId, merged);
          const ended = update.status === 'completed' || update.status === 'failed';
          // Claude Code asks through an elicitation; the host records that exchange as its own question row.
          if (merged.name === 'AskUserQuestion') { if (ended) active.announced.delete(update.toolCallId); return; }
          // A call first seen finished that only carried diffs (Codex's "Editing files") is shown as those edits alone.
          const edits = (merged.content ?? []).flatMap(part => part.type === 'diff' ? [part] : []);
          if (ended && merged.kind === 'edit' && edits.length && !dshTool(merged)) {
            active.announced.delete(update.toolCallId);
            const outcome: HostItemOutcome = update.status === 'completed' ? { status: 'succeeded' } : { status: 'failed', error: error('nativeFailure', 'File edit failed') };
            edits.forEach((diff, index) => this.#emitDone(active, diffTool(`${update.toolCallId}#${index}`, diff), outcome));
            return;
          }
          // Claude streams Bash input one field at a time; wait for its required description before creating the DSH row.
          if (merged.name === 'Bash' && commandOf(merged.rawInput)
            && !text(record(merged.rawInput).description, 200) && !ended) return;
          if (!hasInput(merged.rawInput) && !ended) return;
          if (!merged.title && !merged.name) return;
          active.announced.delete(update.toolCallId);
          item = toolItem({ ...merged, title: merged.title ?? merged.name ?? 'tool' });
          active.tools.set(update.toolCallId, item);
          this.#emit({ type: 'item.started', turnId, item });
        }
        // An update that delivers the input describes the call (Claude Code repeats the Bash description there); its content is not output.
        const terminal = update.status === 'completed' || update.status === 'failed';
        const describing = hasInput(update.rawInput) && !terminal;
        const rawOutput = typeof update.rawOutput === 'string' ? update.rawOutput : typeof record(update.rawOutput).output === 'string' ? record(update.rawOutput).output as string : typeof record(update.rawOutput).aggregatedOutput === 'string' ? record(update.rawOutput).aggregatedOutput as string : undefined;
        const outputText = describing ? '' : item.type === 'commandExecution' && terminal && rawOutput !== undefined ? rawOutput
          : (update.content ?? []).flatMap(part => part.type === 'content' && part.content.type === 'text' ? [part.content.text] : []).join('');
        const images = describing ? [] : (update.content ?? []).flatMap(part => part.type === 'content' && part.content.type === 'image' ? [{ type: 'image' as const, mimeType: part.content.mimeType, base64Data: part.content.data }] : []);
        const diffs = (update.content ?? []).flatMap(part => part.type === 'diff' ? [part] : []);
        if (outputText || images.length) {
          const truncated = outputText.length > TOOL_OUTPUT_LIMIT, output = truncated ? outputText.slice(0, TOOL_OUTPUT_LIMIT) : outputText;
          if (item.type === 'commandExecution') { item = { ...item, output, outputTruncated: truncated }; }
          else item = { ...item, output: { content: [...(output ? [{ type: 'text' as const, text: output }] : []), ...images], ...(truncated ? { truncated } : {}) } };
          active.tools.set(update.toolCallId, item);
        }
        if (item.type === 'commandExecution' && typeof record(update.rawOutput).exitCode === 'number') { item = { ...item, exitCode: record(update.rawOutput).exitCode as number }; active.tools.set(update.toolCallId, item); }
        if (update.status === 'completed' || update.status === 'failed') {
          active.tools.delete(update.toolCallId);
          const outcome: HostItemOutcome = update.status === 'completed' ? { status: 'succeeded' } : { status: 'failed', error: error('nativeFailure', `Tool '${item.type === 'commandExecution' ? item.command : item.toolName}' failed`) };
          const snapshot = { item, outcome };
          active.transcript.items.push(snapshot);
          this.#emit({ type: 'item.completed', turnId, snapshot });
          // Claude Code's Edit/Write row already shows its change; any other call's diffs become edit rows of their own.
          if (item.type !== 'toolExecution' || (item.toolName !== 'edit' && item.toolName !== 'write')) {
            diffs.forEach((diff, index) => this.#emitDone(active, diffTool(`${update.toolCallId}#${index}`, diff), outcome));
          }
        }
        return;
      }
      case 'plan': case 'plan_update': {
        const plan = update.sessionUpdate === 'plan' ? update.entries : update.plan.type === 'items' ? update.plan.entries : update.plan.type === 'markdown' ? update.plan.content : update.plan.uri;
        const item: HostItem = Array.isArray(plan) ? { type: 'toolExecution', itemId: newItemId(), toolName: 'todo_write', arguments: jsonOf({ todos: plan }) }
          : { type: 'toolExecution', itemId: newItemId(), toolName: 'Todo', arguments: jsonOf(plan) };
        this.#emit({ type: 'item.started', turnId, item });
        this.#emit({ type: 'item.completed', turnId, snapshot: { item, outcome: { status: 'succeeded' } } });
        return;
      }
      case 'compaction_update': {
        let item = active.compaction.get(update.compactionId);
        if (!item) { item = { type: 'contextCompaction', itemId: newItemId() }; active.compaction.set(update.compactionId, item); this.#emit({ type: 'item.started', turnId, item }); }
        if (update.status !== 'in_progress') {
          active.compaction.delete(update.compactionId);
          this.#emit({ type: 'item.completed', turnId, snapshot: { item, outcome: update.status === 'completed' ? { status: 'succeeded' } : update.status === 'cancelled' ? { status: 'cancelled' } : { status: 'failed', error: error('nativeFailure', update.error ?? 'Context compaction failed', true) } } });
        }
        return;
      }
      case 'session_info_update': {
        const notice = text(record(record(record(update._meta).codex).error).message, 500) ?? (() => { const failure = sessionFailure(update._meta); return failure && `${failure.title}${failure.details ? `\n${failure.details}` : ''}`; })();
        if (!notice || notice.startsWith(SKILLS_CONTEXT_BUDGET_NOTICE)) return;
        this.#completeMessage(active, { status: 'succeeded' });
        const item: HostItem = { type: 'agentMessage', itemId: newItemId(), text: notice };
        this.#emit({ type: 'item.started', turnId, item });
        this.#emit({ type: 'item.completed', turnId, snapshot: { item, outcome: { status: 'succeeded' } } });
        return;
      }
      default: return;
    }
  }
  #emitDone(active: ActiveTurn, item: HostItem, outcome: HostItemOutcome): void {
    const snapshot = { item, outcome };
    active.transcript.items.push(snapshot);
    this.#emit({ type: 'item.started', turnId: active.hostId, item });
    this.#emit({ type: 'item.completed', turnId: active.hostId, snapshot });
  }
  #completeMessage(active: ActiveTurn, outcome: HostItemOutcome): void {
    const item = active.message;
    if (!item) return;
    active.message = undefined; active.messageId = undefined;
    const snapshot = { item, outcome };
    active.transcript.items.push(snapshot);
    this.#emit({ type: 'item.completed', turnId: active.hostId, snapshot });
  }
  #completeThought(active: ActiveTurn, outcome: HostItemOutcome): void {
    const item = active.thought;
    if (!item) return;
    active.thought = undefined; active.thoughtId = undefined;
    this.#emit({ type: 'item.completed', turnId: active.hostId, snapshot: { item, outcome } });
  }
  #publishUsage(delta: HostUsage, turnId?: HostTurnId): void {
    const next = { ...this.#usage, ...delta };
    if (this.#usage && Object.entries(next).every(([key, value]) => this.#usage![key as keyof HostUsage] === value)) return;
    this.#usage = next;
    this.#emit({ type: 'session.usage.changed', usage: next, ...(turnId ? { observedForTurnId: turnId } : {}) });
  }

  // ── Interactions ──────────────────────────────────────────────────────────────────────────────────────────────────

  #permission(params: acp.RequestPermissionRequest, signal: AbortSignal): Promise<acp.RequestPermissionResponse> {
    const active = this.#active;
    if (!active || !this.#owns(params.sessionId) || !params.options.length) return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    const presentation = record(record(params._meta).permission);
    const command = commandOf(params.toolCall.rawInput);
    const title = text(presentation.title, 200) ?? text(params.toolCall.title, 200) ?? command ?? text(params.toolCall.name, 120) ?? 'Approval required';
    const description = [text(presentation.description), command && command !== title ? command : undefined,
      ...(params.toolCall.locations ?? []).map(location => location.path).slice(0, 5)].filter((value): value is string => !!value).join('\n');
    const interaction: HostApprovalInteraction = {
      type: 'approval', interactionId: hostInteractionIdSchema.parse(randomUUID()), turnId: active.hostId, title, ...(description ? { description } : {}), subject: { type: 'nativeAction' },
      actions: params.options.map(option => ({ id: option.optionId, label: option.name,
        effect: option.kind === 'allow_once' ? 'allowOnce' : option.kind === 'allow_always' ? 'allowAlways' : 'deny' })),
    };
    return this.#ask(active, interaction, 'permission', signal) as Promise<acp.RequestPermissionResponse>;
  }
  #elicitation(params: acp.CreateElicitationRequest, signal: AbortSignal): Promise<acp.CreateElicitationResponse> {
    const active = this.#active;
    if (!active || ('sessionId' in params && !this.#owns(String(params.sessionId)))) return Promise.resolve({ action: 'cancel' });
    const title = text(params.message, 200) ?? 'Input required';
    if (params.mode === 'url') {
      const url = 'url' in params ? String(params.url) : '';
      const interaction: HostApprovalInteraction = { type: 'approval', interactionId: hostInteractionIdSchema.parse(randomUUID()), turnId: active.hostId, title, description: url,
        subject: { type: 'nativeAction' }, actions: [{ id: 'accept', label: 'Continue after completing the browser step', effect: 'allowOnce' }, { id: 'decline', label: 'Cancel', effect: 'deny' }] };
      return this.#ask(active, interaction, 'url', signal, undefined, 'elicitationId' in params ? String(params.elicitationId) : undefined) as Promise<acp.CreateElicitationResponse>;
    }
    if (params.mode !== 'form') return Promise.resolve({ action: 'cancel' });
    const form = formOf(params.requestedSchema as acp.ElicitationSchema);
    if (!form) return Promise.resolve({ action: 'cancel' });
    const interaction: HostQuestionInteraction = { type: 'question', interactionId: hostInteractionIdSchema.parse(randomUUID()), turnId: active.hostId, title, questions: form.questions };
    return this.#ask(active, interaction, 'form', signal, form) as Promise<acp.CreateElicitationResponse>;
  }
  #ask(active: ActiveTurn, interaction: HostInteraction, kind: Pending['kind'], signal: AbortSignal, form?: Form, elicitationId?: string) {
    return new Promise<acp.RequestPermissionResponse | acp.CreateElicitationResponse>(resolve => {
      const pending: Pending = { interaction, kind, ...(form ? { form } : {}), ...(elicitationId ? { elicitationId } : {}), settle: response => {
        if (!active.interactions.delete(interaction.interactionId)) return;
        signal.removeEventListener('abort', onAbort);
        resolve(response);
      } };
      const onAbort = () => { this.#emit({ type: 'interaction.closed', interactionId: interaction.interactionId, turnId: active.hostId, reason: 'cancelled' }); pending.settle(kind === 'permission' ? { outcome: { outcome: 'cancelled' } } : { action: 'cancel' }); };
      signal.addEventListener('abort', onAbort, { once: true });
      // Text streamed before the agent asks belongs ahead of the question in the conversation.
      this.#completeMessage(active, { status: 'succeeded' });
      this.#completeThought(active, { status: 'succeeded' });
      active.interactions.set(interaction.interactionId, pending);
      this.#channel.emit({ kind: 'interaction', interaction });
    });
  }
  #elicitationComplete(params: acp.CompleteElicitationNotification): void {
    const active = this.#active;
    if (!active) return;
    for (const pending of active.interactions.values()) if (pending.elicitationId && pending.elicitationId === String(record(params as unknown).elicitationId)) {
      this.#emit({ type: 'interaction.closed', interactionId: pending.interaction.interactionId, turnId: active.hostId, reason: 'superseded' });
      pending.settle({ action: 'accept' });
    }
  }
  async #respond(command: InteractionRespondCommand): Promise<HarnessResult<{ accepted: true }>> {
    const active = this.#active, pending = active?.interactions.get(command.interactionId);
    if (!active || !pending) return failed('invalidState', 'Interaction is no longer pending');
    const invalid = validateHostInteractionResponse(pending.interaction, command.response);
    if (invalid) return { ok: false, error: invalid };
    let response: acp.RequestPermissionResponse | acp.CreateElicitationResponse;
    if (command.response.type === 'approval') {
      response = pending.kind === 'permission' ? { outcome: { outcome: 'selected', optionId: command.response.actionId } }
        : command.response.actionId === 'accept' ? { action: 'accept' } : { action: 'decline' };
    } else if (command.response.cancelled || !pending.form) response = { action: 'cancel' };
    else {
      try { response = { action: 'accept', content: formContent(pending.form, command.response.answers) }; }
      catch (cause) { return failed('invalidRequest', cause instanceof Error ? cause.message : 'Invalid answer'); }
    }
    pending.settle(response);
    this.#emit({ type: 'interaction.closed', interactionId: command.interactionId, turnId: active.hostId, reason: 'responded' });
    return { ok: true, value: { accepted: true } };
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────────────────────────────────────────────

  #faulted(cause: HarnessError): void {
    if (this.#fault || this.#closing) return;
    this.#fault = { ...cause, code: 'processExited', retryable: true };
    if (this.#active) this.#finish(this.#active, { status: 'failed', error: this.#fault });
    this.#emit({ type: 'session.faulted', error: this.#fault });
    this.#channel.end();
    void this.#process.close().catch(() => {});
    this.#onClosed();
  }
  close(): Promise<void> {
    return this.#closing ??= (async () => {
      try {
        const active = this.#active;
        if (active && !this.#fault) {
          active.cancelled = true;
          await this.#process.agent.notify('session/cancel', { sessionId: this.#sessionId }).catch(() => {});
          await Promise.race([active.done.promise, new Promise(resolve => setTimeout(resolve, CLOSE_TIMEOUT_MS).unref())]);
          if (this.#active === active) this.#finish(active, { status: 'cancelled', reason: 'Session closed' });
        }
        if (!this.#fault) await request(this.#process.agent, 'session/close', { sessionId: this.#sessionId }, 2_000).catch(() => {});
      } finally {
        await this.#process.close();
        this.#channel.end();
        this.#onClosed();
      }
    })();
  }
  #emit(event: HostEvent): void { this.#channel.emit({ kind: 'event', event }); }
}

const blocksOf = (input: HostInput[]): acp.ContentBlock[] => input.map(part => part.type === 'text' ? { type: 'text', text: part.text } : { type: 'image', mimeType: part.mimeType, data: part.base64Data });
function skillsOf(profile: AcpProfile, commands: acp.AvailableCommand[]): HarnessSkill[] {
  return commands.flatMap(command => {
    const name = profile.skillName ? profile.skillName(command) : command.name;
    return name ? [{ name, description: [command.description, command.input?.hint ? `<${command.input.hint}>` : ''].filter(Boolean).join(' '), modelInvocable: true }] : [];
  });
}
function sessionFailure(meta: unknown): { title: string; details?: string; severity: string } | undefined {
  const failure = record(record(record(record(meta).jetbrains).air).sessionFailure);
  const title = text(failure.title, 1000);
  return title ? { title, severity: String(failure.severity), ...(text(failure.details, 4000) ? { details: text(failure.details, 4000)! } : {}) } : undefined;
}

// ── Adapter ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface AcpAdapterOptions { profile: AcpProfile; environment: NodeJS.ProcessEnv }

/** Sessions, catalogs and skills of one ACP agent program; every operation runs in its own agent process. */
export class AcpAdapter implements HarnessAdapter {
  readonly harnessId: HarnessId;
  readonly #options: AcpAdapterOptions;
  readonly #sessions = new Set<AcpSession>();
  readonly #pending = new Set<Promise<unknown>>();
  #closing: Promise<void> | null = null;
  constructor(options: AcpAdapterOptions) { this.#options = options; this.harnessId = harnessIdSchema.parse(options.profile.harnessId); }

  /** A throwaway session reports the agent's catalogs; it is closed before it ever prompts, so nothing persists. */
  inspect(input: { cwd?: string } = {}): Promise<HarnessInspection> {
    return this.#track(async () => {
      const startedAt = Date.now();
      try {
        return await this.#probe(input.cwd ?? process.cwd(), async (process_, opened): Promise<HarnessInspection> => {
          const catalogs = catalogsOf(opened);
          return { status: 'ready', catalog: catalogs.catalog, ...(catalogs.permissionModes ? { permissionModes: catalogs.permissionModes } : {}),
            capabilities: capabilitiesOf(process_.initialized.agentCapabilities, catalogs) };
        });
      } catch (cause) {
        const failure = toError(cause, 'Harness could not start');
        return { status: failure.code === 'notInstalled' ? 'notInstalled' : failure.code === 'authenticationRequired' ? 'unavailable' : 'error', error: { ...failure, durationMs: Date.now() - startedAt } };
      }
    });
  }
  /** Agents publish the command list in waves (Claude Code adds project skills after discovery); the last quiet wave wins. */
  listSkills({ cwd }: { cwd: string }): Promise<HarnessSkill[]> {
    return this.#track(() => this.#probe(cwd, async (_process, _opened, commands) => {
      let latest = await waitFor(() => commands.value, 5_000);
      for (let quiet = 0; latest && quiet < 3; quiet++) {
        await new Promise(resolve => setTimeout(resolve, 500));
        if (commands.value !== latest) { latest = commands.value; quiet = -1; }
      }
      return skillsOf(this.#options.profile, latest ?? []);
    }));
  }
  inspectAccount(): Promise<HarnessAccountSnapshot | null> {
    if (this.#closing || !this.#options.profile.inspectAccount) return Promise.resolve(null);
    return this.#track(() => this.#options.profile.inspectAccount!().catch(() => null));
  }
  async open(input: OpenSessionInput): Promise<HarnessResult<HarnessSession>> {
    if (this.#closing) return failed('invalidState', 'Harness adapter is closing');
    if (input.kind === 'resume' && (!nativeSessionRefSchema.safeParse(input.nativeRef).success || input.nativeRef.harnessId !== this.harnessId)) return failed('invalidRequest', 'Native session belongs to another Harness');
    try {
      const session = await this.#track(() => AcpSession.open({ profile: this.#options.profile, environment: { ...this.#options.environment, ...input.environment }, input, onClosed: () => this.#sessions.delete(session) }));
      if (this.#closing) { await session.close(); return failed('invalidState', 'Harness adapter is closing'); }
      this.#sessions.add(session);
      return { ok: true, value: session };
    } catch (cause) { return { ok: false, error: toError(cause, 'Harness session could not open') }; }
  }
  close(): Promise<void> {
    return this.#closing ??= (async () => {
      await Promise.allSettled([...this.#pending]);
      const results = await Promise.allSettled([...this.#sessions].map(session => session.close()));
      this.#sessions.clear();
      const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      if (failures.length) throw new AggregateError(failures, 'Harness session cleanup failed');
    })();
  }
  async #probe<T>(cwd: string, work: (process_: AcpProcess, opened: acp.NewSessionResponse, commands: { value?: acp.AvailableCommand[] }) => Promise<T>): Promise<T> {
    if (this.#closing) throw error('invalidState', 'Harness adapter is closing');
    const commands: { value?: acp.AvailableCommand[] } = {};
    const process_ = await AcpProcess.connect(this.#options.profile, this.#options.environment, cwd, { ...IDLE_HANDLERS,
      update: notification => { if (notification.update.sessionUpdate === 'available_commands_update') commands.value = notification.update.availableCommands; } });
    try {
      const opened = await request<acp.NewSessionResponse>(process_.agent, 'session/new', { cwd, mcpServers: [], ...(this.#options.profile.sessionMeta?.('create') ? { _meta: this.#options.profile.sessionMeta('create') } : {}) });
      try { return await work(process_, opened, commands); }
      finally { await request(process_.agent, 'session/close', { sessionId: opened.sessionId }, 2_000).catch(() => {}); }
    } finally { await process_.close(); }
  }
  async #track<T>(work: () => Promise<T>): Promise<T> {
    const promise = work();
    this.#pending.add(promise);
    try { return await promise; } finally { this.#pending.delete(promise); }
  }
}
