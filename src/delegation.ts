import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const delegationRequest = z.object({
  requestId: z.string().min(1).max(128), harness: z.enum(['dsh', 'codex', 'claude-code']),
  prompt: z.string().trim().min(1).max(64_000), title: z.string().trim().min(1).max(80).optional(),
}).strict();

export const delegationReadRequest = z.object({ sessionId: z.string().min(1), offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(64_000).default(32_000), throughSeq: z.number().int().nonnegative().optional() }).strict();

/** Loopback-only, per-source credentials; no Host Runtime or global CLI configuration. */
export class DelegationBridge {
  private server?: Server;
  private starting?: Promise<string>;
  private closed = false;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly tokens = new Map<string, string>();
  constructor(private readonly call: (source: string, method: 'create' | 'read', input: unknown) => Promise<unknown>) {}

  async environment(source: string): Promise<Record<string, string>> {
    if (this.closed) throw new Error('DSH delegation is closed');
    const endpoint = await (this.starting ??= this.listen());
    if (this.closed) throw new Error('DSH delegation is closed');
    let token = this.tokens.get(source);
    if (!token) { token = randomBytes(32).toString('hex'); this.tokens.set(source, token); }
    return { DSH_DELEGATE_ENDPOINT: endpoint, DSH_DELEGATE_TOKEN: token };
  }

  private listen(): Promise<string> {
    const server = this.server = createServer(async (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      const source = [...this.tokens].find(([, token]) => req.headers.authorization === `Bearer ${token}`)?.[0];
      if (!source || req.headers.origin) { res.writeHead(403).end(JSON.stringify({ error: 'Forbidden' })); return; }
      if (req.method !== 'POST' || !['/create', '/read'].includes(req.url ?? '')) {
        res.writeHead(404).end(JSON.stringify({ error: 'Unknown delegation operation' })); return;
      }
      try {
        let size = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 256_000) { res.writeHead(413).end(JSON.stringify({ error: 'Request too large' })); return; }
          chunks.push(chunk);
        }
        if (this.closed) throw new Error('DSH delegation is closed');
        const work = this.call(source, req.url === '/create' ? 'create' : 'read', JSON.parse(Buffer.concat(chunks).toString('utf8')));
        this.pending.add(work);
        try { res.end(JSON.stringify(await work)); } finally { this.pending.delete(work); }
      } catch (error) {
        res.writeHead(400).end(JSON.stringify({ error: error instanceof Error ? error.message : 'Delegation failed' }));
      }
    });
    server.requestTimeout = 15_000;
    server.headersTimeout = 10_000;
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') { reject(new Error('Missing delegation address')); return; }
        resolve(`http://127.0.0.1:${address.port}`);
      });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.tokens.clear();
    await this.starting?.catch(() => {});
    const server = this.server;
    if (server) await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
    await Promise.allSettled(this.pending);
  }
}

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
export function delegationInstructions(): string {
  const command = `${quote(process.execPath)} ${quote(fileURLToPath(new URL('./delegate-cli.mjs', import.meta.url)))}`;
  // Leading blank line: the agent joins prompt blocks verbatim, so this stays apart from the user's last line.
  return `\n\n[DSH 会话能力，由宿主提供]
用户明确要求把工作交给指定 harness 或新会话处理时（例如实现、修复、调研、审查、测试），使用以下入口创建同工作区的全新 DSH 会话，左侧会话区会显示进度。
${command} create '{"requestId":"唯一请求标识","harness":"codex","title":"简短任务标题","prompt":"完整任务：目标、背景、范围、约束（如是否允许修改文件）和验收要求"}'
harness 支持 dsh、codex、claude-code；title 可省略。新会话没有本会话历史，必须写全任务。requestId 每个新任务使用唯一值；失败重试必须使用相同 requestId 和参数。
返回 sessionId 只表示任务已提交。创建成功后立即结束当前轮次并等待宿主的完成通知；不要执行 sleep 后反复 read 轮询。宿主会在任务结束后自动通知并唤醒来源会话。
收到完成通知后，使用 ${command} read '<sessionId>' 读取状态与回复。结果按字符分页；nextOffset 非空时，用 read '{"sessionId":"目标 ID","offset":下一偏移,"throughSeq":首次返回的 throughSeq}' 继续读取，直到 nextOffset 为 null 才算读完。
状态为 not-started 时，使用相同 requestId 和参数重试 create；状态为 interrupted 时，进入目标会话检查和处理，不要自动重发。
此入口独立于 codexhost delegate；不要用 codex exec、claude -p 等后台命令替代可见会话。环境凭据已注入，不要打印或写入消息。
[/DSH 会话能力]`;
}
