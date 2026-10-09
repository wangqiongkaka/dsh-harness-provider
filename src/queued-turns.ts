import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Binding, Bindings } from './bindings.js';

/** Wake the public driver without admitting an already durable message a second time. */
export function wakeQueued(agent: Agent): void {
  const inbox = agent.inbox;
  const target = inbox.nextTurn.length ? 'next-turn' : 'next-step';
  const message = (target === 'next-turn' ? inbox.nextTurn : inbox.nextStep)[0];
  if (!message) return;
  const descriptor = Object.getOwnPropertyDescriptor(inbox, 'splice');
  const original = inbox.splice;
  let intercepted = false;
  const splice: typeof inbox.splice = function (list, start, count, inserted) {
    const pending = list === 'next-turn' ? inbox.nextTurn : inbox.nextStep;
    if (!intercepted && list === target && start === Infinity && count === 0 && inserted.length === 1 &&
      inserted[0] === message && pending.includes(message)) {
      intercepted = true;
      return [];
    }
    return original.call(inbox, list, start, count, inserted);
  };
  // rc.2 stops after an initial empty pre-step, bypassing its pending-inbox check.
  // Public send supplies the maintenance wake latch; suppress only its duplicate admission.
  Object.defineProperty(inbox, 'splice', { configurable: true, writable: true, value: splice });
  try { agent.send(message, target, true); }
  finally {
    if (Object.getOwnPropertyDescriptor(inbox, 'splice')?.value === splice) {
      if (descriptor) Object.defineProperty(inbox, 'splice', descriptor);
      else Reflect.deleteProperty(inbox, 'splice');
    }
  }
  if (!intercepted) throw new Error('Harness queue wake did not use the expected public inbox admission');
}

type Receipt = { turn: number; signal: AbortSignal; harness: Binding['harness']; nativeRef: NonNullable<Binding['nativeRef']>; completed: boolean; waiting?: boolean; settled: Promise<void>; resolve: () => void };
type Tracked = { revision: number; original: Agent['whenIdle']; wrapper: Agent['whenIdle']; descriptor?: PropertyDescriptor;
  originalCancel: Agent['cancel']; cancelWrapper: Agent['cancel']; cancelDescriptor?: PropertyDescriptor };

/** One-shot successful native completion receipts; failed/orphaned requests never arm a wake. */
export class QueuedTurns {
  private readonly receipts = new WeakMap<Agent, Receipt>();
  private readonly tracked = new Map<Agent, Tracked>();
  constructor(private readonly ctx: Context, private readonly bindings: Bindings, private readonly stopped: () => boolean) {
    ctx.on('agent/created', ({ agent }) => { this.track(agent); });
    ctx.on('agent/disposed', ({ agent }) => { this.restore(agent); });
    ctx.effect(() => () => { for (const agent of this.tracked.keys()) this.restore(agent); }, 'harness: queued turn activity bridge');
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'turn/end') return;
      const agent = ctx.agents.get(session.id);
      if (!agent || agent.session !== session) return;
      const receipt = this.receipts.get(agent);
      if (!receipt || receipt.turn !== event.data.turn) return;
      if (event.data.reason.kind === 'completed') receipt.completed = true;
      else this.retire(agent, receipt);
    });
    ctx.on('agent/status', ({ agent, status }) => {
      const receipt = this.receipts.get(agent);
      if (!receipt?.completed) return;
      if (status === 'running') { this.retire(agent, receipt); return; }
      if (status === 'idle') this.continue(agent, receipt);
    });
  }
  private track(agent: Agent): Tracked {
    const existing = this.tracked.get(agent);
    if (existing) return existing;
    const state: Tracked = { revision: 0, original: agent.whenIdle, descriptor: Object.getOwnPropertyDescriptor(agent, 'whenIdle'), wrapper: async () => {},
      originalCancel: agent.cancel, cancelDescriptor: Object.getOwnPropertyDescriptor(agent, 'cancel'), cancelWrapper: () => {} };
    state.wrapper = async () => {
      while (true) {
        const revision = state.revision;
        await state.original.call(agent);
        const receipt = this.receipts.get(agent);
        if (receipt?.completed) { await receipt.settled; continue; }
        if (state.revision !== revision) continue;
        return;
      }
    };
    state.cancelWrapper = (...args) => {
      // A cancellation of another maintenance owner must invalidate this deferred wake too.
      const receipt = this.receipts.get(agent);
      if (receipt) this.retire(agent, receipt);
      state.originalCancel.call(agent, ...args);
    };
    Object.defineProperty(agent, 'whenIdle', { configurable: true, writable: true, value: state.wrapper });
    Object.defineProperty(agent, 'cancel', { configurable: true, writable: true, value: state.cancelWrapper });
    this.tracked.set(agent, state);
    return state;
  }
  private retire(agent: Agent, receipt: Receipt): void {
    if (this.receipts.get(agent) !== receipt) return;
    this.receipts.delete(agent);
    const state = this.tracked.get(agent);
    if (state) state.revision++;
    receipt.resolve();
  }
  private restore(agent: Agent): void {
    const state = this.tracked.get(agent);
    if (!state) return;
    const receipt = this.receipts.get(agent);
    if (receipt) this.retire(agent, receipt);
    if (Object.getOwnPropertyDescriptor(agent, 'whenIdle')?.value === state.wrapper) {
      if (state.descriptor) Object.defineProperty(agent, 'whenIdle', state.descriptor);
      else Reflect.deleteProperty(agent, 'whenIdle');
    }
    if (Object.getOwnPropertyDescriptor(agent, 'cancel')?.value === state.cancelWrapper) {
      if (state.cancelDescriptor) Object.defineProperty(agent, 'cancel', state.cancelDescriptor);
      else Reflect.deleteProperty(agent, 'cancel');
    }
    this.tracked.delete(agent);
  }
  private continue(agent: Agent, receipt: Receipt): void {
    if (this.receipts.get(agent) !== receipt) return;
    if (receipt.signal.aborted || this.stopped() || this.ctx.agents.get(agent.id) !== agent ||
      agent.status !== 'idle' || (!agent.inbox.nextTurn.length && !agent.inbox.nextStep.length)) { this.retire(agent, receipt); return; }
    try {
      // Reserve the public activity chain synchronously, before whenIdle can settle.
      void agent.runMaintenance(signal => {
        this.retire(agent, receipt); // A reserved receipt is consumed, including cancellation/job failure.
        return this.bindings.serial(agent.id, async () => {
          const binding = await this.bindings.read(agent.id);
          if (signal.aborted || receipt.signal.aborted || this.stopped() || this.ctx.agents.get(agent.id) !== agent ||
            !binding?.nativeRef || binding.harness !== receipt.harness || binding.pending || binding.pendingNative ||
            binding.nativeRef.harnessId !== receipt.nativeRef.harnessId ||
            binding.nativeRef.nativeSessionId !== receipt.nativeRef.nativeSessionId ||
            binding.nativeRef.formatVersion !== receipt.nativeRef.formatVersion || (!agent.inbox.nextTurn.length && !agent.inbox.nextStep.length)) return;
          wakeQueued(agent);
        });
      }).catch(error => console.error('[harness] queued turn continuation failed:', error));
    } catch (error) {
      // Another observer can reserve maintenance first. Follow that activity exactly once;
      // a later native driver invalidates this receipt through its running notification.
      if (error instanceof Error && error.message === `agent "${agent.id}" already has active work`) {
        if (receipt.waiting) return;
        receipt.waiting = true;
        const state = this.tracked.get(agent);
        if (!state) { this.retire(agent, receipt); return; }
        // The public bridge awaits this receipt; use the original activity wait to avoid a cycle.
        void state.original.call(agent).then(() => {
          receipt.waiting = false;
          this.continue(agent, receipt);
        }).catch(failure => {
          this.retire(agent, receipt);
          console.error('[harness] queued turn continuation wait failed:', failure);
        });
      } else {
        this.retire(agent, receipt);
        console.error('[harness] queued turn continuation unavailable:', error);
      }
    }
  }
  completed(agent: Agent, turn: number, signal: AbortSignal, binding: Binding): void {
    if (signal.aborted || !binding.nativeRef) return;
    const state = this.track(agent);
    const previous = this.receipts.get(agent);
    if (previous) this.retire(agent, previous);
    const { promise, resolve } = Promise.withResolvers<void>();
    this.receipts.set(agent, { turn, signal, harness: binding.harness, nativeRef: { ...binding.nativeRef }, completed: false, settled: promise, resolve });
    state.revision++;
  }
}
