import { z } from "zod";
export declare const HARNESS_MODEL_REF_MAX_LENGTH = 512;
export declare const HARNESS_MODEL_LABEL_MAX_LENGTH = 256;
export declare const HARNESS_THINKING_OPTION_ID_MAX_LENGTH = 128;
export declare const THREAD_OWNERSHIP_LIST_MAX_LENGTH = 100;
export declare const harnessModelRefIdSchema: z.core.$ZodBranded<z.ZodString, "HarnessModelRefId", "out">;
export declare const harnessModelRefSchema: z.ZodObject<{
    id: z.core.$ZodBranded<z.ZodString, "HarnessModelRefId", "out">;
}, z.core.$strict>;
export type HarnessModelRef = z.infer<typeof harnessModelRefSchema>;
export declare const harnessThinkingOptionIdSchema: z.core.$ZodBranded<z.ZodString, "HarnessThinkingOptionId", "out">;
export type HarnessThinkingOptionId = z.infer<typeof harnessThinkingOptionIdSchema>;
export declare const harnessResolvedModelLabelSchema: z.ZodString;
export declare const harnessThinkingOptionSchema: z.ZodObject<{
    id: z.core.$ZodBranded<z.ZodString, "HarnessThinkingOptionId", "out">;
    label: z.ZodString;
}, z.core.$strict>;
export type HarnessThinkingOption = z.infer<typeof harnessThinkingOptionSchema>;
export declare const harnessModelSchema: z.ZodObject<{
    ref: z.ZodObject<{
        id: z.core.$ZodBranded<z.ZodString, "HarnessModelRefId", "out">;
    }, z.core.$strict>;
    label: z.ZodString;
    resolvedModelLabel: z.ZodOptional<z.ZodString>;
    supportedThinkingOptionIds: z.ZodOptional<z.ZodArray<z.core.$ZodBranded<z.ZodString, "HarnessThinkingOptionId", "out">>>;
}, z.core.$strict>;
export type HarnessModel = z.infer<typeof harnessModelSchema>;
export declare const harnessModelCatalogSchema: z.ZodObject<{
    models: z.ZodArray<z.ZodObject<{
        ref: z.ZodObject<{
            id: z.core.$ZodBranded<z.ZodString, "HarnessModelRefId", "out">;
        }, z.core.$strict>;
        label: z.ZodString;
        resolvedModelLabel: z.ZodOptional<z.ZodString>;
        supportedThinkingOptionIds: z.ZodOptional<z.ZodArray<z.core.$ZodBranded<z.ZodString, "HarnessThinkingOptionId", "out">>>;
    }, z.core.$strict>>;
    defaultModel: z.ZodOptional<z.ZodObject<{
        id: z.core.$ZodBranded<z.ZodString, "HarnessModelRefId", "out">;
    }, z.core.$strict>>;
    thinkingOptions: z.ZodArray<z.ZodObject<{
        id: z.core.$ZodBranded<z.ZodString, "HarnessThinkingOptionId", "out">;
        label: z.ZodString;
    }, z.core.$strict>>;
    defaultThinkingOptionId: z.ZodOptional<z.core.$ZodBranded<z.ZodString, "HarnessThinkingOptionId", "out">>;
}, z.core.$strict>;
export type HarnessModelCatalog = z.infer<typeof harnessModelCatalogSchema>;
export declare const harnessPermissionModeScopeSchema: z.ZodEnum<{
    live: "live";
    atCreate: "atCreate";
}>;
export type HarnessPermissionModeScope = z.infer<typeof harnessPermissionModeScopeSchema>;
export declare function permissionModeFixedAtCreate(configuration: {
    permissionModeScope?: HarnessPermissionModeScope;
}): boolean;
export declare const harnessSessionCapabilitiesSchema: z.ZodObject<{
    configuration: z.ZodObject<{
        selectModel: z.ZodBoolean;
        selectThinkingOption: z.ZodBoolean;
        selectPermissionMode: z.ZodBoolean;
        permissionModeScope: z.ZodDefault<z.ZodEnum<{
            live: "live";
            atCreate: "atCreate";
        }>>;
    }, z.core.$strict>;
    history: z.ZodObject<{
        fork: z.ZodBoolean;
        forkAcrossCwd: z.ZodBoolean;
        rollbackLastTurn: z.ZodBoolean;
    }, z.core.$strict>;
    subagents: z.ZodOptional<z.ZodObject<{
        observe: z.ZodBoolean;
        readTranscript: z.ZodBoolean;
    }, z.core.$strict>>;
    autonomousTurns: z.ZodOptional<z.ZodObject<{
        observe: z.ZodBoolean;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type HarnessSessionCapabilities = z.infer<typeof harnessSessionCapabilitiesSchema>;
export declare const harnessConfigurationStateSchema: z.ZodObject<{
    effectiveModel: z.ZodOptional<z.ZodObject<{
        id: z.core.$ZodBranded<z.ZodString, "HarnessModelRefId", "out">;
    }, z.core.$strict>>;
    resolvedModelLabel: z.ZodOptional<z.ZodString>;
    effectiveThinkingOptionId: z.ZodOptional<z.core.$ZodBranded<z.ZodString, "HarnessThinkingOptionId", "out">>;
    availableThinkingOptions: z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.core.$ZodBranded<z.ZodString, "HarnessThinkingOptionId", "out">;
        label: z.ZodString;
    }, z.core.$strict>>>;
    effectivePermissionModeId: z.ZodOptional<z.core.$ZodBranded<z.ZodString, "HarnessPermissionModeId", "out">>;
}, z.core.$strict>;
export type HarnessConfigurationState = z.infer<typeof harnessConfigurationStateSchema>;
export declare const harnessModelSelectionStateSchema: z.ZodObject<{
    effectiveModel: z.ZodOptional<z.ZodObject<{
        id: z.core.$ZodBranded<z.ZodString, "HarnessModelRefId", "out">;
    }, z.core.$strict>>;
    resolvedModelLabel: z.ZodOptional<z.ZodString>;
    effectiveThinkingOptionId: z.ZodOptional<z.core.$ZodBranded<z.ZodString, "HarnessThinkingOptionId", "out">>;
    availableThinkingOptions: z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.core.$ZodBranded<z.ZodString, "HarnessThinkingOptionId", "out">;
        label: z.ZodString;
    }, z.core.$strict>>>;
    effectivePermissionModeId: z.ZodOptional<z.core.$ZodBranded<z.ZodString, "HarnessPermissionModeId", "out">>;
}, z.core.$strict>;
export type HarnessModelSelectionState = HarnessConfigurationState;
export declare const harnessWebUiCapabilitySchema: z.ZodObject<{
    open: z.ZodLiteral<true>;
}, z.core.$strict>;
export type HarnessWebUiCapability = z.infer<typeof harnessWebUiCapabilitySchema>;
export declare const harnessInspectionSchema: z.ZodUnion<readonly [z.ZodObject<{
    status: z.ZodLiteral<"ready">;
    catalog: z.ZodObject<{
        models: z.ZodArray<z.ZodObject<{
            ref: z.ZodObject<{
                id: z.core.$ZodBranded<z.ZodString, "HarnessModelRefId", "out">;
            }, z.core.$strict>;
            label: z.ZodString;
            resolvedModelLabel: z.ZodOptional<z.ZodString>;
            supportedThinkingOptionIds: z.ZodOptional<z.ZodArray<z.core.$ZodBranded<z.ZodString, "HarnessThinkingOptionId", "out">>>;
        }, z.core.$strict>>;
        defaultModel: z.ZodOptional<z.ZodObject<{
            id: z.core.$ZodBranded<z.ZodString, "HarnessModelRefId", "out">;
        }, z.core.$strict>>;
        thinkingOptions: z.ZodArray<z.ZodObject<{
            id: z.core.$ZodBranded<z.ZodString, "HarnessThinkingOptionId", "out">;
            label: z.ZodString;
        }, z.core.$strict>>;
        defaultThinkingOptionId: z.ZodOptional<z.core.$ZodBranded<z.ZodString, "HarnessThinkingOptionId", "out">>;
    }, z.core.$strict>;
    permissionModes: z.ZodOptional<z.ZodObject<{
        modes: z.ZodArray<z.ZodObject<{
            id: z.core.$ZodBranded<z.ZodString, "HarnessPermissionModeId", "out">;
            label: z.ZodString;
            description: z.ZodOptional<z.ZodString>;
            dangerous: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
        defaultModeId: z.core.$ZodBranded<z.ZodString, "HarnessPermissionModeId", "out">;
    }, z.core.$strict>>;
    capabilities: z.ZodObject<{
        configuration: z.ZodObject<{
            selectModel: z.ZodBoolean;
            selectThinkingOption: z.ZodBoolean;
            selectPermissionMode: z.ZodBoolean;
            permissionModeScope: z.ZodDefault<z.ZodEnum<{
                live: "live";
                atCreate: "atCreate";
            }>>;
        }, z.core.$strict>;
        history: z.ZodObject<{
            fork: z.ZodBoolean;
            forkAcrossCwd: z.ZodBoolean;
            rollbackLastTurn: z.ZodBoolean;
        }, z.core.$strict>;
        subagents: z.ZodOptional<z.ZodObject<{
            observe: z.ZodBoolean;
            readTranscript: z.ZodBoolean;
        }, z.core.$strict>>;
        autonomousTurns: z.ZodOptional<z.ZodObject<{
            observe: z.ZodBoolean;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    webUi: z.ZodOptional<z.ZodObject<{
        open: z.ZodLiteral<true>;
    }, z.core.$strict>>;
}, z.core.$strict>, z.ZodObject<{
    status: z.ZodEnum<{
        error: "error";
        unavailable: "unavailable";
        notInstalled: "notInstalled";
    }>;
    error: z.ZodObject<{
        code: z.ZodString;
        message: z.ZodString;
        retryable: z.ZodBoolean;
        diagnostic: z.ZodOptional<z.ZodString>;
        stage: z.ZodOptional<z.ZodString>;
        durationMs: z.ZodOptional<z.ZodNumber>;
        stderrTail: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
}, z.core.$strict>]>;
export type HarnessInspection = z.infer<typeof harnessInspectionSchema>;
export declare const harnessInspectParamsSchema: z.ZodObject<{
    harnessId: z.core.$ZodBranded<z.ZodString, "HarnessId", "out">;
    cwd: z.ZodOptional<z.ZodString>;
    refresh: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strict>;
export type HarnessInspectParams = z.infer<typeof harnessInspectParamsSchema>;
export declare const harnessWebUiOpenParamsSchema: z.ZodObject<{
    harnessId: z.core.$ZodBranded<z.ZodString, "HarnessId", "out">;
}, z.core.$strict>;
export type HarnessWebUiOpenParams = z.infer<typeof harnessWebUiOpenParamsSchema>;
export declare const harnessWebUiOpenResultSchema: z.ZodObject<{}, z.core.$strict>;
export type HarnessWebUiOpenResult = z.infer<typeof harnessWebUiOpenResultSchema>;
export declare const threadModelSelectParamsSchema: z.ZodObject<{
    threadId: z.core.$ZodBranded<z.ZodString, "HostThreadId", "out">;
    model: z.ZodObject<{
        id: z.core.$ZodBranded<z.ZodString, "HarnessModelRefId", "out">;
    }, z.core.$strict>;
}, z.core.$strict>;
export type ThreadModelSelectParams = z.infer<typeof threadModelSelectParamsSchema>;
export declare const threadThinkingSelectParamsSchema: z.ZodObject<{
    threadId: z.core.$ZodBranded<z.ZodString, "HostThreadId", "out">;
    thinkingOptionId: z.core.$ZodBranded<z.ZodString, "HarnessThinkingOptionId", "out">;
}, z.core.$strict>;
export type ThreadThinkingSelectParams = z.infer<typeof threadThinkingSelectParamsSchema>;
export declare const threadInspectionParamsSchema: z.ZodObject<{
    threadId: z.core.$ZodBranded<z.ZodString, "HostThreadId", "out">;
}, z.core.$strict>;
export type ThreadInspectionParams = z.infer<typeof threadInspectionParamsSchema>;
export declare const threadInspectionSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    owner: z.ZodLiteral<"codex">;
    locked: z.ZodLiteral<true>;
}, z.core.$strict>, z.ZodObject<{
    owner: z.ZodLiteral<"external">;
    harnessId: z.ZodString;
    transportModelId: z.ZodString;
    effectiveModel: z.ZodOptional<z.ZodObject<{
        id: z.core.$ZodBranded<z.ZodString, "HarnessModelRefId", "out">;
    }, z.core.$strict>>;
    resolvedModelLabel: z.ZodOptional<z.ZodString>;
    effectiveThinkingOptionId: z.ZodOptional<z.core.$ZodBranded<z.ZodString, "HarnessThinkingOptionId", "out">>;
    availableThinkingOptions: z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.core.$ZodBranded<z.ZodString, "HarnessThinkingOptionId", "out">;
        label: z.ZodString;
    }, z.core.$strict>>>;
    effectivePermissionModeId: z.ZodOptional<z.core.$ZodBranded<z.ZodString, "HarnessPermissionModeId", "out">>;
    history: z.ZodObject<{
        fork: z.ZodBoolean;
        forkAcrossCwd: z.ZodBoolean;
        rollbackLastTurn: z.ZodBoolean;
    }, z.core.$strict>;
    usage: z.ZodOptional<z.ZodObject<{
        inputTokens: z.ZodOptional<z.ZodNumber>;
        cachedInputTokens: z.ZodOptional<z.ZodNumber>;
        cacheWriteInputTokens: z.ZodOptional<z.ZodNumber>;
        outputTokens: z.ZodOptional<z.ZodNumber>;
        outputTokensPerSecond: z.ZodOptional<z.ZodNumber>;
        reasoningOutputTokens: z.ZodOptional<z.ZodNumber>;
        totalTokens: z.ZodOptional<z.ZodNumber>;
        totalCostUsd: z.ZodOptional<z.ZodNumber>;
        totalCredits: z.ZodOptional<z.ZodNumber>;
        contextUsagePercent: z.ZodOptional<z.ZodNumber>;
        cacheHitRatePercent: z.ZodOptional<z.ZodNumber>;
        contextWindowTokens: z.ZodOptional<z.ZodNumber>;
        contextUsedTokens: z.ZodOptional<z.ZodNumber>;
        planFiveHourUsedPercent: z.ZodOptional<z.ZodNumber>;
        planFiveHourResetsAtUnix: z.ZodOptional<z.ZodNumber>;
        planSevenDayUsedPercent: z.ZodOptional<z.ZodNumber>;
        planSevenDayResetsAtUnix: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>;
    locked: z.ZodLiteral<true>;
}, z.core.$strict>], "owner">;
export type ThreadInspection = z.infer<typeof threadInspectionSchema>;
export declare const threadOwnershipListParamsSchema: z.ZodObject<{
    threadIds: z.ZodArray<z.core.$ZodBranded<z.ZodString, "HostThreadId", "out">>;
}, z.core.$strict>;
export type ThreadOwnershipListParams = z.infer<typeof threadOwnershipListParamsSchema>;
export declare const threadOwnershipSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    threadId: z.core.$ZodBranded<z.ZodString, "HostThreadId", "out">;
    owner: z.ZodLiteral<"codex">;
}, z.core.$strict>, z.ZodObject<{
    threadId: z.core.$ZodBranded<z.ZodString, "HostThreadId", "out">;
    owner: z.ZodLiteral<"external">;
    harnessId: z.ZodPipe<z.ZodString, z.core.$ZodBranded<z.ZodString, "HarnessId", "out">>;
}, z.core.$strict>], "owner">;
export type ThreadOwnership = z.infer<typeof threadOwnershipSchema>;
export declare const threadOwnershipListResultSchema: z.ZodObject<{
    threads: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
        threadId: z.core.$ZodBranded<z.ZodString, "HostThreadId", "out">;
        owner: z.ZodLiteral<"codex">;
    }, z.core.$strict>, z.ZodObject<{
        threadId: z.core.$ZodBranded<z.ZodString, "HostThreadId", "out">;
        owner: z.ZodLiteral<"external">;
        harnessId: z.ZodPipe<z.ZodString, z.core.$ZodBranded<z.ZodString, "HarnessId", "out">>;
    }, z.core.$strict>], "owner">>;
}, z.core.$strict>;
export type ThreadOwnershipListResult = z.infer<typeof threadOwnershipListResultSchema>;
//# sourceMappingURL=harness-models.d.ts.map