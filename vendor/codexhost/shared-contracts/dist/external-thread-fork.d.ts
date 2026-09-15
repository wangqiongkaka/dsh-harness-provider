import { z } from "zod";
export declare const externalThreadForkParamsSchema: z.ZodObject<{
    threadId: z.core.$ZodBranded<z.ZodString, "HostThreadId", "out">;
    lastTurnId: z.core.$ZodBranded<z.ZodString, "HostTurnId", "out">;
}, z.core.$strict>;
export type ExternalThreadForkParams = z.infer<typeof externalThreadForkParamsSchema>;
export declare const externalThreadForkResultSchema: z.ZodObject<{
    threadId: z.core.$ZodBranded<z.ZodString, "HostThreadId", "out">;
}, z.core.$strict>;
export type ExternalThreadForkResult = z.infer<typeof externalThreadForkResultSchema>;
//# sourceMappingURL=external-thread-fork.d.ts.map