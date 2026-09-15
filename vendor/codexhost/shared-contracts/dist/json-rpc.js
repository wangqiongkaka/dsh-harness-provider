import { z } from "zod";
import { jsonValueSchema, rejectExplicitUndefined } from "./json-value.js";
const jsonRpcVersionSchema = z.literal("2.0").optional();
const absentSchema = z.never().optional();
const methodSchema = z.string().min(1);
export const jsonRpcIdSchema = z.union([z.string(), z.number().int()]);
export const jsonRpcErrorSchema = z
    .object({
    code: z.number().int(),
    message: z.string(),
    data: jsonValueSchema.optional(),
})
    .catchall(jsonValueSchema)
    .superRefine(rejectExplicitUndefined(["data"]));
export const jsonRpcRequestSchema = z
    .object({
    jsonrpc: jsonRpcVersionSchema,
    id: jsonRpcIdSchema,
    method: methodSchema,
    params: jsonValueSchema.optional(),
    result: absentSchema,
    error: absentSchema,
})
    .catchall(jsonValueSchema)
    .superRefine(rejectExplicitUndefined(["jsonrpc", "params", "result", "error"]));
export const jsonRpcNotificationSchema = z
    .object({
    jsonrpc: jsonRpcVersionSchema,
    id: absentSchema,
    method: methodSchema,
    params: jsonValueSchema.optional(),
    result: absentSchema,
    error: absentSchema,
})
    .catchall(jsonValueSchema)
    .superRefine(rejectExplicitUndefined(["jsonrpc", "id", "params", "result", "error"]));
export const jsonRpcSuccessResponseSchema = z
    .object({
    jsonrpc: jsonRpcVersionSchema,
    id: jsonRpcIdSchema,
    method: absentSchema,
    params: absentSchema,
    result: jsonValueSchema,
    error: absentSchema,
})
    .catchall(jsonValueSchema)
    .superRefine(rejectExplicitUndefined(["jsonrpc", "method", "params", "error"]));
export const jsonRpcErrorResponseSchema = z
    .object({
    jsonrpc: jsonRpcVersionSchema,
    id: jsonRpcIdSchema,
    method: absentSchema,
    params: absentSchema,
    result: absentSchema,
    error: jsonRpcErrorSchema,
})
    .catchall(jsonValueSchema)
    .superRefine(rejectExplicitUndefined(["jsonrpc", "method", "params", "result"]));
export const jsonRpcEnvelopeSchema = z.union([
    jsonRpcRequestSchema,
    jsonRpcNotificationSchema,
    jsonRpcSuccessResponseSchema,
    jsonRpcErrorResponseSchema,
]);
//# sourceMappingURL=json-rpc.js.map