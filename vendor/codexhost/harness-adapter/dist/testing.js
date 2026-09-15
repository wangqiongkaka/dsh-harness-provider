import { harnessIdSchema, harnessModelCatalogSchema, hostInteractionIdSchema, hostItemIdSchema, } from "@codexhost/shared-contracts";
import { validateHostInteractionResponse } from "./interaction.js";
import { HarnessOutputChannel } from "./output-channel.js";
import { parseHostUsage } from "./usage.js";
const invalidStateError = {
    code: "invalidState",
    message: "Fake Harness Session is closed",
    retryable: false,
};
const defaultFakeCatalog = harnessModelCatalogSchema.parse({
    models: [
        {
            ref: { id: "fake-model-v1.primary" },
            label: "Fake Primary",
            resolvedModelLabel: "fake-runtime-primary",
            supportedThinkingOptionIds: ["off", "high"],
        },
        {
            ref: { id: "fake-model-v1.secondary" },
            label: "Fake Secondary",
            supportedThinkingOptionIds: ["off", "low"],
        },
    ],
    defaultModel: { id: "fake-model-v1.primary" },
    thinkingOptions: [
        { id: "off", label: "Off" },
        { id: "low", label: "Low" },
        { id: "high", label: "High" },
    ],
    defaultThinkingOptionId: "high",
});
function catalogHasModel(catalog, model) {
    return catalog.models.some((candidate) => candidate.ref.id === model.id);
}
function resolvedLabelForModel(catalog, model) {
    return catalog.models.find((candidate) => candidate.ref.id === model?.id)?.resolvedModelLabel;
}
function thinkingOptionsForModel(catalog, model) {
    const supported = catalog.models.find((candidate) => candidate.ref.id === model?.id)?.supportedThinkingOptionIds;
    return supported ? catalog.thinkingOptions.filter((option) => supported.includes(option.id)) : [];
}
function catalogHasThinkingOption(catalog, thinkingOptionId) {
    return catalog.thinkingOptions.some(({ id }) => id === thinkingOptionId);
}
function catalogHasPermissionMode(catalog, permissionModeId) {
    return catalog?.modes.some(({ id }) => id === permissionModeId) ?? false;
}
function invalidState(message) {
    return { code: "invalidState", message, retryable: false };
}
function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}
export class FakeHarnessSession {
    harnessId;
    capabilities;
    cwd;
    initialState;
    initialUsage;
    commands;
    interactionResponses = [];
    outputs;
    snapshotReads = 0;
    usageRefreshes = 0;
    usageFailures = 0;
    #catalog;
    #permissionModes;
    #channel = new HarnessOutputChannel();
    #active = null;
    #closed = false;
    #completeCancellationDuringRequest = false;
    #interactionOrdinal = 0;
    #itemOrdinal = 0;
    #nextModelRejection = null;
    #nextThinkingRejection = null;
    #nextPermissionModeRejection = null;
    #nextTurnUsage;
    #nextApproval = null;
    #nextQuestion = null;
    #nextRejection = null;
    #state;
    #snapshot;
    #turnOrdinal = 0;
    constructor(harnessId, catalog = defaultFakeCatalog, initialModel = catalog.defaultModel, nativeRef = {
        harnessId,
        nativeSessionId: `fake-session-${Math.random().toString(36).slice(2)}`,
        formatVersion: 1,
    }, snapshot = { turns: [] }, supportsFork = true, cwd = "/synthetic", supportsForkAcrossCwd = supportsFork, initialThinkingOptionId = catalog.defaultThinkingOptionId, initialUsage = null, permissionModes, initialPermissionModeId = permissionModes?.defaultModeId, supportsRollbackLastTurn = false, permissionModeScope = "live") {
        this.harnessId = harnessId;
        const availableThinkingOptions = thinkingOptionsForModel(catalog, initialModel);
        const effectiveThinkingOptionId = availableThinkingOptions.some(({ id }) => id === initialThinkingOptionId)
            ? initialThinkingOptionId
            : availableThinkingOptions[0]?.id;
        this.capabilities = {
            configuration: {
                selectModel: true,
                selectThinkingOption: catalog.thinkingOptions.length > 0,
                selectPermissionMode: permissionModes !== undefined,
                permissionModeScope,
            },
            history: {
                fork: supportsFork,
                forkAcrossCwd: supportsForkAcrossCwd,
                rollbackLastTurn: supportsRollbackLastTurn,
            },
            subagents: { observe: false, readTranscript: false },
        };
        this.cwd = cwd;
        this.#catalog = catalog;
        this.#permissionModes = permissionModes;
        const resolvedModelLabel = resolvedLabelForModel(catalog, initialModel);
        this.initialState = {
            nativeRef,
            ...(initialModel ? { effectiveModel: initialModel } : {}),
            ...(resolvedModelLabel ? { resolvedModelLabel } : {}),
            ...(effectiveThinkingOptionId ? { effectiveThinkingOptionId } : {}),
            ...(availableThinkingOptions.length > 0 ? { availableThinkingOptions } : {}),
            ...(initialPermissionModeId ? { effectivePermissionModeId: initialPermissionModeId } : {}),
        };
        this.#state = this.initialState;
        this.initialUsage = initialUsage === null ? null : parseHostUsage(initialUsage);
        this.#snapshot = cloneJson(snapshot);
        this.#turnOrdinal = snapshot.turns.length;
        this.outputs = this.#channel.outputs;
    }
    get state() {
        return this.#state;
    }
    setStateForSnapshot(state) {
        if (this.#closed)
            throw new Error("Fake Harness Session is closed");
        this.#state = cloneJson(state);
    }
    publishEphemeralCommand(turnId, item) {
        if (this.#closed)
            throw new Error("Fake Harness Session is closed");
        this.#event({ type: "turn.started", turnId });
        this.#event({ type: "item.started", turnId, item });
        this.#event({
            type: "item.completed",
            turnId,
            snapshot: { item, outcome: { status: "succeeded" } },
        });
        this.#event({ type: "turn.completed", turnId, outcome: { status: "succeeded" } });
    }
    publishAutonomousTurn(turnId, input) {
        if (this.#closed)
            throw new Error("Fake Harness Session is closed");
        if (this.#active)
            throw new Error("Fake Harness Session already has an active Turn");
        this.#active = {
            command: { type: "turn.start", turnId, input },
            items: new Map(),
            completedItems: [],
            interactions: new Map(),
            cancellationRequested: false,
        };
        this.#event({ type: "turn.autonomous.started", turnId, input });
        this.#event({ type: "turn.started", turnId });
        this.succeedTurn();
    }
    publishUsage(usage, observedForTurnId) {
        if (this.#closed)
            throw new Error("Fake Harness Session is closed");
        this.#event({
            type: "session.usage.changed",
            usage: usage === null ? null : parseHostUsage(usage),
            ...(observedForTurnId ? { observedForTurnId } : {}),
        });
    }
    failUsageTelemetry() {
        if (this.#closed)
            throw new Error("Fake Harness Session is closed");
        this.usageFailures += 1;
    }
    publishUsageOnNextTurn(usage) {
        this.#nextTurnUsage = usage === null ? null : parseHostUsage(usage);
    }
    async refreshUsage() {
        if (this.#closed)
            throw new Error("Fake Harness Session is closed");
        this.usageRefreshes += 1;
    }
    async readSnapshot() {
        this.snapshotReads += 1;
        if (this.#closed)
            return { ok: false, error: invalidStateError };
        if (this.#active) {
            return {
                ok: false,
                error: {
                    code: "sessionBusy",
                    message: "Fake Harness Session cannot read history during an active Turn",
                    retryable: true,
                },
            };
        }
        return {
            ok: true,
            value: { ...cloneJson(this.#snapshot), state: cloneJson(this.#state) },
        };
    }
    persistedSnapshot() {
        return cloneJson(this.#snapshot);
    }
    rejectNextTurn(error) {
        this.#nextRejection = error;
    }
    rejectNextModelSelection(error) {
        this.#nextModelRejection = error;
    }
    rejectNextThinkingSelection(error) {
        this.#nextThinkingRejection = error;
    }
    rejectNextPermissionModeSelection(error) {
        this.#nextPermissionModeRejection = error;
    }
    completeCancellationOnRequest() {
        this.#completeCancellationDuringRequest = true;
    }
    requestApprovalOnNextTurn(title, description) {
        this.#nextApproval = { title, ...(description ? { description } : {}) };
    }
    askQuestionOnNextTurn(question, options = {}) {
        this.#nextQuestion = { question, options };
    }
    async execute(command) {
        if (this.#closed)
            return { ok: false, error: invalidStateError };
        if (command.type === "turn.cancel")
            return this.#cancel(command);
        if (command.type === "interaction.respond")
            return this.#respond(command);
        if (command.type === "model.select")
            return this.#selectModel(command);
        if (command.type === "thinking.select")
            return this.#selectThinking(command);
        if (command.type === "permissionMode.select")
            return this.#selectPermissionMode(command);
        if (this.#nextRejection) {
            const error = this.#nextRejection;
            this.#nextRejection = null;
            return { ok: false, error };
        }
        if (this.#active) {
            return {
                ok: false,
                error: {
                    code: "sessionBusy",
                    message: "Fake Harness Session already has an active Turn",
                    retryable: true,
                },
            };
        }
        const text = command.input.map((input) => input.text).join("\n");
        if (text.length === 0) {
            return {
                ok: false,
                error: {
                    code: "invalidRequest",
                    message: "Text Turn input must not be empty",
                    retryable: false,
                },
            };
        }
        const item = {
            type: "agentMessage",
            itemId: this.#nextItemId(),
            text: "",
        };
        this.#active = {
            command,
            items: new Map([[item.itemId, item]]),
            completedItems: [],
            interactions: new Map(),
            cancellationRequested: false,
        };
        this.#event({ type: "turn.started", turnId: command.turnId });
        this.#event({ type: "item.started", turnId: command.turnId, item });
        if (this.#nextTurnUsage !== undefined) {
            const usage = this.#nextTurnUsage;
            this.#nextTurnUsage = undefined;
            this.publishUsage(usage, command.turnId);
        }
        if (this.#nextQuestion) {
            const pending = this.#nextQuestion;
            this.#nextQuestion = null;
            this.askQuestion(pending.question, pending.options);
        }
        if (this.#nextApproval) {
            const pending = this.#nextApproval;
            this.#nextApproval = null;
            this.requestApproval(pending.title, pending.description);
        }
        return { ok: true, value: { turnId: command.turnId } };
    }
    appendText(text) {
        const active = this.#requireActive();
        const item = [...active.items.values()].find((candidate) => candidate.type === "agentMessage");
        if (!item)
            throw new Error("Fake Harness Session has no Agent Message Item");
        const updated = { ...item, text: item.text + text };
        active.items.set(item.itemId, updated);
        this.#updateItem(item.itemId, { type: "text.append", text });
    }
    startReasoning(text) {
        if (text.length === 0)
            throw new Error("Fake Reasoning must start with non-empty text");
        const item = {
            type: "reasoning",
            itemId: this.#nextItemId(),
            text: "",
        };
        this.#startItem(item);
        this.appendReasoning(item.itemId, text);
        return item.itemId;
    }
    appendReasoning(itemId, text) {
        const active = this.#requireActive();
        const item = active.items.get(itemId);
        if (item?.type !== "reasoning")
            throw new Error("Fake Harness Item is not Reasoning");
        active.items.set(itemId, { ...item, text: item.text + text });
        this.#updateItem(itemId, { type: "text.append", text });
    }
    startCommandExecution(command, cwd) {
        const item = {
            type: "commandExecution",
            itemId: this.#nextItemId(),
            command,
            ...(cwd ? { cwd } : {}),
        };
        this.#startItem(item);
        return item.itemId;
    }
    appendCommandOutput(itemId, text) {
        const active = this.#requireActive();
        const item = active.items.get(itemId);
        if (item?.type !== "commandExecution") {
            throw new Error("Fake Harness Item is not a Command Execution");
        }
        active.items.set(itemId, { ...item, output: (item.output ?? "") + text });
        this.#updateItem(itemId, { type: "output.append", text });
    }
    startToolExecution(toolName, arguments_, namespace) {
        const item = {
            type: "toolExecution",
            itemId: this.#nextItemId(),
            toolName,
            arguments: arguments_,
            ...(namespace ? { namespace } : {}),
        };
        this.#startItem(item);
        return item.itemId;
    }
    startSubagentDelegation(subagent) {
        const item = {
            type: "subagentDelegation",
            itemId: this.#nextItemId(),
            operation: "spawn",
            subagents: [subagent],
        };
        this.#startItem(item);
        return item.itemId;
    }
    replaceSubagents(itemId, subagents) {
        const active = this.#requireActive();
        const item = active.items.get(itemId);
        if (item?.type !== "subagentDelegation") {
            throw new Error("Fake Harness Item is not a Subagent delegation");
        }
        active.items.set(itemId, { ...item, subagents });
        this.#updateItem(itemId, { type: "subagents.replace", subagents });
    }
    emitSubagentTranscriptChanged(nativeSubagentId) {
        this.#channel.emit({
            kind: "event",
            event: { type: "subagent.transcript.changed", nativeSubagentId },
        });
    }
    emitSubagentState(nativeSubagentId, status, resultSummary) {
        this.#channel.emit({
            kind: "event",
            event: {
                type: "subagent.state.changed",
                nativeSubagentId,
                status,
                ...(resultSummary ? { resultSummary } : {}),
            },
        });
    }
    replaceToolOutput(itemId, output) {
        const active = this.#requireActive();
        const item = active.items.get(itemId);
        if (item?.type !== "toolExecution") {
            throw new Error("Fake Harness Item is not a Generic Tool");
        }
        active.items.set(itemId, { ...item, output });
        this.#updateItem(itemId, { type: "output.replace", output });
    }
    completeItem(itemId, outcome) {
        const active = this.#requireActive();
        const item = active.items.get(itemId);
        if (!item)
            throw new Error("Fake Harness Item is not active");
        active.items.delete(itemId);
        const snapshot = { item, outcome };
        active.completedItems.push(snapshot);
        this.#event({
            type: "item.completed",
            turnId: active.command.turnId,
            snapshot,
        });
    }
    emitFileChange(changes) {
        const itemId = this.#nextItemId();
        this.#startItem({ type: "fileChange", itemId, changes });
        this.completeItem(itemId, { status: "succeeded" });
        return itemId;
    }
    askQuestion(question, options = {}) {
        const active = this.#requireActive();
        const interactionId = this.#nextInteractionId();
        const interaction = {
            type: "question",
            interactionId,
            turnId: active.command.turnId,
            questions: [question],
            ...(options.itemId ? { itemId: options.itemId } : {}),
            ...(options.title ? { title: options.title } : {}),
            ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
        };
        active.interactions.set(interactionId, interaction);
        this.#channel.emit({ kind: "interaction", interaction });
        return interactionId;
    }
    requestApproval(title, description, suggestedScope) {
        const active = this.#requireActive();
        const interactionId = this.#nextInteractionId();
        const interaction = {
            type: "approval",
            interactionId,
            turnId: active.command.turnId,
            title,
            ...(description ? { description } : {}),
            subject: { type: "nativeAction" },
            actions: [
                { id: "allowOnce", label: "Allow once", effect: "allowOnce" },
                ...(suggestedScope === "session"
                    ? [
                        {
                            id: "allowForSession",
                            label: "Allow this conversation",
                            effect: "allowForSession",
                        },
                    ]
                    : suggestedScope === "always"
                        ? [
                            {
                                id: "allowAlways",
                                label: "Always allow",
                                effect: "allowAlways",
                            },
                        ]
                        : []),
                { id: "deny", label: "Deny", effect: "deny" },
            ],
        };
        active.interactions.set(interactionId, interaction);
        this.#channel.emit({ kind: "interaction", interaction });
        return interactionId;
    }
    expireQuestion(interactionId) {
        const active = this.#requireActive();
        if (active.interactions.get(interactionId)?.type !== "question") {
            throw new Error("Fake Harness Question is not pending");
        }
        active.interactions.delete(interactionId);
        this.#event({
            type: "interaction.closed",
            interactionId,
            turnId: active.command.turnId,
            reason: "expired",
        });
    }
    succeedTurn() {
        const active = this.#requireActive();
        const unfinishedTools = [...active.items.values()].filter((item) => item.type !== "agentMessage" && item.type !== "reasoning");
        if (unfinishedTools.length > 0) {
            throw new Error("Fake Harness Session cannot succeed with active Tool Items");
        }
        if (active.interactions.size > 0) {
            throw new Error("Fake Harness Session cannot succeed with pending Interactions");
        }
        this.#completeItems(active, { status: "succeeded" });
        this.#finishTurn(active, { status: "succeeded" });
    }
    completeCancellation(reason = "Cancelled by user") {
        const active = this.#requireActive();
        if (!active.cancellationRequested) {
            throw new Error("Fake Harness Turn has no cancellation request");
        }
        const outcome = { status: "cancelled", reason };
        this.#closeInteractions(active, "cancelled");
        this.#completeItems(active, outcome);
        this.#finishTurn(active, outcome);
    }
    failTurn(error) {
        const active = this.#requireActive();
        const outcome = { status: "failed", error };
        this.#closeInteractions(active, "cancelled");
        this.#completeItems(active, outcome);
        this.#finishTurn(active, outcome);
    }
    fault(error) {
        if (this.#active)
            this.failTurn(error);
        this.#closed = true;
        this.#event({ type: "session.faulted", error });
        this.#channel.end();
    }
    async close() {
        if (this.#closed)
            return;
        if (this.#active)
            this.failTurn(invalidStateError);
        this.#closed = true;
        this.#channel.end();
    }
    #respond(command) {
        const active = this.#active;
        const interaction = active?.interactions.get(command.interactionId);
        if (!active || !interaction) {
            return {
                ok: false,
                error: invalidState("Interaction Response must reference a pending Interaction"),
            };
        }
        const error = validateHostInteractionResponse(interaction, command.response);
        if (error)
            return { ok: false, error };
        active.interactions.delete(command.interactionId);
        this.interactionResponses.push(command);
        this.#event({
            type: "interaction.closed",
            interactionId: command.interactionId,
            turnId: active.command.turnId,
            reason: command.response.type === "question" && command.response.cancelled
                ? "cancelled"
                : "responded",
        });
        return { ok: true, value: { accepted: true } };
    }
    #selectModel(command) {
        if (this.#active) {
            return {
                ok: false,
                error: {
                    code: "sessionBusy",
                    message: "Fake Harness Session cannot select a Model during an active Turn",
                    retryable: true,
                },
            };
        }
        if (this.#nextModelRejection) {
            const error = this.#nextModelRejection;
            this.#nextModelRejection = null;
            return { ok: false, error };
        }
        if (!catalogHasModel(this.#catalog, command.model)) {
            return {
                ok: false,
                error: {
                    code: "invalidRequest",
                    message: "Fake Harness Model Ref is not in the current catalog",
                    retryable: false,
                },
            };
        }
        const availableThinkingOptions = thinkingOptionsForModel(this.#catalog, command.model);
        const effectiveThinkingOptionId = availableThinkingOptions.some(({ id }) => id === this.#state.effectiveThinkingOptionId)
            ? this.#state.effectiveThinkingOptionId
            : availableThinkingOptions[0]?.id;
        const resolvedModelLabel = resolvedLabelForModel(this.#catalog, command.model);
        const nextState = {
            ...this.#state,
            effectiveModel: command.model,
            ...(resolvedModelLabel ? { resolvedModelLabel } : {}),
            ...(effectiveThinkingOptionId ? { effectiveThinkingOptionId } : {}),
            availableThinkingOptions,
        };
        if (!resolvedModelLabel)
            delete nextState.resolvedModelLabel;
        if (!effectiveThinkingOptionId)
            delete nextState.effectiveThinkingOptionId;
        this.#state = nextState;
        this.#event({ type: "session.state.changed", state: this.#state });
        return { ok: true, value: { completed: true } };
    }
    #selectThinking(command) {
        if (this.#active) {
            return {
                ok: false,
                error: {
                    code: "sessionBusy",
                    message: "Fake Harness Session cannot select Thinking during an active Turn",
                    retryable: true,
                },
            };
        }
        if (!this.capabilities.configuration.selectThinkingOption) {
            return {
                ok: false,
                error: {
                    code: "unsupported",
                    message: "Fake Harness does not support Thinking selection",
                    retryable: false,
                },
            };
        }
        if (this.#nextThinkingRejection) {
            const error = this.#nextThinkingRejection;
            this.#nextThinkingRejection = null;
            return { ok: false, error };
        }
        const available = this.#state.availableThinkingOptions ?? [];
        if (!available.some(({ id }) => id === command.thinkingOptionId)) {
            return {
                ok: false,
                error: {
                    code: "invalidRequest",
                    message: "Fake Harness Thinking option is not currently available",
                    retryable: false,
                },
            };
        }
        this.#state = { ...this.#state, effectiveThinkingOptionId: command.thinkingOptionId };
        this.#event({ type: "session.state.changed", state: this.#state });
        return { ok: true, value: { completed: true } };
    }
    #selectPermissionMode(command) {
        if (this.#active) {
            return {
                ok: false,
                error: {
                    code: "sessionBusy",
                    message: "Fake Harness Session cannot select Permission Mode during an active Turn",
                    retryable: true,
                },
            };
        }
        if (!this.capabilities.configuration.selectPermissionMode || !this.#permissionModes) {
            return {
                ok: false,
                error: {
                    code: "unsupported",
                    message: "Fake Harness does not support Permission Mode selection",
                    retryable: false,
                },
            };
        }
        if (this.capabilities.configuration.permissionModeScope === "atCreate") {
            return {
                ok: false,
                error: {
                    code: "invalidRequest",
                    message: "Permission Mode is fixed at Session creation",
                    retryable: false,
                },
            };
        }
        if (this.#nextPermissionModeRejection) {
            const error = this.#nextPermissionModeRejection;
            this.#nextPermissionModeRejection = null;
            return { ok: false, error };
        }
        if (!catalogHasPermissionMode(this.#permissionModes, command.permissionModeId)) {
            return {
                ok: false,
                error: {
                    code: "invalidRequest",
                    message: "Fake Harness Permission Mode is not in the current catalog",
                    retryable: false,
                },
            };
        }
        this.#state = { ...this.#state, effectivePermissionModeId: command.permissionModeId };
        this.#event({ type: "session.state.changed", state: this.#state });
        return { ok: true, value: { completed: true } };
    }
    #cancel(command) {
        const active = this.#active;
        if (!active || active.command.turnId !== command.turnId) {
            return { ok: false, error: invalidState("Turn Cancel must reference the active Turn") };
        }
        active.cancellationRequested = true;
        if (this.#completeCancellationDuringRequest) {
            this.#completeCancellationDuringRequest = false;
            this.completeCancellation();
        }
        return { ok: true, value: { cancellationRequested: true } };
    }
    #startItem(item) {
        const active = this.#requireActive();
        active.items.set(item.itemId, item);
        this.#event({ type: "item.started", turnId: active.command.turnId, item });
    }
    #updateItem(itemId, update) {
        const active = this.#requireActive();
        this.#event({ type: "item.updated", turnId: active.command.turnId, itemId, update });
    }
    #closeInteractions(active, reason) {
        for (const interaction of active.interactions.values()) {
            this.#event({
                type: "interaction.closed",
                interactionId: interaction.interactionId,
                turnId: active.command.turnId,
                reason,
            });
        }
        active.interactions.clear();
    }
    #completeItems(active, outcome) {
        for (const item of [...active.items.values()].reverse()) {
            active.items.delete(item.itemId);
            const snapshot = { item, outcome };
            active.completedItems.push(snapshot);
            this.#event({
                type: "item.completed",
                turnId: active.command.turnId,
                snapshot,
            });
        }
    }
    #finishTurn(active, outcome) {
        if (this.#active !== active)
            return;
        this.#active = null;
        this.#turnOrdinal += 1;
        const nativeRef = this.#state.nativeRef;
        if (!nativeRef)
            throw new Error("Fake Harness Session has no Native Session identity");
        const nativeTurnRef = {
            harnessId: this.harnessId,
            nativeSessionId: nativeRef.nativeSessionId,
            nativeTurnKey: `fake-turn-${this.#turnOrdinal}`,
            formatVersion: 1,
        };
        const checkpoint = this.capabilities.history.fork
            ? {
                harnessId: this.harnessId,
                nativeSessionId: nativeRef.nativeSessionId,
                checkpointId: `fake-checkpoint-${this.#turnOrdinal}`,
                formatVersion: 1,
            }
            : undefined;
        const historicalOutcome = outcome.status === "succeeded"
            ? { status: "succeeded" }
            : outcome.status === "cancelled"
                ? {
                    status: "cancelled",
                    ...(outcome.reason ? { reason: outcome.reason } : {}),
                }
                : { status: "failed", error: outcome.error };
        const turn = {
            nativeTurnRef,
            ...(checkpoint ? { checkpoint } : {}),
            input: cloneJson(active.command.input),
            items: cloneJson(active.completedItems),
            outcome: historicalOutcome,
            ...(this.#state.effectiveModel ? { model: this.#state.effectiveModel } : {}),
        };
        this.#snapshot.turns.push(turn);
        this.#event({
            type: "turn.completed",
            turnId: active.command.turnId,
            nativeTurnRef,
            outcome: { ...outcome, ...(checkpoint ? { checkpoint } : {}) },
        });
    }
    #event(event) {
        this.#channel.emit({ kind: "event", event });
    }
    #nextInteractionId() {
        this.#interactionOrdinal += 1;
        return hostInteractionIdSchema.parse(`fake-interaction-${this.#interactionOrdinal}`);
    }
    #nextItemId() {
        this.#itemOrdinal += 1;
        return hostItemIdSchema.parse(`fake-item-${this.#itemOrdinal}`);
    }
    #requireActive() {
        if (!this.#active)
            throw new Error("Fake Harness Session has no active Turn");
        return this.#active;
    }
}
export class FakeHarnessAdapter {
    harnessId;
    catalog;
    permissionModes;
    sessions = [];
    initialUsage;
    supportsFork;
    supportsForkAcrossCwd;
    supportsRollbackLastTurn;
    permissionModeScope;
    inspectionCalls = 0;
    #closePromise = null;
    #sessionOrdinal = 0;
    #sessionsByNativeId = new Map();
    constructor(harnessId = harnessIdSchema.parse("fake"), catalog = defaultFakeCatalog, supportsFork = true, supportsForkAcrossCwd = supportsFork, initialUsage = null, permissionModes, supportsRollbackLastTurn = false, permissionModeScope = "live") {
        this.harnessId = harnessId;
        this.catalog = catalog;
        this.permissionModes = permissionModes;
        this.initialUsage = initialUsage === null ? null : parseHostUsage(initialUsage);
        this.supportsFork = supportsFork;
        this.supportsForkAcrossCwd = supportsForkAcrossCwd;
        this.supportsRollbackLastTurn = supportsRollbackLastTurn;
        this.permissionModeScope = permissionModeScope;
    }
    async inspect(input = {}) {
        void input;
        this.inspectionCalls += 1;
        if (this.#closePromise) {
            return {
                status: "unavailable",
                error: {
                    code: "invalidState",
                    message: "Fake Harness Adapter is closed",
                    retryable: false,
                },
            };
        }
        return {
            status: "ready",
            catalog: this.catalog,
            ...(this.permissionModes ? { permissionModes: this.permissionModes } : {}),
            capabilities: {
                configuration: {
                    selectModel: true,
                    selectThinkingOption: this.catalog.thinkingOptions.length > 0,
                    selectPermissionMode: this.permissionModes !== undefined,
                    permissionModeScope: this.permissionModeScope,
                },
                history: {
                    fork: this.supportsFork,
                    forkAcrossCwd: this.supportsForkAcrossCwd,
                    rollbackLastTurn: this.supportsRollbackLastTurn,
                },
                subagents: { observe: false, readTranscript: false },
            },
        };
    }
    async open(input) {
        if (this.#closePromise)
            return { ok: false, error: invalidStateError };
        if (input.cwd.length === 0) {
            return {
                ok: false,
                error: {
                    code: "invalidRequest",
                    message: "Fake Adapter requires a non-empty cwd",
                    retryable: false,
                },
            };
        }
        if (input.kind === "rollbackLastTurn" && !this.supportsRollbackLastTurn) {
            return {
                ok: false,
                error: {
                    code: "unsupported",
                    message: "Fake Adapter does not support last-Turn rollback",
                    retryable: false,
                },
            };
        }
        if (input.kind === "create") {
            if (input.model && !catalogHasModel(this.catalog, input.model)) {
                return {
                    ok: false,
                    error: {
                        code: "invalidRequest",
                        message: "Fake Adapter create Model is not in the current catalog",
                        retryable: false,
                    },
                };
            }
            if (input.thinkingOptionId &&
                !catalogHasThinkingOption(this.catalog, input.thinkingOptionId)) {
                return {
                    ok: false,
                    error: {
                        code: "invalidRequest",
                        message: "Fake Adapter create Thinking option is not in the current catalog",
                        retryable: false,
                    },
                };
            }
            if (input.permissionModeId &&
                !catalogHasPermissionMode(this.permissionModes, input.permissionModeId)) {
                return {
                    ok: false,
                    error: {
                        code: "invalidRequest",
                        message: "Fake Adapter create Permission Mode is not in the current catalog",
                        retryable: false,
                    },
                };
            }
            return {
                ok: true,
                value: this.#createSession(input.cwd, input.model, [], input.thinkingOptionId, input.permissionModeId),
            };
        }
        const sourceRef = input.kind === "resume" ? input.nativeRef : input.sourceRef;
        if (sourceRef.harnessId !== this.harnessId) {
            return {
                ok: false,
                error: {
                    code: "invalidRequest",
                    message: "Fake Native Session belongs to another Harness",
                    retryable: false,
                },
            };
        }
        const source = this.#sessionsByNativeId.get(sourceRef.nativeSessionId);
        if (!source) {
            return {
                ok: false,
                error: {
                    code: "sessionNotFound",
                    message: "Fake Native Session was not found",
                    retryable: false,
                },
            };
        }
        if (input.kind === "resume")
            return { ok: true, value: source };
        if (input.kind === "rollbackLastTurn") {
            const current = await source.readSnapshot();
            if (!current.ok)
                return current;
            if (current.value.turns.length === 0) {
                return {
                    ok: false,
                    error: invalidState("Fake Native Session has no Turn to roll back"),
                };
            }
            return {
                ok: true,
                value: this.#createSession(input.cwd, source.state.effectiveModel, current.value.turns.slice(0, -1), source.state.effectiveThinkingOptionId, source.state.effectivePermissionModeId),
            };
        }
        const snapshot = source.persistedSnapshot();
        if (!this.supportsFork || (!this.supportsForkAcrossCwd && input.cwd !== source.cwd)) {
            return {
                ok: false,
                error: {
                    code: "unsupported",
                    message: "Fake Adapter does not support the requested Fork cwd",
                    retryable: false,
                },
            };
        }
        if (input.checkpoint.harnessId !== this.harnessId ||
            input.checkpoint.nativeSessionId !== sourceRef.nativeSessionId) {
            return {
                ok: false,
                error: {
                    code: "checkpointNotFound",
                    message: "Fake Checkpoint does not belong to the source Session",
                    retryable: false,
                },
            };
        }
        const checkpointIndex = snapshot.turns.findIndex((turn) => turn.checkpoint?.checkpointId === input.checkpoint.checkpointId);
        if (checkpointIndex < 0) {
            return {
                ok: false,
                error: {
                    code: "checkpointNotFound",
                    message: "Fake Checkpoint was not found",
                    retryable: false,
                },
            };
        }
        return {
            ok: true,
            value: this.#createSession(input.cwd, source.state.effectiveModel, snapshot.turns.slice(0, checkpointIndex + 1), source.state.effectiveThinkingOptionId, source.state.effectivePermissionModeId),
        };
    }
    #createSession(cwd, model, sourceTurns = [], thinkingOptionId, permissionModeId) {
        this.#sessionOrdinal += 1;
        const nativeRef = {
            harnessId: this.harnessId,
            nativeSessionId: `fake-session-${this.#sessionOrdinal}`,
            formatVersion: 1,
        };
        const turns = sourceTurns.map((turn, index) => ({
            ...cloneJson(turn),
            items: turn.items.map((snapshot, itemIndex) => ({
                ...cloneJson(snapshot),
                item: {
                    ...cloneJson(snapshot.item),
                    itemId: hostItemIdSchema.parse(`fake-derived-item-${this.#sessionOrdinal}-${index + 1}-${itemIndex + 1}`),
                },
            })),
            nativeTurnRef: {
                ...turn.nativeTurnRef,
                nativeSessionId: nativeRef.nativeSessionId,
                nativeTurnKey: `fake-derived-turn-${index + 1}`,
            },
            ...(turn.checkpoint
                ? {
                    checkpoint: {
                        ...turn.checkpoint,
                        nativeSessionId: nativeRef.nativeSessionId,
                        checkpointId: `fake-checkpoint-${index + 1}`,
                    },
                }
                : {}),
        }));
        const session = new FakeHarnessSession(this.harnessId, this.catalog, model, nativeRef, { turns }, this.supportsFork, cwd, this.supportsForkAcrossCwd, thinkingOptionId, this.initialUsage, this.permissionModes, permissionModeId, this.supportsRollbackLastTurn, this.permissionModeScope);
        this.sessions.push(session);
        this.#sessionsByNativeId.set(nativeRef.nativeSessionId, session);
        return session;
    }
    close() {
        if (!this.#closePromise) {
            this.#closePromise = Promise.all(this.sessions.map((session) => session.close())).then(() => undefined);
        }
        return this.#closePromise;
    }
}
//# sourceMappingURL=testing.js.map