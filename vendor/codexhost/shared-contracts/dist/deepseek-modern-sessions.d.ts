import { z } from "zod";
import { type HarnessSessionImportCandidate } from "./harness-session-import.js";
export declare const DEEPSEEK_MODERN_SESSION_ID_MAX_LENGTH = 1024;
export declare const DEEPSEEK_MODERN_SESSION_CWD_MAX_LENGTH = 16384;
export declare const DEEPSEEK_MODERN_SESSION_TITLE_MAX_LENGTH = 4096;
export declare const DEEPSEEK_MODERN_SESSION_LIST_MAX_LENGTH = 1000;
export declare const DEEPSEEK_MODERN_SESSION_UPDATED_AT_MAX = 8640000000000000;
export declare const DEEPSEEK_MODERN_HOST_THREAD_ID_MAX_LENGTH = 1024;
export declare const deepSeekModernSessionCandidateSchema: z.ZodObject<{
    nativeSessionId: z.ZodString;
    title: z.ZodNullable<z.ZodString>;
    updatedAt: z.ZodNumber;
    cwd: z.ZodString;
    running: z.ZodNullable<z.ZodBoolean>;
}, z.core.$strict>;
export type DeepSeekModernSessionCandidate = HarnessSessionImportCandidate;
export declare const deepSeekModernSessionListParamsSchema: z.ZodObject<{}, z.core.$strict>;
export type DeepSeekModernSessionListParams = z.infer<typeof deepSeekModernSessionListParamsSchema>;
export declare const deepSeekModernSessionListResultSchema: z.ZodObject<{
    candidates: z.ZodArray<z.ZodObject<{
        nativeSessionId: z.ZodString;
        title: z.ZodNullable<z.ZodString>;
        updatedAt: z.ZodNumber;
        cwd: z.ZodString;
        running: z.ZodNullable<z.ZodBoolean>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type DeepSeekModernSessionListResult = z.infer<typeof deepSeekModernSessionListResultSchema>;
export declare const deepSeekModernSessionImportParamsSchema: z.ZodObject<{
    nativeSessionId: z.ZodString;
}, z.core.$strict>;
export type DeepSeekModernSessionImportParams = z.infer<typeof deepSeekModernSessionImportParamsSchema>;
export declare const deepSeekModernSessionImportResultSchema: z.ZodObject<{
    threadId: z.ZodPipe<z.ZodString, z.core.$ZodBranded<z.ZodString, "HostThreadId", "out">>;
}, z.core.$strict>;
export type DeepSeekModernSessionImportResult = z.infer<typeof deepSeekModernSessionImportResultSchema>;
//# sourceMappingURL=deepseek-modern-sessions.d.ts.map