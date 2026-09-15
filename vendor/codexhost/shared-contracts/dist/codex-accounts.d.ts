import { z } from "zod";
export declare const codexAccountPlanTypeSchema: z.ZodEnum<{
    free: "free";
    go: "go";
    plus: "plus";
    pro: "pro";
    prolite: "prolite";
    team: "team";
    self_serve_business_prolite: "self_serve_business_prolite";
    self_serve_business_usage_based: "self_serve_business_usage_based";
    business: "business";
    ent26: "ent26";
    enterprise_cbp_automation: "enterprise_cbp_automation";
    enterprise_cbp_usage_based: "enterprise_cbp_usage_based";
    enterprise: "enterprise";
    edu: "edu";
    edu_plus: "edu_plus";
    edu_pro: "edu_pro";
    unknown: "unknown";
}>;
export type CodexAccountPlanType = z.infer<typeof codexAccountPlanTypeSchema>;
export declare const codexAccountSchema: z.ZodObject<{
    accountId: z.ZodString;
    label: z.ZodString;
    email: z.ZodOptional<z.ZodString>;
    planType: z.ZodOptional<z.ZodEnum<{
        free: "free";
        go: "go";
        plus: "plus";
        pro: "pro";
        prolite: "prolite";
        team: "team";
        self_serve_business_prolite: "self_serve_business_prolite";
        self_serve_business_usage_based: "self_serve_business_usage_based";
        business: "business";
        ent26: "ent26";
        enterprise_cbp_automation: "enterprise_cbp_automation";
        enterprise_cbp_usage_based: "enterprise_cbp_usage_based";
        enterprise: "enterprise";
        edu: "edu";
        edu_plus: "edu_plus";
        edu_pro: "edu_pro";
        unknown: "unknown";
    }>>;
}, z.core.$strict>;
export type CodexAccountSummary = z.infer<typeof codexAccountSchema>;
export declare const codexAccountPhaseSchema: z.ZodEnum<{
    ready: "ready";
    unavailable: "unavailable";
}>;
export type CodexAccountPhase = z.infer<typeof codexAccountPhaseSchema>;
export declare const codexAccountListResultSchema: z.ZodObject<{
    version: z.ZodLiteral<2>;
    currentAccountId: z.ZodNullable<z.ZodString>;
    phase: z.ZodEnum<{
        ready: "ready";
        unavailable: "unavailable";
    }>;
    revision: z.ZodNumber;
    instanceId: z.ZodOptional<z.ZodString>;
    accounts: z.ZodArray<z.ZodObject<{
        accountId: z.ZodString;
        label: z.ZodString;
        email: z.ZodOptional<z.ZodString>;
        planType: z.ZodOptional<z.ZodEnum<{
            free: "free";
            go: "go";
            plus: "plus";
            pro: "pro";
            prolite: "prolite";
            team: "team";
            self_serve_business_prolite: "self_serve_business_prolite";
            self_serve_business_usage_based: "self_serve_business_usage_based";
            business: "business";
            ent26: "ent26";
            enterprise_cbp_automation: "enterprise_cbp_automation";
            enterprise_cbp_usage_based: "enterprise_cbp_usage_based";
            enterprise: "enterprise";
            edu: "edu";
            edu_plus: "edu_plus";
            edu_pro: "edu_pro";
            unknown: "unknown";
        }>>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type CodexAccountListResult = z.infer<typeof codexAccountListResultSchema>;
export declare const codexAccountChangedSchema: z.ZodObject<{
    version: z.ZodLiteral<2>;
    currentAccountId: z.ZodNullable<z.ZodString>;
    phase: z.ZodEnum<{
        ready: "ready";
        unavailable: "unavailable";
    }>;
    revision: z.ZodNumber;
    instanceId: z.ZodOptional<z.ZodString>;
    accounts: z.ZodArray<z.ZodObject<{
        accountId: z.ZodString;
        label: z.ZodString;
        email: z.ZodOptional<z.ZodString>;
        planType: z.ZodOptional<z.ZodEnum<{
            free: "free";
            go: "go";
            plus: "plus";
            pro: "pro";
            prolite: "prolite";
            team: "team";
            self_serve_business_prolite: "self_serve_business_prolite";
            self_serve_business_usage_based: "self_serve_business_usage_based";
            business: "business";
            ent26: "ent26";
            enterprise_cbp_automation: "enterprise_cbp_automation";
            enterprise_cbp_usage_based: "enterprise_cbp_usage_based";
            enterprise: "enterprise";
            edu: "edu";
            edu_plus: "edu_plus";
            edu_pro: "edu_pro";
            unknown: "unknown";
        }>>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type CodexAccountChanged = z.infer<typeof codexAccountChangedSchema>;
export declare const codexAccountUsageParamsSchema: z.ZodObject<{
    accountId: z.ZodString;
    refresh: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strict>;
export type CodexAccountUsageParams = z.infer<typeof codexAccountUsageParamsSchema>;
export declare const codexAccountUsageResultSchema: z.ZodObject<{
    accountId: z.ZodString;
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
    freshness: z.ZodEnum<{
        live: "live";
        cached: "cached";
    }>;
    observedAt: z.ZodNullable<z.ZodString>;
}, z.core.$strict>;
export type CodexAccountUsageResult = z.infer<typeof codexAccountUsageResultSchema>;
//# sourceMappingURL=codex-accounts.d.ts.map