import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import type { JobHandle, JobOutcome, JobOutputSource, JobRegistry } from '@deepseek-ai/dsh-jobs';
import type { HarnessBackgroundTask, HarnessSession } from './contracts.js';

/** The native agent owns execution and notifications; DSH owns only its existing job-list projection. */
export class BackgroundJobs {
  private readonly tasks = new Map<string, { task: HarnessBackgroundTask; job: JobHandle; done: PromiseWithResolvers<JobOutcome>; output: string; settled: boolean }>();
  constructor(private readonly ctx: Context, private readonly agent: Agent, private readonly session: HarnessSession) {}

  update(task: HarnessBackgroundTask): void {
    const jobs = this.ctx.get('jobs');
    if (!jobs) return;
    let entry = this.tasks.get(task.id);
    if (!entry) {
      const done = Promise.withResolvers<JobOutcome>();
      try {
        jobs.start({ kind: 'bash', label: task.command ?? task.name, owner: this.agent.id,
          ...(task.toolCallId ? { toolCall: { callId: ToolCallId(task.toolCallId), rootCallId: ToolCallId(task.toolCallId) } } : {}),
          output: [taskFileOutput(() => this.tasks.get(task.id)?.task ?? task)],
          run: job => {
            entry = { task, job, done, output: '', settled: false };
            this.tasks.set(task.id, entry);
            return { done: done.promise, cancel: () => {
              if (!this.session.stopBackgroundTask) throw new Error('Harness 不支持停止后台任务');
              void this.session.stopBackgroundTask(task.id).then(result => {
                if (!result.ok) throw new Error(result.error.message);
                if (!result.value.stopped) throw new Error('原生任务未接受停止请求');
              }).catch(error => {
                job.updateProgress(`停止失败：${String(error)}`);
                this.ctx.logger.warn(`后台任务 ${task.id} 停止失败：${String(error)}`);
              });
            } };
          } });
      } catch (error) {
        this.tasks.delete(task.id);
        this.ctx.logger.warn(`后台任务 ${task.id} 无法显示：${String(error)}`);
        return;
      }
    }
    if (!entry || entry.settled) return;
    entry.task = task;
    if (!task.outputFilePath && task.output !== undefined && task.output !== entry.output) {
      const appended = task.output.startsWith(entry.output);
      entry.job.append(appended ? task.output.slice(entry.output.length) : task.output, appended ? {} : { gapBefore: true });
      entry.output = task.output;
    }
    if (task.status === 'running' || task.status === 'paused') {
      entry.job.updateProgress(task.summary ?? (task.status === 'paused' ? '已暂停' : ''));
      return;
    }
    // Claude's Bash tool exit is the submission result; its task log records the process's final exit instead.
    const loggedExit = task.outputFilePath ? /\n\[exited with code (-?\d+)\]\s*$/.exec(taskFileOutput(() => task).read(0).text) : null;
    const exitCode = task.outputFilePath ? loggedExit ? Number(loggedExit[1]) : undefined : task.exitCode;
    const status = task.status === 'stopped' ? 'killed' : task.status === 'failed' || (exitCode !== undefined && exitCode !== 0) ? 'failed' : 'completed';
    this.settle(jobs, entry, { status, ...(exitCode !== undefined ? { detail: `exit code: ${exitCode}` } : task.summary ? { detail: task.summary } : {}) });
  }

  close(): void {
    const jobs = this.ctx.get('jobs');
    if (jobs) for (const entry of this.tasks.values()) if (!entry.settled) this.settle(jobs, entry, { status: 'failed', detail: 'Harness 进程已结束' });
  }

  private settle(jobs: JobRegistry, entry: { job: JobHandle; done: PromiseWithResolvers<JobOutcome>; settled: boolean }, outcome: JobOutcome): void {
    entry.settled = true;
    // Collect the terminal state before resolving: tool-jobs then suppresses its duplicate model wake-up notice.
    void jobs.wait(entry.job.id, 5_000, this.agent.id).then(() => jobs.read(entry.job.id, this.agent.id)).catch(error => {
      this.ctx.logger.warn(`后台任务 ${entry.job.id} 状态收取失败：${String(error)}`);
    });
    entry.done.resolve(outcome);
  }
}

/** Pull native Claude task logs without retaining an open file or loading an unbounded log into memory. */
function taskFileOutput(current: () => HarnessBackgroundTask): JobOutputSource {
  let path: string | undefined, decoder = new TextDecoder();
  return { channel: 'stdout', read: from => {
    const task = current(), nextPath = task.outputFilePath;
    if (!nextPath || !isAbsolute(nextPath)) return { text: '', nextOffset: from, lossy: false };
    let fd: number | undefined;
    try {
      fd = openSync(nextPath, 'r');
      const info = fstatSync(fd);
      if (!info.isFile()) return { text: '', nextOffset: from, lossy: false };
      const reset = path !== nextPath || info.size < from;
      const start = Math.max(reset ? 0 : from, info.size - 256 * 1024);
      const lossy = (path !== undefined && reset) || start > (reset ? 0 : from);
      if (reset || lossy) decoder = new TextDecoder();
      path = nextPath;
      const bytes = Buffer.alloc(info.size - start);
      const length = readSync(fd, bytes, 0, bytes.length, start);
      let head = 0;
      if (lossy) while (head < length && (bytes[head]! & 0xc0) === 0x80) head++;
      const text = decoder.decode(bytes.subarray(head, length), { stream: task.status === 'running' || task.status === 'paused' });
      return { text, nextOffset: start + length, lossy, spillPath: nextPath };
    } catch { return { text: '', nextOffset: from, lossy: false }; }
    finally { if (fd !== undefined) closeSync(fd); }
  } };
}
