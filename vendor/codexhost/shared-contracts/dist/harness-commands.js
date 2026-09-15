import { z } from "zod";
import { harnessIdSchema, hostThreadIdSchema, hostTurnIdSchema } from "./ids.js";
import { jsonObjectSchema } from "./json-value.js";
const commandIdSchema = z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9._:-]+$/u)
    .brand();
const commandInvocationSchema = z.string().min(1).max(128);
const commandLabelSchema = z.string().trim().min(1).max(128);
const commandDescriptionSchema = z.string().trim().min(1).max(512);
export const harnessCommandDescriptorSchema = z
    .object({
    id: commandIdSchema,
    invocation: commandInvocationSchema,
    label: commandLabelSchema,
    description: commandDescriptionSchema.optional(),
    argumentMode: z.enum(["none", "text"]),
})
    .strict();
export const harnessCommandCatalogSchema = z
    .object({
    commands: z.array(harnessCommandDescriptorSchema),
})
    .strict()
    .superRefine((catalog, context) => {
    const ids = new Set();
    for (const [index, command] of catalog.commands.entries()) {
        if (ids.has(command.id)) {
            context.addIssue({
                code: "custom",
                message: "Harness command IDs must be unique",
                path: ["commands", index, "id"],
            });
        }
        ids.add(command.id);
    }
});
export const harnessCommandsInspectParamsSchema = z.object({ harnessId: harnessIdSchema }).strict();
export const threadCommandsInspectParamsSchema = z
    .object({
    threadId: hostThreadIdSchema,
})
    .strict();
export const threadCommandExecuteParamsSchema = z
    .object({
    threadId: hostThreadIdSchema,
    commandId: commandIdSchema,
    turnId: hostTurnIdSchema.optional(),
    arguments: jsonObjectSchema.optional(),
})
    .strict();
export const threadCommandExecuteResultSchema = z
    .object({
    accepted: z.literal(true),
    turnId: hostTurnIdSchema,
})
    .strict();
//# sourceMappingURL=harness-commands.js.map