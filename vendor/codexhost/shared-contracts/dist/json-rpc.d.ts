import { z } from "zod";
export declare const jsonRpcIdSchema: z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>;
export type JsonRpcId = z.infer<typeof jsonRpcIdSchema>;
export declare const jsonRpcErrorSchema: z.ZodObject<{
    code: z.ZodNumber;
    message: z.ZodString;
    data: z.ZodOptional<z.ZodType<import("./json-value.js").JsonValue, unknown, z.core.$ZodTypeInternals<import("./json-value.js").JsonValue, unknown>>>;
}, z.core.$catchall<z.ZodType<import("./json-value.js").JsonValue, unknown, z.core.$ZodTypeInternals<import("./json-value.js").JsonValue, unknown>>>>;
export type JsonRpcError = z.infer<typeof jsonRpcErrorSchema>;
export declare const jsonRpcRequestSchema: z.ZodObject<{
    jsonrpc: z.ZodOptional<z.ZodLiteral<"2.0">>;
    id: z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>;
    method: z.ZodString;
    params: z.ZodOptional<z.ZodType<import("./json-value.js").JsonValue, unknown, z.core.$ZodTypeInternals<import("./json-value.js").JsonValue, unknown>>>;
    result: z.ZodOptional<z.ZodNever>;
    error: z.ZodOptional<z.ZodNever>;
}, z.core.$catchall<z.ZodType<import("./json-value.js").JsonValue, unknown, z.core.$ZodTypeInternals<import("./json-value.js").JsonValue, unknown>>>>;
export type JsonRpcRequest = z.infer<typeof jsonRpcRequestSchema>;
export declare const jsonRpcNotificationSchema: z.ZodObject<{
    jsonrpc: z.ZodOptional<z.ZodLiteral<"2.0">>;
    id: z.ZodOptional<z.ZodNever>;
    method: z.ZodString;
    params: z.ZodOptional<z.ZodType<import("./json-value.js").JsonValue, unknown, z.core.$ZodTypeInternals<import("./json-value.js").JsonValue, unknown>>>;
    result: z.ZodOptional<z.ZodNever>;
    error: z.ZodOptional<z.ZodNever>;
}, z.core.$catchall<z.ZodType<import("./json-value.js").JsonValue, unknown, z.core.$ZodTypeInternals<import("./json-value.js").JsonValue, unknown>>>>;
export type JsonRpcNotification = z.infer<typeof jsonRpcNotificationSchema>;
export declare const jsonRpcSuccessResponseSchema: z.ZodObject<{
    jsonrpc: z.ZodOptional<z.ZodLiteral<"2.0">>;
    id: z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>;
    method: z.ZodOptional<z.ZodNever>;
    params: z.ZodOptional<z.ZodNever>;
    result: z.ZodType<import("./json-value.js").JsonValue, unknown, z.core.$ZodTypeInternals<import("./json-value.js").JsonValue, unknown>>;
    error: z.ZodOptional<z.ZodNever>;
}, z.core.$catchall<z.ZodType<import("./json-value.js").JsonValue, unknown, z.core.$ZodTypeInternals<import("./json-value.js").JsonValue, unknown>>>>;
export type JsonRpcSuccessResponse = z.infer<typeof jsonRpcSuccessResponseSchema>;
export declare const jsonRpcErrorResponseSchema: z.ZodObject<{
    jsonrpc: z.ZodOptional<z.ZodLiteral<"2.0">>;
    id: z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>;
    method: z.ZodOptional<z.ZodNever>;
    params: z.ZodOptional<z.ZodNever>;
    result: z.ZodOptional<z.ZodNever>;
    error: z.ZodObject<{
        code: z.ZodNumber;
        message: z.ZodString;
        data: z.ZodOptional<z.ZodType<import("./json-value.js").JsonValue, unknown, z.core.$ZodTypeInternals<import("./json-value.js").JsonValue, unknown>>>;
    }, z.core.$catchall<z.ZodType<import("./json-value.js").JsonValue, unknown, z.core.$ZodTypeInternals<import("./json-value.js").JsonValue, unknown>>>>;
}, z.core.$catchall<z.ZodType<import("./json-value.js").JsonValue, unknown, z.core.$ZodTypeInternals<import("./json-value.js").JsonValue, unknown>>>>;
export type JsonRpcErrorResponse = z.infer<typeof jsonRpcErrorResponseSchema>;
export declare const jsonRpcEnvelopeSchema: z.ZodUnion<readonly [z.ZodObject<{
    jsonrpc: z.ZodOptional<z.ZodLiteral<"2.0">>;
    id: z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>;
    method: z.ZodString;
    params: z.ZodOptional<z.ZodType<import("./json-value.js").JsonValue, unknown, z.core.$ZodTypeInternals<import("./json-value.js").JsonValue, unknown>>>;
    result: z.ZodOptional<z.ZodNever>;
    error: z.ZodOptional<z.ZodNever>;
}, z.core.$catchall<z.ZodType<import("./json-value.js").JsonValue, unknown, z.core.$ZodTypeInternals<import("./json-value.js").JsonValue, unknown>>>>, z.ZodObject<{
    jsonrpc: z.ZodOptional<z.ZodLiteral<"2.0">>;
    id: z.ZodOptional<z.ZodNever>;
    method: z.ZodString;
    params: z.ZodOptional<z.ZodType<import("./json-value.js").JsonValue, unknown, z.core.$ZodTypeInternals<import("./json-value.js").JsonValue, unknown>>>;
    result: z.ZodOptional<z.ZodNever>;
    error: z.ZodOptional<z.ZodNever>;
}, z.core.$catchall<z.ZodType<import("./json-value.js").JsonValue, unknown, z.core.$ZodTypeInternals<import("./json-value.js").JsonValue, unknown>>>>, z.ZodObject<{
    jsonrpc: z.ZodOptional<z.ZodLiteral<"2.0">>;
    id: z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>;
    method: z.ZodOptional<z.ZodNever>;
    params: z.ZodOptional<z.ZodNever>;
    result: z.ZodType<import("./json-value.js").JsonValue, unknown, z.core.$ZodTypeInternals<import("./json-value.js").JsonValue, unknown>>;
    error: z.ZodOptional<z.ZodNever>;
}, z.core.$catchall<z.ZodType<import("./json-value.js").JsonValue, unknown, z.core.$ZodTypeInternals<import("./json-value.js").JsonValue, unknown>>>>, z.ZodObject<{
    jsonrpc: z.ZodOptional<z.ZodLiteral<"2.0">>;
    id: z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>;
    method: z.ZodOptional<z.ZodNever>;
    params: z.ZodOptional<z.ZodNever>;
    result: z.ZodOptional<z.ZodNever>;
    error: z.ZodObject<{
        code: z.ZodNumber;
        message: z.ZodString;
        data: z.ZodOptional<z.ZodType<import("./json-value.js").JsonValue, unknown, z.core.$ZodTypeInternals<import("./json-value.js").JsonValue, unknown>>>;
    }, z.core.$catchall<z.ZodType<import("./json-value.js").JsonValue, unknown, z.core.$ZodTypeInternals<import("./json-value.js").JsonValue, unknown>>>>;
}, z.core.$catchall<z.ZodType<import("./json-value.js").JsonValue, unknown, z.core.$ZodTypeInternals<import("./json-value.js").JsonValue, unknown>>>>]>;
export type JsonRpcEnvelope = z.infer<typeof jsonRpcEnvelopeSchema>;
//# sourceMappingURL=json-rpc.d.ts.map