import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { HostTurnSnapshot, NativeSessionRef } from './contracts.js';

/** SDK history helpers use process environment; isolate them so parallel Harness homes never mix. */
export async function claudeHistoryOperation(operation: 'read' | 'fork', nativeRef: NativeSessionRef, cwd: string, environment: NodeJS.ProcessEnv, throughTurn?: string | null) {
  const { stdout } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('./claude-history-cli.js', import.meta.url)), operation,
    JSON.stringify(nativeRef), cwd, ...(throughTurn === undefined ? [] : [JSON.stringify(throughTurn)])],
  { env: environment, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
  return JSON.parse(stdout) as HostTurnSnapshot[] | NativeSessionRef | null;
}
