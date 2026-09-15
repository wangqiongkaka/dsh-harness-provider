import { useEffect, useRef, useState } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import type {} from '@deepseek-ai/dsh-api-remotes/client';
import type {} from '@deepseek-ai/dsh-api-session-controller/client';
import type {} from '@deepseek-ai/dsh-client-locale/client';
import type {} from '@deepseek-ai/dsh-client-ui-settings/client';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type { PropsRuntime, PropsLocale, InjectFace } from '@deepseek-ai/dsh-client-ui-slots';
import { contribution, type stateSchema, type modelsSchema } from './remote.js';
import type { z } from 'zod';

type State = z.infer<typeof stateSchema>;
type Models = z.infer<typeof modelsSchema>;
type Api = {
  state(request: {sessionId: string}): Promise<RemoteResult<State>>;
  select(request: {sessionId: string; harness: State['harness']}): Promise<RemoteResult<State>>;
  models(request: {sessionId: string}): Promise<RemoteResult<Models>>;
  selectModel(request: {sessionId: string; model: string}): Promise<RemoteResult<State>>;
};
const zh = {
  harness: '选择 Harness', model: '选择 Harness 模型', native: 'DSH 原生', defaultModel: '原生默认模型',
  retry: '重试', locked: '开始对话后 Harness 固定；切换请新建会话',
  recovery: '上次请求结果未确认，已暂停发送以避免重复执行。', loading: '加载中',
};
const en: Record<keyof typeof zh,string> = {
  harness:'Select Harness', model:'Select Harness model', native:'Native DSH', defaultModel:'Native default model',
  retry:'Retry', locked:'Harness is fixed after the first prompt. Start a new session to switch.',
  recovery:'The previous request was not confirmed. Sending is paused to avoid duplicate execution.', loading:'Loading',
};
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { harness: keyof typeof zh }
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
  read(id: string): Promise<State>;
  select(id: string, harness: State['harness']): Promise<State>;
  models(id: string): Promise<Models>;
  selectModel(id: string, model: string): Promise<State>;
  changed(id: string, external: boolean): void;
}
type Props = PropsRuntime<'conversation.input.left'> & PropsLocale<'harness'> & InjectFace<Injected>;

export function HarnessSelect({ sessionId, useSessions, read, select, models, selectModel, changed, t }: Props) {
  const [state,setState] = useState<State>();
  const [catalog,setCatalog] = useState<Models>({models:[],error:null});
  const [error,setError] = useState<string>();
  const [busy,setBusy] = useState(false);
  const [reload,setReload] = useState(0);
  const generation = useRef(0);
  const catalogKey = useRef('');
  const summary = useSessions(s => s.byId[sessionId]);
  useEffect(() => {
    const version = ++generation.current;
    setError(undefined);
    void read(sessionId).then(async next => {
      if (generation.current !== version) return;
      setState(next);changed(sessionId,next.harness !== 'dsh');
      const key = `${sessionId}/${next.harness}/${reload}`;
      if (next.harness !== 'dsh' && catalogKey.current !== key) {
        const catalog = await models(sessionId);
        if (generation.current === version) { setCatalog(catalog); catalogKey.current = key; }
      }
    }).catch(error => { if (generation.current === version) setError(error instanceof Error ? error.message : String(error)); });
    return () => { generation.current++; };
  }, [sessionId,summary?.running,reload,read,models,changed]);
  async function choose(work: () => Promise<State>) {
    const version = generation.current;setBusy(true);setError(undefined);
    try {
      const next = await work();
      if (generation.current !== version) return;
      setState(next);changed(sessionId,next.harness !== 'dsh');setReload(n=>n+1);
    } catch(error) { if (generation.current === version) setError(error instanceof Error ? error.message : String(error)); }
    finally { if (generation.current === version) setBusy(false); }
  }
  return <div className="dsh-harness-selector" aria-busy={busy || !state}>
    <select aria-label={t('harness')} title={t('locked')} value={state?.harness ?? 'dsh'}
      disabled={!state || busy || state.locked || summary?.running || summary?.blank === false}
      onChange={event=>{const next=event.target.value as State['harness'];void choose(()=>select(sessionId,next));}}>
      <option value="dsh">{t('native')}</option><option value="codex">Codex</option><option value="claude-code">Claude Code</option>
    </select>
    {state && state.harness !== 'dsh' && <select aria-label={t('model')} value={state.model ?? ''}
      disabled={busy || summary?.running || !catalog.models.length || state.recoveryRequired}
      onChange={event=>{const next=event.target.value;void choose(()=>selectModel(sessionId,next));}}>
      <option value="" disabled>{t('defaultModel')}</option>
      {state.model && !catalog.models.some(m=>m.id===state.model) && <option value={state.model}>{state.model}</option>}
      {catalog.models.map(model=><option key={model.id} value={model.id}>{model.label}</option>)}
    </select>}
    {(error || catalog.error) && <span role="alert">{error ?? catalog.error} <button type="button" onClick={()=>setReload(n=>n+1)}>{t('retry')}</button></span>}
    {state?.recoveryRequired && !summary?.running && <span role="status">{t('recovery')}</span>}
  </div>;
}

function ExternalOnboarding({ complete }: PropsRuntime<'settings.onboarding'>) {
  useEffect(() => { complete(); }, [complete]);
  return null;
}

export async function apply(ctx: Context): Promise<void> {
  const unmount = await ctx.remote.$mount(contribution);
  ctx.effect(() => unmount, 'harness: Remote client');
  ctx.effect(() => ctx.locale.register('harness',{zh,en}), 'harness: locale');
  ctx.effect(() => {
    const style=document.createElement('style');
    style.textContent=`.dsh-harness-selector{display:flex;align-items:center;gap:6px;flex-wrap:wrap;max-width:100%;font-size:13px;color:var(--dsw-alias-label-primary)}.dsh-harness-selector select,.dsh-harness-selector button{font:inherit;color:inherit;background:transparent;border:1px solid var(--dsw-alias-outline-weak);border-radius:14px;min-height:28px;padding:0 8px;max-width:220px}.dsh-harness-selector select:disabled{opacity:.55}.dsh-harness-selector [role=alert]{max-width:360px}`;
    document.head.append(style);return ()=>style.remove();
  }, 'harness: selector styles');
  ctx.inject(['sessions', 'remote.harness'], scope => {
    let nativeSeats: Array<()=>void> = [];
    const known = new Map<string,boolean>();
    function syncModel() {
      const {current,byId}=scope.sessions.list.getSnapshot();
      for (const id of known.keys()) if (!(id in byId)) known.delete(id);
      const external=current !== undefined && known.get(current) === true;
      if (external && !nativeSeats.length) {
        nativeSeats = (['conversation.input.model', 'conversation.input.permission', 'conversation.input.plan'] as const)
          .map(name => scope.slots.register({ name, priority: -100 }, () => null));
        nativeSeats.push(scope.slots.register({ name: 'settings.onboarding', id: 'deepseek-official', priority: -100 }, ExternalOnboarding));
      }
      if (!external && nativeSeats.length) { for (const dispose of nativeSeats) dispose(); nativeSeats = []; }
    }
    const api: Injected = {
      read:id=>value(scope.remote.harness.state({sessionId:id})),
      select:(id,harness)=>value(scope.remote.harness.select({sessionId:id,harness})),
      models:id=>value(scope.remote.harness.models({sessionId:id})),
      selectModel:(id,model)=>value(scope.remote.harness.selectModel({sessionId:id,model})),
      changed:(id,external)=>{known.set(id,external);syncModel();},
    };
    scope.effect(()=>{
      const stop=scope.sessions.list.subscribe(syncModel);
      return ()=>{stop();for (const dispose of nativeSeats) dispose();};
    },'harness: native model seat');
    scope.slots.inject('conversation.input.left',()=>scope.slots.register({
      name:'conversation.input.left',id:'harness-selector',order:-100,locale:'harness',inject:()=>api,
    },HarnessSelect));
  });
}
