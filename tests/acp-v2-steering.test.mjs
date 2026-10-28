import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { test } from 'node:test';

test('Claude ACP v2 接受追加扩展并验证请求', { timeout: 15000 }, async t => {
 const child = spawn(process.execPath, ['dist/claude-agent-acp.mjs'], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, CLAUDE_AGENT_ACP_PROTOCOL: 'v2' } });
 t.after(() => child.kill());
 const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
 const request = async (id, method, params) => {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  while (true) { const next = await lines.next(); assert.equal(next.done, false); const message = JSON.parse(next.value); if (message.id === id) return message; }
 };
 const initialized = await request(1, 'initialize', { protocolVersion: 2, info: { name: 'test', version: '1.0.0' }, capabilities: {} });
 assert.equal(initialized.result?.protocolVersion, 2);
 assert.equal(initialized.result?._meta?.steering?.supported, true);
 const invalid = await request(2, '_session/steering', { sessionId: '', prompt: [] });
 assert.equal(invalid.error?.code, -32602);
 const missing = await request(3, '_session/steering', { sessionId: 'missing', prompt: [{ type: 'text', text: 'hello' }] });
 assert.equal(missing.error?.code, -32603);
});
