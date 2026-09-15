import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseZaiQuota, parseDeepSeekBalance, fetchNativeQuota } from '../dist/native-quota.js';
import { accountSnapshot } from '../dist/codex-adapter.js';
import { accountQuota } from '../dist/dsh.js';

test('智谱 Coding Plan limits[] 映射为 5 小时与周窗口，忽略 MCP TIME_LIMIT', () => {
 const quota = parseZaiQuota({ success: true, data: { limits: [
  { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 23, nextResetTime: 1_700_000_000_000 },
  { type: 'CREDIT_LIMIT', unit: 6, number: 1, currentValue: 47, usage: 100 },
  { type: 'TIME_LIMIT', unit: 5, number: 1, percentage: 99 },
 ], level: 'lite' } }, 'glm');
 assert.deepEqual(quota, { kind: 'windows', source: 'glm', plan: 'lite', windows: [
  { id: 'five_hour', label: 'five_hour', usedPercent: 23, resetsAt: new Date(1_700_000_000_000).toISOString() },
  { id: 'seven_day', label: 'seven_day', usedPercent: 47, resetsAt: null },
 ] });
 assert.equal(parseZaiQuota({ data: { limits: [{ type: 'TIME_LIMIT', percentage: 50 }] } }, 'glm'), null);
});

test('DeepSeek 余额映射与按端点选择探测', async () => {
 assert.deepEqual(parseDeepSeekBalance({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' }] }, 'deepseek-official'),
  { kind: 'balance', source: 'deepseek-official', currency: 'CNY', total: '110.00', granted: '10.00', toppedUp: '100.00' });
 const calls = [];
 const fetchImpl = async (url, init) => { calls.push([url, init.headers.Authorization]); return { ok: true, json: async () => url.includes('deepseek')
  ? { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '1', granted_balance: '0', topped_up_balance: '1' }] }
  : { data: { limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 1 }] } } }; };
 assert.equal((await fetchNativeQuota({ baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4', apiKey: 'k1', source: 'glm' }, fetchImpl)).kind, 'windows');
 assert.equal((await fetchNativeQuota({ baseURL: 'https://api.z.ai/api/paas/v4', apiKey: 'k2', source: 'zai' }, fetchImpl)).kind, 'windows');
 assert.equal((await fetchNativeQuota({ baseURL: 'https://api.deepseek.com', apiKey: 'k3', source: 'ds' }, fetchImpl)).kind, 'balance');
 assert.equal(await fetchNativeQuota({ baseURL: 'https://example.com/v1', apiKey: 'k4', source: 'x' }, fetchImpl), null);
 assert.deepEqual(calls.map(([url, auth]) => [new URL(url).host, auth]), [['open.bigmodel.cn', 'k1'], ['api.z.ai', 'Bearer k2'], ['api.deepseek.com', 'Bearer k3']]);
});

test('Codex 限速快照与账户快照展开为额度窗口', () => {
 const snapshot = accountSnapshot({ rateLimits: { planType: 'plus',
  primary: { usedPercent: 62, windowDurationMins: 300, resetsAt: 1_700_000_000 },
  secondary: { usedPercent: 31, windowDurationMins: 10080, resetsAt: 1_700_500_000_000 } } });
 assert.equal(snapshot.plan, 'plus');
 assert.equal(snapshot.credits.periodType, 'five_hour');
 assert.equal(snapshot.credits.resetsAt, new Date(1_700_000_000_000).toISOString());
 assert.equal(snapshot.credits.productUsage[0].resetsAt, new Date(1_700_500_000_000).toISOString());
 assert.equal(accountSnapshot({ rateLimits: { primary: null, secondary: null } }), null);
 const quota = accountQuota({ plan: 'max', credits: { usedPercent: 62, periodType: 'five_hour', resetsAt: '2026-09-15T06:30:00.000Z',
  productUsage: [{ product: '7-day window', usagePercent: 31 }, { product: 'Opus · 7-day', usagePercent: 54, resetsAt: '2026-09-21T00:00:00.000Z' }] } }, 'claude-code');
 assert.deepEqual(quota.windows.map(w => [w.id, w.label, w.usedPercent, w.resetsAt]), [
  ['five_hour', 'five_hour', 62, '2026-09-15T06:30:00.000Z'], ['product:7-day window', '7-day window', 31, null], ['product:Opus · 7-day', 'Opus · 7-day', 54, '2026-09-21T00:00:00.000Z'],
 ]);
 assert.equal(accountQuota(null, 'codex'), null);
});
