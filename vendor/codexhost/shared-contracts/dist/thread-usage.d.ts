import { z } from "zod";
export declare const threadUsageSnapshotSchema: z.ZodObject<{
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
}, z.core.$strict>;
export type ThreadUsageSnapshot = z.infer<typeof threadUsageSnapshotSchema>;
export declare const accountCreditsProductUsageSchema: z.ZodObject<{
    product: z.ZodString;
    usagePercent: z.ZodNumber;
    resetsAt: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export declare const accountResetCreditsSchema: z.ZodObject<{
    availableCount: z.ZodNumber;
    nextExpiresAt: z.ZodOptional<z.ZodString>;
    expiresAt: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strict>;
export declare const accountCreditsSnapshotSchema: z.ZodObject<{
    label: z.ZodOptional<z.ZodString>;
    usedPercent: z.ZodNumber;
    resetsAt: z.ZodOptional<z.ZodString>;
    periodType: z.ZodEnum<{
        unknown: "unknown";
        weekly: "weekly";
        monthly: "monthly";
        five_hour: "five_hour";
        seven_day: "seven_day";
    }>;
    productUsage: z.ZodOptional<z.ZodArray<z.ZodObject<{
        product: z.ZodString;
        usagePercent: z.ZodNumber;
        resetsAt: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>>;
    resetCredits: z.ZodOptional<z.ZodObject<{
        availableCount: z.ZodNumber;
        nextExpiresAt: z.ZodOptional<z.ZodString>;
        expiresAt: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type AccountResetCredits = z.infer<typeof accountResetCreditsSchema>;
export type AccountCreditsSnapshot = z.infer<typeof accountCreditsSnapshotSchema>;
export declare const threadUsageInspectionParamsSchema: z.ZodObject<{
    threadId: z.core.$ZodBranded<z.ZodString, "HostThreadId", "out">;
    refresh: z.ZodOptional<z.ZodLiteral<"exact">>;
}, z.core.$strict>;
export type ThreadUsageInspectionParams = z.infer<typeof threadUsageInspectionParamsSchema>;
export declare const threadUsageInspectionSchema: z.ZodObject<{
    threadId: z.core.$ZodBranded<z.ZodString, "HostThreadId", "out">;
    usage: z.ZodNullable<z.ZodObject<{
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
    accountCredits: z.ZodOptional<z.ZodObject<{
        label: z.ZodOptional<z.ZodString>;
        usedPercent: z.ZodNumber;
        resetsAt: z.ZodOptional<z.ZodString>;
        periodType: z.ZodEnum<{
            unknown: "unknown";
            weekly: "weekly";
            monthly: "monthly";
            five_hour: "five_hour";
            seven_day: "seven_day";
        }>;
        productUsage: z.ZodOptional<z.ZodArray<z.ZodObject<{
            product: z.ZodString;
            usagePercent: z.ZodNumber;
            resetsAt: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>>;
        resetCredits: z.ZodOptional<z.ZodObject<{
            availableCount: z.ZodNumber;
            nextExpiresAt: z.ZodOptional<z.ZodString>;
            expiresAt: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type ThreadUsageInspection = z.infer<typeof threadUsageInspectionSchema>;
//# sourceMappingURL=thread-usage.d.ts.map