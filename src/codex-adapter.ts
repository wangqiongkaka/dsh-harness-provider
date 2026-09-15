import {
  HarnessOutputChannel, validateHostInteractionResponse,
  type HarnessAdapter, type HarnessOutput, type HarnessSession, type HarnessSessionState,
  type HarnessInspection, type HarnessResult, type HarnessError, type HostCommand,
  type HostEvent, type HostInteraction, type OpenSessionInput, type HostTurnSnapshot,
  type TurnStartCommand, type TurnCancelCommand, type InteractionRespondCommand,
  type ModelSelectCommand, type ThinkingSelectCommand, type PermissionModeSelectCommand,
  type TurnStartAccepted, type TurnCancelAccepted, type InteractionRespondAccepted, type ModelSelectCompleted,
} from '@codexhost/harness-adapter';
import {
  harnessIdSchema, harnessModelRefSchema, hostInteractionIdSchema,
  hostItemIdSchema, type HostTurnId,
} from '@codexhost/shared-contracts';
import { z } from 'zod';
import pkg from '../package.json' with { type: 'json' };
import { CodexRpc, type RpcId, type RpcMessage, type RpcOptions } from './codex-rpc.js';
import { itemOf, snapshotItem, nativeTurn, object, turnSnapshot } from './codex-items.js';

const id = harnessIdSchema.parse('codex');
const capabilities = {
  configuration: { selectModel: true, selectThinkingOption: false, selectPermissionMode: false, permissionModeScope: 'live' as const },
  history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
};
const opened = z.object({
  thread: z.object({ id: z.string().min(1), cwd: z.string(), ephemeral: z.boolean(), turns: z.array(z.unknown()) }).passthrough(),
  model: z.string().min(1), modelProvider: z.string().min(1),
}).passthrough();
const modelList = z.object({
  data: z.array(z.object({ model: z.string().min(1), displayName: z.string(), isDefault: z.boolean(), hidden: z.boolean() }).passthrough()),
  nextCursor: z.string().nullable(),
});

function errorResult(error: unknown): { ok: false; error: HarnessError } {
  return { ok: false, error: {
    code: error instanceof z.ZodError ? 'protocolError' : 'nativeFailure',
    message: error instanceof z.ZodError ? 'Unsupported Codex protocol response' : error instanceof Error ? error.message : 'Codex operation failed',
    retryable: false,
  } };
}

export interface CodexOptions extends Omit<RpcOptions, 'cwd' | 'onMessage' | 'onFault'> {}

/** Native Codex app-server sessions, with each connection owned by its session. */
export class CodexAdapter implements HarnessAdapter {
  readonly harnessId = id;
  private readonly sessions = new Set<CodexSession>();
  private closing?: Promise<void>;
  private readonly pending = new Set<Promise<unknown>>();

  constructor(private readonly options: CodexOptions) {}

  async inspect(input: { cwd?: string } = {}): Promise<HarnessInspection> {
    if (this.closing) return { status: 'unavailable', error: errorResult(new Error('Codex adapter closed')).error };
    const rpc = new CodexRpc({ ...this.options, cwd: input.cwd ?? process.cwd(), onMessage: () => {}, onFault: () => {} });
    const work = (async (): Promise<HarnessInspection> => {
      try {
        await initialize(rpc);
        const models = [];
        let cursor: string | null = null;
        const cursors = new Set<string>();
        do {
          const page = modelList.parse(await rpc.request('model/list', { cursor, limit: 100 }));
          models.push(...page.data.filter(model => !model.hidden));
          cursor = page.nextCursor;
          if (cursor !== null && cursors.has(cursor)) throw new Error('Codex model pagination repeated');
          if (cursor !== null) cursors.add(cursor);
        } while (cursor !== null);
        const fallback = models.find(model => model.isDefault);
        return {
          status: 'ready', capabilities,
          catalog: {
            models: models.map(model => ({ ref: harnessModelRefSchema.parse({ id: model.model }), label: model.displayName })),
            thinkingOptions: [],
            ...(fallback ? { defaultModel: harnessModelRefSchema.parse({ id: fallback.model }) } : {}),
          },
        };
      } catch (error) {
        return { status: 'unavailable', error: errorResult(error).error };
      } finally { await rpc.close(); }
    })();
    this.pending.add(work);
    try { return await work; } finally { this.pending.delete(work); }
  }

  async open(input: OpenSessionInput): Promise<HarnessResult<HarnessSession>> {
    if (this.closing) return errorResult(new Error('Codex adapter closed'));
    if (input.kind !== 'create' && input.kind !== 'resume') {
      return { ok: false, error: { code: 'unsupported', message: 'Codex fork and rollback are not implemented', retryable: false } };
    }
    if (input.kind === 'resume' && input.nativeRef.harnessId !== id) return errorResult(new Error('Wrong native Harness identity'));
    const work = CodexSession.open(this.options, input);
    this.pending.add(work);
    try {
      const session = await work;
      if (this.closing) { await session.close(); return errorResult(new Error('Codex adapter closed')); }
      this.sessions.add(session);
      return { ok: true, value: session };
    } catch (error) { return errorResult(error); }
    finally { this.pending.delete(work); }
  }

  close(): Promise<void> {
    return this.closing ??= Promise.resolve().then(async () => {
      await Promise.allSettled([...this.pending]);
      const settled = await Promise.allSettled([...this.sessions].map(session => session.close()));
      const failures = settled.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      this.sessions.clear();
      if (failures.length) throw new AggregateError(failures, 'Codex session cleanup failed');
    });
  }
}

async function initialize(rpc: CodexRpc): Promise<void> {
  await rpc.request('initialize', {
    clientInfo: { name: pkg.name, version: pkg.version, title: 'DSH Harness Plugin' },
    capabilities: { experimentalApi: true },
  });
  rpc.send({ method: 'initialized', params: {} });
}

type ActiveTurn = { hostId: HostTurnId; nativeId?: string; started: boolean; done: ReturnType<typeof Promise.withResolvers<void>> };

class CodexSession implements HarnessSession {
  readonly harnessId = id;
  readonly capabilities = capabilities;
  readonly initialUsage = null;
  readonly channel = new HarnessOutputChannel<HarnessOutput>();
  readonly outputs = this.channel.outputs;
  readonly rpc: CodexRpc;
  initialState: HarnessSessionState = {};
  sourceProvider?: string;
  private threadId?: string;
  private active?: ActiveTurn;
  private fault?: HarnessError;
  private closing?: Promise<void>;
  private start?: Promise<unknown>;
  private readonly interactions = new Map<string, { rpcId: RpcId; interaction: HostInteraction }>();

  private constructor(private readonly options: CodexOptions, cwd: string) {
    this.rpc = new CodexRpc({ ...options, cwd, onMessage: message => this.receive(message), onFault: error => this.fail(error) });
  }

  static async open(options: CodexOptions, input: Extract<OpenSessionInput, { kind: 'create' | 'resume' }>): Promise<CodexSession> {
    const session = new CodexSession(options, input.cwd);
    try {
      await initialize(session.rpc);
      const response = opened.parse(await session.rpc.request(input.kind === 'create' ? 'thread/start' : 'thread/resume', {
        cwd: input.cwd,
        ...(input.model ? { model: input.model.id } : {}),
        ...(input.kind === 'create' ? { ephemeral: false } : { threadId: input.nativeRef.nativeSessionId }),
      }));
      if (response.thread.ephemeral || (input.kind === 'resume' && response.thread.id !== input.nativeRef.nativeSessionId)) {
        throw new Error('Codex returned an unexpected native session');
      }
      if (response.thread.cwd !== input.cwd) throw new Error('Codex returned a different workspace');
      session.threadId = response.thread.id;
      session.sourceProvider = response.modelProvider;
      session.initialState = {
        nativeRef: { harnessId: id, nativeSessionId: session.threadId, formatVersion: 1 },
        effectiveModel: harnessModelRefSchema.parse({ id: response.model }), resolvedModelLabel: response.model,
      };
      return session;
    } catch (error) { await session.rpc.close(); throw error; }
  }

  async readSnapshot(): Promise<HarnessResult<{ turns: HostTurnSnapshot[]; state: HarnessSessionState }>> {
    try {
      if (this.fault) return { ok: false, error: this.fault };
      const response = z.object({ thread: z.object({ id: z.string(), turns: z.array(z.unknown()) }) })
        .parse(await this.rpc.request('thread/read', { threadId: this.threadId, includeTurns: true }));
      if (response.thread.id !== this.threadId) throw new Error('Codex history identity mismatch');
      return { ok: true, value: { turns: response.thread.turns.map(turn => turnSnapshot(response.thread.id, turn)), state: this.initialState } };
    } catch (error) { return errorResult(error); }
  }

  execute(command: TurnStartCommand): Promise<HarnessResult<TurnStartAccepted>>;
  execute(command: TurnCancelCommand): Promise<HarnessResult<TurnCancelAccepted>>;
  execute(command: InteractionRespondCommand): Promise<HarnessResult<InteractionRespondAccepted>>;
  execute(command: ModelSelectCommand): Promise<HarnessResult<ModelSelectCompleted>>;
  execute(command: ThinkingSelectCommand): Promise<HarnessResult<ModelSelectCompleted>>;
  execute(command: PermissionModeSelectCommand): Promise<HarnessResult<ModelSelectCompleted>>;
  async execute(command: HostCommand): Promise<HarnessResult<
    TurnStartAccepted | TurnCancelAccepted | InteractionRespondAccepted | ModelSelectCompleted
  >> {
    try {
      if (this.fault) return { ok: false, error: this.fault };
      if (this.closing) throw new Error('Codex session closed');
      switch (command.type) {
        case 'turn.start': {
          if (this.active) return { ok: false, error: { code: 'sessionBusy', message: 'Codex turn is active', retryable: true } };
          if (!command.input.length || command.input.some(part => part.type !== 'text') || !command.input.some(part => part.text.trim())) {
            return { ok: false, error: { code: 'invalidRequest', message: 'A non-empty text prompt is required', retryable: false } };
          }
          const active: ActiveTurn = { hostId: command.turnId, started: false, done: Promise.withResolvers<void>() };
          this.active = active;
          const work = this.rpc.request('turn/start', {
            threadId: this.threadId,
            input: command.input.map(part => ({ type: 'text', text: part.text, text_elements: [] })),
            ...(this.initialState.effectiveModel ? { model: this.initialState.effectiveModel.id } : {}),
          });
          this.start = work;
          try {
            const response = z.object({ turn: nativeTurn }).parse(await work);
            this.identify(active, response.turn.id);
            return { ok: true, value: { turnId: command.turnId } };
          } catch (error) { this.finish(active, { status: 'failed', error: errorResult(error).error }); throw error; }
          finally { if (this.start === work) this.start = undefined; }
        }
        case 'turn.cancel': {
          const active = this.active;
          if (!active || active.hostId !== command.turnId) throw new Error('Codex turn is not active');
          await this.start?.catch(() => {}); // A rejected turn/start already cleared `active`.
          if (this.active === active) await this.rpc.request('turn/interrupt', { threadId: this.threadId, turnId: active.nativeId });
          return { ok: true, value: { cancellationRequested: true } };
        }
        case 'interaction.respond': {
          const pending = this.interactions.get(command.interactionId);
          if (!pending) throw new Error('Codex interaction is no longer pending');
          const validation = validateHostInteractionResponse(pending.interaction, command.response);
          if (validation) throw new Error('Invalid Codex interaction response');
          const response = command.response;
          this.rpc.send({ id: pending.rpcId, result: response.type === 'approval'
            ? { decision: response.actionId }
            : { answers: Object.fromEntries(Object.entries(response.answers).map(([key, answers]) => [key, { answers }])) } });
          this.interactions.delete(command.interactionId);
          this.emit({ type: 'interaction.closed', interactionId: command.interactionId, turnId: pending.interaction.turnId, reason: 'responded' });
          return { ok: true, value: { accepted: true } };
        }
        case 'model.select':
          if (this.active) throw new Error('Model selection requires an idle Codex session');
          this.initialState = { ...this.initialState, effectiveModel: command.model, resolvedModelLabel: command.model.id };
          this.emit({ type: 'session.state.changed', state: this.initialState });
          return { ok: true, value: { completed: true } };
        default: return { ok: false, error: { code: 'unsupported', message: 'Codex configuration operation is not implemented', retryable: false } };
      }
    } catch (error) { return errorResult(error); }
  }

  private identify(active: ActiveTurn, nativeId: string): void {
    if (active.nativeId && active.nativeId !== nativeId) throw new Error('Codex turn identity mismatch');
    active.nativeId = nativeId;
    if (!active.started) { active.started = true; this.emit({ type: 'turn.started', turnId: active.hostId }); }
  }

  private receive(message: RpcMessage): void {
    const params = object.parse(message.params ?? {});
    if (message.id !== undefined) { this.ask(message.id, message.method!, params); return; }
    if (params.threadId !== this.threadId) return;
    const active = this.active;
    if (!active) return;
    if (message.method === 'turn/started' || message.method === 'turn/completed') {
      const turn = nativeTurn.parse(params.turn);
      this.identify(active, turn.id);
      if (message.method === 'turn/completed') this.finish(active,
        turn.status === 'completed' ? { status: 'succeeded' }
          : turn.status === 'interrupted' ? { status: 'cancelled' }
            : { status: 'failed', error: { code: 'nativeFailure', message: 'Codex turn failed', retryable: false } });
      return;
    }
    if (!['item/started', 'item/completed', 'item/agentMessage/delta', 'item/reasoning/summaryTextDelta'].includes(message.method ?? '')) return;
    if (typeof params.turnId !== 'string' || (active.nativeId && params.turnId !== active.nativeId)) return;
    this.identify(active, params.turnId);
    if (message.method === 'item/started') {
      const item = itemOf(params.item);
      if (item) this.emit({ type: 'item.started', turnId: active.hostId, item });
    } else if (message.method === 'item/completed') {
      const snapshot = snapshotItem(params.item);
      if (snapshot) this.emit({ type: 'item.completed', turnId: active.hostId, snapshot });
    } else if (message.method === 'item/agentMessage/delta' || message.method === 'item/reasoning/summaryTextDelta') {
      this.emit({ type: 'item.updated', turnId: active.hostId, itemId: hostItemIdSchema.parse(params.itemId),
        update: { type: 'text.append', text: z.string().parse(params.delta) } });
    }
  }

  private ask(rpcId: RpcId, method: string, params: Record<string, unknown>): void {
    const active = this.active;
    if (!active || params.threadId !== this.threadId || typeof params.turnId !== 'string') {
      this.rpc.send({ id: rpcId, error: { code: -32601, message: 'Request has no active DSH turn' } });
      return;
    }
    this.identify(active, params.turnId);
    const interactionId = hostInteractionIdSchema.parse(`codex:${typeof rpcId}:${rpcId}`);
    let interaction: HostInteraction;
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      interaction = {
        type: 'approval', interactionId, turnId: active.hostId, subject: { type: 'nativeAction' },
        title: typeof params.command === 'string' ? params.command : 'Codex 请求修改文件',
        ...(typeof params.reason === 'string' ? { description: params.reason } : {}),
        actions: [{ id: 'accept', label: '允许一次', effect: 'allowOnce' }, { id: 'decline', label: '拒绝', effect: 'deny' }],
      };
    } else if (method === 'item/tool/requestUserInput') {
      const questions = z.array(z.object({ id: z.string(), header: z.string(), question: z.string(),
        isOther: z.boolean().optional(), isSecret: z.boolean().optional(),
        options: z.array(z.object({ label: z.string(), description: z.string() })).nullable().optional(),
      })).parse(params.questions);
      interaction = { type: 'question', interactionId, turnId: active.hostId, questions: questions.map(question =>
        question.options?.length ? {
          id: question.id, type: 'choice', prompt: question.question,
          options: question.options.map(option => ({ value: option.label, label: option.label, description: option.description })),
          multiple: false, allowOther: question.isOther === true, optional: false,
        } : { id: question.id, type: 'text', prompt: question.question, multiline: true, secret: question.isSecret === true, optional: false }) };
    } else {
      this.rpc.send({ id: rpcId, error: { code: -32601, message: 'This Codex interaction is not supported by the DSH plugin' } });
      return;
    }
    this.interactions.set(interactionId, { rpcId, interaction });
    this.channel.emit({ kind: 'interaction', interaction });
  }

  private emit(event: HostEvent): void { this.channel.emit({ kind: 'event', event }); }

  private finish(active: ActiveTurn, outcome: Extract<HostEvent, { type: 'turn.completed' }>['outcome']): void {
    if (this.active !== active) return;
    for (const [interactionId, pending] of this.interactions) {
      this.emit({ type: 'interaction.closed', interactionId: pending.interaction.interactionId, turnId: active.hostId, reason: 'cancelled' });
      this.interactions.delete(interactionId);
    }
    this.emit({ type: 'turn.completed', turnId: active.hostId, outcome,
      ...(active.nativeId && this.threadId ? { nativeTurnRef: { harnessId: id, nativeSessionId: this.threadId, nativeTurnKey: active.nativeId, formatVersion: 1 as const } } : {}) });
    this.active = undefined;
    active.done.resolve();
  }

  private fail(error: Error): void {
    if (this.fault) return;
    this.fault = { ...errorResult(error).error, code: 'processExited' };
    if (this.active) this.finish(this.active, { status: 'failed', error: this.fault });
    this.emit({ type: 'session.faulted', error: this.fault });
    this.channel.end();
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = Promise.resolve().then(async () => {
      try {
        const active = this.active;
        if (active) {
          await this.start?.catch(() => {});
          if (this.active === active) await this.rpc.request('turn/interrupt', { threadId: this.threadId, turnId: active.nativeId });
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([active.done.promise, new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error('Codex cancellation was not confirmed')), this.options.requestTimeoutMs);
            })]);
          } finally { clearTimeout(timer); }
        }
      } finally { await this.rpc.close(); this.channel.end(); }
    });
    return this.closing;
  }
}
