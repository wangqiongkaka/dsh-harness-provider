import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { UserMessage, TokenUsage } from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-user-questions';
import type { HarnessAdapter, HarnessSession, HarnessResult, HarnessOutput, HostInteraction, HostInteractionResponse, HarnessSessionState, HostUsage } from './contracts.js';
import { hostTurnIdSchema } from './contracts.js';
import { Bindings, type Binding } from './bindings.js';
import { SecretQuestions } from './secret-questions.js';
import { harnessInput } from './media.js';
import { DshOutput } from './dsh-output.js';
import { delegationInstructions, type DelegationBridge } from './delegation.js';

export function unwrap<T>(result: HarnessResult<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
type Live = { session: HarnessSession; revision: number; usage: HostUsage | null; queue: HarnessOutput[]; ended: boolean; wake: () => void; turnId?: import('./contracts.js').HostTurnId; ready?: Promise<unknown>; steering?: Promise<void>; steerError?: unknown; steerMessages?: UserMessage[] };
/** Drains the native session continuously: usage readings land as they arrive (also between turns), everything else queues for the turn loop. */
function pump(live: Live): void {
  void (async () => {
    try {
      for await (const value of live.session.outputs) {
        if (value.kind === 'event' && value.event.type === 'session.usage.changed') { live.usage = value.event.usage; continue; }
        live.queue.push(value);
        live.wake();
      }
    } finally { live.ended = true; live.wake(); }
  })();
}
/** Persisted across restarts: the context reading for display, and the cumulative counters usageDelta subtracts from. */
const USAGE_KEYS = ['contextUsedTokens', 'contextWindowTokens', 'totalTokens', 'inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens'] as const;
/**
 * This turn's token usage as DSH's per-message buckets: the Harness reports cumulative counts, with cached input included
 * in inputTokens and also reported on its own.
 */
export function usageDelta(before: HostUsage | null, after: HostUsage | null): TokenUsage | undefined {
  if (!after) return undefined;
  const step = (key: 'inputTokens' | 'cachedInputTokens' | 'cacheWriteInputTokens' | 'outputTokens') => Math.max(0, (after[key] ?? 0) - (before?.[key] ?? 0));
  const input = step('inputTokens'), outputTokens = step('outputTokens');
  if (!input && !outputTokens) return undefined;
  const cacheReadTokens = step('cachedInputTokens');
  const cacheWriteTokens = step('cacheWriteInputTokens');
  return { inputTokens: Math.max(0, input - cacheReadTokens - cacheWriteTokens), outputTokens, cacheReadTokens, cacheWriteTokens };
}
async function take(live: Live): Promise<HarnessOutput | undefined> {
  while (!live.queue.length) {
    if (live.ended) return undefined;
    await new Promise<void>(resolve => { live.wake = resolve; });
  }
  return live.queue.shift();
}
export class DshRunner {
  readonly live = new Map<string, Live>();
  constructor(private readonly ctx: Context, private readonly bindings: Bindings,
    private readonly adapters: Record<Binding['harness'], HarnessAdapter>, private readonly delegation?: DelegationBridge, readonly secrets = new SecretQuestions()) {}

  pendingSteering(id: string): readonly UserMessage[] { return this.live.get(id)?.steerMessages ?? []; }

  drainSteering(agent: Agent): void {
    const live = this.live.get(agent.id);
    if (!live?.turnId || !live.session.steer) return;
    for (const message of [...agent.inbox.nextStep]) {
      (live.steerMessages ??= []).push(message);
      agent.inbox.remove(message.id);
      live.steering = (live.steering ?? Promise.resolve()).then(async () => {
        await live.ready;
        const input = await harnessInput(this.ctx, [message], new AbortController().signal);
        agent.session.append('user/message', message, { surfaceOp: 'append' });
        await this.ctx.sessions.flush(agent.session);
        unwrap(await live.session.steer!(input));
      }).catch(async error => {
        live.steerError = error;
        agent.cancel({ kind: 'user' }, { keepInbox: true });
      });
    }
  }

  async run(payload: { agent: Agent; messages: UserMessage[]; turn: number; step: number; signal: AbortSignal }, binding: Binding): Promise<void> {
    const { agent, messages, turn, step, signal } = payload;
    signal.throwIfAborted();
    const worktree = binding.delegation?.worktree;
    if (worktree?.removed) throw new Error('该委派会话的独立 worktree 已合并或删除，无法继续对话；如需继续，请在来源会话重新委派。');
    // A worktree delegation keeps its DSH session in the source workspace while the Harness works in the checkout.
    if (binding.cwd !== agent.session.header.cwd && !worktree) throw new Error('Harness workspace identity mismatch');
    if (binding.pending) throw new Error('上次 Harness 请求的结果尚未确认；为避免重复执行，本会话暂停发送。');
    const input = await harnessInput(this.ctx, messages, signal);
    if (!input.length) throw new Error('Harness prompt is empty');
    const delegation = this.delegation;
    let live = this.live.get(agent.id);
    if (!live) {
      // The adapter places the instructions: the agent's system prompt, or Codex's developer instructions at launch.
      const hints = { ...(delegation ? { environment: { ...process.env, ...await delegation.environment(agent.id) }, instructions: delegationInstructions() } : {}),
        ...(binding.model ? { model: binding.model } : {}), ...(binding.thinking ? { thinkingOptionId: binding.thinking } : {}),
        ...(binding.permission ? { permissionModeId: binding.permission } : {}), ...(binding.configs ? { configValues: binding.configs } : {}),
        ...(binding.usage ? { usage: binding.usage } : {}) };
      const session = unwrap(await this.adapters[binding.harness].open(binding.nativeRef
        ? { kind: 'resume', cwd: binding.cwd, nativeRef: binding.nativeRef, ...hints }
        : { kind: 'create', cwd: binding.cwd, ...hints }));
      live = { session, revision: 0, usage: session.initialUsage, queue: [], ended: false, wake: () => {} };
      pump(live);
      this.live.set(agent.id, live);
      const owned = live;
      agent.ctx.effect(() => async () => {
        try { await session.close(); } finally { if (this.live.get(agent.id) === owned) this.live.delete(agent.id); }
      }, 'harness: native session');
      try { await this.saveState(binding, session.initialState); }
      catch (error) {
        // An identity mismatch must not leave a reusable live session behind.
        this.live.delete(agent.id);
        await session.close().catch(() => {});
        throw error;
      }
    }
    signal.throwIfAborted();
    const current = live;
    const turnId = hostTurnIdSchema.parse(`dsh:${agent.id}:${turn}`);
    const turnAbort = new AbortController();
    const questionSignal = AbortSignal.any([signal, turnAbort.signal]);
    const output = new DshOutput(this.ctx, agent, { turn, step }, () => ++current.revision, () => ({
      provider: 'sourceProvider' in current.session && typeof current.session.sourceProvider === 'string' ? current.session.sourceProvider : current.session.harnessId || binding.harness,
      model: binding.model?.id ?? current.session.initialState.effectiveModel?.id ?? 'unreported',
    }));
    const usageBefore = current.usage;
    let submitted = false;
    let cancelWork: Promise<void> | undefined;
    let interactionError: unknown;
    const questions = new Set<Promise<void>>();
    const cancel = () => {
      cancelWork ??= (async () => {
        const result = await current.session.execute({ type: 'turn.cancel', turnId });
        if (!result.ok) await current.session.close();
      })().catch(error => { interactionError ??= error; });
    };
    agent.session.append('step/start', { turn, step });
    for (const message of messages) agent.session.append('user/message', message, { surfaceOp: 'append' });
    try {
      await this.ctx.sessions.flush(agent.session);
      signal.throwIfAborted();
      binding.pending = turnId;
      await this.bindings.write(binding);
      signal.throwIfAborted();
      submitted = true;
      current.turnId = turnId; current.steerError = undefined; current.steerMessages = [];
      const starting = current.session.execute({ type: 'turn.start', turnId, input });
      current.ready = starting;
      this.drainSteering(agent);
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
      unwrap(await starting);
      let completed = false;
      while (!completed) {
        const value = await take(current);
        if (!value) throw new Error('Harness disconnected before confirming the turn');
        if (value.kind === 'interaction') {
          const task = this.answer(agent, value.interaction, questionSignal, current.session, output)
            .catch(error => { if (!questionSignal.aborted) { interactionError = error; cancel(); } })
            .finally(() => questions.delete(task));
          questions.add(task);
          continue;
        }
        const event = value.event;
        if (event.type === 'session.state.changed') { await this.saveState(binding, event.state); continue; }
        if (event.type === 'session.faulted') throw new Error(event.error.message);
        if (!('turnId' in event) || event.turnId !== turnId) continue;
        switch (event.type) {
          case 'interaction.closed': this.secrets.cancel(agent.id, event.interactionId); break;
          case 'turn.started':
            if (event.nativeTurnRef) { binding.pendingNative = event.nativeTurnRef.nativeTurnKey; await this.bindings.write(binding); }
            break;
          case 'item.started': output.start(event.item); break;
          case 'item.updated': output.update(event.itemId, event.update); break;
          case 'item.completed': await output.complete(event.snapshot); break;
          case 'turn.completed': {
            current.turnId = undefined;
            await current.steering;
            if (current.steerError) throw new Error('插入请求的结果未确认，已暂停会话；请核对原生记录后恢复');
            await output.finish(usageDelta(usageBefore, current.usage));
            await this.ctx.sessions.flush(agent.session);
            const uncertain = event.outcome.status === 'failed' && ['processExited', 'protocolError', 'internalError'].includes(event.outcome.error.code);
            if (current.usage) binding.usage = Object.fromEntries(USAGE_KEYS.flatMap(key => current.usage![key] !== undefined ? [[key, current.usage![key]]] : []));
            if (event.nativeTurnRef) binding.turns = [...(binding.turns ?? []).filter(entry => entry.turn !== turn), { turn, key: event.nativeTurnRef.nativeTurnKey }];
            if (!uncertain) { delete binding.pending; delete binding.pendingNative; }
            await this.bindings.write(binding);
            completed = true;
            if (event.outcome.status === 'failed') throw new Error(event.outcome.error.message);
            if (event.outcome.status === 'cancelled' && !signal.aborted && !interactionError) throw new Error('Harness cancelled the turn');
            break;
          }
        }
      }
      if (interactionError) throw interactionError;
      signal.throwIfAborted();
    } catch (error) {
      // A projection/storage/transport failure must not leave native tools running.
      if (binding.pending && !submitted) {
        delete binding.pending; await this.bindings.write(binding);
      } else if (binding.pending) {
        cancel();
        await cancelWork;
        try { await current.session.close(); } finally { this.live.delete(agent.id); }
      }
      throw error;
    } finally {
      current.turnId = undefined;
      await current.steering;
      signal.removeEventListener('abort', cancel);
      turnAbort.abort();
      await Promise.allSettled(questions);
      await cancelWork;
      try { await output.finish(); } finally { agent.session.append('step/end', { turn, step: output.step }); }
    }
  }

  private async saveState(binding: Binding, state: HarnessSessionState): Promise<void> {
    if (state.nativeRef) {
      if (state.nativeRef.harnessId !== binding.harness) throw new Error('Harness returned a different identity');
      if (binding.nativeRef && binding.nativeRef.nativeSessionId !== state.nativeRef.nativeSessionId) throw new Error('Harness changed native session identity');
      binding.nativeRef = state.nativeRef;
    }
    if (state.effectiveModel) binding.model = state.effectiveModel;
    if (state.effectiveThinkingOptionId) binding.thinking = state.effectiveThinkingOptionId;
    if (state.effectivePermissionModeId) binding.permission = state.effectivePermissionModeId;
    if (state.configValues) binding.configs = state.configValues;
    await this.bindings.write(binding);
  }

  private async answer(agent: Agent, interaction: HostInteraction, signal: AbortSignal, session: HarnessSession, output: DshOutput): Promise<void> {
    if (interaction.type === 'question' && interaction.questions.some(q => q.type === 'text' && q.secret)) {
      const response = await this.secrets.ask(agent.id, interaction, signal);
      if (!response) return;
      signal.throwIfAborted();
      unwrap(await session.execute({ type: 'interaction.respond', interactionId: interaction.interactionId, response }));
      return;
    }
    const questions = interaction.type === 'approval' ? [{
      id: 'approval', question: interaction.title, detail: interaction.description,
      options: interaction.actions.map(action => ({ label: action.label })),
    }] : interaction.questions.map(question => ({
      id: question.id, question: question.prompt,
      ...(question.type === 'choice' ? { options: question.options.map(option => ({ label: option.label, description: option.description })), multiSelect: question.multiple } : {}),
    }));
    const ask = () => this.ctx.userQuestions.ask({ agent, questions, signal });
    // Approvals stay transient like DSH's own; a question leaves the same answered row DSH's ask_user_question tool does.
    const answer = interaction.type === 'approval' ? await ask() : await output.question(interaction.interactionId, questions, ask);
    signal.throwIfAborted();
    let response: HostInteractionResponse;
    if (interaction.type === 'approval') {
      const result = answer.answers.find(a => a.id === 'approval');
      const action = interaction.actions.find(a => result?.selected.length === 1 && result.selected[0] === a.label);
      if (!action || result?.custom) throw new Error('请选择明确的审批选项');
      response = { type: 'approval', actionId: action.id };
    } else {
      response = { type: 'question', answers: Object.fromEntries(interaction.questions.map(q => {
        const result = answer.answers.find(a => a.id === q.id);
        const selected = result?.selected.map(label => q.type === 'choice' ? q.options.find(o => o.label === label)?.value ?? label : label) ?? [];
        return [q.id, [...selected, ...(result?.custom ? [result.custom] : [])]];
      })) };
    }
    unwrap(await session.execute({ type: 'interaction.respond', interactionId: interaction.interactionId, response }));
  }
}
