import { z } from "zod";
/** Read-only telemetry for the Harness's current native authentication, never a login record. */
export declare const harnessAccountSnapshotSchema: z.ZodObject<{
    email: z.ZodOptional<z.ZodString>;
    label: z.ZodOptional<z.ZodString>;
    plan: z.ZodOptional<z.ZodString>;
    credits: z.ZodObject<{
        label: z.ZodOptional<z.ZodString>;
        usedPercent: z.ZodNumber;
        resetsAt: z.ZodOptional<z.ZodString>;
        periodType: z.ZodEnum<{
            weekly: "weekly";
            monthly: "monthly";
            five_hour: "five_hour";
            seven_day: "seven_day";
            unknown: "unknown";
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
}, z.core.$strict>;
export type HarnessAccountSnapshot = z.infer<typeof harnessAccountSnapshotSchema>;
export declare const harnessAccountSourceSchema: z.ZodObject<{
    harnessId: z.core.$ZodBranded<z.ZodString, "HarnessId", "out">;
    harnessName: z.ZodString;
}, z.core.$strict>;
export type HarnessAccountSource = z.infer<typeof harnessAccountSourceSchema>;
export declare const harnessAccountSourceListParamsSchema: z.ZodObject<{}, z.core.$strict>;
export declare const harnessAccountSourceListResultSchema: z.ZodObject<{
    sources: z.ZodArray<z.ZodObject<{
        harnessId: z.core.$ZodBranded<z.ZodString, "HarnessId", "out">;
        harnessName: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type HarnessAccountSourceListResult = z.infer<typeof harnessAccountSourceListResultSchema>;
export declare const harnessAccountInspectParamsSchema: z.ZodObject<{
    harnessId: z.core.$ZodBranded<z.ZodString, "HarnessId", "out">;
    refresh: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strict>;
export type HarnessAccountInspectParams = z.infer<typeof harnessAccountInspectParamsSchema>;
export declare const harnessAccountInspectResultSchema: z.ZodObject<{
    account: z.ZodNullable<z.ZodObject<{
        email: z.ZodOptional<z.ZodString>;
        label: z.ZodOptional<z.ZodString>;
        plan: z.ZodOptional<z.ZodString>;
        credits: z.ZodObject<{
            label: z.ZodOptional<z.ZodString>;
            usedPercent: z.ZodNumber;
            resetsAt: z.ZodOptional<z.ZodString>;
            periodType: z.ZodEnum<{
                weekly: "weekly";
                monthly: "monthly";
                five_hour: "five_hour";
                seven_day: "seven_day";
                unknown: "unknown";
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
    }, z.core.$strict>>;
    harnessId: z.core.$ZodBranded<z.ZodString, "HarnessId", "out">;
    harnessName: z.ZodString;
}, z.core.$strict>;
export type HarnessAccountInspectResult = z.infer<typeof harnessAccountInspectResultSchema>;
export declare const harnessAccountListParamsSchema: z.ZodObject<{
    refresh: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strict>;
export type HarnessAccountListParams = z.infer<typeof harnessAccountListParamsSchema>;
export declare const harnessAccountListResultSchema: z.ZodObject<{
    accounts: z.ZodArray<z.ZodObject<{
        email: z.ZodOptional<z.ZodString>;
        label: z.ZodOptional<z.ZodString>;
        plan: z.ZodOptional<z.ZodString>;
        credits: z.ZodObject<{
            label: z.ZodOptional<z.ZodString>;
            usedPercent: z.ZodNumber;
            resetsAt: z.ZodOptional<z.ZodString>;
            periodType: z.ZodEnum<{
                weekly: "weekly";
                monthly: "monthly";
                five_hour: "five_hour";
                seven_day: "seven_day";
                unknown: "unknown";
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
        harnessId: z.core.$ZodBranded<z.ZodString, "HarnessId", "out">;
        harnessName: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type HarnessAccountListResult = z.infer<typeof harnessAccountListResultSchema>;
//# sourceMappingURL=harness-accounts.d.ts.map