/** Pure Claude Code protocol translation: SDK messages → turn events, plus the catalogs the adapter exposes. */
import { Buffer } from 'node:buffer';
import path from 'node:path';
import { z } from 'zod';
import {
  harnessModelRefSchema, harnessPermissionModeIdSchema, harnessThinkingOptionIdSchema,
  type HarnessAccountSnapshot, type HarnessModelCatalog, type HarnessModelRef, type HarnessPermissionModeCatalog,
  type HarnessPermissionModeId, type HarnessThinkingOptionId, type HostFileChange, type JsonValue,
} from './contracts.js';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const safeCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function bounded(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, limit) : undefined;
}
const jsonValue = z.json();

// ── Thinking, permission modes, models ──────────────────────────────────────────────────────────────────────────────

export const THINKING_OPTIONS = ([['off', 'Off'], ['auto', 'Auto'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra High'], ['max', 'Max']] as const)
  .map(([id, label]) => ({ id: harnessThinkingOptionIdSchema.parse(id), label }));
export const DEFAULT_THINKING = harnessThinkingOptionIdSchema.parse('auto');
export type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export function parseThinking(value: unknown): HarnessThinkingOptionId {
  const id = harnessThinkingOptionIdSchema.parse(value);
  if (!THINKING_OPTIONS.some(option => option.id === id)) throw new Error('Claude Code Thinking option is invalid');
  return id;
}
export function thinkingConfiguration(id: HarnessThinkingOptionId): { enabled: boolean; effort?: ClaudeEffort } {
  const parsed = parseThinking(id);
  return parsed === 'off' ? { enabled: false } : parsed === 'auto' ? { enabled: true } : { enabled: true, effort: parsed as ClaudeEffort };
}

export type ClaudePermissionMode = 'plan' | 'default' | 'acceptEdits' | 'auto' | 'bypassPermissions';
const PERMISSION_MODES = [
  { id: 'plan', label: 'Plan mode', description: 'Explore and prepare a plan; approval exits planning and resumes the previous permission mode.' },
  { id: 'default', label: 'Default', description: 'Ask before edits and other protected actions.' },
  { id: 'acceptEdits', label: 'Accept edits', description: 'Allow file edits and ask for other protected actions.' },
  { id: 'auto', label: 'Auto mode', description: 'Let Claude classify permission requests.' },
  { id: 'bypassPermissions', label: 'Bypass permissions', description: 'Skip Claude Code permission checks.', dangerous: true },
] as const;
export const DEFAULT_PERMISSION_MODE = harnessPermissionModeIdSchema.parse('default');
export const isPermissionMode = (value: unknown): value is ClaudePermissionMode => PERMISSION_MODES.some(mode => mode.id === value);
export function decodePermissionMode(id: HarnessPermissionModeId): ClaudePermissionMode {
  if (!isPermissionMode(id)) throw new Error('Claude Code Permission Mode belongs to another Adapter');
  return id;
}
export const encodePermissionMode = (mode: ClaudePermissionMode): HarnessPermissionModeId => harnessPermissionModeIdSchema.parse(mode);
/** Auto mode is offered only when a native model advertises support for it. */
export function permissionModeCatalog(models: unknown): HarnessPermissionModeCatalog {
  const auto = Array.isArray(models) && models.some(model => isRecord(model) && model.supportsAutoMode === true);
  return {
    modes: PERMISSION_MODES.filter(mode => auto || mode.id !== 'auto').map(mode => ({ ...mode, id: harnessPermissionModeIdSchema.parse(mode.id) })),
    defaultModeId: DEFAULT_PERMISSION_MODE,
  };
}

const MODEL_REF_PREFIX = 'claude-model-v1.';
const modelInfo = z.object({ value: z.string().trim().min(1).max(512), displayName: z.string().trim().min(1).max(256), resolvedModel: z.string().trim().min(1).max(256).optional() });
/** Native model values are opaque (aliases, provider ids); the ref carries them losslessly in a transport-safe form. */
export function encodeModelRef(value: string): HarnessModelRef {
  return harnessModelRefSchema.parse({ id: MODEL_REF_PREFIX + Buffer.from(z.string().trim().min(1).max(512).parse(value), 'utf8').toString('base64url') });
}
export const DEFAULT_MODEL_REF = encodeModelRef('default');
/** The native model value, or undefined for Claude Code's own default. */
export function decodeModelRef(ref: HarnessModelRef): string | undefined {
  const { id } = harnessModelRefSchema.parse(ref);
  if (!id.startsWith(MODEL_REF_PREFIX)) throw new Error('Claude Code Model Ref belongs to another Adapter');
  const value = Buffer.from(id.slice(MODEL_REF_PREFIX.length), 'base64url').toString('utf8');
  if (!value || encodeModelRef(value).id !== id) throw new Error('Claude Code Model Ref is not canonical');
  return value === 'default' ? undefined : value;
}
export function modelCatalog(models: unknown): HarnessModelCatalog {
  if (!Array.isArray(models)) throw new Error('Claude Code Model catalog is not an array');
  const rows = new Map<string, z.infer<typeof modelInfo>>();
  for (const native of models) {
    const row = modelInfo.parse(native);
    const existing = rows.get(row.value);
    if (existing && JSON.stringify(existing) !== JSON.stringify(row)) throw new Error('Claude Code Model catalog contains conflicting selectable values');
    rows.set(row.value, row);
  }
  if (!rows.size) throw new Error('Claude Code Model catalog is empty');
  if (!rows.has('default')) rows.set('default', { value: 'default', displayName: 'Default' });
  const duplicated = new Set([...rows.values()].map(row => row.displayName).filter((name, index, all) => all.indexOf(name) !== index));
  const ids = THINKING_OPTIONS.map(option => option.id);
  const entries = [...rows.values()].map(row => ({
    ref: encodeModelRef(row.value),
    label: duplicated.has(row.displayName) ? `${row.displayName} (${row.value})`.slice(0, 256) : row.displayName,
    ...(row.resolvedModel ? { resolvedModelLabel: row.resolvedModel } : {}),
    supportedThinkingOptionIds: [...ids],
  })).sort((left, right) => left.ref.id === DEFAULT_MODEL_REF.id ? -1 : right.ref.id === DEFAULT_MODEL_REF.id ? 1
    : left.label.localeCompare(right.label) || left.ref.id.localeCompare(right.ref.id));
  return { models: entries, defaultModel: DEFAULT_MODEL_REF, thinkingOptions: [...THINKING_OPTIONS], defaultThinkingOptionId: DEFAULT_THINKING };
}

/** Native plan limits only; session cost is not account quota. */
export function accountSnapshot(usage: { rate_limits_available?: boolean; rate_limits?: unknown; subscription_type?: string | null }, email?: string): HarnessAccountSnapshot | null {
  if (!usage.rate_limits_available || !isRecord(usage.rate_limits)) return null;
  const limits = usage.rate_limits;
  const windows: Array<{ product: string; periodType: 'five_hour' | 'seven_day'; usagePercent: number; resetsAt?: string }> = [];
  const add = (product: string, periodType: 'five_hour' | 'seven_day', value: unknown) => {
    if (!isRecord(value) || typeof value.utilization !== 'number' || !Number.isFinite(value.utilization) || value.utilization < 0 || value.utilization > 100) return;
    windows.push({ product, periodType, usagePercent: value.utilization,
      ...(typeof value.resets_at === 'string' && Number.isFinite(Date.parse(value.resets_at)) ? { resetsAt: value.resets_at } : {}) });
  };
  add('5-hour window', 'five_hour', limits.five_hour);
  add('7-day window', 'seven_day', limits.seven_day);
  add('OAuth apps · 7-day', 'seven_day', limits.seven_day_oauth_apps);
  add('Opus · 7-day', 'seven_day', limits.seven_day_opus);
  add('Sonnet · 7-day', 'seven_day', limits.seven_day_sonnet);
  for (const window of Array.isArray(limits.model_scoped) ? limits.model_scoped : []) {
    if (isRecord(window) && typeof window.display_name === 'string') add(`${window.display_name} · 7-day`, 'seven_day', window);
  }
  const [primary, ...others] = windows;
  if (!primary) return null;
  const generic = primary.product === '5-hour window' || primary.product === '7-day window';
  return {
    ...(email ? { email } : {}), ...(usage.subscription_type ? { plan: usage.subscription_type } : {}),
    credits: {
      usedPercent: primary.usagePercent, periodType: primary.periodType, ...(!generic ? { label: primary.product } : {}),
      ...(primary.resetsAt ? { resetsAt: primary.resetsAt } : {}),
      ...(others.length ? { productUsage: others.map(({ product, usagePercent, resetsAt }) => ({ product, usagePercent, ...(resetsAt ? { resetsAt } : {}) })) } : {}),
    },
  };
}

// ── Interactions ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ClaudeQuestion { question: string; header: string; options: Array<{ label: string; description: string }>; multiSelect: boolean }
export type ClaudeInteractionRequest =
  | { type: 'approval'; requestId: string; title: string; description?: string; suggestedScope?: 'session' | 'always' }
  | { type: 'question'; requestId: string; questions: ClaudeQuestion[] }
  /** `plan` is the SDK-provided plan text; null means there is nothing reviewable to approve. */
  | { type: 'planApproval'; requestId: string; plan: string | null };

/** AskUserQuestion input, accepted only in the documented shape (1–4 questions, 2–4 distinct options). */
export function parseQuestions(input: Record<string, unknown>): ClaudeQuestion[] | null {
  if (!Array.isArray(input.questions) || input.questions.length < 1 || input.questions.length > 4) return null;
  const questions: ClaudeQuestion[] = [];
  for (const value of input.questions) {
    if (!isRecord(value) || typeof value.question !== 'string' || !value.question || questions.some(question => question.question === value.question)
      || typeof value.header !== 'string' || !value.header || typeof value.multiSelect !== 'boolean'
      || !Array.isArray(value.options) || value.options.length < 2 || value.options.length > 4) return null;
    const options: ClaudeQuestion['options'] = [];
    for (const option of value.options) {
      if (!isRecord(option) || typeof option.label !== 'string' || !option.label || options.some(known => known.label === option.label)
        || typeof option.description !== 'string') return null;
      options.push({ label: option.label, description: option.description });
    }
    questions.push({ question: value.question, header: value.header, options, multiSelect: value.multiSelect });
  }
  return questions;
}

const displayText = (value: unknown, max: number) => typeof value === 'string' && value.trim() && value.trim().length <= max ? value.trim() : null;
const SESSION_DESTINATIONS = new Set(['session', 'cliArg']);
const PERSISTENT_DESTINATIONS = new Set(['userSettings', 'projectSettings', 'localSettings']);
function suggestionIsValid(value: unknown): boolean {
  if (!isRecord(value) || !(SESSION_DESTINATIONS.has(String(value.destination)) || PERSISTENT_DESTINATIONS.has(String(value.destination)))) return false;
  if (value.type === 'setMode') return ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'].includes(String(value.mode));
  if (value.type === 'addDirectories' || value.type === 'removeDirectories') return Array.isArray(value.directories) && value.directories.every(entry => typeof entry === 'string');
  if (value.type === 'addRules' || value.type === 'replaceRules' || value.type === 'removeRules') {
    return ['allow', 'deny', 'ask'].includes(String(value.behavior)) && Array.isArray(value.rules)
      && value.rules.every(rule => isRecord(rule) && typeof rule.toolName === 'string' && (rule.ruleContent === undefined || typeof rule.ruleContent === 'string'));
  }
  return false;
}
/** The widest scope Claude Code suggests remembering an approval for; undefined when its suggestions are not all well-formed. */
export function suggestionScope(suggestions: unknown): 'session' | 'always' | undefined {
  if (!Array.isArray(suggestions) || !suggestions.length || !suggestions.every(suggestionIsValid)) return undefined;
  return suggestions.some(suggestion => PERSISTENT_DESTINATIONS.has(String((suggestion as Record<string, unknown>).destination))) ? 'always' : 'session';
}
export function approvalRequest(requestId: string, toolName: string, options: { title?: unknown; displayName?: unknown; description?: unknown; suggestions?: unknown }): ClaudeInteractionRequest | null {
  const title = [options.title, options.displayName, options.description, toolName].map(value => displayText(value, 120)).find(Boolean);
  if (!title) return null;
  const description = displayText(options.description, 500);
  const scope = suggestionScope(options.suggestions);
  return { type: 'approval', requestId, title, ...(description && description !== title ? { description } : {}), ...(scope ? { suggestedScope: scope } : {}) };
}

// ── File changes and tasks ──────────────────────────────────────────────────────────────────────────────────────────

const hunkSchema = z.object({ oldStart: z.number().int().nonnegative(), oldLines: z.number().int().nonnegative(), newStart: z.number().int().nonnegative(), newLines: z.number().int().nonnegative(), lines: z.array(z.string()) }).strict();
type Hunk = z.infer<typeof hunkSchema>;
export interface ClaudeFileChange { path: string; kind: 'add' | 'update'; hunks: Hunk[] }
const validPath = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && !/[\0\n\r]/u.test(value);
/** Edit/Write structured patches, accepted only when every hunk's line counts agree with its body. */
export function parseFileChange(toolName: string, value: unknown): ClaudeFileChange | null {
  if ((toolName !== 'Edit' && toolName !== 'Write') || !isRecord(value) || !validPath(value.filePath) || !Array.isArray(value.structuredPatch) || !value.structuredPatch.length) return null;
  if (toolName === 'Write' && value.type !== 'create' && value.type !== 'update') return null;
  const hunks: Hunk[] = [];
  for (const raw of value.structuredPatch) {
    const parsed = hunkSchema.safeParse(raw);
    if (!parsed.success) return null;
    const { lines } = parsed.data;
    const count = (prefixes: string) => lines.filter(line => prefixes.includes(line[0]!)).length;
    if (lines.some(line => !line || !' +-\\'.includes(line[0]!)) || count(' -') !== parsed.data.oldLines || count(' +') !== parsed.data.newLines) return null;
    hunks.push(parsed.data);
  }
  return { path: value.filePath, kind: toolName === 'Write' && value.type === 'create' ? 'add' : 'update', hunks };
}
/** A unified diff with paths relative to cwd when the file lies inside it. */
export function projectFileChange(change: ClaudeFileChange, cwd: string): HostFileChange | null {
  const absolute = path.resolve(cwd, change.path);
  const relative = path.relative(path.resolve(cwd), absolute);
  const shown = (relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) ? relative : absolute).replaceAll('\\', '/');
  if (!validPath(shown) || shown === '.') return null;
  const rooted = path.posix.isAbsolute(shown);
  const body = change.hunks.flatMap(hunk => [`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`, ...hunk.lines]);
  const oldHeader = change.kind === 'add' ? '/dev/null' : rooted ? shown : `a/${shown}`;
  return { path: shown, kind: change.kind, unifiedDiff: [`--- ${oldHeader}`, `+++ ${rooted ? shown : `b/${shown}`}`, ...body, ''].join('\n') };
}

export const isTaskTool = (name: string) => name === 'TaskCreate' || name === 'TaskUpdate' || name === 'TaskList';
const taskStatuses = ['pending', 'in_progress', 'completed', 'deleted'] as const;
const field = (value: unknown, keys: string[]) => {
  if (!isRecord(value)) return undefined;
  for (const key of keys) if (typeof value[key] === 'string' && value[key]) return value[key] as string;
  return undefined;
};
/** Folds Claude's TaskCreate/TaskUpdate/TaskList calls into the todo list shown for the session. */
export class TaskTracker {
  readonly #tasks = new Map<string, { id: string; subject: string; status: 'pending' | 'in_progress' | 'completed' }>();
  apply(toolName: string, args: JsonValue, result: JsonValue | undefined): JsonValue | null {
    if (toolName === 'TaskCreate') {
      const id = isRecord(result) ? field(result.task, ['id']) : undefined;
      const subject = field(args, ['subject']) ?? (isRecord(result) ? field(result.task, ['subject']) : undefined);
      if (id && subject) this.#tasks.set(id, { id, subject, status: 'pending' });
    } else if (toolName === 'TaskUpdate') {
      const id = field(args, ['taskId', 'id', 'task_id']);
      const status = isRecord(args) ? taskStatuses.find(value => value === args.status) : undefined;
      const existing = id ? this.#tasks.get(id) : undefined;
      const subject = field(args, ['subject']) ?? existing?.subject;
      if (id && status === 'deleted') this.#tasks.delete(id);
      else if (id && subject && status !== 'deleted') this.#tasks.set(id, { id, subject, status: status ?? existing?.status ?? 'pending' });
    } else if (toolName === 'TaskList') {
      if (isRecord(result) && Array.isArray(result.tasks)) {
        this.#tasks.clear();
        for (const task of result.tasks) {
          const id = field(task, ['id']), subject = field(task, ['subject']);
          const status = isRecord(task) ? taskStatuses.find(value => value === task.status) : undefined;
          if (id && subject && status && status !== 'deleted') this.#tasks.set(id, { id, subject, status });
        }
      }
    } else return null;
    return { todos: [...this.#tasks.values()].map(({ id, subject, status }) => ({ id, content: subject, status })) };
  }
}

// ── Turn accumulator ────────────────────────────────────────────────────────────────────────────────────────────────

/** Token counts of one native API request. */
export interface ClaudeRequestUsage { model?: string; inputTokens: number; outputTokens: number; cacheCreationInputTokens: number; cacheReadInputTokens: number }
/** Claude Code's `modelUsage`, cumulative for the native process and summed over models. */
export interface ClaudeProcessUsage { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number; contextWindows: Record<string, number> }
export type SubagentStatus = 'pending' | 'running' | 'completed' | 'failed' | 'interrupted';
export type ClaudeFailureKind = 'authentication' | 'cancellationUnproven' | 'native' | 'protocol' | 'textConflict';
export type ClaudeTurnResult = { status: 'succeeded' } | { status: 'cancelled'; reason: string } | { status: 'failed'; kind: ClaudeFailureKind };
export type ClaudeTurnEvent =
  | { type: 'segment.started' }
  | { type: 'subagents.live'; nativeSubagentIds: string[] }
  | { type: 'compaction.started' }
  | { type: 'compaction.completed'; outcome: 'succeeded' | 'failed' }
  | { type: 'text.delta'; messageId: string; delta: string }
  | { type: 'reasoning.delta'; messageId: string; delta: string }
  | { type: 'reasoning.completed'; messageId: string }
  | { type: 'message.completed'; messageId: string; requestUsage?: ClaudeRequestUsage }
  | { type: 'tool.started'; callId: string; toolName: string; arguments: JsonValue }
  | { type: 'tool.progress'; callId: string; elapsedMs: number }
  | { type: 'tool.completed'; callId: string; toolName: string; outputText?: string; structuredResult?: JsonValue; isError: boolean; fileChange?: ClaudeFileChange }
  | { type: 'subagent.started'; callId: string; operation: 'spawn' | 'send'; description: string; prompt?: string; role?: string; background: boolean; nativeSubagentId?: string }
  | { type: 'subagent.updated'; callId: string; status: SubagentStatus; description?: string; role?: string; nativeSubagentId?: string; resultSummary?: string }
  | { type: 'subagent.completed'; callId: string; isError: boolean; continuesInBackground?: boolean; nativeSubagentId?: string; resultSummary?: string }
  | { type: 'subagent.settled'; nativeSubagentId: string; callId?: string; status: 'completed' | 'failed' | 'interrupted'; resultSummary?: string }
  | { type: 'usage.result'; processUsage: ClaudeProcessUsage };

const ABORTED_TERMINALS = new Set(['aborted_streaming', 'aborted_tools']);
const SUBAGENT_TOOLS = new Set(['Agent', 'Task', 'SendMessage']);
const DESCRIPTION_LIMIT = 500;
const SUMMARY_LIMIT = 2_000;

function nativeTaskStatus(value: unknown): SubagentStatus | null {
  if (value === 'killed' || value === 'stopped') return 'interrupted';
  return value === 'pending' || value === 'running' || value === 'completed' || value === 'failed' ? value : null;
}
const settledStatus = (status: SubagentStatus | null): status is 'completed' | 'failed' | 'interrupted' =>
  status === 'completed' || status === 'failed' || status === 'interrupted';
const blockText = (content: unknown): string => typeof content === 'string' ? content
  : Array.isArray(content) ? content.flatMap(block => isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('') : '';

function requestUsage(message: Record<string, unknown>): ClaudeRequestUsage | undefined {
  const inner = isRecord(message.message) ? message.message : undefined;
  const usage = inner?.usage;
  if (!isRecord(usage) || !safeCount(usage.input_tokens) || !safeCount(usage.output_tokens)
    || !safeCount(usage.cache_creation_input_tokens) || !safeCount(usage.cache_read_input_tokens)) return undefined;
  const model = bounded(inner?.model, DESCRIPTION_LIMIT);
  return { ...(model ? { model } : {}), inputTokens: usage.input_tokens, outputTokens: usage.output_tokens,
    cacheCreationInputTokens: usage.cache_creation_input_tokens, cacheReadInputTokens: usage.cache_read_input_tokens };
}
export function processUsage(value: unknown): ClaudeProcessUsage | undefined {
  if (!isRecord(value)) return undefined;
  const total: ClaudeProcessUsage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, contextWindows: {} };
  for (const [model, entry] of Object.entries(value)) {
    if (!isRecord(entry) || !safeCount(entry.inputTokens) || !safeCount(entry.outputTokens)) return undefined;
    total.inputTokens += entry.inputTokens;
    total.outputTokens += entry.outputTokens;
    total.cacheReadInputTokens += safeCount(entry.cacheReadInputTokens) ? entry.cacheReadInputTokens : 0;
    total.cacheCreationInputTokens += safeCount(entry.cacheCreationInputTokens) ? entry.cacheCreationInputTokens : 0;
    if (safeCount(entry.contextWindow) && entry.contextWindow > 0) total.contextWindows[model] = entry.contextWindow;
  }
  return total;
}

/** A queued `<task-notification>` user message reporting that a background task stopped. */
function taskNotification(message: Record<string, unknown>): Extract<ClaudeTurnEvent, { type: 'subagent.settled' }> | null {
  if (message.type !== 'user' || !isRecord(message.message)) return null;
  if (isRecord(message.origin) && message.origin.kind !== 'task-notification') return null;
  const content = blockText(message.message.content);
  if (!content.includes('<task-notification>')) return null;
  const tag = (name: string) => content.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'u'))?.[1]?.trim();
  const taskId = tag('task-id');
  const status = nativeTaskStatus(tag('status') ?? 'completed');
  if (!taskId || !settledStatus(status)) return null;
  const callId = tag('tool-use-id'), summary = tag('summary');
  return { type: 'subagent.settled', nativeSubagentId: taskId, status, ...(callId ? { callId } : {}), ...(summary ? { resultSummary: summary.slice(0, SUMMARY_LIMIT) } : {}) };
}

/**
 * Interprets the SDK message stream of one native turn. Inconsistent streams (tool lifecycles, text that disagrees with
 * its deltas) fail the turn instead of being guessed at.
 */
export class TurnAccumulator {
  #streamMessageId: string | null = null;
  #errors: string[] = [];
  #cancelRequested = false;
  #compaction: 'idle' | 'active' | 'settled' = 'idle';
  #completed = false;
  #completedTools = new Set<string>();
  #ordinal = 0;
  #messages = new Map<string, { completed: boolean; reasoning: string; text: string; usagePublished: boolean }>();
  #protocolConflict = false;
  #textConflict = false;
  #tools = new Map<string, { name: string; subagent: boolean }>();

  requestCancel(): void { this.#cancelRequested = true; }

  consume(message: unknown): { events: ClaudeTurnEvent[]; terminal?: ClaudeTurnResult } {
    if (this.#completed || !isRecord(message)) return { events: [] };
    const events: ClaudeTurnEvent[] = [];
    const nested = typeof message.parent_tool_use_id === 'string' && message.parent_tool_use_id.length > 0;
    if (message.type === 'system') {
      this.#system(message, events, nested);
      if (!nested) this.#compactionStatus(message, events);
    }
    if (message.type === 'stream_event' && isRecord(message.event) && !nested) this.#stream(message, events);
    if (message.type === 'tool_progress') this.#toolProgress(message, events);
    if (message.type === 'assistant' && !nested) {
      if (typeof message.error === 'string') this.#errors.push(message.error);
      this.#assistant(message, events);
    }
    if (message.type === 'user') {
      const settled = taskNotification(message);
      if (settled) events.push(settled);
      this.#toolResults(message, events, nested);
    }
    if (message.type !== 'result') return { events };

    const usage = processUsage(message.modelUsage);
    if (usage) events.push({ type: 'usage.result', processUsage: usage });
    this.#completed = true;
    const terminalReason = typeof message.terminal_reason === 'string' ? message.terminal_reason : 'missing';
    const success = message.subtype === 'success' && message.is_error === false
      && (terminalReason === 'completed' || terminalReason === 'missing') && !this.#errors.length;
    if (success && this.#tools.size) this.#protocolConflict = true;
    const text = [message.result, ...(Array.isArray(message.errors) ? message.errors : [])].filter(value => typeof value === 'string').join(' ').toLowerCase();
    const authentication = this.#errors.some(error => error === 'authentication_failed' || error === 'oauth_org_not_allowed')
      || text.includes('not logged in') || text.includes('invalid api key') || text.includes('oauth');
    const terminal: ClaudeTurnResult = this.#protocolConflict ? { status: 'failed', kind: 'protocol' }
      : this.#textConflict ? { status: 'failed', kind: 'textConflict' }
        : authentication ? { status: 'failed', kind: 'authentication' }
          : this.#cancelRequested ? ABORTED_TERMINALS.has(terminalReason) ? { status: 'cancelled', reason: terminalReason } : { status: 'failed', kind: 'cancellationUnproven' }
            : success ? { status: 'succeeded' } : { status: 'failed', kind: 'native' };
    return { events, terminal };
  }

  #system(message: Record<string, unknown>, events: ClaudeTurnEvent[], nested: boolean): void {
    if (message.subtype === 'init') { events.push({ type: 'segment.started' }); return; }
    if (message.subtype === 'background_tasks_changed' && Array.isArray(message.tasks)) {
      events.push({ type: 'subagents.live', nativeSubagentIds: message.tasks.flatMap(task => isRecord(task) && bounded(task.task_id, DESCRIPTION_LIMIT) ? [bounded(task.task_id, DESCRIPTION_LIMIT)!] : []) });
      return;
    }
    if (message.subtype === 'local_command_output') {
      if (nested || typeof message.content !== 'string' || !message.content) return;
      const messageId = typeof message.uuid === 'string' && message.uuid ? message.uuid : this.#nextId();
      const state = this.#state(messageId);
      if (state.completed) return;
      state.text += message.content;
      state.completed = true;
      events.push({ type: 'text.delta', messageId, delta: message.content }, { type: 'message.completed', messageId });
      return;
    }
    const taskId = bounded(message.task_id, DESCRIPTION_LIMIT);
    if (message.subtype === 'task_notification') {
      const status = nativeTaskStatus(message.status);
      const callId = bounded(message.tool_use_id, DESCRIPTION_LIMIT), summary = bounded(message.summary, SUMMARY_LIMIT);
      if (taskId && settledStatus(status)) events.push({ type: 'subagent.settled', nativeSubagentId: taskId, status, ...(callId ? { callId } : {}), ...(summary ? { resultSummary: summary } : {}) });
      return;
    }
    const callId = typeof message.tool_use_id === 'string' ? message.tool_use_id : null;
    if (!callId || !this.#tools.get(callId)?.subagent) return;
    const description = bounded(isRecord(message.patch) ? message.patch.description : message.description, DESCRIPTION_LIMIT);
    const common = { type: 'subagent.updated' as const, callId, ...(description ? { description } : {}), ...(taskId ? { nativeSubagentId: taskId } : {}) };
    const role = bounded(message.subagent_type, DESCRIPTION_LIMIT);
    if (message.subtype === 'task_started') events.push({ ...common, status: 'running', ...(role ? { role } : {}) });
    else if (message.subtype === 'task_progress') {
      const summary = bounded(message.summary, SUMMARY_LIMIT);
      events.push({ ...common, status: 'running', ...(role ? { role } : {}), ...(summary ? { resultSummary: summary } : {}) });
    } else if (message.subtype === 'task_updated' && isRecord(message.patch)) {
      const status = nativeTaskStatus(message.patch.status), error = bounded(message.patch.error, SUMMARY_LIMIT);
      if (status) events.push({ ...common, status, ...(error ? { resultSummary: error } : {}) });
    }
  }

  #compactionStatus(message: Record<string, unknown>, events: ClaudeTurnEvent[]): void {
    const settle = (outcome: 'succeeded' | 'failed') => {
      if (this.#compaction === 'settled') return;
      if (this.#compaction === 'idle') events.push({ type: 'compaction.started' });
      this.#compaction = 'settled';
      events.push({ type: 'compaction.completed', outcome });
    };
    if (message.subtype === 'status') {
      if (message.status === 'compacting' && this.#compaction === 'idle') { this.#compaction = 'active'; events.push({ type: 'compaction.started' }); }
      if (message.compact_result === 'success' || message.compact_result === 'failed') settle(message.compact_result === 'success' ? 'succeeded' : 'failed');
    } else if (message.subtype === 'compact_boundary') settle('succeeded');
  }

  #stream(message: Record<string, unknown>, events: ClaudeTurnEvent[]): void {
    const event = message.event as Record<string, unknown>;
    if (event.type === 'message_start' && isRecord(event.message) && typeof event.message.id === 'string' && event.message.id) {
      this.#streamMessageId = event.message.id;
      this.#state(event.message.id);
      return;
    }
    if (event.type !== 'content_block_delta' || !isRecord(event.delta)) return;
    const messageId = this.#streamMessageId ??= typeof message.uuid === 'string' && message.uuid ? message.uuid : this.#nextId();
    const state = this.#state(messageId);
    if (state.completed) { if (event.delta.type === 'text_delta') this.#textConflict = true; return; }
    if (event.delta.type === 'text_delta' && typeof event.delta.text === 'string' && event.delta.text) {
      state.text += event.delta.text;
      events.push({ type: 'text.delta', messageId, delta: event.delta.text });
    } else if (event.delta.type === 'thinking_delta' && typeof event.delta.thinking === 'string' && event.delta.thinking) {
      state.reasoning += event.delta.thinking;
      events.push({ type: 'reasoning.delta', messageId, delta: event.delta.thinking });
    }
  }

  #assistant(message: Record<string, unknown>, events: ClaudeTurnEvent[]): void {
    const inner = isRecord(message.message) ? message.message : {};
    const messageId = this.#streamMessageId ?? (typeof inner.id === 'string' && inner.id ? inner.id : undefined)
      ?? (typeof message.uuid === 'string' && message.uuid ? message.uuid : this.#nextId());
    const state = this.#state(messageId);
    const usage = requestUsage(message);
    if (state.completed) {
      // A multi-block response repeats the message per block; only new tool calls and the first usage matter.
      this.#toolUses(inner.content, events, true);
      if (usage && !state.usagePublished) { state.usagePublished = true; events.push({ type: 'message.completed', messageId, requestUsage: usage }); }
      return;
    }
    if (state.reasoning) events.push({ type: 'reasoning.completed', messageId });
    const complete = Array.isArray(inner.content) ? blockText(inner.content) : '';
    if (complete.startsWith(state.text)) {
      const suffix = complete.slice(state.text.length);
      if (suffix) { state.text += suffix; events.push({ type: 'text.delta', messageId, delta: suffix }); }
    } else if (complete) this.#textConflict = true;
    this.#toolUses(inner.content, events, false);
    if (!this.#protocolConflict && !this.#textConflict) {
      state.usagePublished = usage !== undefined;
      events.push({ type: 'message.completed', messageId, ...(usage ? { requestUsage: usage } : {}) });
    }
    state.completed = true;
    if (this.#streamMessageId === messageId) this.#streamMessageId = null;
  }

  #toolUses(content: unknown, events: ClaudeTurnEvent[], ignoreKnown: boolean): void {
    for (const block of Array.isArray(content) ? content : []) {
      if (!isRecord(block) || block.type !== 'tool_use') continue;
      const args = jsonValue.safeParse(block.input);
      if (typeof block.id !== 'string' || !block.id || typeof block.name !== 'string' || !block.name || !args.success) { this.#protocolConflict = true; continue; }
      if (this.#tools.has(block.id) || this.#completedTools.has(block.id)) { if (!ignoreKnown) this.#protocolConflict = true; continue; }
      const subagent = SUBAGENT_TOOLS.has(block.name);
      this.#tools.set(block.id, { name: block.name, subagent });
      if (!subagent) { events.push({ type: 'tool.started', callId: block.id, toolName: block.name, arguments: args.data }); continue; }
      const input = isRecord(args.data) ? args.data : {};
      const prompt = bounded(input.prompt ?? input.message, SUMMARY_LIMIT), role = bounded(input.subagent_type ?? input.agent_type, DESCRIPTION_LIMIT);
      const target = bounded(input.to ?? input.recipient ?? input.agentId, DESCRIPTION_LIMIT);
      events.push({
        type: 'subagent.started', callId: block.id, operation: block.name === 'SendMessage' ? 'send' : 'spawn',
        description: bounded(input.description, DESCRIPTION_LIMIT) ?? bounded(input.summary, DESCRIPTION_LIMIT) ?? bounded(input.name, DESCRIPTION_LIMIT) ?? `${block.name} delegation`,
        ...(prompt ? { prompt } : {}), ...(role ? { role } : {}),
        background: block.name === 'SendMessage' || input.run_in_background === true, ...(target ? { nativeSubagentId: target } : {}),
      });
    }
  }

  #toolProgress(message: Record<string, unknown>, events: ClaudeTurnEvent[]): void {
    const { tool_use_id: callId, elapsed_time_seconds: seconds } = message;
    if (typeof callId !== 'string' || this.#tools.get(callId)?.subagent !== false || typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return;
    events.push({ type: 'tool.progress', callId, elapsedMs: Math.round(seconds * 1_000) });
  }

  #toolResults(message: Record<string, unknown>, events: ClaudeTurnEvent[], ignoreUnknown: boolean): void {
    if (!isRecord(message.message) || !Array.isArray(message.message.content)) return;
    const blocks = message.message.content.filter((block): block is Record<string, unknown> => isRecord(block) && block.type === 'tool_result');
    if (blocks.length > 1 && message.tool_use_result !== undefined) this.#protocolConflict = true;
    for (const block of blocks) {
      const callId = block.tool_use_id;
      if (typeof callId !== 'string' || !callId) { this.#protocolConflict = true; continue; }
      const tool = this.#tools.get(callId);
      if (!tool || this.#completedTools.has(callId)) { if (!ignoreUnknown) this.#protocolConflict = true; continue; }
      if (block.is_error !== undefined && typeof block.is_error !== 'boolean') { this.#protocolConflict = true; continue; }
      this.#tools.delete(callId);
      this.#completedTools.add(callId);
      const isError = block.is_error === true;
      const native = blocks.length === 1 ? message.tool_use_result ?? message.toolUseResult : undefined;
      const stdio = isRecord(native) ? `${typeof native.stdout === 'string' ? native.stdout : ''}${typeof native.stderr === 'string' ? native.stderr : ''}` : '';
      const outputText = blockText(block.content) || stdio || undefined;
      if (tool.subagent) {
        const agentId = bounded(isRecord(native) ? native.agentId ?? native.agent_id ?? native.task_id : undefined, DESCRIPTION_LIMIT)
          ?? bounded(/agentId:\s*([A-Za-z0-9_-]+)/u.exec(outputText ?? '')?.[1], DESCRIPTION_LIMIT);
        const background = (isRecord(native) && (native.isAsync === true || native.is_async === true || native.status === 'async_launched'))
          || (outputText?.includes('The agent is working in the background.') ?? false);
        const summary = bounded(outputText, SUMMARY_LIMIT);
        events.push({ type: 'subagent.completed', callId, isError, ...(background ? { continuesInBackground: true } : {}),
          ...(agentId ? { nativeSubagentId: agentId } : {}), ...(summary ? { resultSummary: summary } : {}) });
        continue;
      }
      const structured = isTaskTool(tool.name) ? jsonValue.safeParse(native) : null;
      const fileChange = isError ? null : parseFileChange(tool.name, native);
      events.push({ type: 'tool.completed', callId, toolName: tool.name, isError, ...(outputText ? { outputText } : {}),
        ...(structured?.success ? { structuredResult: structured.data } : {}), ...(fileChange ? { fileChange } : {}) });
    }
  }

  #state(messageId: string) {
    let state = this.#messages.get(messageId);
    if (!state) this.#messages.set(messageId, state = { completed: false, reasoning: '', text: '', usagePublished: false });
    return state;
  }
  #nextId(): string { return `claude-assistant-${++this.#ordinal}`; }
}
