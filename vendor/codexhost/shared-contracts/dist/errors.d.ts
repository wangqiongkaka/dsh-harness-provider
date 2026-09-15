import { z } from "zod";
export declare const codexhostErrorSchema: z.ZodObject<{
    code: z.ZodString;
    message: z.ZodString;
    retryable: z.ZodBoolean;
    diagnostic: z.ZodOptional<z.ZodString>;
    stage: z.ZodOptional<z.ZodString>;
    durationMs: z.ZodOptional<z.ZodNumber>;
    stderrTail: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export type CodexhostError = Omit<z.infer<typeof codexhostErrorSchema>, "diagnostic" | "stage" | "durationMs" | "stderrTail"> & {
    diagnostic?: string;
    stage?: string;
    durationMs?: number;
    stderrTail?: string;
};
//# sourceMappingURL=errors.d.ts.map