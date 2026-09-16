import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import type {} from '@deepseek-ai/dsh-api-remotes/client';
import type {} from '@deepseek-ai/dsh-api-session-controller/client';
import type {} from '@deepseek-ai/dsh-client-locale/client';
import type {} from '@deepseek-ai/dsh-client-ui-settings/client';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type { PropsRuntime, PropsLocale, InjectFace } from '@deepseek-ai/dsh-client-ui-slots';
import { contribution, type stateSchema, type modelsSchema, type usageSchema, type quotaSchema, type secretStatusSchema } from './remote.js';
import type { z } from 'zod';

type State = z.infer<typeof stateSchema>;
type Models = z.infer<typeof modelsSchema>;
type Usage = z.infer<typeof usageSchema>;
type Quota = z.infer<typeof quotaSchema>;
type SecretStatus = z.infer<typeof secretStatusSchema>;
type Api = {
  recover(request: {sessionId: string; action: 'check' | 'unlock'}): Promise<RemoteResult<State & {detail: string}>>;
  secretStatus(request: {sessionId: string}): Promise<RemoteResult<SecretStatus>>;
  answerSecret(request: {sessionId: string; id: string; answers: Record<string,string[]>; cancelled?: boolean}): Promise<RemoteResult<{accepted: boolean}>>;
  state(request: {sessionId: string}): Promise<RemoteResult<State>>;
  select(request: {sessionId: string; harness: State['harness']}): Promise<RemoteResult<State>>;
  models(request: {sessionId: string}): Promise<RemoteResult<Models>>;
  selectModel(request: {sessionId: string; model: string}): Promise<RemoteResult<State>>;
  selectThinking(request: {sessionId: string; thinking: string}): Promise<RemoteResult<State>>;
  selectPermission(request: {sessionId: string; permission: string}): Promise<RemoteResult<State>>;
  selectConfig(request: {sessionId: string; configId: string; value: string | boolean}): Promise<RemoteResult<State>>;
  usage(request: {sessionId: string}): Promise<RemoteResult<Usage>>;
  quota(request: {sessionId: string}): Promise<RemoteResult<Quota>>;
};
const zh = {
  harness: '选择 Harness', model: '选择 Harness 模型', native: 'DSH 原生', defaultModel: '默认模型',
  retry: '重试', locked: '开始对话后 Harness 固定；切换请新建会话',
  recovery: '上次请求结果未确认，已暂停发送以避免重复执行。', loading: '加载中',
  menuModel: '模型', menuEffort: '强度', effortDefault: '默认', emptyModels: '没有可用模型', emptyEfforts: '当前模型不支持调整强度',
  fastMode: '快速模式', collaborationMode: '协作模式', enabled: '开启', disabled: '关闭',
  'effort.off': '关闭', 'effort.auto': '自动', 'effort.minimal': '极低', 'effort.low': '低', 'effort.medium': '中',
  'effort.high': '高', 'effort.xhigh': '极高', 'effort.max': '最大', 'effort.ultra': '极限', 'effort.default': '默认',
  permissionAria: '权限模式', 'mode.plan': '计划模式', 'mode.default': '默认', 'mode.acceptEdits': '接受编辑', 'mode.auto': '自动',
  'mode.bypassPermissions': '完全权限', 'mode.dangerFullAccess': '完全权限', 'mode.workspaceWrite': '工作区可写', 'mode.readOnly': '只读',
  'mode.agent-full-access': '完全权限', 'mode.agent': '自动审批', 'mode.read-only': '逐项审批',
  contextAria: '上下文', contextUsed: '上下文已用', contextWindow: '模型窗口', sessionTotal: '本会话累计',
  quotaAria: '额度', quotaUsed: '已用', quotaLeft: '剩余', quotaReset: '{time} 重置', balance: '余额', balanceTotal: '账户余额',
  balanceTopped: '充值余额', balanceGranted: '赠送余额', quotaSource: '额度由 {source} 提供 · 每 60 秒同步',
  'window.five_hour': '5 小时', 'window.seven_day': '本周', 'window.weekly': '本周', 'window.monthly': '本月', 'window.unknown': '额度',
  'window.5-hour window': '5 小时', 'window.7-day window': '本周', 'window.Opus · 7-day': 'Opus 本周', 'window.Sonnet · 7-day': 'Sonnet 本周',
  'window.OAuth apps · 7-day': 'OAuth 应用本周',
};
const en: Record<keyof typeof zh,string> = {
  harness:'Select Harness', model:'Select Harness model', native:'Native DSH', defaultModel:'Default model',
  retry:'Retry', locked:'Harness is fixed after the first prompt. Start a new session to switch.',
  recovery:'The previous request was not confirmed. Sending is paused to avoid duplicate execution.', loading:'Loading',
  menuModel:'Model', menuEffort:'Effort', effortDefault:'Default', emptyModels:'No models available', emptyEfforts:'This model has no effort levels',
  fastMode:'Fast mode', collaborationMode:'Collaboration mode', enabled:'On', disabled:'Off',
  'effort.off':'Off', 'effort.auto':'Auto', 'effort.minimal':'Minimal', 'effort.low':'Low', 'effort.medium':'Medium',
  'effort.high':'High', 'effort.xhigh':'Extra High', 'effort.max':'Max', 'effort.ultra':'Ultra', 'effort.default':'Default',
  permissionAria:'Permission mode', 'mode.plan':'Plan mode', 'mode.default':'Default', 'mode.acceptEdits':'Accept edits', 'mode.auto':'Auto mode',
  'mode.bypassPermissions':'Full access', 'mode.dangerFullAccess':'Full access', 'mode.workspaceWrite':'Workspace write', 'mode.readOnly':'Read-only',
  'mode.agent-full-access':'Full access', 'mode.agent':'Approve for me', 'mode.read-only':'Ask for approval',
  contextAria:'Context', contextUsed:'Context used', contextWindow:'Model window', sessionTotal:'Session total',
  quotaAria:'Quota', quotaUsed:'Used', quotaLeft:'Left', quotaReset:'Resets {time}', balance:'Balance', balanceTotal:'Account balance',
  balanceTopped:'Topped up', balanceGranted:'Granted', quotaSource:'Quota from {source} · refreshed every 60s',
  'window.five_hour':'5-hour', 'window.seven_day':'Weekly', 'window.weekly':'Weekly', 'window.monthly':'Monthly', 'window.unknown':'Quota',
  'window.5-hour window':'5-hour', 'window.7-day window':'Weekly', 'window.Opus · 7-day':'Opus weekly', 'window.Sonnet · 7-day':'Sonnet weekly',
  'window.OAuth apps · 7-day':'OAuth apps weekly',
};
type Key = keyof typeof zh;
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { harness: Key }
}
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap { harness: Api }
}
export const inject = ['remote', 'slots', 'locale'];
async function value<T>(promise: Promise<RemoteResult<T>>): Promise<T> {
  const result = await promise;
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
interface Injected {
  recover(id: string, action: 'check' | 'unlock'): Promise<State & {detail: string}>;
  secretStatus(id: string): Promise<SecretStatus>;
  answerSecret(id: string, question: string, answers: Record<string,string[]>, cancelled?: boolean): Promise<{accepted: boolean}>;
  read(id: string): Promise<State>;
  select(id: string, harness: State['harness']): Promise<State>;
  models(id: string): Promise<Models>;
  selectModel(id: string, model: string): Promise<State>;
  selectThinking(id: string, thinking: string): Promise<State>;
  selectPermission(id: string, permission: string): Promise<State>;
  selectConfig(id: string, configId: string, value: string | boolean): Promise<State>;
  usage(id: string): Promise<Usage>;
  quota(id: string): Promise<Quota>;
  changed(id: string, external: boolean): void;
  /** Fires after any selection made in a sibling seat; seats reload their state on it. */
  subscribe(listener: () => void): () => void;
}
type T = (key: Key, params?: Record<string, unknown>) => string;
type LeftProps = PropsRuntime<'conversation.input.left'> & PropsLocale<'harness'> & InjectFace<Injected>;
type ModelProps = PropsRuntime<'conversation.input.model'> & PropsLocale<'harness'> & InjectFace<Injected>;
type PermissionProps = PropsRuntime<'conversation.input.permission'> & PropsLocale<'harness'> & InjectFace<Injected>;

// ---- shared chrome (copies the host's ModelSelect / PermissionSelect / ContextMeter geometry) ----
const Chevron = ({ open }: { open?: boolean }) => <svg className={`hp-chevron${open ? ' hp-chevron-open' : ''}`} width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden><path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>;
const ChevronRight = () => <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden><path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>;
const Back = () => <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden><path d="M10 4L6 8l4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>;
const Check = () => <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden><path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>;
const icons: Record<string, ReactNode> = {
  clock: <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden><circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.4"/><path d="M8 4.5V8l2.5 1.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>,
  calendar: <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden><rect x="2" y="3" width="12" height="11" rx="1.6" stroke="currentColor" strokeWidth="1.4"/><path d="M2 6.5h12M5 1.8v2.4M11 1.8v2.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>,
  sparkle: <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden><path d="M8 2l1.4 3.6L13 7l-3.6 1.4L8 12l-1.4-3.6L3 7l3.6-1.4L8 2z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/></svg>,
  wallet: <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden><path d="M2.5 5A1.5 1.5 0 014 3.5h8A1.5 1.5 0 0113.5 5v6A1.5 1.5 0 0112 12.5H4A1.5 1.5 0 012.5 11V5z" stroke="currentColor" strokeWidth="1.4"/><path d="M9.5 8h4" stroke="currentColor" strokeWidth="1.4"/><circle cx="10.5" cy="8" r=".9" fill="currentColor"/></svg>,
};
const windowIcon = (id: string) => id === 'five_hour' ? icons.clock : id.startsWith('product:') && !id.includes('7-day window') ? icons.sparkle : icons.calendar;
const windowLabel = (t: T, id: string, label: string) => {
  const key = `window.${id.startsWith('product:') ? label : id}` as Key;
  if (key in zh) return t(key);
  const generic = label.match(/^(.*) · 7-day$/);
  return generic ? `${generic[1]} ${t('window.seven_day')}` : label;
};
const effortLabel = (t: T, id: string, fallback: string) => { const key = `effort.${id}` as Key; return key in zh ? t(key) : fallback; };
const modeLabel = (t: T, id: string, fallback: string) => { const key = `mode.${id}` as Key; return key in zh ? t(key) : fallback; };
const configLabel = (t: T, id: string, fallback: string) => id === 'fast' || id === 'fast-mode' ? t('fastMode') : id === 'collaboration_mode' ? t('collaborationMode') : fallback;
const configValueLabel = (t: T, value: string | boolean, fallback?: string) => typeof value === 'boolean' ? t(value ? 'enabled' : 'disabled')
  : value === 'default' ? t('mode.default') : value === 'plan' ? t('mode.plan') : fallback ?? value;
// Copied from the host's PermissionSelect glyphs (dsh-client-ui-primitives SHIELD_OUTLINE_PATH + mode marks) so external
// Harness rows show the same shields as DSH native: check = read-only / plan, pencil = write, exclamation = full access.
const SHIELD = 'M8.20554 0.899994L14.7901 3.36857V7.01026C14.7901 12 11.0466 14.2103 8.20554 15.3C5.36446 14.2103 1.62012 12 1.62012 7.01026V3.36857L8.20554 0.899994Z';
const Shield = ({ kind }: { kind: 'full' | 'check' | 'write' }) => <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
  {kind !== 'write' && <path d={SHIELD} stroke="currentColor" strokeWidth="1.31831" strokeLinejoin="round"/>}
  {kind === 'full' && <><path d="M9.10094 4.5V8.75939H7.59888V4.5H9.10094Z" fill="currentColor"/><path d="M9.10094 9.8114V11.5H7.59888V9.8114H9.10094Z" fill="currentColor"/></>}
  {kind === 'check' && <path d="M12.1654 5.7552L8.9447 9.41475C8.73044 9.65816 8.53628 9.8804 8.35774 10.0423C8.1713 10.2114 7.94235 10.3717 7.64016 10.4254C7.48207 10.4535 7.32 10.4552 7.16151 10.4294C6.85843 10.3801 6.62728 10.2223 6.43836 10.0559C6.25752 9.89653 6.06037 9.67732 5.84264 9.43705L4.72925 8.20897L5.63557 7.38707L6.74897 8.61594C6.98603 8.87755 7.12974 9.03533 7.24673 9.13839C7.31033 9.19443 7.34485 9.21476 7.35823 9.22122C7.38068 9.22484 7.40352 9.22515 7.42593 9.22122C7.40522 9.22502 7.42893 9.23294 7.53583 9.136C7.65132 9.03126 7.79316 8.87139 8.02643 8.60638L11.2479 4.94763L12.1654 5.7552Z" fill="currentColor"/>}
  {kind === 'write' && <>
    <path d="M8.08887 0.251709C8.20479 0.23085 8.32486 0.241168 8.43652 0.282959L15.0215 2.75171C15.2787 2.84819 15.4492 3.09414 15.4492 3.3689V7.0105C15.4492 7.10986 15.4441 7.2081 15.4414 7.30542C15.0285 7.07175 14.5905 6.87695 14.1309 6.73022V3.82495L8.20508 1.60327L2.2793 3.82495V7.0105C2.27936 9.7171 3.4745 11.5379 5.02734 12.7947C5.01025 12.9942 5 13.1962 5 13.4001C5.00001 13.7617 5.02722 14.1169 5.08008 14.4636C2.91555 13.0393 0.961014 10.752 0.960938 7.0105V3.3689C0.960938 3.09417 1.13146 2.84821 1.38867 2.75171L7.97461 0.282959L8.08887 0.251709Z" fill="currentColor"/>
    <path d="M11.3525 5.64688V6.85688H5V5.64688H11.3525Z" fill="currentColor"/><path d="M9.5824 8.29376V9.50376H5V8.29376H9.5824Z" fill="currentColor"/>
    <path d="M14.6647 15.6852H10.0338C10.3878 15.3751 10.7567 15.0517 11.0772 14.7706C11.2531 14.6164 11.4144 14.4746 11.5511 14.3547H14.6647V15.6852Z" fill="currentColor"/>
    <path d="M8.14852 14.1308L7.33925 15.4976C7.22458 15.6912 7.42245 15.9194 7.63037 15.8333L9.09785 15.2254L15.0399 10.0719L14.0905 8.97733L8.14852 14.1308Z" fill="currentColor"/>
  </>}
</svg>;
const shieldKind = (id: string, dangerous: boolean) => dangerous || id === 'dangerFullAccess' || id === 'agent-full-access' ? 'full' : id === 'plan' || id === 'readOnly' || id === 'read-only' ? 'check' : 'write';
const compact = (tokens: number) => tokens < 1000 ? String(tokens) : tokens < 1_000_000 ? `${Math.round(tokens / 100) / 10}K` : `${Math.round(tokens / 100_000) / 10}M`;
const clock = (iso: string | null) => {
  if (!iso) return null;
  const date = new Date(iso), now = new Date();
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return date.toDateString() === now.toDateString() ? time : `${date.getMonth() + 1}/${date.getDate()} ${time}`;
};

/** Closes on outside pointer-down or Escape while `open`, the same one-listener pattern as the host's ContextMeter. */
function useDismiss(open: boolean, close: () => void, ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => { if (!(event.target instanceof Node && ref.current?.contains(event.target))) close(); };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    document.addEventListener('pointerdown', onPointerDown); document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('pointerdown', onPointerDown); document.removeEventListener('keydown', onKeyDown); };
  }, [open, close, ref]);
}
function Option({ icon, label, hint, selected, disabled, onClick }: { icon?: ReactNode; label: string; hint?: string; selected: boolean; disabled?: boolean; onClick: () => void }) {
  return <button type="button" role="menuitemradio" aria-checked={selected} className="hp-option" disabled={disabled} onClick={onClick}>
    {icon && <span className="hp-option-icon">{icon}</span>}
    <span className="hp-option-copy"><span className="hp-option-name">{label}</span>{hint && <span className="hp-option-hint">{hint}</span>}</span>
    <span className="hp-check">{selected ? <Check /> : null}</span>
  </button>;
}
function Cell({ label, value, onClick }: { label: string; value: string; onClick: () => void }) {
  return <button type="button" role="menuitem" className="hp-cell" onClick={onClick}>
    <span className="hp-cell-label">{label}</span><span className="hp-cell-value">{value}</span><span className="hp-cell-chevron"><ChevronRight /></span>
  </button>;
}

/** Polls `load` while mounted: immediately, on every dependency change, and every `everyMs`. */
function usePolled<V>(load: () => Promise<V>, everyMs: number, deps: unknown[]): V | undefined {
  const [state, setState] = useState<V>();
  useEffect(() => {
    let live = true;
    const tick = () => { void load().then(next => { if (live) setState(next); }).catch(() => {}); };
    tick();
    const timer = setInterval(tick, everyMs);
    return () => { live = false; clearInterval(timer); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

const RADIUS = 5.5, CIRCUMFERENCE = 2 * Math.PI * RADIUS;

// ---- quota chip: one 28px chip after the Harness chip, showing the tightest window (or the balance) ----
/** Classify consumed capacity: quota remaining <=30% / <=10%, context used >=70% / >=90%. */
const tier = (percent: number) => percent >= 90 ? ' hp-danger' : percent >= 70 ? ' hp-warn' : '';
function QuotaChip({ quota, t }: { quota: Quota | undefined; t: T }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, root);
  if (!quota) return null;
  let trigger: ReactNode, panel: ReactNode, level = '';
  if (quota.kind === 'balance') {
    trigger = <>{icons.wallet}<span>{t('balance')} {quota.currency === 'CNY' ? '¥' : '$'}{quota.total}</span></>;
    panel = <>
      <div className="hp-panel-head"><span className="hp-panel-icon">{icons.wallet}</span><span className="hp-panel-title">{t('balanceTotal')}</span><span className="hp-figure">{quota.currency} {quota.total}</span></div>
      <dl className="hp-rows"><div className="hp-row"><dt>{t('balanceTopped')}</dt><dd>{quota.toppedUp}</dd></div><div className="hp-row"><dt>{t('balanceGranted')}</dt><dd>{quota.granted}</dd></div></dl>
    </>;
  } else {
    if (!quota.windows.length) return null;
    const tight = quota.windows.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a));
    level = tier(tight.usedPercent);
    // Windows read as what is left: the chip and bars shrink toward empty as the quota runs out.
    const left = (percent: number) => Math.max(0, 100 - Math.round(percent));
    // The chip lists the plan-wide windows (5-hour, weekly); per-model windows stay in the panel. Color follows the tightest.
    const headline = quota.windows.filter(window => !window.id.startsWith('product:')).slice(0, 2);
    const shown = headline.length ? headline : [tight];
    trigger = <>
      {windowIcon(shown[0]!.id)}
      {shown.map((window, index) => <span key={window.id} className={index ? 'hp-chip-effort' : undefined}>{index ? '· ' : ''}{windowLabel(t, window.id, window.label)} {left(window.usedPercent)}%</span>)}
      <svg className={`hp-quota-ring${level}`} width="14" height="14" viewBox="0 0 14 14" aria-hidden>
        <circle className="hp-track" cx="7" cy="7" r={RADIUS} />
        <circle className="hp-fill" cx="7" cy="7" r={RADIUS} strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * tight.usedPercent / 100} transform="rotate(-90 7 7)" />
      </svg>
    </>;
    panel = quota.windows.map((window, index) => {
      const reset = clock(window.resetsAt);
      return <div key={window.id} className={index ? 'hp-section' : undefined}>
        <div className="hp-panel-head"><span className="hp-panel-icon">{windowIcon(window.id)}</span><span className="hp-panel-title">{windowLabel(t, window.id, window.label)}</span>
          <span className={`hp-figure${tier(window.usedPercent)}`}>{t('quotaLeft')} {left(window.usedPercent)}%</span></div>
        <div className="hp-bar"><span className={`hp-bar-fill${tier(window.usedPercent)}`} style={{ width: `${left(window.usedPercent)}%` }} /></div>
        <div className="hp-row hp-muted"><span>{t('quotaUsed')} {Math.min(100, Math.round(window.usedPercent))}%</span>{reset && <span>{t('quotaReset', { time: reset })}</span>}</div>
      </div>;
    });
  }
  return <div ref={root} className="hp-anchor">
    <button type="button" className={`hp-chip${level}`} aria-label={t('quotaAria')} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(v => !v)}>
      {trigger}<Chevron open={open} />
    </button>
    {open && <div className="hp-panel hp-panel-left" role="dialog" aria-label={t('quotaAria')}>
      {panel}
      <div className="hp-foot">{t('quotaSource', { source: quota.kind === 'windows' && quota.plan ? `${quota.source} · ${quota.plan}` : quota.source })}</div>
    </div>}
  </div>;
}

// ---- context ring (host ContextMeter geometry: 28px trigger, 14px ring, 264px panel) ----
function ContextRing({ usage, t }: { usage: Usage | undefined; t: T }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, root);
  if (!usage || usage.contextUsedTokens === null || !usage.contextWindowTokens) return null;
  const ratio = Math.min(1, usage.contextUsedTokens / usage.contextWindowTokens);
  const percent = Math.round(ratio * 100), level = tier(ratio * 100);
  return <span ref={root} className="hp-anchor">
    <button type="button" className={`hp-ring${level}`} aria-label={`${t('contextUsed')} ${percent}%`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(v => !v)}>
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
        <circle className="hp-track" cx="7" cy="7" r={RADIUS} />
        <circle className="hp-fill" cx="7" cy="7" r={RADIUS} strokeDasharray={CIRCUMFERENCE} strokeDashoffset={CIRCUMFERENCE * (1 - ratio)} transform="rotate(-90 7 7)" />
      </svg>
    </button>
    {open && <div className="hp-panel hp-panel-right" role="dialog" aria-label={t('contextAria')}>
      <div className="hp-panel-head"><span className="hp-muted">{t('contextUsed')}</span><span className={`hp-percent${level}`}>{percent}%</span>
        <span className="hp-figure">{compact(usage.contextUsedTokens)} / {compact(usage.contextWindowTokens)}</span></div>
      <div className="hp-bar hp-bar-context"><span className={`hp-bar-fill hp-bar-messages${level}`} style={{ width: `${percent}%` }} /></div>
      <dl className="hp-rows">
        <div className="hp-row"><dt>{t('contextWindow')}</dt><dd>{compact(usage.contextWindowTokens)}</dd></div>
        {usage.totalTokens !== null && <div className="hp-row"><dt>{t('sessionTotal')}</dt><dd>{compact(usage.totalTokens)} tokens</dd></div>}
      </dl>
    </div>}
  </span>;
}

function SessionRecovery({ sessionId, recover, running, onChange }: {
  sessionId: string; recover: Injected['recover']; running: boolean; onChange: (state: State) => void;
}) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [detail, setDetail] = useState('');
  const root = useRef<HTMLSpanElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, root);
  async function act(operation: 'check' | 'unlock') {
    setBusy(true); setDetail('');
    try {
      const state = await recover(sessionId, operation);
      onChange(state); setDetail(state.detail);
    } catch (error) { setDetail(error instanceof Error ? error.message : '操作失败'); }
    finally { setBusy(false); }
  }
  return <span className="hp-anchor" ref={root}>
    <button type="button" className="hp-chip" aria-expanded={open} aria-label="恢复会话" onClick={() => setOpen(!open)}>恢复会话</button>
    {open && <div className="hp-panel hp-panel-left" role="dialog" aria-label="恢复会话">
      <p>上次请求结果未确认。先核对原生记录；手动解除暂停会保留原生上下文，不重发原请求。</p>
      <button disabled={busy || running} onClick={() => void act('check')}>核对原生记录</button>
      <button disabled={busy || running} onClick={() => void act('unlock')}>解除暂停，不重发</button>
      {detail && <p role="status" style={{whiteSpace:'pre-wrap',maxHeight:240,overflow:'auto'}}>{detail}</p>}
    </div>}
  </span>;
}

/** Password values remain in the form DOM until submission; never put them in a draft/store. */
export function SecretPanel({ sessionId, read, answer }: { sessionId: string; read: Injected['secretStatus']; answer: Injected['answerSecret'] }) {
  const pending = usePolled(() => read(sessionId), 1000, [sessionId]);
  const [closed, setClosed] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  if (!pending || pending.id === closed) return null;
  async function submit(form: HTMLFormElement, cancelled = false) {
    if (!pending) return;
    setBusy(true); setError(false);
    const data = new FormData(form);
    const answers: Record<string,string[]> = {};
    if (!cancelled) for (const question of pending.questions) {
      const values = data.getAll(question.id).map(String).filter(Boolean);
      const other = data.get(`${question.id}:other`);
      answers[question.id] = [...values, ...(other ? [String(other)] : [])];
    }
    form.reset();
    try { await answer(sessionId, pending.id, answers, cancelled); setClosed(pending.id); }
    catch { setError(true); }
    finally { setBusy(false); }
  }
  return <form key={pending.id} className="hp-secret" aria-label={pending.title} aria-busy={busy} autoComplete="off"
    onSubmit={event => { event.preventDefault(); void submit(event.currentTarget); }}>
    <strong>{pending.title}</strong>
    <p>保密答复仅发送给当前 Harness，不保存到 DSH 对话记录。</p>
    {pending.questions.map(question => <label key={question.id} style={{display:'block',margin:'8px 0'}}>
      {question.prompt}
      {question.type === 'text' ? <input name={question.id} type={question.secret ? 'password' : 'text'} required={!question.optional}
        placeholder={question.placeholder} autoComplete="off" disabled={busy} />
        : <><select name={question.id} multiple={question.multiple} required={!question.optional && !question.allowOther} disabled={busy} defaultValue={question.multiple ? [] : ''}>
          {!question.multiple && <option value="">请选择</option>}
          {question.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>{question.allowOther && <input name={`${question.id}:other`} aria-label="其他答复" disabled={busy}/>}</>}
    </label>)}
    {error && <p role="alert">提交失败，请检查问题是否已过期，重新填写后再提交。</p>}
    <button type="submit" disabled={busy}>提交</button>
    <button type="button" disabled={busy} onClick={event => { const form = event.currentTarget.form; if (form) void submit(form, true); }}>取消</button>
  </form>;
}

// ---- left slot: Harness chip + quota chip ----
const names: Record<State['harness'], string> = { dsh: '', codex: 'Codex', 'claude-code': 'Claude Code' };
export function HarnessSelect({ sessionId, useSessions, read, select, quota, changed, secretStatus, answerSecret, recover, t }: LeftProps) {
  const [state,setState] = useState<State>();
  const [error,setError] = useState<string>();
  const [busy,setBusy] = useState(false);
  const [open,setOpen] = useState(false);
  const generation = useRef(0);
  const root = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, root);
  const summary = useSessions(s => s.byId[sessionId]);
  useEffect(() => {
    const version = ++generation.current;
    setError(undefined);
    void read(sessionId).then(next => { if (generation.current === version) { setState(next); changed(sessionId, next.harness !== 'dsh'); } })
      .catch(error => { if (generation.current === version) setError(error instanceof Error ? error.message : String(error)); });
    return () => { generation.current++; };
  }, [sessionId,summary?.running,read,changed]);
  const quotaView = usePolled(() => quota(sessionId), 60_000, [sessionId, state?.harness, summary?.running]);
  async function choose(next: State['harness']) {
    const version = generation.current; setBusy(true); setError(undefined); setOpen(false);
    try {
      const result = await select(sessionId, next);
      if (generation.current !== version) return;
      setState(result); changed(sessionId, result.harness !== 'dsh');
    } catch(error) { if (generation.current === version) setError(error instanceof Error ? error.message : String(error)); }
    finally { if (generation.current === version) setBusy(false); }
  }
  const current = state?.harness ?? 'dsh';
  const disabled = !state || busy || state.locked || !!summary?.running || summary?.blank === false;
  return <div className="hp-root" aria-busy={busy || !state}>
    <div ref={root} className="hp-anchor">
      <button type="button" className="hp-chip" aria-label={t('harness')} aria-haspopup="menu" aria-expanded={open} title={disabled && state ? t('locked') : undefined}
        disabled={disabled} onClick={() => setOpen(v => !v)}>
        <span className="hp-chip-label">{current === 'dsh' ? t('native') : names[current]}</span><Chevron open={open} />
      </button>
      {open && <div className="hp-menu hp-menu-left" role="menu" aria-label={t('harness')}>
        {(['dsh', 'codex', 'claude-code'] as const).map(id => <Option key={id} label={id === 'dsh' ? t('native') : names[id]} selected={current === id} onClick={() => void choose(id)} />)}
      </div>}
    </div>
    <QuotaChip quota={quotaView} t={t} />
    {current !== 'dsh' && state?.recoveryRequired && <SessionRecovery key={`recovery:${sessionId}`} sessionId={sessionId} recover={recover} running={!!summary?.running} onChange={setState} />}
    <SecretPanel key={sessionId} sessionId={sessionId} read={secretStatus} answer={answerSecret} />
    {error && <span role="alert" className="hp-alert">{error}</span>}
    {state?.recoveryRequired && !summary?.running && <span role="status" className="hp-alert">{t('recovery')}</span>}
  </div>;
}

// ---- permission seat (external Harness only): Claude Code switches modes, Codex only reports its sandbox policy ----
export function HarnessPermission({ sessionId, locked, useSessions, read, models, selectPermission, subscribe, t }: PermissionProps) {
  const [state,setState] = useState<State>();
  const [catalog,setCatalog] = useState<Models>();
  const [error,setError] = useState<string>();
  const [busy,setBusy] = useState(false);
  const [open,setOpen] = useState(false);
  const [reload,setReload] = useState(0);
  const generation = useRef(0);
  const root = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, root);
  useEffect(() => subscribe(() => setReload(n => n + 1)), [subscribe]);
  const summary = useSessions(s => s.byId[sessionId]);
  useEffect(() => {
    const version = ++generation.current;
    setError(undefined);
    void read(sessionId).then(async next => {
      if (generation.current !== version) return;
      setState(next);
      if (next.harness === 'dsh') return;
      const list = await models(sessionId);
      if (generation.current === version) setCatalog(list);
    }).catch(error => { if (generation.current === version) setError(error instanceof Error ? error.message : String(error)); });
    return () => { generation.current++; };
  }, [sessionId,summary?.running,reload,read,models]);
  if (!state || state.harness === 'dsh') return null;
  const modes = catalog?.permissionModes ?? [];
  const current = modes.find(mode => mode.id === state.permission) ?? (state.permission ? { id: state.permission, label: state.permission, dangerous: false }
    : modes.find(mode => mode.id === catalog?.defaultPermissionModeId) ?? modes[0]);
  if (!current) return null;
  const selectable = modes.length > 0;
  const disabled = !selectable || locked || busy || !!summary?.running || state.recoveryRequired;
  async function choose(id: string) {
    const version = generation.current; setBusy(true); setError(undefined); close();
    try { const next = await selectPermission(sessionId, id); if (generation.current === version) setState(next); }
    catch(error) { if (generation.current === version) setError(error instanceof Error ? error.message : String(error)); }
    finally { if (generation.current === version) setBusy(false); }
  }
  return <div ref={root} className="hp-root">
    <div className="hp-anchor">
      <button type="button" className="hp-chip" aria-label={t('permissionAria')} aria-haspopup={selectable ? 'menu' : undefined} aria-expanded={selectable ? open : undefined}
        title={modeLabel(t, current.id, current.label)} disabled={disabled} onClick={() => setOpen(v => !v)}>
        <span className="hp-chip-icon"><Shield kind={shieldKind(current.id, current.dangerous)} /></span>
        <span className="hp-chip-label">{modeLabel(t, current.id, current.label)}</span>
        {selectable && <Chevron open={open} />}
      </button>
      {open && selectable && <div className="hp-menu hp-menu-left" role="menu" aria-label={t('permissionAria')}>
        {modes.map(mode => <Option key={mode.id} icon={<Shield kind={shieldKind(mode.id, mode.dangerous)} />} label={modeLabel(t, mode.id, mode.label)} selected={mode.id === current.id}
          onClick={() => { if (mode.id !== current.id) void choose(mode.id); else close(); }} />)}
      </div>}
    </div>
    {error && <span role="alert" className="hp-alert">{error}</span>}
  </div>;
}

// ---- model seat (external Harness only): context ring + "model · effort" chip with the host's two-level menu ----
export function HarnessModel({ sessionId, locked, useSessions, read, models, selectModel, selectThinking, selectConfig, usage, subscribe, t }: ModelProps) {
  const [state,setState] = useState<State>();
  const [catalog,setCatalog] = useState<Models>();
  const [error,setError] = useState<string>();
  const [busy,setBusy] = useState(false);
  const [open,setOpen] = useState(false);
  const [pane,setPane] = useState<'root' | 'model' | 'effort' | `config:${string}`>('root');
  const [reload,setReload] = useState(0);
  const generation = useRef(0);
  const root = useRef<HTMLDivElement>(null);
  const close = useCallback(() => { setOpen(false); setPane('root'); }, []);
  useEffect(() => subscribe(() => setReload(n => n + 1)), [subscribe]);
  useDismiss(open, close, root);
  const summary = useSessions(s => s.byId[sessionId]);
  useEffect(() => {
    const version = ++generation.current;
    setError(undefined);
    void read(sessionId).then(async next => {
      if (generation.current !== version) return;
      setState(next);
      if (next.harness === 'dsh') return;
      const list = await models(sessionId);
      if (generation.current === version) setCatalog(list);
    }).catch(error => { if (generation.current === version) setError(error instanceof Error ? error.message : String(error)); });
    return () => { generation.current++; };
  }, [sessionId,summary?.running,reload,read,models]);
  const usageView = usePolled(() => usage(sessionId), summary?.running ? 5_000 : 30_000, [sessionId, summary?.running]);
  async function choose(work: () => Promise<State>) {
    const version = generation.current; setBusy(true); setError(undefined); close();
    try { const next = await work(); if (generation.current === version) setState(next); }
    catch(error) { if (generation.current === version) setError(error instanceof Error ? error.message : String(error)); }
    finally { if (generation.current === version) setBusy(false); }
  }
  if (!state || state.harness === 'dsh') return null;
  const modelEntry = catalog?.models.find(model => model.id === (state.model ?? catalog.defaultModel?.id));
  const shown = modelEntry ?? (state.model ? undefined : catalog?.defaultModel ?? undefined);
  const modelLabel = state.model ? shown?.label ?? state.model : catalog ? shown?.label ?? t('defaultModel') : t('loading');
  const modelTitle = shown?.resolved && shown.resolved !== modelLabel ? `${modelLabel} (${shown.resolved})` : modelLabel;
  const efforts = (catalog?.thinkingOptions ?? []).filter(option => !modelEntry?.thinkingOptionIds || modelEntry.thinkingOptionIds.includes(option.id));
  const effective = state.thinking ?? catalog?.defaultThinkingOptionId ?? null;
  const effortOption = efforts.find(option => option.id === effective);
  const effortText = efforts.length ? (effortOption ? effortLabel(t, effortOption.id, effortOption.label) : effective ?? t('effortDefault')) : undefined;
  const configs = catalog?.configOptions ?? [];
  const disabled = locked || busy || !!summary?.running || state.recoveryRequired;
  return <div ref={root} className="hp-root hp-model-seat">
    <div className="hp-anchor">
      <button type="button" className="hp-chip" aria-label={t('model')} aria-haspopup="menu" aria-expanded={open} title={effortText ? `${modelTitle} · ${effortText}` : modelTitle}
        disabled={disabled} onClick={() => { if (open) close(); else { setPane('root'); setOpen(true); } }}>
        <span className="hp-chip-label">{modelLabel}</span>
        {effortText && <span className="hp-chip-effort">· {effortText}</span>}
        <Chevron open={open} />
      </button>
      {open && <div className="hp-menu hp-menu-right" role="menu" aria-label={t('model')} aria-busy={!catalog}>
        {pane === 'root' && <>
          <Cell label={t('menuModel')} value={modelLabel} onClick={() => setPane('model')} />
          {efforts.length > 0 && <Cell label={t('menuEffort')} value={effortText ?? ''} onClick={() => setPane('effort')} />}
          {configs.map(option => {
            const current = state.configs[option.id] ?? option.currentValue;
            const choice = option.choices?.find(entry => entry.value === current);
            return <Cell key={option.id} label={configLabel(t, option.id, option.label)} value={configValueLabel(t, current, choice?.label)}
              onClick={() => option.choices ? setPane(`config:${option.id}`) : void choose(() => selectConfig(sessionId, option.id, !current))} />;
          })}
        </>}
        {pane === 'model' && <>
          <button type="button" role="menuitem" className="hp-cell" onClick={() => setPane('root')}><span className="hp-cell-back"><Back /></span><span className="hp-cell-label">{t('menuModel')}</span></button>
          <div className="hp-separator" />
          {catalog?.error && <div className="hp-error"><span>{catalog.error}</span><button type="button" className="hp-retry" onClick={() => setReload(n => n + 1)}>{t('retry')}</button></div>}
          {catalog && !catalog.models.length && !catalog.error && <div className="hp-empty">{t('emptyModels')}</div>}
          {state.model && catalog && !modelEntry && <Option label={state.model} selected onClick={() => {}} />}
          {catalog?.models.map(model => <Option key={model.id} label={model.label} hint={model.resolved && model.resolved !== model.label ? model.resolved : undefined}
            selected={model.id === (state.model ?? catalog.defaultModel?.id)}
            onClick={() => { if (model.id !== state.model) void choose(() => selectModel(sessionId, model.id)); else close(); }} />)}
        </>}
        {pane === 'effort' && <>
          <button type="button" role="menuitem" className="hp-cell" onClick={() => setPane('root')}><span className="hp-cell-back"><Back /></span><span className="hp-cell-label">{t('menuEffort')}</span></button>
          <div className="hp-separator" />
          {!efforts.length && <div className="hp-empty">{t('emptyEfforts')}</div>}
          {efforts.map(option => <Option key={option.id} label={effortLabel(t, option.id, option.label)} selected={option.id === effective}
            onClick={() => { if (option.id !== state.thinking) void choose(() => selectThinking(sessionId, option.id)); else close(); }} />)}
        </>}
        {pane.startsWith('config:') && (() => {
          const option = configs.find(entry => entry.id === pane.slice(7));
          if (!option?.choices) return null;
          const current = state.configs[option.id] ?? option.currentValue;
          return <>
            <button type="button" role="menuitem" className="hp-cell" onClick={() => setPane('root')}><span className="hp-cell-back"><Back /></span><span className="hp-cell-label">{configLabel(t, option.id, option.label)}</span></button>
            <div className="hp-separator" />
            {option.choices.map(choice => <Option key={choice.value} label={configValueLabel(t, choice.value, choice.label)} hint={choice.description ?? undefined}
              selected={choice.value === current} onClick={() => { if (choice.value !== current) void choose(() => selectConfig(sessionId, option.id, choice.value)); else close(); }} />)}
          </>;
        })()}
      </div>}
    </div>
    <ContextRing usage={usageView} t={t} />
    {error && <span role="alert" className="hp-alert">{error}</span>}
  </div>;
}

function ExternalOnboarding({ complete }: PropsRuntime<'settings.onboarding'>) {
  useEffect(() => { complete(); }, [complete]);
  return null;
}

/* Copied from the host's ModelSelect.module.css / PermissionSelect.module.css / ContextMeter.module.css so the
   plugin controls read as the same material: 28px r24 chips, r20 menus, 40px cells, 38px options, r12 panels. */
const styles = `
.hp-root{display:flex;align-items:center;gap:12px;min-width:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}
.hp-anchor{position:relative;display:inline-flex;min-width:0}
.hp-chip{display:inline-flex;align-items:center;gap:4px;min-width:0;max-width:220px;height:28px;padding:0 4px 0 8px;border:none;border-radius:24px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:20px;font-weight:500;font-variant-numeric:tabular-nums;white-space:nowrap;cursor:pointer}
.hp-chip:hover:not(:disabled),.hp-chip[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover)}
.hp-chip:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}
.hp-chip:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}
.hp-chip:disabled .hp-chevron{color:var(--dsw-alias-label-dimmed)}
.hp-chip svg{flex:none}
.hp-chip-icon{display:inline-flex;flex:0 0 auto}.hp-chip-icon svg{width:14px;height:14px}
.hp-option-icon{display:inline-flex;flex:none;width:16px;height:16px;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary)}
.hp-chip-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hp-chip-effort{flex-shrink:1000;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-caption)}
.hp-chip.hp-warn,.hp-figure.hp-warn{color:var(--dsw-alias-state-warn-label)}.hp-chip.hp-danger,.hp-figure.hp-danger{color:var(--dsw-alias-state-error-primary)}
.hp-chevron{flex:none;color:var(--dsw-alias-label-caption);transition:transform 120ms ease}
.hp-chevron-open{transform:rotate(180deg)}
.hp-quota-ring{flex:none}
.hp-bar-fill{display:block;height:100%;border-radius:999px;background:var(--dsw-alias-state-success-primary)}
.hp-bar-fill.hp-warn{background:var(--dsw-alias-state-warn-primary)}.hp-bar-fill.hp-danger{background:var(--dsw-alias-state-error-primary)}
.hp-menu{position:absolute;bottom:calc(100% + 8px);z-index:100;display:flex;flex-direction:column;box-sizing:border-box;width:max-content;min-width:240px;max-width:min(420px,calc(100vw - 32px));max-height:min(360px,calc(100vh - 96px));overflow-y:auto;padding:4px;border:0;border-radius:20px;background:var(--dsw-specific-menu);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-primary);text-align:left}
.hp-menu-left,.hp-panel-left{left:0}.hp-menu-right,.hp-panel-right{right:0}
.hp-cell{box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;height:40px;padding:0 10px;border:none;border-radius:10px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;text-align:left;cursor:pointer}
.hp-cell:hover{background:var(--dsw-alias-interactive-bg-hover)}
.hp-cell-label{flex:0 0 auto;white-space:nowrap}
.hp-cell-value{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right;color:var(--dsw-alias-label-tertiary)}
.hp-cell-chevron,.hp-cell-back{display:inline-flex;flex:0 0 auto;color:var(--dsw-alias-label-tertiary)}
.hp-separator{height:.5px;margin:4px 0;background:var(--dsw-alias-border-l2)}
.hp-option{box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;min-height:38px;padding:6px 8px;border:none;border-radius:10px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer}
.hp-option:hover:not(:disabled),.hp-option:focus-visible{outline:none;background:var(--dsw-alias-interactive-bg-hover)}
.hp-option:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}
.hp-option-copy{display:flex;flex:1;flex-direction:column;min-width:0}
.hp-option-name{overflow:hidden;font-size:14px;line-height:20px;font-weight:500;text-overflow:ellipsis;white-space:nowrap}
.hp-option-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.hp-check{display:grid;place-items:center;flex:0 0 18px;color:var(--dsw-alias-label-primary)}
.hp-status,.hp-empty{padding:10px;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}
.hp-error{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:4px;padding:7px 8px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.hp-retry{flex:0 0 auto;padding:0;border:none;background:transparent;color:inherit;font:inherit;font-weight:600;cursor:pointer}
.hp-ring{display:grid;place-items:center;flex:none;width:28px;height:28px;border:none;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.hp-ring:hover,.hp-ring[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover)}
.hp-quota-ring,.hp-ring{--hp-usage-color:var(--dsw-alias-state-success-primary)}
.hp-quota-ring.hp-warn,.hp-ring.hp-warn{--hp-usage-color:var(--dsw-alias-state-warn-primary)}
.hp-quota-ring.hp-danger,.hp-ring.hp-danger{--hp-usage-color:var(--dsw-alias-state-error-primary)}
.hp-track{fill:none;stroke:var(--hp-usage-color);stroke-opacity:.2;stroke-width:2}
.hp-fill{fill:none;stroke:var(--hp-usage-color);stroke-width:2;stroke-linecap:round}
.hp-panel{position:absolute;bottom:calc(100% + 8px);z-index:100;box-sizing:border-box;width:264px;padding:12px;border:0;border-radius:12px;background:var(--dsw-specific-menu);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);font-size:12px;line-height:20px;font-weight:400;color:var(--dsw-alias-label-secondary);text-align:left;white-space:normal;cursor:default}
.hp-panel-head{display:flex;align-items:center;gap:6px}
.hp-panel-icon{display:inline-flex;color:var(--dsw-alias-label-tertiary)}
.hp-panel-title{font-weight:500;color:var(--dsw-alias-label-primary)}
.hp-figure{margin-left:auto;font-weight:500;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}
.hp-percent{font-weight:500;color:var(--dsw-alias-label-primary)}.hp-percent.hp-warn{color:var(--dsw-alias-state-warn-label)}.hp-percent.hp-danger{color:var(--dsw-alias-state-error-primary)}
.hp-muted{color:var(--dsw-alias-label-tertiary)}
.hp-bar{display:flex;margin:8px 0 6px;height:4px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);overflow:hidden}
.hp-bar-context{margin:10px 0 12px}
.hp-bar-messages{background:var(--dsw-static-blue-450)}.hp-bar-messages.hp-warn{background:var(--dsw-alias-state-warn-primary)}.hp-bar-messages.hp-danger{background:var(--dsw-alias-state-error-primary)}
.hp-rows{margin:6px 0 0}
.hp-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:2px 0}
.hp-row dt{color:var(--dsw-alias-label-secondary)}
.hp-row dd{margin:0;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}
.hp-section{margin-top:12px;padding-top:12px;border-top:.5px solid var(--dsw-alias-border-l2)}
.hp-foot{margin-top:10px;padding-top:8px;border-top:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-caption)}
.hp-secret{position:absolute;bottom:100%;left:0;z-index:110;max-height:60vh;overflow:auto;width:340px;padding:16px;border-radius:12px;background:var(--dsw-specific-menu);box-shadow:var(--dsw-elevation-prominent);font-size:14px}.hp-secret input,.hp-secret select{display:block;box-sizing:border-box;width:100%;margin-top:4px}.hp-secret p{font-size:12px}.hp-alert{max-width:360px;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}
`;

export async function apply(ctx: Context): Promise<void> {
  const unmount = await ctx.remote.$mount(contribution);
  ctx.effect(() => unmount, 'harness: Remote client');
  ctx.effect(() => ctx.locale.register('harness',{zh,en}), 'harness: locale');
  ctx.effect(() => {
    const style=document.createElement('style');
    style.textContent=styles;
    document.head.append(style);return ()=>style.remove();
  }, 'harness: selector styles');
  ctx.inject(['sessions', 'remote.harness'], scope => {
    let nativeSeats: Array<()=>void> = [];
    const known = new Map<string,boolean>();
    const listeners = new Set<() => void>();
    const api: Injected = {
      recover:(sessionId,action)=>value(scope.remote.harness.recover({sessionId,action})),
      secretStatus:id=>value(scope.remote.harness.secretStatus({sessionId:id})),
      answerSecret:(sessionId,id,answers,cancelled)=>value(scope.remote.harness.answerSecret({sessionId,id,answers,cancelled})),
      read:id=>value(scope.remote.harness.state({sessionId:id})),
      select:(id,harness)=>value(scope.remote.harness.select({sessionId:id,harness})),
      models:id=>value(scope.remote.harness.models({sessionId:id})),
      selectModel:(id,model)=>value(scope.remote.harness.selectModel({sessionId:id,model})),
      selectThinking:(id,thinking)=>value(scope.remote.harness.selectThinking({sessionId:id,thinking})),
      selectPermission:(id,permission)=>value(scope.remote.harness.selectPermission({sessionId:id,permission})),
      selectConfig:(id,configId,value_)=>value(scope.remote.harness.selectConfig({sessionId:id,configId,value:value_})),
      usage:id=>value(scope.remote.harness.usage({sessionId:id})),
      quota:id=>value(scope.remote.harness.quota({sessionId:id})),
      changed:(id,external)=>{known.set(id,external);syncModel();for (const listener of listeners) listener();},
      subscribe:listener=>{listeners.add(listener);return ()=>{listeners.delete(listener);};},
    };
    function syncModel() {
      const {current,byId}=scope.sessions.list.getSnapshot();
      for (const id of known.keys()) if (!(id in byId)) known.delete(id);
      const external=current !== undefined && known.get(current) === true;
      if (external && !nativeSeats.length) {
        nativeSeats = [scope.slots.register({ name: 'conversation.input.plan', priority: -100 }, () => null)];
        nativeSeats.push(scope.slots.register({ name: 'conversation.input.permission', priority: -100, locale: 'harness', inject: () => api }, HarnessPermission));
        nativeSeats.push(scope.slots.register({ name: 'conversation.input.model', priority: -100, locale: 'harness', inject: () => api }, HarnessModel));
        nativeSeats.push(scope.slots.register({ name: 'settings.onboarding', id: 'deepseek-official', priority: -100 }, ExternalOnboarding));
      }
      if (!external && nativeSeats.length) { for (const dispose of nativeSeats) dispose(); nativeSeats = []; }
    }
    scope.effect(()=>{
      const stop=scope.sessions.list.subscribe(syncModel);
      return ()=>{stop();for (const dispose of nativeSeats) dispose();};
    },'harness: native model seat');
    scope.slots.inject('conversation.input.left',()=>scope.slots.register({
      name:'conversation.input.left',id:'harness-selector',order:-100,locale:'harness',inject:()=>api,
    },HarnessSelect));
  });
}
