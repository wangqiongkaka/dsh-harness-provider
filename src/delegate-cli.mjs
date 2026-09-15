// Bundled, session-scoped CLI. No shell execution and no persistent credentials.
try {
  const [method, value, ...extra] = process.argv.slice(2);
  if (!['create', 'read'].includes(method) || !value || extra.length) throw new Error('Usage: delegate-cli.mjs create <JSON> | read <sessionId>');
  const endpoint = process.env.DSH_DELEGATE_ENDPOINT;
  const token = process.env.DSH_DELEGATE_TOKEN;
  if (!endpoint || !token) throw new Error('DSH delegation is unavailable in this process; start a new DSH harness turn.');
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password) throw new Error('Invalid DSH delegation endpoint');
  const body = method === 'create' || value.startsWith('{') ? JSON.parse(value) : { sessionId: value };
  const response = await fetch(new URL(method, url), {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(120_000),
  });
  const result = await response.json();
  console.log(JSON.stringify(result));
  if (!response.ok) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ error: error.message, hint: '创建请求结果不明确时，使用相同 requestId 和参数重试。' }));
  process.exitCode = 1;
}
