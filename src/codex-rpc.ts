import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

export type RpcId = string | number;
export type RpcMessage = {
  id?: RpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
};

export interface RpcOptions {
  command: string;
  args?: string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  requestTimeoutMs: number;
  shutdownTimeoutMs: number;
  maxFrameBytes: number;
  onMessage(message: RpcMessage): void;
  onFault(error: Error): void;
}

/** One native app-server connection; its owner also owns the spawned process group. */
export class CodexRpc {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<RpcId, {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private sequence = 0;
  private failure?: Error;
  private closing?: Promise<void>;
  private readonly exited: Promise<void>;

  constructor(private readonly options: RpcOptions) {
    for (const value of [options.requestTimeoutMs, options.shutdownTimeoutMs, options.maxFrameBytes]) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error('RPC limits must be positive integers');
    }
    this.child = spawn(options.command, options.args ?? ['app-server'], {
      cwd: options.cwd,
      env: options.environment,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    // Child stderr is not a protocol channel and may contain credentials or prompt text.
    this.child.stderr.resume();
    this.exited = new Promise(resolve => {
      this.child.once('close', () => {
        if (!this.closing) this.fail(new Error('Codex app-server exited'));
        resolve();
      });
    });
    this.child.on('error', () => { this.fail(new Error('Could not start Codex app-server')); });
    this.child.stdin.on('error', () => { this.fail(new Error('Codex app-server input closed')); });
    void this.consume().catch(() => { this.fail(new Error('Invalid Codex app-server output')); });
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.failure || this.closing) return Promise.reject(this.failure ?? new Error('Codex connection closed'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // A timed-out mutation may already have happened remotely; retire the connection.
        this.fail(new Error(`Codex request timed out: ${method}`));
      }, this.options.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error('Codex request failed'));
      }
    });
  }

  send(message: RpcMessage): void {
    if (this.failure || this.closing) throw this.failure ?? new Error('Codex connection closed');
    const frame = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(frame) > this.options.maxFrameBytes) throw new Error('Codex request is too large');
    this.child.stdin.write(frame);
  }

  private async consume(): Promise<void> {
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    for await (const chunk of this.child.stdout) {
      buffer += decoder.write(chunk as Buffer);
      let end: number;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (Buffer.byteLength(line) > this.options.maxFrameBytes) throw new Error('Oversized frame');
        this.receive(JSON.parse(line));
      }
      if (Buffer.byteLength(buffer) > this.options.maxFrameBytes) throw new Error('Oversized frame');
    }
    buffer += decoder.end();
    if (buffer.length > 0) throw new Error('Incomplete frame');
  }

  private receive(value: unknown): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid RPC envelope');
    const message = value as RpcMessage;
    if (message.id !== undefined && typeof message.id !== 'string' && !Number.isSafeInteger(message.id)) {
      throw new Error('Invalid RPC id');
    }
    if (message.method !== undefined) {
      if (typeof message.method !== 'string' || 'result' in message || 'error' in message) throw new Error('Invalid RPC method');
      this.options.onMessage(message);
      return;
    }
    if (message.id === undefined || (('result' in message) === ('error' in message))) {
      throw new Error('Invalid RPC response');
    }
    if ('error' in message && (!message.error || typeof message.error !== 'object'
      || !Number.isSafeInteger(message.error.code) || typeof message.error.message !== 'string')) {
      throw new Error('Invalid RPC error');
    }
    const pending = this.pending.get(message.id);
    if (!pending) throw new Error('Unsolicited RPC response');
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error !== undefined) {
      // Original protocol errors are intentionally not relayed into UI diagnostics.
      pending.reject(new Error('Codex rejected the request'));
    } else {
      pending.resolve(message.result);
    }
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    try {
      if (!this.closing) this.options.onFault(error);
    } catch {
      // Observer failures must not escape child-process event handlers.
    } finally {
      // Retain the cleanup promise for close(); contain this background observer.
      void this.close().catch(() => {});
    }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = Promise.resolve().then(async () => {
      this.fail(new Error('Codex connection closed'));
      this.child.stdin.end();
      if (await this.waitForShutdown()) return;
      if (process.platform === 'win32') {
        if (this.child.pid !== undefined) {
          await new Promise<void>((resolve, reject) => {
            const killer = spawn('taskkill', ['/pid', String(this.child.pid), '/t', '/f'], { windowsHide: true });
            killer.stdout.resume();
            killer.stderr.resume();
            killer.once('error', reject);
            killer.once('close', code => code === 0 ? resolve() : reject(new Error('Codex process-tree shutdown failed')));
          });
        }
      } else {
        await this.signalGroup('SIGTERM');
        if (await this.waitForShutdown()) return;
        await this.signalGroup('SIGKILL');
      }
      if (!(await this.waitForShutdown())) throw new Error('Codex process group did not exit');
    });
    return this.closing;
  }

  private async signalGroup(signal: NodeJS.Signals): Promise<void> {
    if (this.child.pid === undefined) return;
    try {
      process.kill(-this.child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      if ((error as NodeJS.ErrnoException).code === 'EPERM' && !(await this.groupAlive())) return;
      throw error;
    }
  }

  private async groupAlive(): Promise<boolean> {
    if (process.platform === 'win32' || this.child.pid === undefined) return false;
    try { process.kill(-this.child.pid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    }
    // Darwin reports EPERM for an orphan group containing only zombies.
    // Reaping belongs to the OS; a zombie cannot run or receive signals.
    const { stdout } = await promisify(execFile)('/bin/ps', ['-axo', 'pgid=,stat='], { timeout: this.options.shutdownTimeoutMs });
    return stdout.split('\n').some(line => {
      const [group, state] = line.trim().split(/\s+/);
      return group === String(this.child.pid) && state !== undefined && !state.startsWith('Z');
    });
  }

  private async waitForShutdown(): Promise<boolean> {
    if (!(await this.waitForExit())) return false;
    const deadline = performance.now() + this.options.shutdownTimeoutMs;
    while (await this.groupAlive()) {
      if (performance.now() >= deadline) return false;
      await delay(Math.min(20, this.options.shutdownTimeoutMs));
    }
    return true;
  }

  private async waitForExit(): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.exited.then(() => true),
        new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), this.options.shutdownTimeoutMs); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
