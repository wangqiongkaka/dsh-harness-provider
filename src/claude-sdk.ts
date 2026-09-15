/** Claude Code processes: executable discovery, environment, and the Agent SDK query each native session runs on. */
import { execFile, spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { query, type CanUseTool, type PermissionResult, type PermissionUpdate, type Query, type SDKUserMessage, type SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import pkg from '../package.json' with { type: 'json' };
import type { HarnessThinkingOptionId } from './contracts.js';
import {
  approvalRequest, isPermissionMode, parseQuestions, thinkingConfiguration, TurnAccumulator,
  type ClaudeInteractionRequest, type ClaudePermissionMode, type ClaudeTurnEvent, type ClaudeTurnResult,
} from './claude-native.js';

export const CLAUDE_COMMAND_ENV = 'CODEXHOST_CLAUDE_COMMAND';
const CLIENT_APP = `${pkg.name}/${pkg.version}`;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

// ── Executable and environment ──────────────────────────────────────────────────────────────────────────────────────

export class ClaudeNotInstalledError extends Error {}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch { return false; }
}
function subdirectories(directory: string): string[] {
  try { return fs.readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name); } catch { return []; }
}
const newestFirst = (names: string[]) => [...names].sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
function envValue(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  return Object.entries(environment).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

/** Where Node.js version managers keep global binaries: a Claude Code installed under an inactive runtime is not on PATH. */
function versionManagerDirectories(environment: NodeJS.ProcessEnv, home: string): string[] {
  const directories: string[] = [];
  const versioned = (root: string, ...tail: string[]) => { for (const version of newestFirst(subdirectories(root))) directories.push(path.join(root, version, ...tail)); };
  const value = (name: string) => envValue(environment, name);
  if (process.platform === 'win32') {
    const appData = value('APPDATA') ?? path.join(home, 'AppData', 'Roaming');
    const localAppData = value('LOCALAPPDATA') ?? path.join(home, 'AppData', 'Local');
    versioned(path.join(appData, 'nvm'));
    versioned(value('FNM_DIR') ?? path.join(appData, 'fnm', 'node-versions'), 'installation');
    directories.push(path.join(localAppData, 'Volta', 'bin'), path.join(home, '.bun', 'bin'), ...(value('PNPM_HOME') ? [value('PNPM_HOME')!] : []), path.join(localAppData, 'pnpm'));
    return directories;
  }
  versioned(path.join(value('NVM_DIR') ?? path.join(home, '.nvm'), 'versions', 'node'), 'bin');
  for (const root of [value('FNM_DIR'), path.join(home, '.local', 'share', 'fnm'), path.join(home, 'Library', 'Application Support', 'fnm')]) {
    if (root) versioned(path.join(root, 'node-versions'), 'installation', 'bin');
  }
  const volta = value('VOLTA_HOME') ?? path.join(home, '.volta');
  versioned(path.join(volta, 'tools', 'image', 'node'), 'bin');
  directories.push(path.join(volta, 'bin'));
  const asdf = value('ASDF_DATA_DIR') ?? path.join(home, '.asdf');
  versioned(path.join(asdf, 'installs', 'nodejs'), 'bin');
  directories.push(path.join(asdf, 'shims'));
  const nodenv = value('NODENV_ROOT') ?? path.join(home, '.nodenv');
  versioned(path.join(nodenv, 'versions'), 'bin');
  directories.push(path.join(nodenv, 'shims'));
  versioned(path.join(value('N_PREFIX') ?? '/usr/local', 'n', 'versions', 'node'), 'bin');
  directories.push(path.join(home, '.bun', 'bin'), ...(value('PNPM_HOME') ? [value('PNPM_HOME')!] : []), path.join(home, 'Library', 'pnpm'), path.join(home, '.local', 'share', 'pnpm'));
  for (const prefix of ['/opt/homebrew/opt', '/usr/local/opt']) {
    for (const formula of newestFirst(subdirectories(prefix).filter(name => name.startsWith('node@')))) directories.push(path.join(prefix, formula, 'bin'));
  }
  return directories;
}

/**
 * The configured command (CODEXHOST_CLAUDE_COMMAND) when set, searched only on PATH if it is a bare name; otherwise
 * `claude` on PATH, then the usual install locations. A configured command never falls back to another installation.
 */
export function resolveClaudeExecutable(environment: NodeJS.ProcessEnv, command?: string): string {
  const configured = command ?? envValue(environment, CLAUDE_COMMAND_ENV);
  const name = configured ?? 'claude';
  const windows = process.platform === 'win32';
  const candidates: string[] = [];
  if (path.isAbsolute(name) || name.includes('/') || name.includes('\\')) candidates.push(name);
  else {
    const extensions = !windows || path.extname(name) ? [''] : (envValue(environment, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
    for (const directory of (envValue(environment, 'PATH') ?? '').split(path.delimiter).map(entry => entry.trim().replace(/^"|"$/gu, '')).filter(Boolean)) {
      for (const extension of extensions) candidates.push(path.join(directory, name + extension));
    }
    if (configured === undefined) {
      const home = envValue(environment, 'HOME') ?? envValue(environment, 'USERPROFILE') ?? os.homedir();
      const appData = envValue(environment, 'APPDATA') ?? path.join(home, 'AppData', 'Roaming');
      const roots = windows
        ? [path.join(appData, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin'), path.join(appData, 'npm'), path.join(home, '.local', 'bin'), ...versionManagerDirectories(environment, home)]
        : [path.join(home, '.npm-global', 'bin'), path.join(home, '.local', 'bin'), path.join(home, '.claude', 'local'), ...versionManagerDirectories(environment, home), '/opt/homebrew/bin', '/usr/local/bin'];
      for (const root of roots) for (const extension of windows ? ['.exe', '.cmd'] : ['']) candidates.push(path.join(root, 'claude' + extension));
    }
  }
  for (const candidate of candidates) {
    // The npm .cmd shim spawns an extra cmd.exe and loses signals; prefer the native binary beside it.
    const runnable = windows && path.basename(candidate).toLowerCase() === 'claude.cmd'
      ? path.join(path.dirname(candidate), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe') : candidate;
    if (isExecutable(runnable)) return path.resolve(runnable);
  }
  throw new ClaudeNotInstalledError('Claude Code is not installed');
}

/** A `#!/usr/bin/env node` entrypoint needs `node` on PATH, which a GUI-launched host rarely has. */
function withNodeOnPath(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const key = Object.keys(environment).find(name => name.toLowerCase() === 'path') ?? 'PATH';
  const directories = (environment[key] ?? '').split(path.delimiter).filter(Boolean);
  const runtime = path.dirname(process.execPath);
  const same = (entry: string) => process.platform === 'win32' ? entry.toLowerCase() === runtime.toLowerCase() : entry === runtime;
  return { ...environment, [key]: (directories.some(same) ? directories : [runtime, ...directories]).join(path.delimiter) };
}

const SHELL_MARKER = Buffer.from('\0DSH_HARNESS_SHELL_ENV_V1\0');
const shellCache = new Map<string, Readonly<Record<string, string>>>();
/**
 * GUI-launched hosts do not load the user's shell init files; capture them once so Claude Code sees the same
 * environment as in a terminal. Existing variables win; the snapshot is never persisted or logged.
 */
export function withUserShellEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (process.platform === 'win32' || !environment.HOME) return environment;
  const shell = environment.SHELL?.trim() || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
  if (!['bash', 'fish', 'zsh'].includes(path.basename(shell))) return environment;
  const key = `${shell}\0${environment.HOME}`;
  let loaded = shellCache.get(key);
  if (!loaded) {
    try {
      const result = spawnSync(shell, ['-ilc', `printf '\\0DSH_HARNESS_SHELL_ENV_V1\\0'; /usr/bin/env -0`], {
        env: environment, encoding: 'buffer', maxBuffer: 2 * 1024 * 1024, timeout: 3_000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
        // An interactive shell with a controlling terminal takes over the terminal's foreground process group and leaves it
        // pointing at a dead group when it exits, after which Ctrl+C never reaches DSH. Without a terminal it cannot.
        // Undocumented for spawnSync, but honoured by Node's shared spawn path (setsid).
        detached: true,
      } as Parameters<typeof spawnSync>[2] & { encoding: 'buffer' });
      const marker = result.status === 0 ? result.stdout.indexOf(SHELL_MARKER) : -1;
      if (marker < 0) return environment;
      const parsed: Record<string, string> = {};
      for (const entry of result.stdout.subarray(marker + SHELL_MARKER.length).toString().split('\0')) {
        const separator = entry.indexOf('=');
        if (separator > 0) parsed[entry.slice(0, separator)] = entry.slice(separator + 1);
      }
      shellCache.set(key, loaded = parsed);
    } catch { return environment; }
  }
  const merged = { ...environment };
  for (const [name, value] of Object.entries(loaded)) merged[name] ??= value;
  return merged;
}

/** Stops the process group the SDK spawn hook created, including the native CLI and MCP children behind a wrapper. */
async function closeProcessGroup(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Claude process tree cannot be confirmed after its Windows root exited');
    const root = process.env.SystemRoot ?? process.env.SYSTEMROOT;
    if (!root || !path.win32.isAbsolute(root)) throw new Error('Windows SystemRoot is unavailable');
    await promisify(execFile)(path.win32.join(root, 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { timeout: timeoutMs, windowsHide: true });
    return;
  }
  const signal = (value: NodeJS.Signals | 0) => {
    try { process.kill(-pid, value); return true; } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') return false;
      if (value === 0 && code === 'EPERM') return true; // macOS reports EPERM for a group that is still exiting
      throw error;
    }
  };
  for (const stop of ['SIGTERM', 'SIGKILL'] as const) {
    if (!signal(stop)) return;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) { if (!signal(0)) return; await sleep(10); }
  }
  throw new Error('Claude SDK process group did not exit');
}

function timeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]).finally(() => clearTimeout(timer));
}

class PushableInput<T> implements AsyncIterable<T> {
  #closed = false;
  readonly #queue: T[] = [];
  readonly #waiters: Array<(result: IteratorResult<T>) => void> = [];
  push(value: T): void {
    if (this.#closed) throw new Error('Claude SDK input is closed');
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ done: false, value }); else this.#queue.push(value);
  }
  end(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return { next: () => this.#queue.length ? Promise.resolve({ done: false, value: this.#queue.shift()! })
      : this.#closed ? Promise.resolve({ done: true, value: undefined }) : new Promise(resolve => this.#waiters.push(resolve)) };
  }
}

// ── Transport ───────────────────────────────────────────────────────────────────────────────────────────────────────

export type TransportEvent = ClaudeTurnEvent
  | { type: 'interaction.requested'; request: ClaudeInteractionRequest }
  | { type: 'interaction.closed'; requestId: string };
export type ClaudeInteractionResponse =
  | { type: 'approval'; requestId: string; decision: 'allowOnce' | 'allowForSession' | 'allowAlways' | 'deny' }
  | { type: 'question'; requestId: string; answers: Record<string, string> }
  | { type: 'question'; requestId: string; cancelled: true };

export type QueryFactory = typeof query;
export interface ClaudeTransportOptions {
  command?: string;
  environment: NodeJS.ProcessEnv;
  cwd: string;
  sessionId: string;
  openMode: 'create' | 'resume';
  model?: string;
  thinkingOptionId: HarnessThinkingOptionId;
  permissionMode: ClaudePermissionMode;
  closeTimeoutMs: number;
  abortTimeoutMs: number;
  onPermissionModeChanged(mode: ClaudePermissionMode): void;
  onFault(error: unknown): void;
  /** Output produced while no user turn is active: continuations of background subagents. */
  onIdleEvent(event: ClaudeTurnEvent): void;
  onIdleTerminal(result: ClaudeTurnResult): void;
  queryFactory?: QueryFactory;
}

interface PendingInteraction {
  request: ClaudeInteractionRequest; controlRequestId: string; toolUseId: string; input: Record<string, unknown>;
  suggestions?: PermissionUpdate[]; signal: AbortSignal; onAbort(): void; resolve(result: PermissionResult): void;
}
interface ActiveTurn {
  accumulator: TurnAccumulator; interactions: Map<string, PendingInteraction>; controlRequestIds: Set<string>;
  onEvent(event: TransportEvent): void; resolve(result: ClaudeTurnResult): void; reject(error: unknown): void;
}

const denied = (toolUseId: string, message: string): PermissionResult => ({ behavior: 'deny', message, toolUseID: toolUseId, decisionClassification: 'user_reject' });
const allowed = (toolUseId: string, input: Record<string, unknown>, suggestions?: PermissionUpdate[]): PermissionResult => ({
  behavior: 'allow', updatedInput: input, toolUseID: toolUseId, decisionClassification: suggestions ? 'user_permanent' : 'user_temporary',
  ...(suggestions ? { updatedPermissions: suggestions } : {}),
});
/** Root cannot run Claude Code with --dangerously-skip-permissions. */
const allowsBypass = () => process.getuid === undefined || process.getuid() !== 0;

/** One native Claude Code process driven through a streaming SDK query; turns are serialized. */
export class ClaudeTransport {
  readonly #options: ClaudeTransportOptions;
  readonly #children: ChildProcessWithoutNullStreams[] = [];
  readonly #input = new PushableInput<SDKUserMessage>();
  #permissionMode: ClaudePermissionMode;
  #query: Query | null = null;
  #started = false;
  #active: ActiveTurn | null = null;
  #idle: TurnAccumulator | null = null;
  #consumer: Promise<void> | null = null;
  #closing: Promise<void> | null = null;
  #ordinal = 0;
  #backgroundTasks = new Set<string>();

  constructor(options: ClaudeTransportOptions) {
    this.#options = options;
    this.#permissionMode = options.permissionMode;
  }

  get permissionMode(): ClaudePermissionMode { return this.#permissionMode; }

  async start(): Promise<void> {
    if (this.#started) return;
    if (this.#closing) throw new Error('Claude SDK transport is closing');
    const options = this.#options;
    const thinking = thinkingConfiguration(options.thinkingOptionId);
    const activeQuery = (options.queryFactory ?? query)({
      prompt: this.#input,
      options: {
        cwd: options.cwd,
        ...(options.openMode === 'resume' ? { resume: options.sessionId } : { sessionId: options.sessionId }),
        ...(options.model ? { model: options.model } : {}),
        // Adaptive thinking is redacted by default (empty thinking deltas); summarized display is the readable channel.
        thinking: thinking.enabled ? { type: 'adaptive', display: 'summarized' } : { type: 'disabled' },
        ...(thinking.effort ? { effort: thinking.effort } : {}),
        pathToClaudeCodeExecutable: resolveClaudeExecutable(options.environment, options.command),
        settingSources: ['user'],
        permissionMode: this.#permissionMode,
        ...(allowsBypass() ? { allowDangerouslySkipPermissions: true } : {}),
        // Paired with every mode, including bypass: questions and plan approval still need it after a live mode switch.
        canUseTool: (toolName, input, context) => this.#canUseTool(toolName, input, context),
        persistSession: true,
        includePartialMessages: true,
        forwardSubagentText: true,
        env: withNodeOnPath({ ...options.environment, CLAUDE_AGENT_SDK_CLIENT_APP: CLIENT_APP }),
        spawnClaudeCodeProcess: spawnOptions => this.#spawn(spawnOptions, true),
      },
    });
    this.#query = activeQuery;
    try { await activeQuery.initializationResult(); } catch (error) {
      activeQuery.close();
      this.#query = null;
      throw error;
    }
    this.#started = true;
    this.#consumer = this.#consume(activeQuery);
  }

  async getContextUsage(): Promise<{ usedTokens: number; maxTokens: number } | null> {
    if (!this.#started || !this.#query) return null;
    const value: unknown = await this.#query.getContextUsage();
    if (!isRecord(value) || !Number.isSafeInteger(value.totalTokens) || (value.totalTokens as number) < 0
      || !Number.isSafeInteger(value.maxTokens) || (value.maxTokens as number) <= 0) throw new Error('Claude SDK context usage is invalid');
    return { usedTokens: value.totalTokens as number, maxTokens: value.maxTokens as number };
  }

  async setModel(model: string | undefined): Promise<void> { await this.#require().setModel(model); }
  async setThinking(id: HarnessThinkingOptionId): Promise<void> {
    const thinking = thinkingConfiguration(id);
    await this.#require().applyFlagSettings(thinking.enabled ? { alwaysThinkingEnabled: true, effortLevel: thinking.effort ?? null } : { alwaysThinkingEnabled: false });
  }
  async setPermissionMode(mode: ClaudePermissionMode): Promise<void> {
    await this.#require().setPermissionMode(mode);
    this.#permissionMode = mode;
  }

  runTurn(text: string, userMessageId: string, onEvent: (event: TransportEvent) => void): Promise<ClaudeTurnResult> {
    if (this.#closing || !this.#started) return Promise.reject(new Error('Claude SDK transport is not started'));
    if (this.#active) return Promise.reject(new Error('Claude SDK transport is busy'));
    this.#idle = null;
    const result = new Promise<ClaudeTurnResult>((resolve, reject) => {
      this.#active = { accumulator: new TurnAccumulator(), interactions: new Map(), controlRequestIds: new Set(), onEvent, resolve, reject };
    });
    this.#input.push({
      type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: this.#options.sessionId,
      // Claude keeps the caller's user-message UUID in native history.
      uuid: userMessageId as SDKUserMessage['uuid'] & string, origin: { kind: 'human' },
    });
    return result;
  }

  respondToInteraction(response: ClaudeInteractionResponse): void {
    const active = this.#active;
    const pending = active?.interactions.get(response.requestId);
    if (!active || !pending) throw new Error('Claude SDK Interaction is not pending');
    const { request } = pending;
    if (response.type === 'question') {
      if (request.type !== 'question') throw new Error('Claude SDK Interaction response type does not match');
      if ('cancelled' in response) return this.#settle(active, pending, denied(pending.toolUseId, 'User cancelled the Question'));
      const texts = request.questions.map(question => question.question);
      const entries = Object.entries(response.answers);
      if (entries.length !== texts.length || entries.some(([question, answer]) => !texts.includes(question) || !answer)) throw new Error('Claude SDK Question answers do not match the request');
      return this.#settle(active, pending, { behavior: 'allow', updatedInput: { ...pending.input, answers: { ...response.answers } }, toolUseID: pending.toolUseId, decisionClassification: 'user_temporary' });
    }
    if (request.type === 'question') throw new Error('Claude SDK Interaction response type does not match');
    if (response.decision === 'deny') {
      return this.#settle(active, pending, denied(pending.toolUseId, request.type === 'planApproval' ? 'User chose to stay in plan mode. Do not begin implementation.' : 'User denied the Tool request'));
    }
    if (response.decision === 'allowOnce') {
      if (request.type === 'planApproval' && !request.plan) throw new Error('Claude SDK plan text is unavailable for approval');
      return this.#settle(active, pending, allowed(pending.toolUseId, pending.input));
    }
    const scope = response.decision === 'allowForSession' ? 'session' : 'always';
    if (request.type !== 'approval' || request.suggestedScope !== scope || !pending.suggestions) throw new Error('Claude SDK Approval scope is not pending');
    this.#settle(active, pending, allowed(pending.toolUseId, pending.input, pending.suggestions));
  }

  async abort(): Promise<void> {
    const active = this.#active, activeQuery = this.#query;
    if (!active || !activeQuery) throw new Error('Claude SDK transport has no active Turn');
    active.accumulator.requestCancel();
    try { await timeout(activeQuery.interrupt(), this.#options.abortTimeoutMs, 'Claude SDK interrupt timed out'); } catch (error) {
      await this.close();
      throw error;
    }
  }

  close(): Promise<void> { return this.#closing ??= this.#close(); }

  #require(): Query {
    if (!this.#started || !this.#query) throw new Error('Claude SDK transport is not started');
    return this.#query;
  }

  #canUseTool(toolName: string, input: Record<string, unknown>, context: Parameters<CanUseTool>[2]): Promise<PermissionResult> {
    const active = this.#active;
    const invalid = () => Promise.resolve(denied(context.toolUseID, 'Claude Tool permission request is invalid'));
    if (!active || !toolName.trim() || toolName.length > 120 || !context.requestId || !context.toolUseID || context.signal.aborted
      || active.controlRequestIds.has(context.requestId)) return invalid();
    const requestId = `claude-${toolName === 'AskUserQuestion' ? 'question' : 'approval'}-${++this.#ordinal}`;
    let request: ClaudeInteractionRequest | null;
    if (toolName === 'AskUserQuestion') {
      const questions = parseQuestions(input);
      request = questions && { type: 'question', requestId, questions };
    } else if (toolName === 'ExitPlanMode') {
      request = { type: 'planApproval', requestId, plan: typeof input.plan === 'string' && input.plan.trim() ? input.plan : null };
    } else request = approvalRequest(requestId, toolName, context);
    if (!request) return invalid();
    const known = request;
    return new Promise(resolve => {
      const pending: PendingInteraction = {
        request: known, controlRequestId: context.requestId, toolUseId: context.toolUseID, input, signal: context.signal, resolve,
        ...(known.type === 'approval' && known.suggestedScope && context.suggestions ? { suggestions: context.suggestions } : {}),
        onAbort: () => this.#settle(active, pending, denied(pending.toolUseId, known.type === 'question' ? 'Claude Question was interrupted' : 'Claude Tool approval was interrupted')),
      };
      active.interactions.set(requestId, pending);
      active.controlRequestIds.add(context.requestId);
      context.signal.addEventListener('abort', pending.onAbort, { once: true });
      active.onEvent({ type: 'interaction.requested', request: known });
    });
  }

  #settle(active: ActiveTurn, pending: PendingInteraction, result: PermissionResult): void {
    if (!active.interactions.delete(pending.request.requestId)) return;
    active.controlRequestIds.delete(pending.controlRequestId);
    pending.signal.removeEventListener('abort', pending.onAbort);
    active.onEvent({ type: 'interaction.closed', requestId: pending.request.requestId });
    pending.resolve(result);
  }

  #closeInteractions(active: ActiveTurn): void {
    for (const pending of [...active.interactions.values()]) {
      this.#settle(active, pending, denied(pending.toolUseId, pending.request.type === 'question' ? 'Claude Question is no longer pending' : 'Claude Tool approval is no longer pending'));
    }
  }

  async #consume(activeQuery: Query): Promise<void> {
    try {
      for await (const message of activeQuery as AsyncIterable<unknown>) {
        this.#observeBackgroundTasks(message);
        if (isRecord(message) && message.type === 'system' && (message.subtype === 'init' || message.subtype === 'status')
          && isPermissionMode(message.permissionMode) && message.permissionMode !== this.#permissionMode) {
          this.#permissionMode = message.permissionMode;
          this.#options.onPermissionModeChanged(message.permissionMode);
        }
        const active = this.#active;
        if (active) {
          const { events, terminal } = active.accumulator.consume(message);
          for (const event of events) active.onEvent(event);
          if (terminal) {
            this.#closeInteractions(active);
            this.#active = null;
            active.resolve(terminal);
          }
          continue;
        }
        const idle = this.#idle ??= new TurnAccumulator();
        const { events, terminal } = idle.consume(message);
        for (const event of events) this.#options.onIdleEvent(event);
        if (terminal) { this.#idle = null; this.#options.onIdleTerminal(terminal); }
      }
      if (!this.#closing) throw new Error('Claude SDK Query ended unexpectedly');
    } catch (error) {
      const active = this.#active;
      if (active) this.#closeInteractions(active);
      this.#active = null;
      active?.reject(error);
      if (!this.#closing) this.#options.onFault(error);
    }
  }

  #observeBackgroundTasks(message: unknown): void {
    if (!isRecord(message) || message.type !== 'system') return;
    if (message.subtype === 'background_tasks_changed' && Array.isArray(message.tasks)) {
      this.#backgroundTasks = new Set(message.tasks.flatMap(task => isRecord(task) && typeof task.task_id === 'string' ? [task.task_id] : []));
    } else if (message.subtype === 'task_started' && typeof message.task_id === 'string') this.#backgroundTasks.add(message.task_id);
    else if (message.subtype === 'task_notification' && typeof message.task_id === 'string' && ['completed', 'failed', 'stopped'].includes(String(message.status))) {
      this.#backgroundTasks.delete(message.task_id);
    }
  }

  async #close(): Promise<void> {
    const failures: unknown[] = [];
    if (this.#active) this.#closeInteractions(this.#active);
    const closeTimeoutMs = this.#options.closeTimeoutMs;
    try {
      await timeout((async () => {
        // A stop receipt is not a task terminal; wait for the native stopped notification to leave the set.
        const requested = new Set<string>();
        while (this.#backgroundTasks.size && this.#query) {
          for (const id of this.#backgroundTasks) if (!requested.has(id)) { requested.add(id); await this.#query.stopTask(id); }
          if (this.#backgroundTasks.size) await sleep(10);
        }
      })(), closeTimeoutMs, 'Claude background tasks did not stop');
    } catch (error) { failures.push(error); }
    const stopGroups = async () => {
      for (const result of await Promise.allSettled(this.#children.map(child => closeProcessGroup(child, closeTimeoutMs)))) {
        if (result.status === 'rejected') failures.push(result.reason);
      }
    };
    // taskkill needs a living root to enumerate the Windows tree; Unix groups stay addressable, so let the SDK close first.
    if (process.platform === 'win32') await stopGroups();
    this.#input.end();
    try { this.#query?.close(); } catch (error) { failures.push(error); }
    if (process.platform !== 'win32') await stopGroups();
    try { await timeout(Promise.all(this.#children.map(exited)), closeTimeoutMs, 'Claude SDK process did not exit'); } catch (error) { failures.push(error); }
    try { await timeout(this.#consumer?.catch(() => {}) ?? Promise.resolve(), closeTimeoutMs, 'Claude SDK output did not drain'); } catch (error) { failures.push(error); }
    this.#query = null;
    const active = this.#active;
    this.#active = null;
    this.#idle = null;
    active?.reject(new Error('Claude SDK transport closed'));
    if (failures.length) throw new AggregateError(failures, 'Claude SDK shutdown could not be confirmed');
  }

  #spawn(options: SpawnOptions, ownGroup: boolean): ChildProcessWithoutNullStreams {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd, env: options.env, signal: options.signal, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      detached: ownGroup && process.platform !== 'win32',
    });
    // stderr is not a protocol channel and may carry prompt text or credentials.
    child.stderr.resume();
    this.#children.push(child);
    return child;
  }
}

const exited = (child: ChildProcessWithoutNullStreams) => child.exitCode !== null || child.signalCode !== null ? Promise.resolve()
  : new Promise<void>(resolve => { child.once('exit', () => resolve()); child.once('error', () => resolve()); });

// ── Inspection ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** A short-lived, tool-less query for catalogs and account quota; never persists a session. */
export class ClaudeInspector {
  readonly #children: ChildProcessWithoutNullStreams[] = [];
  readonly #input = new PushableInput<SDKUserMessage>();
  #query: Query | null = null;

  constructor(private readonly options: { command?: string; environment: NodeJS.ProcessEnv; cwd: string; closeTimeoutMs: number; queryFactory?: QueryFactory }) {}

  async models(): Promise<{ models: unknown; canSelectModel: boolean; canSelectPermissionMode: boolean }> {
    const activeQuery = this.#create();
    const initialized = await activeQuery.initializationResult();
    const candidate = activeQuery as unknown as Record<string, unknown>;
    return { models: initialized.models, canSelectModel: Array.isArray(initialized.models) && typeof candidate.setModel === 'function', canSelectPermissionMode: typeof candidate.setPermissionMode === 'function' };
  }

  async account(): Promise<{ usage: Awaited<ReturnType<Query['usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET']>>; email?: string } | null> {
    const activeQuery = this.#create();
    return timeout((async () => {
      await activeQuery.initializationResult();
      if (typeof activeQuery.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET !== 'function') return null;
      const usage = await activeQuery.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET();
      if (!usage.rate_limits_available || !usage.rate_limits) return null;
      const { email } = await activeQuery.accountInfo();
      return { usage, ...(email ? { email } : {}) };
    })(), 10_000, 'Claude SDK account inspection timed out');
  }

  async close(): Promise<void> {
    this.#input.end();
    this.#query?.close();
    this.#query = null;
    for (const child of this.#children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await Promise.race([Promise.all(this.#children.map(exited)), sleep(this.options.closeTimeoutMs)]);
    for (const child of this.#children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }

  #create(): Query {
    const { options } = this;
    return this.#query = (options.queryFactory ?? query)({
      prompt: this.#input,
      options: {
        cwd: options.cwd, pathToClaudeCodeExecutable: resolveClaudeExecutable(options.environment, options.command),
        settingSources: ['user'], permissionMode: 'default', tools: [], persistSession: false, includePartialMessages: false,
        env: withNodeOnPath({ ...options.environment, CLAUDE_AGENT_SDK_CLIENT_APP: CLIENT_APP }),
        spawnClaudeCodeProcess: spawnOptions => {
          const child = spawn(spawnOptions.command, spawnOptions.args, { cwd: spawnOptions.cwd, env: spawnOptions.env, signal: spawnOptions.signal, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
          child.stderr.resume();
          this.#children.push(child);
          return child;
        },
      },
    });
  }
}
