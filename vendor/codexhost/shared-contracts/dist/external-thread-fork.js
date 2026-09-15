import { z } from "zod";
import { hostThreadIdSchema, hostTurnIdSchema } from "./ids.js";
export const externalThreadForkParamsSchema = z
    .object({
    threadId: hostThreadIdSchema,
    lastTurnId: hostTurnIdSchema,
})
    .strict();
export const externalThreadForkResultSchema = z
    .object({
    threadId: hostThreadIdSchema,
})
    .strict();
//# sourceMappingURL=external-thread-fork.js.map