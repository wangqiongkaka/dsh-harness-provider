import { z } from "zod";
export declare const HARNESS_SESSION_IMPORT_ID_MAX_LENGTH = 1024;
export declare const HARNESS_SESSION_IMPORT_CWD_MAX_LENGTH = 16384;
export declare const HARNESS_SESSION_IMPORT_TITLE_MAX_LENGTH = 4096;
/** Per-response wire bound, not a storage or total-candidate limit. */
export declare const HARNESS_SESSION_IMPORT_LIST_MAX_LENGTH = 1000;
export declare const HARNESS_SESSION_IMPORT_DEFAULT_PAGE_SIZE = 20;
export declare const HARNESS_SESSION_IMPORT_UPDATED_AT_MAX = 8640000000000000;
export declare const harnessSessionImportIdSchema: z.ZodString;
/** Browser-safe metadata required to map an existing Native Session into codexhost. */
export declare const harnessSessionImportCandidateSchema: z.ZodObject<{
    nativeSessionId: z.ZodString;
    title: z.ZodNullable<z.ZodString>;
    updatedAt: z.ZodNumber;
    cwd: z.ZodString;
    running: z.ZodNullable<z.ZodBoolean>;
}, z.core.$strict>;
export type HarnessSessionImportCandidate = z.infer<typeof harnessSessionImportCandidateSchema>;
export declare const harnessSessionImportSourcesParamsSchema: z.ZodObject<{}, z.core.$strict>;
export declare const harnessSessionImportSourcesResultSchema: z.ZodObject<{
    harnesses: z.ZodArray<z.ZodObject<{
        harnessId: z.ZodPipe<z.ZodString, z.core.$ZodBranded<z.ZodString, "HarnessId", "out">>;
        name: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strict>;
export declare const harnessSessionListParamsSchema: z.ZodObject<{
    harnessId: z.ZodPipe<z.ZodString, z.core.$ZodBranded<z.ZodString, "HarnessId", "out">>;
    query: z.ZodOptional<z.ZodString>;
    offset: z.ZodOptional<z.ZodNumber>;
    limit: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>;
export declare const harnessSessionListResultSchema: z.ZodObject<{
    candidates: z.ZodArray<z.ZodObject<{
        nativeSessionId: z.ZodString;
        title: z.ZodNullable<z.ZodString>;
        updatedAt: z.ZodNumber;
        cwd: z.ZodString;
        running: z.ZodNullable<z.ZodBoolean>;
    }, z.core.$strict>>;
    total: z.ZodNumber;
}, z.core.$strict>;
export declare const harnessSessionImportParamsSchema: z.ZodObject<{
    harnessId: z.ZodPipe<z.ZodString, z.core.$ZodBranded<z.ZodString, "HarnessId", "out">>;
    nativeSessionId: z.ZodString;
}, z.core.$strict>;
export declare const harnessSessionImportResultSchema: z.ZodObject<{
    threadId: z.ZodPipe<z.ZodString, z.core.$ZodBranded<z.ZodString, "HostThreadId", "out">>;
}, z.core.$strict>;
export type HarnessSessionImportSourcesResult = z.infer<typeof harnessSessionImportSourcesResultSchema>;
export type HarnessSessionListParams = z.infer<typeof harnessSessionListParamsSchema>;
export type HarnessSessionListResult = z.infer<typeof harnessSessionListResultSchema>;
export type HarnessSessionImportParams = z.infer<typeof harnessSessionImportParamsSchema>;
export type HarnessSessionImportResult = z.infer<typeof harnessSessionImportResultSchema>;
//# sourceMappingURL=harness-session-import.d.ts.map