/**
 * The two ACP agents this plugin ships: codex-acp over the user's Codex CLI and claude-agent-acp over the user's Claude
 * Code CLI. Account quota windows are not on the ACP wire, so each profile keeps a native probe for them.
 */
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { AvailableCommand } from '@agentclientprotocol/sdk';
import pkg from '../package.json' with { type: 'json' };
import type { HarnessAccountSnapshot } from './contracts.js';
import { feedbackInstructions } from './feedback.js';
import { CodexRpc } from './codex-rpc.js';
import { ClaudeInspector, ClaudeNotInstalledError, resolveClaudeExecutable, withNodeOnPath, withUserShellEnvironment } from './claude-sdk.js';
import type { AcpProfile } from './acp-adapter.js';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const bundled = (name: string) => fileURLToPath(new URL(`./${name}`, import.meta.url));

// ── Codex ───────────────────────────────────────────────────────────────────────────────────────────────────────────

// Official app-server protocol (`codex app-server generate-ts`): v2/GetAccountRateLimitsResponse, RateLimitSnapshot, RateLimitWindow.
const rateLimitWindow = z.object({ usedPercent: z.number(), windowDurationMins: z.number().nullable(), resetsAt: z.number().nullable() }).passthrough();
const rateLimits = z.object({
  rateLimits: z.object({ limitName: z.string().nullable().optional(), primary: rateLimitWindow.nullable(), secondary: rateLimitWindow.nullable(), planType: z.string().nullable().optional() }).passthrough(),
}).passthrough();
/** Codex reports one reset instant per window; the protocol pins the type to int64 without a unit, so seconds are widened to ms. */
const resetIso = (value: number | null) => value === null ? {} : { resetsAt: new Date(value < 1e12 ? value * 1000 : value).toISOString() };
const periodOf = (mins: number | null) => mins === 300 ? 'five_hour' as const : mins === 10080 ? 'seven_day' as const : mins === 43200 ? 'monthly' as const : 'unknown' as const;
const windowLabel = (mins: number | null) => mins === 300 ? '5-hour window' : mins === 10080 ? '7-day window' : mins === null ? 'Rate limit' : `${mins}-minute window`;
/** Maps `account/rateLimits/read` onto the shared account snapshot: primary window as credits, the secondary as product usage. */
export function codexAccountSnapshot(raw: unknown): HarnessAccountSnapshot | null {
  const { rateLimits: limits } = rateLimits.parse(raw);
  const primary = limits.primary ?? limits.secondary;
  if (!primary) return null;
  const secondary = limits.primary ? limits.secondary : null;
  return {
    ...(limits.planType ? { plan: limits.planType } : {}),
    credits: {
      usedPercent: primary.usedPercent, periodType: periodOf(primary.windowDurationMins), ...resetIso(primary.resetsAt),
      ...(secondary ? { productUsage: [{ product: windowLabel(secondary.windowDurationMins), usagePercent: secondary.usedPercent, ...resetIso(secondary.resetsAt) }] } : {}),
    },
  };
}
/** Rolling ChatGPT rate-limit windows of the signed-in Codex account, read through a short-lived app-server. */
async function codexAccount(command: string, environment: NodeJS.ProcessEnv): Promise<HarnessAccountSnapshot | null> {
  const rpc = new CodexRpc({ command, cwd: process.cwd(), environment, requestTimeoutMs: 30_000, shutdownTimeoutMs: 2_000, maxFrameBytes: 16 * 1024 * 1024, onMessage: () => {}, onFault: () => {} });
  try {
    await rpc.request('initialize', { clientInfo: { name: pkg.name, version: pkg.version, title: 'DSH Harness Plugin' }, capabilities: {} });
    rpc.send({ method: 'initialized', params: {} });
    return codexAccountSnapshot(await rpc.request('account/rateLimits/read', {}));
  } finally { await rpc.close(); }
}

/**
 * Both agents would otherwise spend a model request on naming every new session; DSH keeps its own titles, so the
 * native thread is named after the first prompt line instead.
 */
export function codexProfile(options: { command: string; environment: NodeJS.ProcessEnv }): AcpProfile {
  return {
    harnessId: 'codex',
    spawn: environment => ({ command: process.execPath, args: [bundled('codex-acp.mjs')], env: { ...environment, CODEX_PATH: options.command } }),
    // codex-acp exposes no developer-instruction channel; the first prompt of a new thread carries the feedback contract.
    firstPromptPrefix: feedbackInstructions,
    legacyPermissionModes: { readOnly: 'read-only', workspaceWrite: 'agent', dangerFullAccess: 'agent-full-access' },
    skillName: (command: AvailableCommand) => command.name.startsWith('$') ? command.name.slice(1) : command.name,
    // Codex injects a skill only for its own `$skill` mention; the local `/name` spelling of other commands stays as is.
    skillInvocation: (command: AvailableCommand) => command.name.startsWith('$') ? command.name : `/${command.name}`,
    titleCommand: title => `/rename ${title}`,
    inspectAccount: () => codexAccount(options.command, options.environment),
  };
}

// ── Claude Code ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Native plan limits only; session cost is not account quota. */
export function claudeAccountSnapshot(usage: { rate_limits_available?: boolean; rate_limits?: unknown; subscription_type?: string | null }, email?: string): HarnessAccountSnapshot | null {
  if (!usage.rate_limits_available || !isRecord(usage.rate_limits)) return null;
  const limits = usage.rate_limits;
  const windows: Array<{ product: string; periodType: 'five_hour' | 'seven_day'; usagePercent: number; resetsAt?: string }> = [];
  const add = (product: string, periodType: 'five_hour' | 'seven_day', value: unknown) => {
    if (!isRecord(value) || typeof value.utilization !== 'number' || !Number.isFinite(value.utilization) || value.utilization < 0 || value.utilization > 100) return;
    windows.push({ product, periodType, usagePercent: value.utilization,
      ...(typeof value.resets_at === 'string' && Number.isFinite(Date.parse(value.resets_at)) ? { resetsAt: value.resets_at } : {}) });
  };
  add('5-hour window', 'five_hour', limits.five_hour);
  add('7-day window', 'seven_day', limits.seven_day);
  add('OAuth apps · 7-day', 'seven_day', limits.seven_day_oauth_apps);
  add('Opus · 7-day', 'seven_day', limits.seven_day_opus);
  add('Sonnet · 7-day', 'seven_day', limits.seven_day_sonnet);
  for (const window of Array.isArray(limits.model_scoped) ? limits.model_scoped : []) {
    if (isRecord(window) && typeof window.display_name === 'string') add(`${window.display_name} · 7-day`, 'seven_day', window);
  }
  const [primary, ...others] = windows;
  if (!primary) return null;
  const generic = primary.product === '5-hour window' || primary.product === '7-day window';
  return {
    ...(email ? { email } : {}), ...(usage.subscription_type ? { plan: usage.subscription_type } : {}),
    credits: {
      usedPercent: primary.usagePercent, periodType: primary.periodType, ...(!generic ? { label: primary.product } : {}),
      ...(primary.resetsAt ? { resetsAt: primary.resetsAt } : {}),
      ...(others.length ? { productUsage: others.map(({ product, usagePercent, resetsAt }) => ({ product, usagePercent, ...(resetsAt ? { resetsAt } : {}) })) } : {}),
    },
  };
}

export function claudeProfile(options: { environment: NodeJS.ProcessEnv; command?: string }): AcpProfile {
  const environment = withUserShellEnvironment({ ...options.environment });
  const executable = (env: NodeJS.ProcessEnv) => {
    try { return resolveClaudeExecutable(env, options.command); }
    catch (cause) { throw cause instanceof ClaudeNotInstalledError ? { code: 'notInstalled', message: cause.message } : cause; }
  };
  return {
    harnessId: 'claude-code',
    spawn: raw => {
      const env = withUserShellEnvironment({ ...raw });
      return { command: process.execPath, args: [bundled('claude-agent-acp.mjs')], env: withNodeOnPath({ ...env, CLAUDE_CODE_EXECUTABLE: executable(env), CLAUDE_AGENT_SDK_CLIENT_APP: `${pkg.name}/${pkg.version}` }) };
    },
    // The same system-prompt append the SDK adapter used; ACP forwards it through the agent's own options channel.
    sessionMeta: () => ({ systemPrompt: { append: feedbackInstructions } }),
    legacyThinkingOptions: { auto: 'default', off: 'default' },
    titleCommand: title => `/rename ${title}`,
    inspectAccount: async () => {
      const inspector = new ClaudeInspector({ environment, cwd: process.cwd(), closeTimeoutMs: 7_000, ...(options.command ? { command: options.command } : {}) });
      try {
        const account = await inspector.account();
        return account && claudeAccountSnapshot(account.usage, account.email);
      } finally { await inspector.close().catch(() => {}); }
    },
  };
}
