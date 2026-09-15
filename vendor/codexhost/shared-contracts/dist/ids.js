import { z } from "zod";
const opaqueIdSchema = z.string().refine((value) => value.trim().length > 0, {
    message: "Identifier must not be empty or whitespace",
});
export const harnessIdSchema = opaqueIdSchema.brand();
export const hostThreadIdSchema = opaqueIdSchema.brand();
export const hostTurnIdSchema = opaqueIdSchema.brand();
export const hostItemIdSchema = opaqueIdSchema.brand();
export const hostInteractionIdSchema = opaqueIdSchema.brand();
//# sourceMappingURL=ids.js.map