import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ComponentType, type ReactNode } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import type {} from '@deepseek-ai/dsh-api-remotes/client';
import type {} from '@deepseek-ai/dsh-api-session-controller/client';
import type {} from '@deepseek-ai/dsh-client-locale/client';
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client';
import type { DraftAttachmentId, SubmitOutcome } from '@deepseek-ai/dsh-client-ui-conversation/client';
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client';
import type {} from '@deepseek-ai/dsh-client-ui-input-trigger/client';
import type { ClientSessionContext, CommandClaim, InputTriggerCandidate, InputTriggerPick, PickOutcome, SubmitAttachment, SubmitEnvelope } from '@deepseek-ai/dsh-client-ui-input-trigger/client';
import type {} from '@deepseek-ai/dsh-client-ui-commands/client';
import type { PropsRuntime, PropsLocale, InjectFace } from '@deepseek-ai/dsh-client-ui-slots';
import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-chat/client';
import type { Settings } from './settings.js';
import { contribution, SETTINGS_ENTRY, type stateSchema, type modelsSchema, type usageSchema, type quotaSchema, type secretStatusSchema, type subagentsSchema, type pluginsSchema } from './remote.js';
import type { z } from 'zod';

type State = z.infer<typeof stateSchema>;
type Models = z.infer<typeof modelsSchema>;
type Usage = z.infer<typeof usageSchema>;
type Quota = z.infer<typeof quotaSchema>;
type SecretStatus = z.infer<typeof secretStatusSchema>;
type Subagents = z.infer<typeof subagentsSchema>;
type Plugin = z.infer<typeof pluginsSchema>[number];
type Api = {
  recover(request: {sessionId: string; action: 'check' | 'unlock'}): Promise<RemoteResult<State & {detail: string}>>;
  secretStatus(request: {sessionId: string}): Promise<RemoteResult<SecretStatus>>;
  answerSecret(request: {sessionId: string; id: string; answers: Record<string,string[]>; cancelled?: boolean}): Promise<RemoteResult<{accepted: boolean}>>;
  state(request: {sessionId: string}): Promise<RemoteResult<State>>;
  select(request: {sessionId: string; harness: State['harness']}): Promise<RemoteResult<State>>;
  models(request: {sessionId: string; harness?: Exclude<State['harness'], 'dsh'>}): Promise<RemoteResult<Models>>;
  selectModel(request: {sessionId: string; model: string}): Promise<RemoteResult<State>>;
  selectThinking(request: {sessionId: string; thinking: string}): Promise<RemoteResult<State>>;
  selectPermission(request: {sessionId: string; permission: string}): Promise<RemoteResult<State>>;
  selectConfig(request: {sessionId: string; configId: string; value: string | boolean}): Promise<RemoteResult<State>>;
  usage(request: {sessionId: string}): Promise<RemoteResult<Usage>>;
  harnesses(request: {sessionIds: string[]}): Promise<RemoteResult<Record<string, {harness: State['harness']; delegated: boolean; running: boolean}>>>;
  quota(request: {sessionId: string}): Promise<RemoteResult<Quota>>;
  viewing(request: {sessionId: string}): Promise<RemoteResult<null>>;
  subagents(request: {sessionId: string}): Promise<RemoteResult<Subagents>>;
  plugins(request: {sessionId: string}): Promise<RemoteResult<Plugin[]>>;
  edit(request: {sessionId: string; seq: number; text: string; requestId: string}): Promise<RemoteResult<State>>;
  delegateFromUser(request: {sessionId: string; requestId: string; harnesses: State['harness'][]; prompt: string; reportBack: boolean; worktree: boolean; picks: Picks; attachments: readonly SubmitAttachment[]}): Promise<RemoteResult<{sessionId?: string; harness: State['harness']; accepted: true}>>;
  startDiscussionFromUser(request: {sessionId: string; requestId: string; harnesses: State['harness'][]; prompt: string; attachments: readonly SubmitAttachment[]}): Promise<RemoteResult<{accepted: true}>>;
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
  balanceTopped: '充值余额', balanceGranted: '赠送余额', quotaSource: '额度由 {source} 提供 · {sync}',
  'sync.poll': '每 60 秒同步', 'sync.turn': '对话一轮后同步',
  'window.five_hour': '5 小时', 'window.seven_day': '本周', 'window.weekly': '本周', 'window.monthly': '本月', 'window.unknown': '额度',
  'window.5-hour window': '5 小时', 'window.7-day window': '本周', 'window.Opus · 7-day': 'Opus 本周', 'window.Sonnet · 7-day': 'Sonnet 本周',
  'window.OAuth apps · 7-day': 'OAuth 应用本周',
  subagents: '子代理', subagentsDescription: '查看子代理的运行状态和内容', providedBy: '由 dsh-harness-provider 插件提供',
  subagentsEmpty: '当前会话还没有子代理活动。Codex / Claude Code 会话在本次运行中打开后才会显示其子代理。', subagentNoActivity: '暂无内容',
  'subagent.running': '运行中', 'subagent.completed': '已完成', 'subagent.failed': '失败', 'subagent.cancelled': '已取消',
  plugins: '插件',
  edit: '编辑', editCancel: '取消', editSend: '发送', editHint: '发送后从这条消息重新执行，之后的原生上下文会撤销；工作区文件不会还原。',
  clear: '清理', clearDescription: '清理上下文',
  delegate: '委派', delegateMode: '委派模式', delegateDescription: '创建独立会话执行任务', delegateTask: '当前处于委派模式：描述任务，将交给所选 Harness 在新的独立会话中执行；输入 / 可先用当前会话的 skill（如交接）', delegateCreated: '已创建委派会话', delegatePrepared: '正在当前会话执行 skill，完成后自动创建委派会话', commands: '指令',
  reportBack: '完成后回传到当前会话', reportBackOff: '结果仅保留在新会话，不唤醒当前会话', delegateExit: '退出委派模式',
  worktree: '独立 worktree', worktreeHint: '在当前改动的快照上隔离开发，每轮结束后询问是否合并', worktreeNative: '独立 worktree 仅支持 Codex / Claude Code',
  pickModel: '{harness} 的模型与推理强度', pickLast: '沿用上次',
  settingsNav: 'Harness', settingsIntro: '接入 Codex / Claude Code 的默认行为。修改立即保存到当前 Profile 的配置文件；可执行文件、进展反馈说明、讨论等待上限和调试输出在原生进程下次启动时生效。',
  settingsReadOnly: '当前连接不能修改配置，以下内容只读。', settingsUnavailable: '当前 Profile 没有提供本插件的配置。', settingsReset: '恢复默认',
  settingsRejected: '未保存：取值无效或超出范围。', settingsAuto: '自动查找',
  'settingsGroup.programs': '程序', 'settingsGroup.sessions': '会话', 'settingsGroup.delegation': '委派与讨论', 'settingsGroup.feedback': '进展反馈', 'settingsGroup.advanced': '高级',
  'setting.codexCommand': 'Codex 可执行文件', 'setting.codexCommand.hint': '命令名或绝对路径，也用于额度、插件和轮次记录查询。',
  'setting.claudeCommand': 'Claude Code 可执行文件', 'setting.claudeCommand.hint': '留空时依次使用环境变量 CODEXHOST_CLAUDE_COMMAND、PATH 中的 claude 和常见安装位置。',
  'setting.idleCloseSeconds': '空闲回收（秒）', 'setting.idleCloseSeconds.hint': '会话不在屏幕上且空闲超过该时长后关闭原生进程，下一轮按原生会话恢复；仍有后台任务时保留。',
  'setting.delegateHarnesses': '委派默认目标', 'setting.delegateHarnesses.hint': '进入委派模式时预选的 Harness。',
  'setting.delegateReportBack': '委派默认回传', 'setting.delegateReportBack.hint': '进入委派模式时预选“完成后回传到当前会话”。',
  'setting.delegateWorktree': '委派默认使用独立 worktree', 'setting.delegateWorktree.hint': '仅对 Codex / Claude Code 生效；默认目标包含 DSH 原生时不预选。',
  'setting.discussHarnesses': '讨论默认参与者', 'setting.discussHarnesses.hint': '进入讨论模式时预选的 Harness。',
  'setting.progressFeedback': '注入进展反馈说明', 'setting.progressFeedback.hint': '要求 Codex / Claude Code 在执行过程中用中文汇报进展。',
  'setting.progressFeedbackText': '进展反馈说明', 'setting.progressFeedbackText.hint': '作为系统说明交给新启动的原生会话，不进入用户消息。',
  'setting.requestTimeoutSeconds': 'ACP 请求超时（秒）', 'setting.requestTimeoutSeconds.hint': '新建会话、切换模型等单次请求的等待上限，不限制对话轮次本身。',
  'setting.sessionLoadTimeoutSeconds': '会话加载超时（秒）', 'setting.sessionLoadTimeoutSeconds.hint': '恢复或分支原生会话时回放历史的等待上限。',
  'setting.discussionTimeoutMinutes': '讨论等待上限（分钟）', 'setting.discussionTimeoutMinutes.hint': '主 Agent 等待讨论结果的最长时间。',
  'setting.toolOutputChars': '工具输出上限（字符）', 'setting.toolOutputChars.hint': '单个工具输出超过该长度时截断显示。',
  'setting.peerReviewChars': '讨论互评摘录（字符）', 'setting.peerReviewChars.hint': '互评时每位参与者的结果交给其他参与者的最大长度。',
  'setting.discussionResultChars': '讨论结果读取（字符）', 'setting.discussionResultChars.hint': '汇总时读取每位参与者结果末尾的长度，最多 64,000。',
  'setting.catalogCacheSeconds': '模型目录缓存（秒）', 'setting.catalogCacheSeconds.hint': '模型、推理强度和权限模式列表的缓存时长；0 表示每次重新读取。',
  'setting.quotaCacheSeconds': '额度缓存（秒）', 'setting.quotaCacheSeconds.hint': 'DSH 原生模型账户额度的缓存时长，最少 10 秒。',
  'setting.pluginCacheSeconds': '插件目录缓存（秒）', 'setting.pluginCacheSeconds.hint': '@ 菜单中 Harness 插件列表的缓存时长。',
  'setting.recoveryCheckSeconds': '恢复核对间隔（秒）', 'setting.recoveryCheckSeconds.hint': '暂停的会话打开时自动核对原生记录的最短间隔。',
  'setting.acpStderr': 'ACP 调试输出', 'setting.acpStderr.hint': '把 Agent 进程的 stderr 输出到 DSH 日志，仅用于排查启动问题；可能包含提示词或凭据。',
  discuss: '讨论', discussDescription: '由主 Agent 分配一个或多个会话并汇总', discussTask: '讨论任务', discussStarted: '已开始讨论',
  discussHint: '可多选；主 Agent 为选中的 Harness 分工并汇总', discussExit: '退出讨论模式', discussNative: 'DSH 原生暂不支持只读讨论',
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
  balanceTopped:'Topped up', balanceGranted:'Granted', quotaSource:'Quota from {source} · {sync}',
  'sync.poll':'refreshed every 60s', 'sync.turn':'refreshed after each turn',
  'window.five_hour':'5-hour', 'window.seven_day':'Weekly', 'window.weekly':'Weekly', 'window.monthly':'Monthly', 'window.unknown':'Quota',
  'window.5-hour window':'5-hour', 'window.7-day window':'Weekly', 'window.Opus · 7-day':'Opus weekly', 'window.Sonnet · 7-day':'Sonnet weekly',
  'window.OAuth apps · 7-day':'OAuth apps weekly',
  subagents:'Subagents', subagentsDescription:'Status and activity of subagents', providedBy:'Provided by the dsh-harness-provider plugin',
  subagentsEmpty:'No subagent activity in this session yet. Codex / Claude Code subagents appear once the session is open in this run.', subagentNoActivity:'Nothing yet',
  'subagent.running':'Running', 'subagent.completed':'Completed', 'subagent.failed':'Failed', 'subagent.cancelled':'Cancelled',
  plugins:'Plugins',
  edit:'Edit', editCancel:'Cancel', editSend:'Send', editHint:'Sending reruns from this message and drops the native context after it; workspace files are not restored.',
  clear:'Clear', clearDescription:'Clear context',
  delegate:'Delegate', delegateMode:'Delegation mode', delegateDescription:'Create an independent session for this task', delegateTask:'Delegation mode: describe the task for the selected Harness to run in a new session; type / to run one of this session\'s skills (such as a hand-off) first', delegateCreated:'Delegation session created', delegatePrepared:'Running the skill in this session; the delegation starts when it finishes', commands:'Commands',
  reportBack:'Report back to this session when complete', reportBackOff:'Keep the result in the new session without waking this one', delegateExit:'Exit delegation mode',
  worktree:'Isolated worktree', worktreeHint:'Work on a snapshot of the current changes; asks to merge after each turn', worktreeNative:'Isolated worktrees are available for Codex and Claude Code only',
  pickModel:'{harness} model and effort', pickLast:'Last used',
  settingsNav:'Harness', settingsIntro:'Defaults for Codex and Claude Code. Changes save to this profile\'s configuration at once; executables, the progress feedback contract, the discussion wait and debug output apply when a native process next starts.',
  settingsReadOnly:'This connection cannot change configuration; the values below are read-only.', settingsUnavailable:'This profile does not serve the plugin\'s configuration.', settingsReset:'Reset',
  settingsRejected:'Not saved: the value is invalid or out of range.', settingsAuto:'Find automatically',
  'settingsGroup.programs':'Programs', 'settingsGroup.sessions':'Sessions', 'settingsGroup.delegation':'Delegation and discussion', 'settingsGroup.feedback':'Progress feedback', 'settingsGroup.advanced':'Advanced',
  'setting.codexCommand':'Codex executable', 'setting.codexCommand.hint':'Command name or absolute path; also used for quota, plugin and turn-record reads.',
  'setting.claudeCommand':'Claude Code executable', 'setting.claudeCommand.hint':'When empty: CODEXHOST_CLAUDE_COMMAND, then claude on PATH, then the usual install locations.',
  'setting.idleCloseSeconds':'Idle close (seconds)', 'setting.idleCloseSeconds.hint':'An off-screen session idle this long closes its native process and resumes on the next turn; background tasks keep it open.',
  'setting.delegateHarnesses':'Default delegation targets', 'setting.delegateHarnesses.hint':'Harnesses preselected when delegation mode opens.',
  'setting.delegateReportBack':'Report back by default', 'setting.delegateReportBack.hint':'Preselects "Report back to this session when complete".',
  'setting.delegateWorktree':'Isolated worktree by default', 'setting.delegateWorktree.hint':'Codex and Claude Code only; not preselected while the targets include native DSH.',
  'setting.discussHarnesses':'Default discussion participants', 'setting.discussHarnesses.hint':'Harnesses preselected when discussion mode opens.',
  'setting.progressFeedback':'Progress feedback contract', 'setting.progressFeedback.hint':'Asks Codex and Claude Code to report progress in Chinese while they work.',
  'setting.progressFeedbackText':'Contract text', 'setting.progressFeedbackText.hint':'Given to newly started native sessions as system instructions, never as a user message.',
  'setting.requestTimeoutSeconds':'ACP request timeout (seconds)', 'setting.requestTimeoutSeconds.hint':'Limit for one request such as a new session or a model switch; turns themselves are not limited.',
  'setting.sessionLoadTimeoutSeconds':'Session load timeout (seconds)', 'setting.sessionLoadTimeoutSeconds.hint':'Limit for replaying history when resuming or branching a native session.',
  'setting.discussionTimeoutMinutes':'Discussion wait (minutes)', 'setting.discussionTimeoutMinutes.hint':'How long the main agent waits for a discussion result.',
  'setting.toolOutputChars':'Tool output limit (characters)', 'setting.toolOutputChars.hint':'Longer tool output is truncated in the transcript.',
  'setting.peerReviewChars':'Peer review excerpt (characters)', 'setting.peerReviewChars.hint':'How much of each participant\'s result the others review.',
  'setting.discussionResultChars':'Discussion result read (characters)', 'setting.discussionResultChars.hint':'How much of the end of each result the synthesis reads; at most 64,000.',
  'setting.catalogCacheSeconds':'Model catalog cache (seconds)', 'setting.catalogCacheSeconds.hint':'Cache for model, effort and permission lists; 0 reads them every time.',
  'setting.quotaCacheSeconds':'Quota cache (seconds)', 'setting.quotaCacheSeconds.hint':'Cache for native DSH account quota; at least 10 seconds.',
  'setting.pluginCacheSeconds':'Plugin catalog cache (seconds)', 'setting.pluginCacheSeconds.hint':'Cache for the Harness plugins in the @ menu.',
  'setting.recoveryCheckSeconds':'Recovery check interval (seconds)', 'setting.recoveryCheckSeconds.hint':'Minimum gap between automatic native-record checks of a paused session.',
  'setting.acpStderr':'ACP debug output', 'setting.acpStderr.hint':'Sends the agent process stderr to the DSH log, for startup problems only; it may contain prompts or credentials.',
  discuss:'Discuss', discussDescription:'Let the main agent assign one or more sessions and synthesize', discussTask:'Discussion task', discussStarted:'Discussion started',
  discussHint:'Select one or more; the main agent assigns the selected Harnesses and synthesizes', discussExit:'Exit discussion mode', discussNative:'Native DSH does not support read-only discussions yet',
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
  /** Reports the session on screen, so the host keeps its Harness process open. */
  viewing(id: string): Promise<null>;
  /**
   * The model route this session will use next, as the host's own directory sees it, so account quota can follow a
   * provider switch immediately. Null when the host exposes no directory (an older build), which falls back to the
   * quota interval alone.
   */
  modelProvider(id: string): ModelProvider | null;
  changed(id: string, harness: State['harness']): void;
  /** Fires after any selection made in a sibling seat; seats reload their state on it. */
  subscribe(listener: () => void): () => void;
}
/** Live read of one session's routed provider; both the /model popup and the composer seat write the same selection. */
type ModelProvider = { get(): string | null; subscribe(onChange: () => void): () => void };
type T = (key: Key, params?: Record<string, unknown>) => string;
type LeftProps = PropsRuntime<'conversation.input.left'> & PropsLocale<'harness'> & InjectFace<Injected>;
type ModelProps = PropsRuntime<'conversation.input.model'> & PropsLocale<'harness'> & InjectFace<Injected>;
type PermissionProps = PropsRuntime<'conversation.input.permission'> & PropsLocale<'harness'> & InjectFace<Injected>;
type DelegationDockProps = PropsRuntime<'conversation.input.dock'> & PropsLocale<'harness'>;
type ContextDockProps = PropsRuntime<'conversation.composer.dock'> & PropsLocale<'harness'> & InjectFace<Injected>;

// ---- shared chrome (copies the host's ModelSelect / PermissionSelect / ContextMeter geometry) ----
const Chevron = ({ open }: { open?: boolean }) => <svg className={`hp-chevron${open ? ' hp-chevron-open' : ''}`} width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden><path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>;
const ChevronRight = () => <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden><path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>;
const Back = () => <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden><path d="M10 4L6 8l4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>;
const PluginIcon = ({ size = 16 }: { size?: number }) => <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden><path d="M6 2.5h4v2a1.5 1.5 0 003 0V6h.5v4H13v-.5a1.5 1.5 0 00-3 0v4H6v-2a1.5 1.5 0 00-3 0V12h-.5V6H3v.5a1.5 1.5 0 003 0v-4z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/></svg>;
const ClearIcon = () => <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden><path d="M3.2 8.8 8.4 3.6a1.4 1.4 0 012 0L12.4 5.6a1.4 1.4 0 010 2L8 12H5.2a1.4 1.4 0 01-1-.4l-1-1a1.4 1.4 0 010-2zM6.1 6l3.9 3.9M8 12h5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>;
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

/**
 * Reports an external Harness session as on screen while the page is visible, so the host keeps its process open; a
 * hidden or closed page just stops reporting and the host reclaims the process after its idle window.
 */
function useViewing(viewing: Injected['viewing'], sessionId: string, external: boolean): void {
  useEffect(() => {
    if (!external) return;
    const tick = () => { if (document.visibilityState === 'visible') void viewing(sessionId).catch(() => {}); };
    tick();
    const timer = setInterval(tick, 15_000);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', tick); };
  }, [viewing, sessionId, external]);
}

/**
 * The session's routed model provider, re-read whenever the host's directory publishes a new selection. It stays null
 * while the host has no directory to read, so quota keeps polling on its interval instead of failing.
 */
function useModelProvider(modelProvider: Injected['modelProvider'], sessionId: string): string | null {
  const handle = modelProvider(sessionId);
  const subscribe = useCallback((onChange: () => void) => handle?.subscribe(onChange) ?? (() => {}), [handle]);
  const getSnapshot = useCallback(() => handle?.get() ?? null, [handle]);
  // A third, server-side reader keeps the seat renderable outside a browser (where no host directory exists).
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

type Target = Exclude<State['harness'], 'dsh'>;
/** Model / thinking picked per delegated Harness; a missing field keeps that Harness's last pick. */
type Picks = Partial<Record<Target, { model?: string; thinking?: string }>>;
type DelegationOptions = { harnesses: State['harness'][]; reportBack: boolean; worktree: boolean; picks: Picks };
const delegationOptions = new Map<string, DelegationOptions>();
/** The plugin's live configuration, once the Settings form has a value; delegation and discussion defaults come from it. */
let settingsForm: ConfigForm<Settings> | undefined;
const pluginSettings = () => settingsForm?.getSnapshot().value;
const freshOptions = (): DelegationOptions => {
  const settings = pluginSettings();
  const harnesses: State['harness'][] = settings?.delegateHarnesses?.length ? [...settings.delegateHarnesses] : ['codex'];
  return { harnesses, reportBack: settings?.delegateReportBack ?? false, worktree: !harnesses.includes('dsh') && (settings?.delegateWorktree ?? false), picks: {} };
};
const freshDiscussion = (): State['harness'][] => { const harnesses = pluginSettings()?.discussHarnesses; return harnesses?.length ? [...harnesses] : ['codex', 'claude-code']; };
const optionsFor = (sessionId: string): DelegationOptions => delegationOptions.get(sessionId) ?? freshOptions();
/** Catalog reader per session in delegation mode; the dock slot itself has no Remote. */
const delegationCatalogs = new Map<string, (harness: Target) => Promise<Models>>();
const discussionHarnesses = new Map<string, State['harness'][]>();
const discussionFor = (sessionId: string): State['harness'][] => discussionHarnesses.get(sessionId) ?? freshDiscussion();
let delegationRequestSequence = 0;
const delegationRequestId = () => globalThis.crypto?.randomUUID?.() ?? `delegate-${Date.now()}-${++delegationRequestSequence}`;
const delegationClaim = (remote: Api, session: ClientSessionContext, t: T): CommandClaim => {
  const requestId = delegationRequestId();
  delegationOptions.set(session.sessionId, freshOptions());
  delegationCatalogs.set(session.sessionId, harness => value(remote.models({ sessionId: session.sessionId, harness })));
  return {
    name: 'delegate', token: '/delegate ', hint: t('delegateTask'), attachments: true,
    async submit(prompt, _actx, attachments) {
      const options = optionsFor(session.sessionId);
      // Only the selected Harnesses' picks travel; a deselected one's pick stays for the dock but is not sent.
      const picks = Object.fromEntries(Object.entries(options.picks).filter(([harness]) => options.harnesses.includes(harness as Target)));
      const result = await value(remote.delegateFromUser({ sessionId: session.sessionId, requestId, prompt, attachments, ...options, picks }));
      delegationOptions.delete(session.sessionId); delegationCatalogs.delete(session.sessionId);
      return { kind: 'success', text: t(result.sessionId ? 'delegateCreated' : 'delegatePrepared') };
    },
  };
};
const discussionClaim = (remote: Api, session: ClientSessionContext, t: T): CommandClaim => {
  const requestId = delegationRequestId();
  discussionHarnesses.set(session.sessionId, freshDiscussion());
  return {
    name: 'discuss', token: '/discuss ', hint: t('discussTask'), attachments: true,
    async submit(prompt, _actx, attachments) {
      await value(remote.startDiscussionFromUser({ sessionId: session.sessionId, requestId, prompt, attachments, harnesses: discussionFor(session.sessionId) }));
      discussionHarnesses.delete(session.sessionId);
      return { kind: 'success', text: t('discussStarted') };
    },
  };
};

// Mode metadata never enters Lexical: the composer keeps an ordinary draft.
const taskModes = new Map<string, { task: CommandClaim; busy: boolean }>();
const taskModeListeners = new Set<() => void>();
const publishTaskMode = () => { for (const listener of taskModeListeners) listener(); };
const subscribeTaskMode = (listener: () => void) => { taskModeListeners.add(listener); return () => { taskModeListeners.delete(listener); }; };
function setTaskMode(sessionId: string, task?: CommandClaim) {
  if (task) taskModes.set(sessionId, { task, busy: false }); else taskModes.delete(sessionId);
  publishTaskMode();
}

function TaskHarnessSelector({ selected, onChange, discussion = false, disabled = false, t }: { selected: State['harness'][]; onChange: (selected: State['harness'][]) => void; discussion?: boolean; disabled?: boolean; t: T }) {
  const names: Record<State['harness'], string> = { dsh: t('native'), codex: 'Codex', 'claude-code': 'Claude Code' };
  return <div className="hp-delegate-harness" role="group" aria-label={t('harness')}>
    {(Object.keys(names) as State['harness'][]).map(harness => <button key={harness} type="button" role="checkbox" aria-checked={selected.includes(harness)}
      disabled={disabled || (discussion && harness === 'dsh')} title={discussion && harness === 'dsh' ? t('discussNative') : undefined}
      onClick={() => { const next = selected.includes(harness) ? selected.filter(value => value !== harness) : [...selected, harness]; if (next.length) onChange(next); }}>
      {selected.includes(harness) && <Check />}{names[harness]}
    </button>)}
  </div>;
}
/** "Harness · model · effort" chip for one delegation target, with the seat's two-level menu; nothing picked keeps the last pick. */
function DelegatePick({ harness, pick, load, disabled, onChange, t }: { harness: Target; pick: NonNullable<Picks[Target]>; load?: (harness: Target) => Promise<Models>; disabled: boolean; onChange: (pick: NonNullable<Picks[Target]>) => void; t: T }) {
  const [open, setOpen] = useState(false);
  const [pane, setPane] = useState<'root' | 'model' | 'effort'>('root');
  const [catalog, setCatalog] = useState<Models>();
  const root = useRef<HTMLDivElement>(null);
  const close = useCallback(() => { setOpen(false); setPane('root'); }, []);
  useDismiss(open, close, root);
  // Read on first open, so entering delegation mode starts no CLI probe; a failed read is shown with a retry.
  useEffect(() => {
    if (!open || catalog || !load) return;
    let live = true;
    void load(harness).then(next => { if (live) setCatalog(next); }, error => { if (live) setCatalog({ models: [], defaultModel: null, thinkingOptions: [],
      defaultThinkingOptionId: null, permissionModes: [], defaultPermissionModeId: null, configOptions: [], error: error instanceof Error ? error.message : String(error) }); });
    return () => { live = false; };
  }, [open, catalog, load, harness]);
  const name = harness === 'codex' ? 'Codex' : 'Claude Code';
  const model = catalog?.models.find(entry => entry.id === pick.model);
  const modelLabel = pick.model ? model?.label ?? pick.model : t('pickLast');
  const efforts = (catalog?.thinkingOptions ?? []).filter(option => !model?.thinkingOptionIds || model.thinkingOptionIds.includes(option.id));
  const effortText = pick.thinking ? effortLabel(t, pick.thinking, catalog?.thinkingOptions.find(option => option.id === pick.thinking)?.label ?? pick.thinking) : undefined;
  const choose = (next: NonNullable<Picks[Target]>) => { onChange(next); close(); };
  return <div ref={root} className="hp-anchor">
    <button type="button" className="hp-chip" aria-label={t('pickModel', { harness: name })} aria-haspopup="menu" aria-expanded={open}
      title={`${name} · ${modelLabel}${effortText ? ` · ${effortText}` : ''}`} disabled={disabled} onClick={() => { if (open) close(); else setOpen(true); }}>
      <span className="hp-chip-label">{name} · {modelLabel}</span>
      {effortText && <span className="hp-chip-effort">· {effortText}</span>}
      <Chevron open={open} />
    </button>
    {open && <div className="hp-menu hp-menu-left" role="menu" aria-label={t('pickModel', { harness: name })} aria-busy={!catalog}>
      {pane === 'root' && <>
        <Cell label={t('menuModel')} value={modelLabel} onClick={() => setPane('model')} />
        {(!catalog || efforts.length > 0) && <Cell label={t('menuEffort')} value={effortText ?? t('pickLast')} onClick={() => setPane('effort')} />}
      </>}
      {pane !== 'root' && <>
        <button type="button" role="menuitem" className="hp-cell" onClick={() => setPane('root')}><span className="hp-cell-back"><Back /></span><span className="hp-cell-label">{t(pane === 'model' ? 'menuModel' : 'menuEffort')}</span></button>
        <div className="hp-separator" />
        {!catalog && <div className="hp-empty">{t('loading')}</div>}
        {catalog?.error && <div className="hp-error"><span>{catalog.error}</span><button type="button" className="hp-retry" onClick={() => setCatalog(undefined)}>{t('retry')}</button></div>}
      </>}
      {pane === 'model' && catalog && !catalog.error && <>
        <Option label={t('pickLast')} selected={!pick.model} onClick={() => choose({ ...pick, model: undefined })} />
        {catalog.models.map(entry => <Option key={entry.id} label={entry.label} hint={entry.resolved && entry.resolved !== entry.label ? entry.resolved : undefined} selected={entry.id === pick.model}
          // A thinking level the newly picked model lacks is dropped rather than sent and rejected.
          onClick={() => choose({ model: entry.id, thinking: pick.thinking && (!entry.thinkingOptionIds || entry.thinkingOptionIds.includes(pick.thinking)) ? pick.thinking : undefined })} />)}
      </>}
      {pane === 'effort' && catalog && !catalog.error && <>
        <Option label={t('pickLast')} selected={!pick.thinking} onClick={() => choose({ ...pick, thinking: undefined })} />
        {efforts.map(option => <Option key={option.id} label={effortLabel(t, option.id, option.label)} selected={option.id === pick.thinking} onClick={() => choose({ ...pick, thinking: option.id })} />)}
      </>}
    </div>}
  </div>;
}
function DelegationDockActive({ sessionId, t }: DelegationDockProps) {
  const [options, setOptions] = useState(() => optionsFor(sessionId));
  const busy = taskModes.get(sessionId)?.busy === true;
  const update = (next: DelegationOptions) => { delegationOptions.set(sessionId, next); setOptions(next); };
  return <div className="hp-delegate" data-hp-mode="delegate" aria-label={t('delegateMode')}>
    <strong>{t('delegateMode')}</strong>
    <TaskHarnessSelector disabled={busy} selected={options.harnesses} onChange={harnesses => update({ ...options, harnesses, worktree: !harnesses.includes('dsh') && options.worktree })} t={t} />
    {options.harnesses.filter((harness): harness is Target => harness !== 'dsh').map(harness => <DelegatePick key={harness} harness={harness} pick={options.picks[harness] ?? {}}
      load={delegationCatalogs.get(sessionId)} disabled={busy} onChange={pick => update({ ...options, picks: { ...options.picks, [harness]: pick } })} t={t} />)}
    <label className="hp-delegate-report" title={options.harnesses.includes('dsh') ? t('worktreeNative') : t('worktreeHint')}>
      <input type="checkbox" checked={options.worktree} disabled={busy || options.harnesses.includes('dsh')} onChange={event => update({ ...options, worktree: event.target.checked })} />
      <span>{t('worktree')}</span>
    </label>
    <label className="hp-delegate-report" title={!options.reportBack ? t('reportBackOff') : undefined}>
      <input type="checkbox" checked={options.reportBack} disabled={busy} onChange={event => update({ ...options, reportBack: event.target.checked })} />
      <span>{t('reportBack')}</span>
    </label>
    <button type="button" className="hp-delegate-exit" disabled={busy} aria-label={t('delegateExit')} title={t('delegateExit')}
      onClick={() => { delegationOptions.delete(sessionId); delegationCatalogs.delete(sessionId); setTaskMode(sessionId); }}>×</button>
  </div>;
}
function DiscussionDockActive({ sessionId, t }: DelegationDockProps) {
  const [selected, setSelected] = useState(() => discussionFor(sessionId));
  const busy = taskModes.get(sessionId)?.busy === true;
  return <div className="hp-delegate" data-hp-mode="discuss" aria-label={t('discuss')}>
    <strong title={t('discussHint')}>{t('discuss')}</strong>
    <TaskHarnessSelector disabled={busy} selected={selected} onChange={harnesses => { discussionHarnesses.set(sessionId, harnesses); setSelected(harnesses); }} discussion t={t} />
    <button type="button" className="hp-delegate-exit" disabled={busy} aria-label={t('discussExit')} title={t('discussExit')}
      onClick={() => { discussionHarnesses.delete(sessionId); setTaskMode(sessionId); }}>×</button>
  </div>;
}
function DelegationDock(props: DelegationDockProps) {
  const mode = useSyncExternalStore(subscribeTaskMode, () => taskModes.get(props.sessionId), () => taskModes.get(props.sessionId));
  const dock = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const seat = dock.current?.closest<HTMLElement>('[data-composer-seat]');
    if (!mode?.busy || !seat) return;
    // Ordinary sends detach their draft; prevent edits until a failed send can restore it.
    const inert = seat.inert;
    seat.inert = true;
    return () => { seat.inert = inert; };
  }, [mode?.busy, props.sessionId]);
  if (!mode) return null;
  return <div ref={dock} style={{ display: 'contents' }}>
    {mode.task.name === 'delegate' ? <DelegationDockActive key={props.sessionId} {...props} /> : <DiscussionDockActive key={props.sessionId} {...props} />}
  </div>;
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
    // The ring draws the tightest window printed beside it, so arc and percentage agree.
    const ring = shown.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a));
    trigger = <>
      {windowIcon(shown[0]!.id)}
      {shown.map((window, index) => <span key={window.id} className={index ? 'hp-chip-effort' : undefined}>{index ? '· ' : ''}{windowLabel(t, window.id, window.label)} {left(window.usedPercent)}%</span>)}
      <svg className={`hp-quota-ring${level}`} width="14" height="14" viewBox="0 0 14 14" aria-hidden>
        <circle className="hp-track" cx="7" cy="7" r={RADIUS} />
        <circle className="hp-fill" cx="7" cy="7" r={RADIUS} strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * ring.usedPercent / 100} transform="rotate(-90 7 7)" />
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
      {/* External Harness quota is served stale-while-revalidate (a probe spawns a CLI process): it follows turns, not the poll. */}
      <div className="hp-foot">{t('quotaSource', { source: quota.kind === 'windows' && quota.plan ? `${quota.source} · ${quota.plan}` : quota.source,
        sync: quota.source === 'codex' || quota.source === 'claude-code' ? t('sync.turn') : t('sync.poll') })}</div>
    </div>}
  </div>;
}

// ---- context ring: the host ContextMeter's ring and percentage under the composer, in scarcity colors ----
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
      <span>{percent}%</span>
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

/** A Harness session's context reading, in the dock slot where DSH native sessions show theirs; DSH sessions read null. */
export function HarnessContext({ sessionId, useSessions, usage, t }: ContextDockProps) {
  const running = useSessions(s => s.byId[sessionId]?.running);
  const view = usePolled(() => usage(sessionId), running ? 5_000 : 30_000, [sessionId, running]);
  return <ContextRing usage={view ?? undefined} t={t} />;
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
export function HarnessSelect({ sessionId, useSessions, read, select, quota, viewing, modelProvider, changed, secretStatus, answerSecret, recover, t }: LeftProps) {
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
    void read(sessionId).then(next => { if (generation.current === version) { setState(next); changed(sessionId, next.harness); } })
      .catch(error => { if (generation.current === version) setError(error instanceof Error ? error.message : String(error)); });
    return () => { generation.current++; };
  }, [sessionId,summary?.running,read,changed]);
  // Switching the session's model provider changes whose account the quota describes, so the provider joins the
  // dependencies: a switch re-reads at once, while the interval still covers a window moving on its own.
  const provider = useModelProvider(modelProvider, sessionId);
  const quotaView = usePolled(() => quota(sessionId), 60_000, [sessionId, state?.harness, summary?.running, provider]);
  useViewing(viewing, sessionId, state !== undefined && state.harness !== 'dsh' && (summary?.retainedBy.mainView ?? 0) > 0);
  async function choose(next: State['harness']) {
    const version = generation.current; setBusy(true); setError(undefined); setOpen(false);
    try {
      const result = await select(sessionId, next);
      if (generation.current !== version) return;
      setState(result); changed(sessionId, result.harness);
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
export function HarnessModel({ sessionId, locked, useSessions, read, models, selectModel, selectThinking, selectConfig, subscribe, t }: ModelProps) {
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
    {error && <span role="alert" className="hp-alert">{error}</span>}
  </div>;
}

// ---- Settings page: the plugin's live configuration; DSH Settings validates each edit and persists it in the profile ----
type SettingsSectionInjected = { hooks: { harnessSettings: ConfigForm<Settings> }; form: ConfigForm<Settings> };
type SettingsSectionProps = PropsRuntime<'settings.section'> & PropsLocale<'harness'> & InjectFace<SettingsSectionInjected>;
type SettingField = keyof Settings;

/** Text kept locally while typing and committed on blur or Enter, so every keystroke is not a profile write. */
function DraftInput({ value, label, numeric, multiline, placeholder, disabled, onCommit }: { value: string; label: string; numeric?: boolean; multiline?: boolean; placeholder?: string; disabled: boolean; onCommit: (text: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  const commit = () => { if (draft !== value) onCommit(draft); };
  const common = { value: draft, disabled, placeholder, 'aria-label': label, onBlur: commit };
  return multiline ? <textarea {...common} rows={12} onChange={event => setDraft(event.target.value)} />
    : <input {...common} className={numeric ? 'hp-set-number' : undefined} inputMode={numeric ? 'numeric' : undefined} onChange={event => setDraft(event.target.value)}
      onKeyDown={event => { if (event.key === 'Enter') commit(); else if (event.key === 'Escape') setDraft(value); }} />;
}
function Toggle({ checked, label, disabled, onChange }: { checked: boolean; label: string; disabled: boolean; onChange: (checked: boolean) => void }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} className="hp-switch" disabled={disabled} onClick={() => onChange(!checked)}><span className="hp-switch-thumb" /></button>;
}
export function HarnessSettingsSection({ useHarnessSettings, form, t }: SettingsSectionProps) {
  const snapshot = useHarnessSettings(value => value);
  const [failed, setFailed] = useState<SettingField>();
  const value = snapshot.value;
  if (snapshot.status !== 'ready' || !value) return <div className="hp-set">
    <h2 className="hp-set-page">{t('settingsNav')}</h2>
    <p className="hp-set-intro">{snapshot.status === 'loading' ? t('loading') : t('settingsUnavailable')}</p>
  </div>;
  const disabled = !snapshot.writable;
  // A field present in the profile's own layer is an override, even when it equals the default.
  const user = typeof snapshot.user === 'object' && snapshot.user !== null ? snapshot.user as Record<string, unknown> : {};
  const settle = (field: SettingField, work: Promise<boolean>) => { setFailed(undefined); void work.then(ok => { if (!ok) setFailed(field); }, () => setFailed(field)); };
  const label = (field: SettingField) => t(`setting.${field}` as Key);
  const row = (field: SettingField, control: ReactNode, wide = false) => <div key={field} className={`hp-set-row${wide ? ' hp-set-wide' : ''}`}>
    <div className="hp-set-copy">
      <div className="hp-set-title">{label(field)}
        {field in user && <button type="button" className="hp-set-reset" disabled={disabled} onClick={() => settle(field, form.unset(field))}>{t('settingsReset')}</button>}
      </div>
      <div className="hp-set-hint">{t(`setting.${field}.hint` as Key)}</div>
      {failed === field && <div role="alert" className="hp-set-error">{t('settingsRejected')}</div>}
    </div>
    <div className="hp-set-control">{control}</div>
  </div>;
  // Clearing a text field returns it to its default rather than storing an empty override.
  const text = (field: 'codexCommand' | 'claudeCommand', placeholder?: string) => <DraftInput value={value[field] ?? ''} label={label(field)} placeholder={placeholder} disabled={disabled}
    onCommit={draft => settle(field, draft.trim() ? form.set(field, draft.trim()) : form.unset(field))} />;
  const number = (field: SettingField) => <DraftInput numeric value={String(value[field])} label={label(field)} disabled={disabled} onCommit={draft => {
    const parsed = Number(draft.trim());
    if (!draft.trim() || !Number.isInteger(parsed) || parsed < 0) setFailed(field); else settle(field, form.set(field, parsed));
  }} />;
  const toggle = (field: SettingField, off = false) => <Toggle checked={value[field] === true} label={label(field)} disabled={disabled || off} onChange={next => settle(field, form.set(field, next))} />;
  const group = (title: Key, rows: ReactNode) => <section className="hp-set-group" aria-label={t(title)}><h3 className="hp-set-head">{t(title)}</h3>{rows}</section>;
  return <div className="hp-set">
    <h2 className="hp-set-page">{t('settingsNav')}</h2>
    <p className="hp-set-intro">{t('settingsIntro')}</p>
    {disabled && <p className="hp-set-intro" role="note">{t('settingsReadOnly')}</p>}
    {group('settingsGroup.programs', <>{row('codexCommand', text('codexCommand'))}{row('claudeCommand', text('claudeCommand', t('settingsAuto')))}</>)}
    {group('settingsGroup.sessions', row('idleCloseSeconds', number('idleCloseSeconds')))}
    {group('settingsGroup.delegation', <>
      {row('delegateHarnesses', <TaskHarnessSelector selected={value.delegateHarnesses ?? ['codex']} disabled={disabled} t={t} onChange={next => settle('delegateHarnesses', form.set('delegateHarnesses', next))} />)}
      {row('delegateReportBack', toggle('delegateReportBack'))}
      {row('delegateWorktree', toggle('delegateWorktree'))}
      {row('discussHarnesses', <TaskHarnessSelector discussion selected={value.discussHarnesses ?? ['codex', 'claude-code']} disabled={disabled} t={t} onChange={next => settle('discussHarnesses', form.set('discussHarnesses', next))} />)}
    </>)}
    {group('settingsGroup.feedback', <>
      {row('progressFeedback', toggle('progressFeedback'))}
      {row('progressFeedbackText', <DraftInput multiline value={value.progressFeedbackText ?? ''} label={label('progressFeedbackText')} disabled={disabled || !value.progressFeedback}
        onCommit={draft => settle('progressFeedbackText', form.set('progressFeedbackText', draft))} />, true)}
    </>)}
    {group('settingsGroup.advanced', <>
      {(['requestTimeoutSeconds', 'sessionLoadTimeoutSeconds', 'discussionTimeoutMinutes', 'toolOutputChars', 'peerReviewChars', 'discussionResultChars',
        'catalogCacheSeconds', 'quotaCacheSeconds', 'pluginCacheSeconds', 'recoveryCheckSeconds'] as const).map(field => row(field, number(field)))}
      {row('acpStderr', toggle('acpStderr'))}
    </>)}
  </div>;
}

// ---- right sidebar guide card: host geometry, with the provider beside the title ----
type GuideEntryProps = PropsRuntime<'sidebar.right.tab.guide.entry'> & PropsLocale<'harness'>;
export function GuideEntry({ kind, title, description, useTabInfo, t }: GuideEntryProps) {
  const { tab } = useTabInfo();
  return <button type="button" className="hp-guide" data-sidebar-right-guide-entry={kind} onClick={() => tab.actions.openTab(kind, { replaceTab: true })}>
    <span className="hp-guide-icon"><svg width={description === undefined ? 22 : 26} height={description === undefined ? 22 : 26} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" aria-hidden>
      <path d="M 8 2.5 L 12.9 5.2 V 10.8 L 8 13.5 L 3.1 10.8 V 5.2 Z" /><path d="M 3.1 5.2 L 8 7.9 L 12.9 5.2 M 8 7.9 V 13.5" strokeLinecap="round" />
    </svg></span>
    <span className="hp-guide-text">
      <span className="hp-guide-row">
        <span className="hp-guide-title">{title}</span>
        <span className="hp-guide-line" title={t('providedBy')}>{t('providedBy')}</span>
      </span>
      {description !== undefined && <span className="hp-guide-line">{description}</span>}
    </span>
  </button>;
}

// ---- right sidebar tab: Harness subagents, newest first; polled only while the tab is on screen ----
type SubagentsTabProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'harness'> & { load(): Promise<Subagents> };
export function SubagentsTab({ useTabInfo, load, t }: SubagentsTabProps) {
  const { tab } = useTabInfo();
  const list = usePolled(() => tab.visible ? load() : Promise.reject(), 2_000, [tab.visible]);
  const [open, setOpen] = useState<string>();
  if (!list) return <div className="hp-sub-empty">{t('loading')}</div>;
  if (!list.length) return <div className="hp-sub-empty">{t('subagentsEmpty')}</div>;
  return <div className="hp-sub">
    {[...list].reverse().map(agent => {
      const expanded = open === agent.id;
      return <section key={agent.id} className="hp-sub-agent">
        <button type="button" className="hp-sub-head" aria-expanded={expanded} onClick={() => setOpen(expanded ? undefined : agent.id)}>
          <span className={`hp-sub-dot hp-sub-${agent.status}`} aria-hidden />
          <span className="hp-sub-name">{agent.name}</span>
          <span className="hp-sub-status">{t(`subagent.${agent.status}`)}</span>
          <Chevron open={expanded} />
        </button>
        {agent.task && <p className={expanded ? 'hp-sub-task' : 'hp-sub-task hp-sub-clamp'}>{agent.task}</p>}
        {expanded && <div className="hp-sub-entries">
          {!agent.entries.length && <p className="hp-muted">{t('subagentNoActivity')}</p>}
          {agent.entries.map((entry, index) => entry.kind === 'tool'
            ? <details key={index} className="hp-sub-tool"><summary><span className={`hp-sub-dot hp-sub-${entry.status}`} aria-hidden />{entry.title}</summary>{entry.output && <pre>{entry.output}</pre>}</details>
            : <p key={index} className={entry.kind === 'thought' ? 'hp-sub-text hp-muted' : 'hp-sub-text'}>{entry.text}</p>)}
        </div>}
      </section>;
    })}
  </div>;
}

function ExternalOnboarding({ complete }: PropsRuntime<'settings.onboarding'>) {
  useEffect(() => { complete(); }, [complete]);
  return null;
}

/* Copied from the host's ModelSelect.module.css / PermissionSelect.module.css / ContextMeter.module.css so the
   plugin controls read as the same material: 28px r24 chips, r20 menus, 40px cells, 38px options, r12 panels. */
// The host ContextMeter (DSH native sessions) has no tier classes; its aria-label carries the reading (capped at 100%),
// so the same scarcity colors key on it: zh `上下文已用 N%`, en `N% of context used`.
const hostContextRing = (from = 0, to = 100) => from === 0 && to === 100
  ? 'button[aria-label^="上下文已用 "],button[aria-label$="% of context used"]'
  : Array.from({ length: to - from + 1 }, (_, i) => `button[aria-label="上下文已用 ${from + i}%"],button[aria-label="${from + i}% of context used"]`).join(',');
const nativeContextColors = `${hostContextRing()}{--hp-usage-color:var(--dsw-alias-state-success-primary)}
${hostContextRing(70, 89)}{--hp-usage-color:var(--dsw-alias-state-warn-primary)}
${hostContextRing(90, 100)}{--hp-usage-color:var(--dsw-alias-state-error-primary)}
:is(${hostContextRing()})>svg>circle:first-child{stroke:var(--hp-usage-color);stroke-opacity:.2}
:is(${hostContextRing()})>svg>circle:last-child{stroke:var(--hp-usage-color)}`;
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
.hp-ring{display:inline-flex;align-items:center;gap:6px;flex:none;padding:1px 8px;border:none;border-radius:24px;background:transparent;color:var(--dsw-alias-label-tertiary);font-family:inherit;font-size:var(--dsh-content-font-size-secondary,13px);font-variant-numeric:tabular-nums;line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));white-space:nowrap;cursor:pointer}
.hp-ring:hover,.hp-ring[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.hp-quota-ring,.hp-ring{--hp-usage-color:var(--dsw-alias-state-success-primary)}
.hp-quota-ring.hp-warn,.hp-ring.hp-warn{--hp-usage-color:var(--dsw-alias-state-warn-primary)}
.hp-quota-ring.hp-danger,.hp-ring.hp-danger{--hp-usage-color:var(--dsw-alias-state-error-primary)}
.hp-track{fill:none;stroke:var(--hp-usage-color);stroke-opacity:.2;stroke-width:2}
.hp-fill{fill:none;stroke:var(--hp-usage-color);stroke-width:2;stroke-linecap:round}
${nativeContextColors}
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
.hp-guide{display:flex;gap:14px;align-items:center;box-sizing:border-box;width:380px;max-width:100%;min-height:56px;padding:14px 20px;color:var(--dsw-alias-label-primary);font:inherit;text-align:left;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l3);border-radius:24px;cursor:pointer}
.hp-guide:hover{background:var(--dsw-alias-interactive-bg-hover)}
.hp-guide-icon{display:flex;flex:none;align-items:center;justify-content:center;width:26px;height:26px;color:var(--dsw-alias-label-tertiary)}
.hp-guide-text{display:flex;flex-direction:column;gap:3px;min-width:0}
.hp-guide-row{display:flex;align-items:baseline;gap:8px;min-width:0}
.hp-guide-title{flex:none}
.hp-guide-title,.hp-guide-line{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;line-height:1.4}
.hp-guide-title{font-size:14px}
.hp-guide-line{font-size:13px;color:var(--dsw-alias-label-caption)}
.hp-sub{display:flex;flex-direction:column;gap:8px;height:100%;box-sizing:border-box;overflow:auto;padding:12px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}
.hp-sub-empty{padding:24px 16px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary);text-align:center}
.hp-sub-agent{border-radius:12px;background:var(--dsw-alias-interactive-bg-hover)}
.hp-sub-head{display:flex;align-items:center;gap:8px;width:100%;min-height:36px;padding:6px 10px;border:none;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.hp-sub-name{flex:1;min-width:0;overflow:hidden;font-weight:500;text-overflow:ellipsis;white-space:nowrap}
.hp-sub-status{flex:none;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.hp-sub-dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-dimmed)}
.hp-sub-running{background:var(--dsw-static-blue-450);animation:hp-pulse 1.2s ease-in-out infinite}.hp-sub-completed{background:var(--dsw-alias-state-success-primary)}.hp-sub-failed{background:var(--dsw-alias-state-error-primary)}
@keyframes hp-pulse{50%{opacity:.35}}
.hp-sub-task{margin:0;padding:0 10px 8px 26px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word}
.hp-sub-clamp{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.hp-sub-entries{display:flex;flex-direction:column;gap:6px;padding:8px 10px 10px;border-top:.5px solid var(--dsw-alias-border-l2)}
.hp-sub-text{margin:0;white-space:pre-wrap;word-break:break-word}
.hp-sub-tool summary{display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px;color:var(--dsw-alias-label-secondary);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.hp-sub-tool pre{max-height:240px;margin:4px 0 0;padding:8px;overflow:auto;border-radius:8px;background:var(--dsw-specific-menu);font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-word}
.hp-secret{position:absolute;bottom:100%;left:0;z-index:110;max-height:60vh;overflow:auto;width:340px;padding:16px;border-radius:12px;background:var(--dsw-specific-menu);box-shadow:var(--dsw-elevation-prominent);font-size:14px}.hp-secret input,.hp-secret select{display:block;box-sizing:border-box;width:100%;margin-top:4px}.hp-secret p{font-size:12px}.hp-alert{max-width:360px;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}
.hp-user-editable{position:relative}
.hp-user-editable>div>div:last-child{padding-right:calc(36px + var(--dsh-content-font-delta,0px))}
.hp-edit-action{position:absolute;right:0;bottom:0;display:inline-flex;align-items:center;justify-content:center;width:calc(28px + var(--dsh-content-font-delta,0px));height:calc(28px + var(--dsh-content-font-delta,0px));padding:6px;border:none;border-radius:28px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.hp-edit-action:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
@media (hover:hover){
[data-chat-flow-kind='user']:has(~ :is([data-chat-flow-kind='user'],[data-chat-flow-kind='steering'])) .hp-edit-action{opacity:0;transition:opacity 80ms ease}
[data-chat-flow-kind='user']:has(~ :is([data-chat-flow-kind='user'],[data-chat-flow-kind='steering'])):is(:hover,:focus-within) .hp-edit-action{opacity:1}
}
.hp-edit{display:flex;flex-direction:column;gap:8px;margin-left:auto;width:min(calc(var(--dsh-chat-content-width,748px) * 0.702),82%)}
.hp-edit textarea{box-sizing:border-box;width:100%;padding:10px 16px;border:1px solid var(--dsw-alias-border-l2);border-radius:16px;background:var(--dsw-specific-bubble);color:var(--dsw-alias-label-primary);font:inherit;font-size:var(--dsh-content-font-size,14px);line-height:calc(22px + var(--dsh-content-font-delta,0px));resize:vertical;outline:none}
.hp-edit textarea:focus{border-color:var(--dsw-alias-border-l3)}
.hp-edit-bar{display:flex;align-items:center;justify-content:flex-end;gap:8px}
.hp-edit-hint{flex:1;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.hp-edit-bar button{height:30px;padding:0 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:15px;background:transparent;color:var(--dsw-alias-label-primary);font-size:13px;cursor:pointer}
.hp-edit-bar button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.hp-edit-bar .hp-edit-send{border-color:transparent;background:var(--dsw-alias-label-primary);color:var(--dsw-specific-bubble)}
.hp-edit-bar .hp-edit-send:hover:not(:disabled){background:var(--dsw-alias-label-secondary)}
.hp-edit-bar button:disabled{opacity:.5;cursor:default}
.hp-edit-error{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}
[data-composer-seat] [role=status]:has(~ [data-composer-card]){box-sizing:border-box}
.hp-delegate{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance));max-width:var(--dsh-composer-card-max-width);margin:0 auto;padding:7px 10px;border-bottom:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:20px}
.hp-delegate>strong{color:var(--dsw-alias-label-primary);font-weight:600}
.hp-delegate[data-hp-mode=delegate],[data-composer-seat]:has(.hp-delegate[data-hp-mode=delegate]){--hp-mode-color:var(--dsw-alias-state-warn-label)}
.hp-delegate[data-hp-mode=discuss],[data-composer-seat]:has(.hp-delegate[data-hp-mode=discuss]){--hp-mode-color:var(--dsw-static-blue-450)}
.hp-delegate[data-hp-mode]>strong{color:var(--hp-mode-color);white-space:nowrap}
/* Task modes ring the composer card of the same seat in their command color. */
[data-composer-seat]:has(.hp-delegate[data-hp-mode]) [data-composer-card]{--dsw-elevation-stroke-color:var(--hp-mode-color);box-shadow:0 0 0 1.5px var(--hp-mode-color),var(--dsw-elevation-soft,0 0 #0000)}
.hp-delegate-harness{display:flex;padding:2px;border-radius:9px;background:var(--dsw-alias-interactive-bg-hover)}
.hp-delegate-harness button{display:inline-flex;align-items:center;gap:4px;height:26px;padding:0 9px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer}
.hp-delegate-harness button:disabled{opacity:.4;cursor:not-allowed}
.hp-delegate-harness button svg{width:13px;height:13px;flex:none}
.hp-delegate-harness button[aria-checked=true]{background:var(--dsw-specific-menu);color:var(--dsw-alias-label-primary)}
.hp-delegate-harness button:focus-visible,.hp-delegate-exit:focus-visible{outline:2px solid var(--dsw-alias-border-l3);outline-offset:1px}
.hp-delegate-report{display:flex;align-items:center;gap:6px;margin-left:auto;white-space:nowrap;cursor:pointer}.hp-delegate-report input{margin:0}
.hp-delegate-report+.hp-delegate-report{margin-left:0}.hp-delegate-report:has(input:disabled){opacity:.5;cursor:not-allowed}
.hp-delegate[data-hp-mode=discuss] .hp-delegate-exit{margin-left:auto}
.hp-delegate-exit{display:grid;place-items:center;width:28px;height:28px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:18px;cursor:pointer}.hp-delegate-exit:hover{background:var(--dsw-alias-interactive-bg-hover)}
@media(max-width:600px){.hp-delegate{flex-wrap:wrap}.hp-delegate-report{margin-left:0}.hp-delegate-exit{margin-left:auto}}
.hp-set{display:flex;flex-direction:column;gap:12px;max-width:720px;color:var(--dsw-alias-label-primary)}
.hp-set-page{margin:0;font-size:18px;font-weight:600}
.hp-set-intro{margin:0;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.hp-set-group{display:flex;flex-direction:column;margin-top:20px}
.hp-set-head{margin:0 0 2px;font-size:12px;font-weight:600;letter-spacing:.06em;color:var(--dsw-alias-label-tertiary)}
.hp-set-row{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:14px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.hp-set-row:last-child{border-bottom:none}
.hp-set-wide{flex-direction:column;align-items:stretch;gap:10px}
.hp-set-copy{display:grid;gap:4px;min-width:0}
.hp-set-title{display:flex;align-items:center;gap:8px;font-size:14px;line-height:20px}
.hp-set-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.hp-set-error{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}
.hp-set-reset{padding:0;border:none;background:none;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;cursor:pointer;text-decoration:underline;text-underline-offset:2px}
.hp-set-reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.hp-set-control{display:flex;justify-content:flex-end;flex:0 0 auto;min-width:0}
.hp-set-control input,.hp-set-control textarea{box-sizing:border-box;padding:6px 12px;border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px}
.hp-set-control input{width:260px}.hp-set-control input.hp-set-number{width:120px;text-align:right;font-variant-numeric:tabular-nums}
.hp-set-control textarea{width:100%;resize:vertical;font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:12px;line-height:18px}
.hp-set-control input:focus-visible,.hp-set-control textarea:focus-visible{outline:2px solid var(--dsw-alias-border-l3);outline-offset:1px}
.hp-set-control :disabled{opacity:.5;cursor:not-allowed}
.hp-switch{box-sizing:border-box;position:relative;flex:0 0 auto;width:36px;height:20px;padding:2px;border:0;border-radius:10px;background:var(--dsw-alias-border-l3);cursor:pointer}
.hp-switch[aria-checked=true]{background:var(--dsw-alias-brand-primary)}.hp-switch:disabled{opacity:.5;cursor:default}
.hp-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.hp-switch-thumb{display:block;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-primary-foreground);transition:transform 120ms ease}
.hp-switch[aria-checked=true] .hp-switch-thumb{transform:translateX(16px)}
@media(max-width:600px){.hp-set-row{flex-direction:column;align-items:stretch;gap:10px}.hp-set-control{justify-content:flex-start}.hp-set-control input{width:100%}}
@media(prefers-reduced-motion:reduce){.hp-switch-thumb{transition:none}}
`;

// ---- editable user messages: wraps the host's user bubble; registered only while the current session runs on a Harness ----
const Pencil = () => <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden><path d="M10.2 3.3l2.5 2.5M3 13l.6-2.9 7.3-7.3a1.2 1.2 0 011.7 0l.6.6a1.2 1.2 0 010 1.7l-7.3 7.3L3 13z" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>;
interface EditInjected {
  read(id: string): Promise<State>;
  edit(id: string, seq: number, text: string, requestId: string): Promise<State>;
  /** The user renderer this one shadows (the host's bubble). */
  host(): ComponentType<ChatNodeViewProps<'user'>> | undefined;
  ht: T;
}
export function EditableUserMessage(props: ChatNodeViewProps<'user'> & InjectFace<EditInjected>) {
  const { sessionId, useSessions, node, read, edit, host, ht } = props;
  const Host = host();
  const running = !!useSessions(s => s.byId[sessionId]?.running);
  const [state, setState] = useState<State>();
  const [draft, setDraft] = useState<string>();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const requestId = useRef('');
  useEffect(() => {
    let live = true;
    void read(sessionId).then(next => { if (live) setState(next); }, () => {});
    return () => { live = false; };
  }, [sessionId, running, read]);
  const content = node.data.content;
  const text = content.flatMap(part => part.type === 'text' ? [part.text] : []).join('');
  const attached = content.some(part => part.type !== 'text');
  const turn = node.location.kind === 'turn' || node.location.kind === 'step' ? node.location.turn.turn : undefined;
  const editable = !running && !!state && !state.recoveryRequired && turn !== undefined && state.editableTurns.includes(turn);
  async function submit() {
    if (draft === undefined || busy || (!draft.trim() && !attached)) return;
    setBusy(true); setError('');
    try { setState(await edit(sessionId, node.data.seq, draft, requestId.current)); setDraft(undefined); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  if (draft !== undefined) return <div className="hp-edit">
    <textarea autoFocus value={draft} disabled={busy} aria-label={ht('edit')} rows={Math.min(12, draft.split('\n').length + 1)}
      onChange={event => setDraft(event.target.value)}
      onKeyDown={event => {
        if (event.key === 'Escape' && !busy) setDraft(undefined);
        else if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); }
      }} />
    {error && <p className="hp-edit-error" role="alert">{error}</p>}
    <div className="hp-edit-bar">
      <span className="hp-edit-hint">{ht('editHint')}</span>
      <button type="button" disabled={busy} onClick={() => setDraft(undefined)}>{ht('editCancel')}</button>
      <button type="button" className="hp-edit-send" disabled={busy || (!draft.trim() && !attached)} onClick={() => void submit()}>{ht('editSend')}</button>
    </div>
  </div>;
  return <div className={editable ? 'hp-user hp-user-editable' : 'hp-user'}>
    {Host && <Host {...props} />}
    {editable && <button type="button" className="hp-edit-action" aria-label={ht('edit')} title={ht('edit')}
      onClick={() => { requestId.current = crypto.randomUUID(); setError(''); setDraft(text); }}><Pencil /></button>}
  </div>;
}

// ---- sidebar marks: host session rows expose no slot, so rows get a data attribute and CSS draws the logo in the empty status cell ----
// Brand marks: DeepSeek whale from dsh-client-ui-primitives FishLogo; OpenAI and Claude from Simple Icons (CC0).
const FISH_LOGO_PATH = 'M22.9168 1.43018C22.6713 1.31018 22.5658 1.53918 22.4223 1.65519C22.3733 1.69269 22.3318 1.74169 22.2903 1.78669C21.9317 2.1697 21.5127 2.42121 20.9657 2.39121C20.1657 2.34621 19.4827 2.59771 18.8787 3.20973C18.7502 2.45521 18.3236 2.0047 17.6746 1.71569C17.3351 1.56568 16.9916 1.41518 16.7536 1.08867C16.5876 0.856163 16.5421 0.597155 16.4591 0.341647C16.4061 0.187643 16.3536 0.0301382 16.1761 0.00363739C15.9836 -0.0263635 15.9081 0.135141 15.8326 0.270145C15.5306 0.822162 15.4136 1.43018 15.4251 2.0462C15.4516 3.43174 16.0366 4.53527 17.1991 5.3203C17.3311 5.4103 17.3651 5.5003 17.3236 5.63181C17.2441 5.90231 17.1501 6.16482 17.0671 6.43533C17.0141 6.60784 16.9351 6.64584 16.7501 6.57033C16.1121 6.30383 15.5611 5.90931 15.074 5.4328C14.2475 4.63328 13.5 3.75075 12.568 3.05973C12.349 2.89822 12.13 2.74822 11.9034 2.60522C10.9524 1.68169 12.028 0.923165 12.277 0.833162C12.5375 0.739159 12.3675 0.41615 11.5259 0.42015C10.6844 0.42365 9.91439 0.705658 8.93286 1.08117C8.78935 1.13767 8.63835 1.17867 8.48384 1.21267C7.59332 1.04367 6.66829 1.00617 5.70226 1.11517C3.88321 1.31768 2.43016 2.1777 1.36213 3.64575C0.0790928 5.4103 -0.222916 7.41536 0.146595 9.50642C0.535106 11.7105 1.66014 13.535 3.38869 14.9616C5.18125 16.4406 7.24581 17.1657 9.60138 17.0266C11.0319 16.9441 12.6245 16.7526 14.421 15.2321C14.874 15.4576 15.3496 15.5476 16.1381 15.6151C16.7456 15.6716 17.3306 15.5851 17.7836 15.4911C18.4931 15.3411 18.4441 14.6841 18.1876 14.5636C16.1081 13.595 16.5646 13.9891 16.1496 13.67C17.2061 12.42 18.8202 10.1979 19.3182 7.17235C19.3672 6.83834 19.4297 6.36783 19.4222 6.09732C19.4182 5.93231 19.4562 5.86831 19.6447 5.84931C20.1657 5.78931 20.6712 5.64681 21.1357 5.3913C22.4833 4.65528 23.0268 3.44624 23.1548 1.9972C23.1738 1.77569 23.1508 1.54668 22.9168 1.43018ZM11.1749 14.4736C9.15936 12.889 8.18184 12.3675 7.77832 12.39C7.40081 12.4125 7.46881 12.8445 7.55182 13.126C7.63882 13.404 7.75182 13.5955 7.91033 13.8396C8.01983 14.0011 8.09533 14.2411 7.80083 14.4216C7.15181 14.8231 6.02327 14.2866 5.97027 14.2601C4.65673 13.4865 3.5587 12.4655 2.78467 11.069C2.03715 9.72493 1.60314 8.28289 1.53164 6.74384C1.51264 6.37233 1.62214 6.24082 1.99215 6.17332C2.47916 6.08332 2.98118 6.06432 3.46769 6.13582C5.52476 6.43633 7.27581 7.35586 8.74385 8.8129C9.58188 9.64243 10.2159 10.634 10.8689 11.6025C11.5634 12.631 12.3105 13.611 13.262 14.4146C13.598 14.6961 13.866 14.9101 14.1225 15.0681C13.349 15.1546 12.058 15.1731 11.1749 14.4746L11.1749 14.4736ZM12.141 8.25988C12.141 8.09488 12.273 7.96338 12.439 7.96338C12.4765 7.96338 12.5105 7.97088 12.541 7.98188C12.5825 7.99688 12.6205 8.01938 12.6505 8.05338C12.7035 8.10588 12.7335 8.18088 12.7335 8.25988C12.7335 8.42489 12.6015 8.55639 12.4355 8.55639C12.2695 8.55639 12.141 8.42489 12.141 8.25988ZM15.1415 9.79893C14.949 9.87793 14.7565 9.94544 14.5715 9.95294C14.2845 9.96794 13.9715 9.85143 13.8015 9.70893C13.5375 9.48742 13.3485 9.36342 13.2695 8.97691C13.2355 8.8119 13.2545 8.55639 13.2845 8.40989C13.3525 8.09438 13.277 7.89187 13.0545 7.70787C12.8735 7.55786 12.643 7.51636 12.39 7.51636C12.2955 7.51636 12.209 7.47486 12.1445 7.44136C12.039 7.38886 11.9519 7.25735 12.035 7.09585C12.0615 7.04335 12.19 6.91584 12.22 6.89334C12.5635 6.69784 12.9595 6.76184 13.326 6.90834C13.6655 7.04735 13.9225 7.30236 14.292 7.66287C14.6695 8.09838 14.7375 8.21838 14.9525 8.54539C15.1225 8.8009 15.277 9.06341 15.3831 9.36392C15.4471 9.55142 15.3641 9.70493 15.1415 9.79893Z';
const OPENAI_PATH = 'M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z';
const CLAUDE_PATH = 'm4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z';
const svg = (viewBox: string, path: string) => `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}"><path d="${path}"/></svg>`)}")`;
const logos: Record<State['harness'], { mask: string; color: string }> = {
  dsh: { color: '#4D6BFE', mask: svg('0 0 23.16 17.04', FISH_LOGO_PATH) },
  codex: { color: '#10A37F', mask: svg('0 0 24 24', OPENAI_PATH) },
  'claude-code': { color: '#D97757', mask: svg('0 0 24 24', CLAUDE_PATH) },
};
const delegatedMask = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><mask id="m"><circle cx="5" cy="5" r="5" fill="#fff"/><path d="M3 3l4 4M7 4v3H4" stroke="#000" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></mask><circle cx="5" cy="5" r="5" mask="url(#m)"/></svg>')}")`;
const markStyles = Object.entries(logos).map(([harness, { mask, color }]) =>
  `[data-hp-harness="${harness}"]>span:first-child:empty::before,[data-hp-harness="${harness}"]:not([data-hp-closed])>span:first-child::before{content:"";width:14px;height:14px;background:${color};-webkit-mask:${mask} center/contain no-repeat;mask:${mask} center/contain no-repeat}`).join('\n')
  // A running turn replaces the host's status dots with its breathing brand mark; an idle live Harness stays static.
  + `\n[data-hp-running]>span:first-child>*{display:none}`
  + `\n[data-hp-running]>span:first-child::before{animation:hp-logo-breathe 1.4s ease-in-out infinite}`
  + `\n@keyframes hp-logo-breathe{0%,100%{opacity:.55;transform:scale(.9)}50%{opacity:1;transform:scale(1.06)}}`
  + `\n@media (prefers-reduced-motion:reduce){[data-hp-running]>span:first-child::before{animation:none}}`
  // Delegated sessions: a solid badge with a cut-out arrow on the logo's bottom-right corner, in the logo's state color.
  + `\n[data-hp-delegated]>span:first-child:empty{position:relative}[data-hp-delegated]>span:first-child:empty::after{content:"";position:absolute;right:-2px;bottom:0;width:9px;height:9px;background:#4D6BFE;-webkit-mask:${delegatedMask} center/contain no-repeat;mask:${delegatedMask} center/contain no-repeat}`
  // Closed sessions (no live Harness process, or an unloaded DSH agent) show the logo and badge in gray.
  + `\n[data-hp-closed]>span:first-child:empty::before,[data-hp-closed]>span:first-child:empty::after{background:var(--dsw-alias-label-tertiary)}`;
/** Session id from the row's React props (the host's SessionNodeItem receives `node`); undefined for non-session rows. */
// ponytail: reads React internals because the host has no session-row slot; replace with a slot once DSH offers one.
function rowSessionId(row: Element): string | undefined {
  const key = Object.keys(row).find(name => name.startsWith('__reactFiber$'));
  let fiber = key ? (row as unknown as Record<string, { return?: unknown; memoizedProps?: { node?: { id?: unknown } } }>)[key] : undefined;
  for (let depth = 0; fiber && depth < 20; depth++, fiber = fiber.return as typeof fiber) {
    const id = fiber.memoizedProps?.node?.id;
    if (typeof id === 'string') return id;
  }
  return undefined;
}

export async function apply(ctx: Context): Promise<void> {
  const unmount = await ctx.remote.$mount(contribution);
  ctx.effect(() => unmount, 'harness: Remote client');
  ctx.effect(() => ctx.locale.register('harness',{zh,en}), 'harness: locale');
  ctx.effect(() => {
    const style=document.createElement('style');
    style.textContent=styles;
    document.head.append(style);return ()=>style.remove();
  }, 'harness: selector styles');
  ctx.effect(() => {
    const style=document.createElement('style');
    style.textContent=markStyles;
    document.head.append(style);return ()=>style.remove();
  }, 'harness: sidebar mark styles');
  // Harness per session for the composer menus; the selector reports every switch, a failed read is retried next time.
  const harnesses = new Map<string, Promise<State['harness']>>();
  const harnessOf = (remote: Api, sessionId: string) => {
    let harness = harnesses.get(sessionId);
    if (!harness) {
      harnesses.set(sessionId, harness = value(remote.state({ sessionId })).then(state => state.harness));
      harness.catch(() => { if (harnesses.get(sessionId) === harness) harnesses.delete(sessionId); });
    }
    return harness;
  };
  ctx.inject(['sessions', 'remote.harness'], scope => {
    let nativeSeats: Array<()=>void> = [];
    const known = new Map<string,State['harness']>();
    // Harness, delegation and running state per session id for sidebar marks; visible rows are re-read on an interval and when the session list changes.
    const fetched = new Set<string>(), delegated = new Set<string>(), running = new Set<string>();
    let frame = 0, loading = false;
    function paint() {
      frame = 0;
      const {byId}=scope.sessions.list.getSnapshot();
      const missing: string[] = [];
      for (const row of document.querySelectorAll<HTMLElement>('[role="treeitem"]')) {
        const id=rowSessionId(row);
        if (!id) continue;
        const summary=byId[id as keyof typeof byId];
        if (!summary) continue;
        const harness=known.get(id);
        if (harness && row.dataset.hpHarness !== harness) row.dataset.hpHarness=harness;
        if (delegated.has(id) && row.dataset.hpDelegated === undefined) row.dataset.hpDelegated='';
        if (summary.running === (row.dataset.hpRunning === undefined)) { if (summary.running) row.dataset.hpRunning=''; else delete row.dataset.hpRunning; }
        if (harness && running.has(id) === (row.dataset.hpClosed !== undefined)) { if (running.has(id)) delete row.dataset.hpClosed; else row.dataset.hpClosed=''; }
        if (!fetched.has(id)) missing.push(id);
      }
      if (!missing.length || loading) return;
      loading=true;
      void value(scope.remote.harness.harnesses({sessionIds:missing})).then(result => {
        for (const [id,mark] of Object.entries(result)) {
          fetched.add(id); if (mark.delegated) delegated.add(id);
          if (mark.running) running.add(id); else running.delete(id);
          if (!known.has(id) || mark.harness !== 'dsh') known.set(id,mark.harness);
        }
      }, () => {}).finally(() => { loading=false; schedule(); });
    }
    const schedule = () => { if (!frame) frame=requestAnimationFrame(paint); };
    const listeners = new Set<() => void>();
    // The host's per-session model directory is the one shared, durable view of "which provider this session is on":
    // both the /model popup and the composer seat write it, so the quota chip follows a switch without waiting a poll.
    // Handles are cached per session so React keeps one subscription across renders; a missing service (older host)
    // returns null and leaves the interval as the only refresh.
    const providers = new Map<string, ModelProvider>();
    const modelProvider: Injected['modelProvider'] = id => {
      const cached = providers.get(id);
      if (cached) return cached;
      const directories = scope.get('modelDirectories');
      if (!directories) return null;
      let handle: ModelProvider;
      try {
        const { store } = directories.directoryFor(id as never);
        handle = { get: () => store.getSnapshot().current?.provider ?? null, subscribe: onChange => store.subscribe(onChange) };
      } catch { return null; }
      providers.set(id, handle);
      return handle;
    };
    // `/plan` in a Harness session switches its permission or collaboration mode; the seats re-read it.
    scope.on('command/executed', (_sessionId, name) => { if (name === 'plan') for (const listener of listeners) listener(); });
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
      viewing:id=>value(scope.remote.harness.viewing({sessionId:id})),
      modelProvider,
      changed:(id,harness)=>{known.set(id,harness);harnesses.set(id,Promise.resolve(harness));syncModel();schedule();for (const listener of listeners) listener();},
      subscribe:listener=>{listeners.add(listener);return ()=>{listeners.delete(listener);};},
    };
    // Every user bubble reads the same state after a turn; concurrent reads share one request.
    const reads = new Map<string, Promise<State>>();
    const editApi: EditInjected = {
      read: id => {
        let read = reads.get(id);
        if (!read) { reads.set(id, read = api.read(id)); read.finally(() => reads.delete(id)).catch(() => {}); }
        return read;
      },
      edit: (sessionId, seq, text, requestId) => value(scope.remote.harness.edit({ sessionId, seq, text, requestId })),
      host: () => scope.slots.entries('conversation.chat.node').filter(entry => entry.options.key === 'user' && entry.component !== EditableUserMessage)
        .sort((a, b) => (a.options.priority ?? 0) - (b.options.priority ?? 0))[0]?.component as ComponentType<ChatNodeViewProps<'user'>> | undefined,
      ht: ctx.locale.bind('harness'),
    };
    function syncModel() {
      const {byId}=scope.sessions.list.getSnapshot();
      // The open session is the one the main view retains (the snapshot has no `current` since DSH 0.1.6).
      const current=Object.values(byId).find(session => (session.retainedBy.mainView ?? 0) > 0)?.id;
      for (const id of known.keys()) if (!(id in byId)) known.delete(id);
      for (const id of fetched) if (known.get(id) === 'dsh' && id !== current) fetched.delete(id);
      schedule();
      const external=current !== undefined && known.get(current) !== undefined && known.get(current) !== 'dsh';
      if (external && !nativeSeats.length) {
        nativeSeats = [scope.slots.register({ name: 'conversation.input.plan', priority: -100 }, () => null)];
        nativeSeats.push(scope.slots.register({ name: 'conversation.input.permission', priority: -100, locale: 'harness', inject: () => api }, HarnessPermission));
        nativeSeats.push(scope.slots.register({ name: 'conversation.input.model', priority: -100, locale: 'harness', inject: () => api }, HarnessModel));
        // After the host's session stats (order 0), where the host draws a DSH session's context reading.
        nativeSeats.push(scope.slots.register({ name: 'conversation.composer.dock', id: 'harness-context', order: 100, locale: 'harness', inject: () => api }, HarnessContext));
        nativeSeats.push(scope.slots.register({ name: 'settings.onboarding', id: 'deepseek-official', priority: -100 }, ExternalOnboarding));
        nativeSeats.push(scope.slots.inject('conversation.chat.node', () => scope.slots.register({ name: 'conversation.chat.node', key: 'user', priority: -100,
          locale: 'chat', inject: () => editApi }, EditableUserMessage)));
      }
      if (!external && nativeSeats.length) { for (const dispose of nativeSeats) dispose(); nativeSeats = []; }
    }
    scope.effect(()=>{
      const stop=scope.sessions.list.subscribe(syncModel);
      return ()=>{stop();for (const dispose of nativeSeats) dispose();};
    },'harness: native model seat');
    scope.effect(()=>{
      const observer=new MutationObserver(schedule);
      observer.observe(document.body,{childList:true,subtree:true});
      schedule();
      // Processes start with a turn and are reclaimed when idle, so every visible row is re-read periodically.
      // ponytail: polls all visible rows every 5s; push process start/exit events if the sidebar grows large.
      const refresh=setInterval(()=>{fetched.clear();schedule();},5_000);
      return ()=>{observer.disconnect();clearInterval(refresh);cancelAnimationFrame(frame);frame=0;for (const row of document.querySelectorAll<HTMLElement>('[data-hp-harness],[data-hp-delegated],[data-hp-running],[data-hp-closed]')) { delete row.dataset.hpHarness; delete row.dataset.hpDelegated; delete row.dataset.hpRunning; delete row.dataset.hpClosed; }};
    },'harness: sidebar marks');
    scope.slots.inject('conversation.input.left',()=>scope.slots.register({
      name:'conversation.input.left',id:'harness-selector',order:-100,locale:'harness',inject:()=>api,
    },HarnessSelect));
  });
  // `/` in a Harness session keeps the DSH rows a Harness carries out: attaching files, and goal / plan / compact / clear, which the
  // server runs on the Harness. The rest act on DSH's agent (the server already hides its commands); a typed `/model`
  // reaches the Harness as a prompt instead of DSH's model picker.
  ctx.inject(['commandUi', 'remote.harness', 'remote.commands'], scope => {
    type Source = {
      candidates(session: ClientSessionContext, request: { query: string; position?: string }, ...rest: unknown[]): Promise<readonly InputTriggerCandidate[]>;
      dispatch(pick: InputTriggerPick): PickOutcome;
      matchSpace(session: ClientSessionContext, token: string): PickOutcome;
      matchEnter(session: ClientSessionContext, line: string, signal?: AbortSignal, envelope?: SubmitEnvelope): Promise<PickOutcome>;
    };
    const runtime = scope.commandUi as unknown as Source;
    const t = ctx.locale.bind('harness');
    const enter = (name: 'delegate' | 'discuss', session: ClientSessionContext) => {
      if (taskModes.get(session.sessionId)?.busy) return 'handled' as const;
      setTaskMode(session.sessionId, name === 'delegate' ? delegationClaim(scope.remote.harness, session, t) : discussionClaim(scope.remote.harness, session, t));
      return { text: '' } as const;
    };
    const external = async (sessionId: string) => (await harnessOf(scope.remote.harness, sessionId).catch(() => 'dsh')) !== 'dsh';
    const candidates = runtime.candidates.bind(runtime), dispatch = runtime.dispatch.bind(runtime);
    const matchSpace = runtime.matchSpace.bind(runtime), matchEnter = runtime.matchEnter.bind(runtime);
    const kept = new Set(['file', 'goal', 'plan', 'compact', 'clear']);
    const replacements: Source = {
      candidates: async (session, request, ...rest) => {
        if (taskModes.has(session.sessionId)) return [];
        const original = await candidates(session, request, ...rest);
        const rows = await external(session.sessionId) ? original.filter(row => kept.has(row.name)).map(row => row.name === 'clear'
          ? { ...row, label: t('clear'), description: t('clearDescription'), icon: ClearIcon, section: t('commands') } : row) : [...original];
        const query = request.query.toLowerCase();
        const commands = [
          { name: 'delegate', label: t('delegate'), description: t('delegateDescription'), icon: PluginIcon, section: t('commands') },
          { name: 'discuss', label: t('discuss'), description: t('discussDescription'), icon: PluginIcon, section: t('commands') },
        ].filter(command => command.name.includes(query));
        if (request.position === 'inline' || !commands.length) return rows;
        const compact = rows.findIndex(row => row.name === 'compact');
        return compact < 0 ? [...rows, ...commands] : [...rows.slice(0, compact + 1), ...commands, ...rows.slice(compact + 1)];
      },
      dispatch: pick => taskModes.has(pick.session.sessionId) ? undefined : pick.candidate.name === 'delegate' || pick.candidate.name === 'discuss' ? enter(pick.candidate.name, pick.session) : dispatch(pick),
      matchSpace: (session, token) => taskModes.has(session.sessionId) ? undefined : token === '/delegate' ? enter('delegate', session) : token === '/discuss' ? enter('discuss', session) : matchSpace(session, token),
      matchEnter: async (session, line, ...rest) => taskModes.has(session.sessionId) || /^\/(delegate|discuss)(?:\s|$)/.test(line.trim()) ? undefined
        : /^\/model(\s|$)/.test(line.trim()) && await external(session.sessionId) ? undefined : matchEnter(session, line, ...rest),
    };
    scope.effect(() => {
      Object.assign(runtime, replacements);
      return () => { for (const key of ['candidates', 'dispatch', 'matchSpace', 'matchEnter'] as const) if (Object.hasOwn(runtime, key) && runtime[key] === replacements[key]) Reflect.deleteProperty(runtime, key); };
    }, 'harness: DSH slash commands');
  });
  // `@` menu: the session Harness's installed plugins after the files. A pick inserts a chip whose prompt text is the Harness's
  // own plugin mention; the server returns nothing for DSH sessions and Harnesses without plugins.
  ctx.inject(['inputTriggers', 'remote.harness'], scope => {
    const t = ctx.locale.bind('harness');
    scope.effect(() => scope.inputTriggers.registerSource({
      trigger: '@', name: 'harness-plugin', order: 10, showGroupTitle: false,
      async candidates(session, { query, quoted, signal }) {
        if (quoted) return [];
        const plugins = await value(scope.remote.harness.plugins({ sessionId: session.sessionId }));
        if (signal.aborted) return [];
        const needle = query.toLowerCase();
        return plugins.filter(plugin => !needle || plugin.name.toLowerCase().includes(needle) || plugin.displayName.toLowerCase().includes(needle))
          .map(plugin => ({ name: plugin.displayName, ...(plugin.description ? { description: plugin.description } : {}), icon: PluginIcon, section: t('plugins'), value: JSON.stringify(plugin) }));
      },
      onPick({ candidate }) {
        const plugin = JSON.parse(candidate.value!) as Plugin;
        return { insert: { source: 'harness-plugin', ref: plugin.mention, label: plugin.displayName, clipboardText: plugin.mention } };
      },
      codec: { clipboardText: ref => ref, serialize: ref => Promise.resolve(ref) },
    }), 'harness: plugin mentions');
  });
  ctx.inject(['conversation', 'remote.harness'], scope => {
    const service = scope.conversation as unknown as {
      sendSession(session: ClientSessionContext, text: string, ids: readonly DraftAttachmentId[], mode: 'queue' | 'steer', signal?: AbortSignal): Promise<SubmitOutcome>;
      serializeDraftAttachments(ids: readonly DraftAttachmentId[]): Promise<{ attachments: readonly SubmitAttachment[] }>;
      releaseDraftAttachment(id: DraftAttachmentId): void;
    };
    const sendSession = service.sendSession.bind(service);
    const t = ctx.locale.bind('harness');
    const replacement: typeof service.sendSession = async (session, text, attachmentIds, mode, signal) => {
      let active = taskModes.get(session.sessionId);
      const command = /^\/(delegate|discuss)(?:\s+|$)/.exec(text);
      if (command && !active) {
        setTaskMode(session.sessionId, command[1] === 'delegate' ? delegationClaim(scope.remote.harness, session, t) : discussionClaim(scope.remote.harness, session, t));
        active = taskModes.get(session.sessionId);
      }
      if (command && command[1] === active?.task.name) text = text.slice(command[0].length);
      if (!active) return sendSession(session, text, attachmentIds, mode, signal);
      if (active.busy) return { kind: 'error', text: t('loading') };
      if (!text.trim() && !attachmentIds.length) return { kind: 'success' };
      taskModes.set(session.sessionId, { ...active, busy: true }); publishTaskMode();
      try {
        const { attachments } = await service.serializeDraftAttachments(attachmentIds);
        signal?.throwIfAborted();
        const outcome = await active.task.submit(text, scope, attachments);
        if (outcome.kind === 'success') {
          for (const id of attachmentIds) service.releaseDraftAttachment(id);
          setTaskMode(session.sessionId);
        }
        return outcome;
      } finally {
        if (taskModes.has(session.sessionId)) { taskModes.set(session.sessionId, { ...active, busy: false }); publishTaskMode(); }
      }
    };
    scope.effect(() => {
      service.sendSession = replacement;
      return () => {
        if (service.sendSession === replacement) Reflect.deleteProperty(service, 'sendSession');
        taskModes.clear(); publishTaskMode();
      };
    }, 'harness: task submission');
  });
  // The Settings nav row, after Agent presets; present only while the Host serves this plugin's configuration.
  ctx.inject(['slots', 'configForms'], scope => {
    const t = ctx.locale.bind('harness'), form = scope.configForms.get<Settings>(SETTINGS_ENTRY);
    settingsForm = form;
    scope.effect(() => () => { if (settingsForm === form) settingsForm = undefined; }, 'harness: settings form');
    scope.effect(() => scope.configForms.whileServed([SETTINGS_ENTRY], () => scope.slots.inject('settings.section', () => scope.slots.register({
      name: 'settings.section', id: 'harness', order: 25, label: () => t('settingsNav'), locale: 'harness',
      inject: () => ({ hooks: { harnessSettings: form }, form }),
    }, HarnessSettingsSection))), 'harness: settings page');
  });
  ctx.inject(['slots'], scope => {
    scope.effect(() => scope.slots.inject('conversation.input.dock', () => scope.slots.register({
      name: 'conversation.input.dock', id: 'harness-delegation', order: -100, locale: 'harness',
    }, DelegationDock)), 'harness: delegation composer mode');
  });
  // Optional: a DSH build without the right sidebar simply has no subagents tab.
  ctx.inject(['sidebarRightTabs', 'remote.harness'], scope => {
    const id = 'dsh-harness-provider/subagents', t = ctx.locale.bind('harness');
    scope.effect(() => scope.sidebarRightTabs.register({ id, kind: 'harness-subagents', title: () => t('subagents'),
      guide: [{ id: 'open', order: 40, title: () => t('subagents'), description: () => t('subagentsDescription') }] }), 'harness: subagents tab type');
    scope.effect(() => scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({ name: 'sidebar.right.pane.tab', key: id, locale: 'harness',
      inject: sessionId => ({ load: () => value(scope.remote.harness.subagents({ sessionId })) }) }, SubagentsTab)), 'harness: subagents tab');
    scope.effect(() => scope.slots.inject('sidebar.right.tab.guide.entry', () => scope.slots.register({ name: 'sidebar.right.tab.guide.entry', key: id, locale: 'harness' },
      GuideEntry)), 'harness: subagents guide card');
  });
}
