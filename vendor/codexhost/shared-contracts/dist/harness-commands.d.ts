import { z } from "zod";
export declare const harnessCommandDescriptorSchema: z.ZodObject<{
    id: z.core.$ZodBranded<z.ZodString, "HarnessCommandId", "out">;
    invocation: z.ZodString;
    label: z.ZodString;
    description: z.ZodOptional<z.ZodString>;
    argumentMode: z.ZodEnum<{
        none: "none";
        text: "text";
    }>;
}, z.core.$strict>;
export type HarnessCommandDescriptor = z.infer<typeof harnessCommandDescriptorSchema>;
export declare const harnessCommandCatalogSchema: z.ZodObject<{
    commands: z.ZodArray<z.ZodObject<{
        id: z.core.$ZodBranded<z.ZodString, "HarnessCommandId", "out">;
        invocation: z.ZodString;
        label: z.ZodString;
        description: z.ZodOptional<z.ZodString>;
        argumentMode: z.ZodEnum<{
            none: "none";
            text: "text";
        }>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type HarnessCommandCatalog = z.infer<typeof harnessCommandCatalogSchema>;
export declare const harnessCommandsInspectParamsSchema: z.ZodObject<{
    harnessId: z.core.$ZodBranded<z.ZodString, "HarnessId", "out">;
}, z.core.$strict>;
export type HarnessCommandsInspectParams = z.infer<typeof harnessCommandsInspectParamsSchema>;
export declare const threadCommandsInspectParamsSchema: z.ZodObject<{
    threadId: z.core.$ZodBranded<z.ZodString, "HostThreadId", "out">;
}, z.core.$strict>;
export type ThreadCommandsInspectParams = z.infer<typeof threadCommandsInspectParamsSchema>;
export declare const threadCommandExecuteParamsSchema: z.ZodObject<{
    threadId: z.core.$ZodBranded<z.ZodString, "HostThreadId", "out">;
    commandId: z.core.$ZodBranded<z.ZodString, "HarnessCommandId", "out">;
    turnId: z.ZodOptional<z.core.$ZodBranded<z.ZodString, "HostTurnId", "out">>;
    arguments: z.ZodOptional<z.ZodType<import("./json-value.js").JsonObject, unknown, z.core.$ZodTypeInternals<import("./json-value.js").JsonObject, unknown>>>;
}, z.core.$strict>;
export type ThreadCommandExecuteParams = z.infer<typeof threadCommandExecuteParamsSchema>;
export declare const threadCommandExecuteResultSchema: z.ZodObject<{
    accepted: z.ZodLiteral<true>;
    turnId: z.core.$ZodBranded<z.ZodString, "HostTurnId", "out">;
}, z.core.$strict>;
export type ThreadCommandExecuteResult = z.infer<typeof threadCommandExecuteResultSchema>;
//# sourceMappingURL=harness-commands.d.ts.map