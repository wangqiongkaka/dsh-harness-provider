import { z } from "zod";
import { HARNESS_SESSION_IMPORT_CWD_MAX_LENGTH, HARNESS_SESSION_IMPORT_ID_MAX_LENGTH, HARNESS_SESSION_IMPORT_LIST_MAX_LENGTH, HARNESS_SESSION_IMPORT_TITLE_MAX_LENGTH, HARNESS_SESSION_IMPORT_UPDATED_AT_MAX, harnessSessionImportCandidateSchema, harnessSessionImportIdSchema, } from "./harness-session-import.js";
import { hostThreadIdSchema } from "./ids.js";
export const DEEPSEEK_MODERN_SESSION_ID_MAX_LENGTH = HARNESS_SESSION_IMPORT_ID_MAX_LENGTH;
export const DEEPSEEK_MODERN_SESSION_CWD_MAX_LENGTH = HARNESS_SESSION_IMPORT_CWD_MAX_LENGTH;
export const DEEPSEEK_MODERN_SESSION_TITLE_MAX_LENGTH = HARNESS_SESSION_IMPORT_TITLE_MAX_LENGTH;
export const DEEPSEEK_MODERN_SESSION_LIST_MAX_LENGTH = HARNESS_SESSION_IMPORT_LIST_MAX_LENGTH;
export const DEEPSEEK_MODERN_SESSION_UPDATED_AT_MAX = HARNESS_SESSION_IMPORT_UPDATED_AT_MAX;
export const DEEPSEEK_MODERN_HOST_THREAD_ID_MAX_LENGTH = 1_024;
const nonBlankTextSchema = z
    .string()
    .refine((value) => value.trim().length > 0, "Value must not be empty or whitespace")
    .refine((value) => !value.includes("\0"), "Value must not contain NUL");
const deepSeekModernSessionIdSchema = harnessSessionImportIdSchema;
export const deepSeekModernSessionCandidateSchema = harnessSessionImportCandidateSchema;
export const deepSeekModernSessionListParamsSchema = z.object({}).strict();
export const deepSeekModernSessionListResultSchema = z
    .object({
    candidates: z
        .array(deepSeekModernSessionCandidateSchema)
        .max(DEEPSEEK_MODERN_SESSION_LIST_MAX_LENGTH),
})
    .strict();
export const deepSeekModernSessionImportParamsSchema = z
    .object({
    nativeSessionId: deepSeekModernSessionIdSchema,
})
    .strict();
export const deepSeekModernSessionImportResultSchema = z
    .object({
    threadId: nonBlankTextSchema
        .max(DEEPSEEK_MODERN_HOST_THREAD_ID_MAX_LENGTH)
        .pipe(hostThreadIdSchema),
})
    .strict();
//# sourceMappingURL=deepseek-modern-sessions.js.map