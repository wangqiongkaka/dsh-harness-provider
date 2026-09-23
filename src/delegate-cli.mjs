// Bundled, session-scoped CLI. No shell execution and no persistent credentials.
try {
  const [method, value, ...extra] = process.argv.slice(2);
  if (!['create', 'read', 'discuss', 'models'].includes(method) || (method === 'models' ? value : !value) || extra.length) {
    throw new Error('Usage: delegate-cli.mjs create <JSON> | read <sessionId> | discuss <JSON> | models');
  }
  const endpoint = process.env.DSH_DELEGATE_ENDPOINT;
  const token = process.env.DSH_DELEGATE_TOKEN;
  if (!endpoint || !token) throw new Error('DSH delegation is unavailable in this process; start a new DSH harness turn.');
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password) throw new Error('Invalid DSH delegation endpoint');
  const body = method === 'models' ? {} : method !== 'read' || value.startsWith('{') ? JSON.parse(value) : { sessionId: value };
  const response = await fetch(new URL(method, url), {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(method === 'discuss' ? Number(process.env.DSH_DELEGATE_DISCUSS_TIMEOUT_MS) || 1_800_000 : 120_000),
  });
  const result = await response.json();
  console.log(JSON.stringify(result));
  if (!response.ok) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ error: error.message, hint: process.argv[2] === 'create' ? '创建请求结果不明确时，使用相同 requestId 和参数重试。' : '请检查当前会话状态和参数后重试。' }));
  process.exitCode = 1;
}
