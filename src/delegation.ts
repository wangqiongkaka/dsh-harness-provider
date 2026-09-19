import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const delegationRequest = z.object({
  requestId: z.string().min(1).max(128), harness: z.enum(['dsh', 'codex', 'claude-code']),
  prompt: z.string().trim().min(1).max(64_000), title: z.string().trim().min(1).max(80).optional(), reportBack: z.boolean().default(false),
}).strict();

export const delegationReadRequest = z.object({ sessionId: z.string().min(1), offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(64_000).default(32_000), throughSeq: z.number().int().nonnegative().optional() }).strict();
export const discussionRequest = z.object({ assignments: z.array(z.object({
  harness: z.enum(['dsh', 'codex', 'claude-code']), role: z.string().trim().min(1).max(80).optional(), task: z.string().trim().min(1).max(64_000),
}).strict()).min(1, '至少分配给 1 个参与者').max(4, '讨论最多支持 4 个参与者') }).strict();

/** Loopback-only, per-source credentials; no Host Runtime or global CLI configuration. */
export class DelegationBridge {
  private server?: Server;
  private starting?: Promise<string>;
  private closed = false;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly tokens = new Map<string, { source: string; create: boolean }>();
  constructor(private readonly call: (source: string, method: 'create' | 'read' | 'discuss', input: unknown) => Promise<unknown>) {}

  async environment(source: string, create = false): Promise<Record<string, string>> {
    if (this.closed) throw new Error('DSH delegation is closed');
    const endpoint = await (this.starting ??= this.listen());
    if (this.closed) throw new Error('DSH delegation is closed');
    const token = randomBytes(32).toString('hex');
    this.tokens.set(token, { source, create });
    return { DSH_DELEGATE_ENDPOINT: endpoint, DSH_DELEGATE_TOKEN: token };
  }

  private listen(): Promise<string> {
    const server = this.server = createServer(async (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      const credential = typeof req.headers.authorization === 'string' && req.headers.authorization.startsWith('Bearer ')
        ? this.tokens.get(req.headers.authorization.slice(7)) : undefined;
      if (!credential || req.headers.origin) { res.writeHead(403).end(JSON.stringify({ error: 'Forbidden' })); return; }
      if (req.method !== 'POST' || !['/create', '/read', '/discuss'].includes(req.url ?? '')) {
        res.writeHead(404).end(JSON.stringify({ error: 'Unknown delegation operation' })); return;
      }
      if (req.url === '/create' && !credential.create) { res.writeHead(403).end(JSON.stringify({ error: 'Forbidden' })); return; }
      try {
        let size = 0;
        let oversized = false;
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 256_000) oversized = true;
          if (!oversized) chunks.push(chunk);
        }
        if (oversized) { res.setHeader('Connection', 'close'); res.writeHead(413).end(JSON.stringify({ error: 'Request too large' })); return; }
        if (this.closed) throw new Error('DSH delegation is closed');
        const work = this.call(credential.source, req.url === '/create' ? 'create' : req.url === '/discuss' ? 'discuss' : 'read', JSON.parse(Buffer.concat(chunks).toString('utf8')));
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
只有用户可以通过界面中的委派指令创建独立会话；不要自行创建或建议调用创建入口。
仅当用户在当前轮明确使用 /discuss 开启讨论模式时，调用 ${command} discuss '{"assignments":[{"harness":"codex","role":"角色","task":"分工"}]}'。根据任务并发性自行选择 1–4 个参与者；一个参与者直接执行，多个参与者会自动互评一轮。每轮只调用一次，等待返回后综合结论。
仅在收到委派完成通知后，使用 ${command} read '<sessionId>' 读取状态与回复；不要执行 sleep 或定时 read 轮询。结果按字符分页；nextOffset 非空时，用 read '{"sessionId":"目标 ID","offset":下一偏移,"throughSeq":首次返回的 throughSeq}' 继续读取，直到 nextOffset 为 null 才算读完。
状态为 not-started 或 interrupted 时，提醒用户进入目标会话检查和处理，不要自动重发。
此入口只允许读取由当前会话明确要求回传的结果。环境凭据已注入，不要打印或写入消息。
[/DSH 会话能力]`;
}
