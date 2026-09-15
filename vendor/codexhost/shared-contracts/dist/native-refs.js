import { z } from "zod";
import { harnessIdSchema } from "./ids.js";
import { jsonValueSchema, rejectExplicitUndefined } from "./json-value.js";
const nativeIdSchema = z.string().refine((value) => value.trim().length > 0, {
    message: "Native identifier must not be empty or whitespace",
});
const nativeSessionRefV1RuntimeSchema = z
    .strictObject({
    harnessId: harnessIdSchema,
    nativeSessionId: nativeIdSchema,
    locator: jsonValueSchema.optional(),
    formatVersion: z.literal(1),
})
    .superRefine(rejectExplicitUndefined(["locator"]));
export const nativeSessionRefV1Schema = nativeSessionRefV1RuntimeSchema;
export const nativeSessionRefSchema = nativeSessionRefV1Schema;
export const nativeTurnRefV1Schema = z.strictObject({
    harnessId: harnessIdSchema,
    nativeSessionId: nativeIdSchema,
    nativeTurnKey: nativeIdSchema,
    formatVersion: z.literal(1),
});
export const nativeTurnRefSchema = nativeTurnRefV1Schema;
const nativeCheckpointRefV1RuntimeSchema = z
    .strictObject({
    harnessId: harnessIdSchema,
    nativeSessionId: nativeIdSchema,
    checkpointId: nativeIdSchema,
    locator: jsonValueSchema.optional(),
    formatVersion: z.literal(1),
})
    .superRefine(rejectExplicitUndefined(["locator"]));
export const nativeCheckpointRefV1Schema = nativeCheckpointRefV1RuntimeSchema;
export const nativeCheckpointRefSchema = nativeCheckpointRefV1Schema;
//# sourceMappingURL=native-refs.js.map