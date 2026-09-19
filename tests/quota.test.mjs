import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseZaiQuota, parseDeepSeekBalance, fetchNativeQuota, nativeQuotaRoute } from '../dist/native-quota.js';
import { codexAccountSnapshot as accountSnapshot } from '../dist/acp-profiles.js';
import { accountQuota, HarnessQuotaCache } from '../dist/dsh.js';

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

test('DeepSeek 多币种钱包取人民币主钱包，不受 balance_infos 顺序影响', () => {
 const wallet = (currency, total) => ({ currency, total_balance: total, granted_balance: '0.00', topped_up_balance: total });
 const usdFirst = { is_available: true, balance_infos: [wallet('USD', '0.00'), wallet('CNY', '17.11')] };
 const cnyFirst = { is_available: true, balance_infos: [wallet('CNY', '17.11'), wallet('USD', '0.00')] };
 // 同一账户的 balance_infos 顺序会在 [CNY, USD] 与 [USD, CNY] 之间变化，两种顺序都必须给出同一个 ¥17.11。
 assert.equal(parseDeepSeekBalance(usdFirst, 'deepseek-official').total, '17.11');
 assert.equal(parseDeepSeekBalance(cnyFirst, 'deepseek-official').total, '17.11');
 assert.equal(parseDeepSeekBalance(usdFirst, 'deepseek-official').currency, 'CNY');
 // 人民币钱包为空而其它币种有钱时显示有钱的那个，全部为空时退回第一项。
 assert.equal(parseDeepSeekBalance({ is_available: true, balance_infos: [wallet('USD', '5.00'), wallet('CNY', '0.00')] }, 'x').currency, 'USD');
 assert.deepEqual(parseDeepSeekBalance({ is_available: false, balance_infos: [wallet('USD', '0.00')] }, 'x'),
  { kind: 'balance', source: 'x', currency: 'USD', total: '0.00', granted: '0.00', toppedUp: '0.00' });
 assert.equal(parseDeepSeekBalance({ is_available: true, balance_infos: [] }, 'x'), null);
});

test('设置在 llm-pi-ai 里只写 apiKeyEnv 的 provider 仍按自带默认端点探测额度', async () => {
 const calls = [];
 const fetchImpl = async url => { calls.push(new URL(url)); return { ok: true, json: async () => url.includes('deepseek')
  ? { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '17.11', granted_balance: '0.00', topped_up_balance: '17.11' }] }
  : { success: true, data: { level: 'lite', limits: [
    { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 0 },
    { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 1, nextResetTime: 1_700_000_000_000 },
  ] } } }; };
 // zai-coding-cn 默认端点 https://open.bigmodel.cn/api/coding/paas/v4（pi-ai dist/providers/zai-coding-cn.js）。
 const glm = await fetchNativeQuota({ provider: 'zai-coding-cn', apiKey: 'k1', source: 'zai-coding-cn' }, fetchImpl);
 assert.deepEqual(glm.windows.map(window => [window.id, window.usedPercent, window.resetsAt]), [['five_hour', 0, null], ['seven_day', 1, new Date(1_700_000_000_000).toISOString()]]);
 assert.equal(glm.plan, 'lite');
 assert.equal((await fetchNativeQuota({ provider: 'zai', apiKey: 'k2', source: 'zai' }, fetchImpl)).kind, 'windows');
 assert.equal((await fetchNativeQuota({ provider: 'deepseek', apiKey: 'k3', source: 'deepseek' }, fetchImpl)).total, '17.11');
 assert.deepEqual(calls.map(url => url.host), ['open.bigmodel.cn', 'api.z.ai', 'api.deepseek.com']);
 assert.equal(calls[0].pathname, '/api/monitor/usage/quota/limit');
 // 用户显式配置的 baseURL 优先于默认端点；未知 provider 且没有 baseURL 时不发请求。
 assert.equal((await fetchNativeQuota({ provider: 'zai-coding-cn', baseURL: 'https://gateway.example/v1', apiKey: 'k4', source: 'zai-coding-cn' }, fetchImpl)), null);
 assert.equal(await fetchNativeQuota({ provider: 'unknown', apiKey: 'k5', source: 'unknown' }, fetchImpl), null);
 assert.equal(calls.length, 3);
 // dsh.ts 用 nativeQuotaRoute 合并设置与默认值：zai-coding-cn 的设置段只有 apiKeyEnv 时仍拿到智谱端点。
 assert.deepEqual(nativeQuotaRoute('zai-coding-cn', { apiKeyEnv: 'ZAI_CODING_CN_API_KEY' }),
  { provider: 'zai-coding-cn', baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4', apiKeyEnv: 'ZAI_CODING_CN_API_KEY' });
 assert.deepEqual(nativeQuotaRoute('zai-coding-cn', { baseURL: 'https://gateway.example/v1', apiKeyEnv: 'MY_KEY' }),
  { provider: 'zai-coding-cn', baseURL: 'https://gateway.example/v1', apiKeyEnv: 'MY_KEY' });
 assert.deepEqual(nativeQuotaRoute('deepseek-official'),
  { provider: 'deepseek-official', baseURL: 'https://api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY' });
 assert.deepEqual(nativeQuotaRoute('unknown'), { provider: 'unknown', baseURL: undefined, apiKeyEnv: undefined });
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

test('外部 Harness 额度缓存：只在无缓存、窗口已重置或回合结束时探测', async () => {
 let clock = Date.parse('2026-09-19T00:00:00.000Z'), probes = 0, settle;
 const probe = () => { probes++; return new Promise(resolve => { settle = resolve; }); };
 const cache = new HarnessQuotaCache(probe, () => clock);
 const windows = (usedPercent, resetsAt) => ({ kind: 'windows', source: 'codex', plan: null, windows: [
  { id: 'five_hour', label: 'five_hour', usedPercent, resetsAt }, { id: 'seven_day', label: 'seven_day', usedPercent: 10, resetsAt: '2026-09-25T00:00:00.000Z' }] });
 const drain = () => new Promise(resolve => setImmediate(() => setImmediate(resolve)));
 // 首次没有缓存：并发读取共用一次探测并等待结果。
 const first = cache.read(), again = cache.read();
 settle(windows(40, '2026-09-19T05:00:00.000Z'));
 assert.equal((await first).windows[0].usedPercent, 40);
 assert.equal((await again).windows[0].usedPercent, 40);
 assert.equal(probes, 1);
 // 窗口重置前，无论闲置多久（切换会话、轮询）都只读缓存。
 clock = Date.parse('2026-09-19T04:59:59.999Z');
 assert.equal((await cache.read()).windows[0].usedPercent, 40);
 assert.equal(probes, 1);
 // 回合结束后台探测；完成前读取拿旧值。
 cache.invalidate();
 assert.equal(probes, 2);
 assert.equal((await cache.read()).windows[0].usedPercent, 40);
 settle(windows(90, '2026-09-19T05:00:00.000Z'));
 await drain();
 assert.equal((await cache.read()).windows[0].usedPercent, 90);
 // 过了最早的重置时间：读取探测一次并等待新值，之后不再重复探测。
 clock = Date.parse('2026-09-19T05:00:00.000Z');
 const reset = cache.read();
 assert.equal(probes, 3);
 settle(windows(0, '2026-09-19T10:00:00.000Z'));
 assert.equal((await reset).windows[0].usedPercent, 0);
 clock = Date.parse('2026-09-19T09:00:00.000Z');
 assert.equal((await cache.read()).windows[0].usedPercent, 0);
 assert.equal(probes, 3);
});

test('外部 Harness 额度缓存：从未读取过也在回合结束时探测，之后读取直接命中', async () => {
 let probes = 0;
 const cache = new HarnessQuotaCache(() => { probes++; return Promise.resolve({ kind: 'balance', source: 'codex', currency: 'CNY', total: '7', granted: '0', toppedUp: '7' }); }, () => 0);
 cache.invalidate();
 assert.equal(probes, 1);
 assert.equal((await cache.read()).total, '7');
 assert.equal(probes, 1);
});

test('外部 Harness 额度缓存：探测失败记为无数据直到下一回合，未过期旧值保留', async () => {
 let clock = 0, probes = 0, settle, failing = true;
 const probe = () => { probes++; return failing ? Promise.reject(new Error('offline')) : new Promise(resolve => { settle = resolve; }); };
 const cache = new HarnessQuotaCache(probe, () => clock);
 const wallet = total => ({ kind: 'balance', source: 'codex', currency: 'CNY', total, granted: '0', toppedUp: total });
 const drain = () => new Promise(resolve => setImmediate(() => setImmediate(resolve)));
 // 首次失败：返回 null，之后的读取不再探测。
 assert.equal(await cache.read(), null);
 clock = 60 * 60_000;
 assert.equal(await cache.read(), null);
 assert.equal(probes, 1);
 // 下一回合结束才重试。
 failing = false;
 cache.invalidate();
 assert.equal(probes, 2);
 settle(wallet('5'));
 await drain();
 assert.equal((await cache.read()).total, '5');
 // 后台探测失败：保留仍有效的旧值，也不会每次读取都重试。
 failing = true;
 cache.invalidate();
 await drain();
 assert.equal((await cache.read()).total, '5');
 assert.equal(probes, 3);
});
