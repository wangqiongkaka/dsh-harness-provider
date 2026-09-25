/** Claude Code executable discovery, shell environment, and the tool-less SDK query used for account quota. */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { query, type Query, type SDKUserMessage, type SpawnOptions } from '@anthropic-ai/claude-agent-sdk';

export type QueryFactory = typeof query;
import pkg from '../package.json' with { type: 'json' };

export const CLAUDE_COMMAND_ENV = 'CLAUDE_COMMAND_PATH';
const CLIENT_APP = `${pkg.name}/${pkg.version}`;

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
 * The configured command (CLAUDE_COMMAND_PATH) when set, searched only on PATH if it is a bare name; otherwise
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
export function withNodeOnPath(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
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
 * environment as in a terminal. Existing variables win, except that PATH keeps its own entries first and gains the shell's
 * others: launchd's bare PATH would otherwise hide every directory a version manager adds (nvm, pnpm, …). The snapshot is
 * never persisted or logged.
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
  if (environment.PATH && loaded.PATH) merged.PATH = [...new Set([...environment.PATH.split(path.delimiter), ...loaded.PATH.split(path.delimiter)].filter(Boolean))].join(path.delimiter);
  return merged;
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

const exited = (child: ChildProcessWithoutNullStreams) => child.exitCode !== null || child.signalCode !== null ? Promise.resolve()
  : new Promise<void>(resolve => { child.once('exit', () => resolve()); child.once('error', () => resolve()); });

// ── Inspection ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** A short-lived, tool-less query for the account quota; never persists a session. */
export class ClaudeInspector {
  readonly #children: ChildProcessWithoutNullStreams[] = [];
  readonly #input = new PushableInput<SDKUserMessage>();
  #query: Query | null = null;

  constructor(private readonly options: { command?: string; environment: NodeJS.ProcessEnv; cwd: string; closeTimeoutMs: number; queryFactory?: QueryFactory }) {}

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
        spawnClaudeCodeProcess: (spawnOptions: SpawnOptions) => {
          const child = spawn(spawnOptions.command, spawnOptions.args, { cwd: spawnOptions.cwd, env: spawnOptions.env, signal: spawnOptions.signal, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
          child.stderr.resume();
          this.#children.push(child);
          return child;
        },
      },
    });
  }
}
