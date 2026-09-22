import { z } from 'zod';

/** Account quota view shared with the client contract (remote.ts quotaSchema). */
export type QuotaWindow = { id: string; label: string; usedPercent: number; resetsAt: string | null };
export type Quota =
  | { kind: 'windows'; source: string; plan: string | null; windows: QuotaWindow[] }
  | { kind: 'balance'; source: string; currency: string; total: string; granted: string; toppedUp: string }
  | null;

// 智谱 Coding Plan：GET {host}/api/monitor/usage/quota/limit（open.bigmodel.cn 直接放 API Key；api.z.ai 用 Bearer）。
// limits[] 每行 percentage 为已用比例，nextResetTime 为重置时间（unix ms），unit 3/number 5 = 5 小时窗，unit 6/number 1 = 周窗。
const zaiLimits = z.object({
  success: z.boolean().optional(),
  data: z.object({ level: z.string().optional(), limits: z.array(z.object({
    type: z.string(), unit: z.number().optional(), number: z.number().optional(),
    percentage: z.number().optional(), currentValue: z.number().optional(), usage: z.number().optional(),
    nextResetTime: z.number().optional(),
  }).passthrough()) }).passthrough(),
}).passthrough();
export function parseZaiQuota(raw: unknown, source: string): Quota {
  const body = zaiLimits.parse(raw);
  if (body.success === false) return null;
  const windows: QuotaWindow[] = [];
  for (const row of body.data.limits) {
    if (row.type !== 'TOKENS_LIMIT' && row.type !== 'CREDIT_LIMIT') continue; // TIME_LIMIT 是 MCP 调用额度，不是模型额度
    const percent = row.percentage ?? (row.currentValue !== undefined && row.usage ? (row.currentValue / row.usage) * 100 : undefined);
    if (percent === undefined || !Number.isFinite(percent)) continue;
    const id = row.unit === 3 && row.number === 5 ? 'five_hour' : row.unit === 6 && row.number === 1 ? 'seven_day' : null;
    if (!id) continue;
    windows.push({ id, label: id, usedPercent: Math.max(0, Math.min(100, percent)),
      resetsAt: row.nextResetTime ? new Date(row.nextResetTime).toISOString() : null });
  }
  return windows.length ? { kind: 'windows', source, plan: body.data.level ?? null, windows } : null;
}

// DeepSeek 开放平台：GET https://api.deepseek.com/user/balance（Bearer），balance_infos[] 每项是一个币种钱包。
const deepseekBalance = z.object({
  is_available: z.boolean(),
  balance_infos: z.array(z.object({ currency: z.string(), total_balance: z.string(), granted_balance: z.string(), topped_up_balance: z.string() })),
});
export function parseDeepSeekBalance(raw: unknown, source: string): Quota {
  const body = deepseekBalance.parse(raw);
  // balance_infos 的顺序不稳定：同一账户会在 [CNY, USD] 与 [USD, CNY] 之间变化，取第一项会随机把 ¥ 余额显示成 USD 0.00。
  // 人民币是主钱包；没有人民币余额时显示任何有余额的钱包，全为零才退回第一项。
  const { balance_infos: wallets } = body;
  const funded = wallets.filter(wallet => Number(wallet.total_balance) > 0);
  const info = funded.find(wallet => wallet.currency === 'CNY') ?? funded[0] ?? wallets.find(wallet => wallet.currency === 'CNY') ?? wallets[0];
  if (!info) return null;
  return { kind: 'balance', source, currency: info.currency, total: info.total_balance, granted: info.granted_balance, toppedUp: info.topped_up_balance };
}

export type NativeRoute = { provider?: string; baseURL?: string; apiKey: string; source: string };
/**
 * Default endpoint and credential variable each supported provider already carries, keyed by provider route id.
 * Provider catalog defaults may be absent from the host's live settings fields;
 * a route with only `apiKeyEnv` uses its provider's default endpoint.
 * Sources: `@earendil-works/pi-ai` dist/providers/{zai-coding-cn,zai,deepseek}.js and
 * `@deepseek-ai/dsh-llm-deepseek` src/config.ts.
 */
const providerDefaults: Record<string, { baseURL: string; apiKeyEnv: string }> = {
  'zai-coding-cn': { baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4', apiKeyEnv: 'ZAI_CODING_CN_API_KEY' },
  zai: { baseURL: 'https://api.z.ai/api/coding/paas/v4', apiKeyEnv: 'ZAI_API_KEY' },
  deepseek: { baseURL: 'https://api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY' },
  'deepseek-official': { baseURL: 'https://api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY' },
};
/** One probeable native route: the provider id plus the user's settings section with the provider's own defaults filled in. */
export function nativeQuotaRoute(provider: string, section?: { baseURL?: string; apiKeyEnv?: string }): { provider: string; baseURL: string | undefined; apiKeyEnv: string | undefined } {
  const defaults = providerDefaults[provider];
  return { provider, baseURL: section?.baseURL ?? defaults?.baseURL, apiKeyEnv: section?.apiKeyEnv ?? defaults?.apiKeyEnv };
}

/** Picks the quota probe for a native provider route by its endpoint host; unknown hosts report nothing. */
export async function fetchNativeQuota(route: NativeRoute, fetchImpl: typeof fetch = fetch): Promise<Quota> {
  const baseURL = route.baseURL ?? (route.provider ? providerDefaults[route.provider]?.baseURL : undefined);
  if (!baseURL) return null;
  let host: string;
  try { host = new URL(baseURL).host; } catch { return null; }
  const get = async (url: string, authorization: string) => {
    const response = await fetchImpl(url, { headers: { Accept: 'application/json', Authorization: authorization }, redirect: 'error', signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`${host} 额度查询失败：HTTP ${response.status}`);
    return response.json();
  };
  if (host === 'open.bigmodel.cn') return parseZaiQuota(await get('https://open.bigmodel.cn/api/monitor/usage/quota/limit', route.apiKey), route.source);
  if (host === 'api.z.ai') return parseZaiQuota(await get('https://api.z.ai/api/monitor/usage/quota/limit', `Bearer ${route.apiKey}`), route.source);
  if (host === 'api.deepseek.com') return parseDeepSeekBalance(await get('https://api.deepseek.com/user/balance', `Bearer ${route.apiKey}`), route.source);
  return null;
}
