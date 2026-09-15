import { z } from "zod";
import { harnessIdSchema, hostThreadIdSchema } from "./ids.js";
export const harnessSkillSchema = z
    .object({
    name: z
        .string()
        .min(1)
        .max(256)
        .regex(/^[\p{L}\p{N}_.:-]+$/u),
    description: z.string().max(8192),
    argumentHint: z.string().max(1024),
})
    .strict();
export const harnessSkillCatalogSchema = z
    .object({
    skills: z.array(harnessSkillSchema).max(10000),
})
    .strict();
export const harnessSkillsInspectParamsSchema = z
    .object({
    harnessId: harnessIdSchema,
    cwd: z.string().min(1).max(32768),
    threadId: hostThreadIdSchema.optional(),
})
    .strict();
//# sourceMappingURL=harness-skills.js.map