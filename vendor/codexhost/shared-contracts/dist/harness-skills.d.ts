import { z } from "zod";
export declare const harnessSkillSchema: z.ZodObject<{
    name: z.ZodString;
    description: z.ZodString;
    argumentHint: z.ZodString;
}, z.core.$strict>;
export declare const harnessSkillCatalogSchema: z.ZodObject<{
    skills: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        description: z.ZodString;
        argumentHint: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strict>;
export declare const harnessSkillsInspectParamsSchema: z.ZodObject<{
    harnessId: z.core.$ZodBranded<z.ZodString, "HarnessId", "out">;
    cwd: z.ZodString;
    threadId: z.ZodOptional<z.core.$ZodBranded<z.ZodString, "HostThreadId", "out">>;
}, z.core.$strict>;
export type HarnessSkill = z.infer<typeof harnessSkillSchema>;
export type HarnessSkillCatalog = z.infer<typeof harnessSkillCatalogSchema>;
export type HarnessSkillsInspectParams = z.infer<typeof harnessSkillsInspectParamsSchema>;
//# sourceMappingURL=harness-skills.d.ts.map