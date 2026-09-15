import { z } from "zod";
export declare const HARNESS_PERMISSION_MODE_ID_MAX_LENGTH = 128;
export declare const HARNESS_PERMISSION_MODE_LABEL_MAX_LENGTH = 256;
export declare const HARNESS_PERMISSION_MODE_DESCRIPTION_MAX_LENGTH = 1024;
export declare const HARNESS_PERMISSION_MODE_CATALOG_MAX_LENGTH = 32;
export declare const harnessPermissionModeIdSchema: z.core.$ZodBranded<z.ZodString, "HarnessPermissionModeId", "out">;
export type HarnessPermissionModeId = z.infer<typeof harnessPermissionModeIdSchema>;
export declare const harnessPermissionModeSchema: z.ZodObject<{
    id: z.core.$ZodBranded<z.ZodString, "HarnessPermissionModeId", "out">;
    label: z.ZodString;
    description: z.ZodOptional<z.ZodString>;
    dangerous: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strict>;
export type HarnessPermissionMode = z.infer<typeof harnessPermissionModeSchema>;
export declare const harnessPermissionModeCatalogSchema: z.ZodObject<{
    modes: z.ZodArray<z.ZodObject<{
        id: z.core.$ZodBranded<z.ZodString, "HarnessPermissionModeId", "out">;
        label: z.ZodString;
        description: z.ZodOptional<z.ZodString>;
        dangerous: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    defaultModeId: z.core.$ZodBranded<z.ZodString, "HarnessPermissionModeId", "out">;
}, z.core.$strict>;
export type HarnessPermissionModeCatalog = z.infer<typeof harnessPermissionModeCatalogSchema>;
export declare const threadPermissionModeSelectParamsSchema: z.ZodObject<{
    threadId: z.core.$ZodBranded<z.ZodString, "HostThreadId", "out">;
    permissionModeId: z.core.$ZodBranded<z.ZodString, "HarnessPermissionModeId", "out">;
}, z.core.$strict>;
export type ThreadPermissionModeSelectParams = z.infer<typeof threadPermissionModeSelectParamsSchema>;
//# sourceMappingURL=harness-permission-modes.d.ts.map