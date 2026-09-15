import { z } from "zod";
import type { JsonValue } from "./json-value.js";
declare const nativeSessionRefV1RuntimeSchema: z.ZodObject<{
    harnessId: z.core.$ZodBranded<z.ZodString, "HarnessId", "out">;
    nativeSessionId: z.ZodString;
    locator: z.ZodOptional<z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>>;
    formatVersion: z.ZodLiteral<1>;
}, z.core.$strict>;
export type NativeSessionRefV1 = Omit<z.infer<typeof nativeSessionRefV1RuntimeSchema>, "locator"> & {
    locator?: JsonValue;
};
export declare const nativeSessionRefV1Schema: z.ZodType<NativeSessionRefV1>;
export declare const nativeSessionRefSchema: z.ZodType<NativeSessionRefV1, unknown, z.core.$ZodTypeInternals<NativeSessionRefV1, unknown>>;
export type NativeSessionRef = NativeSessionRefV1;
export declare const nativeTurnRefV1Schema: z.ZodObject<{
    harnessId: z.core.$ZodBranded<z.ZodString, "HarnessId", "out">;
    nativeSessionId: z.ZodString;
    nativeTurnKey: z.ZodString;
    formatVersion: z.ZodLiteral<1>;
}, z.core.$strict>;
export type NativeTurnRefV1 = z.infer<typeof nativeTurnRefV1Schema>;
export declare const nativeTurnRefSchema: z.ZodObject<{
    harnessId: z.core.$ZodBranded<z.ZodString, "HarnessId", "out">;
    nativeSessionId: z.ZodString;
    nativeTurnKey: z.ZodString;
    formatVersion: z.ZodLiteral<1>;
}, z.core.$strict>;
export type NativeTurnRef = NativeTurnRefV1;
declare const nativeCheckpointRefV1RuntimeSchema: z.ZodObject<{
    harnessId: z.core.$ZodBranded<z.ZodString, "HarnessId", "out">;
    nativeSessionId: z.ZodString;
    checkpointId: z.ZodString;
    locator: z.ZodOptional<z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>>;
    formatVersion: z.ZodLiteral<1>;
}, z.core.$strict>;
export type NativeCheckpointRefV1 = Omit<z.infer<typeof nativeCheckpointRefV1RuntimeSchema>, "locator"> & {
    locator?: JsonValue;
};
export declare const nativeCheckpointRefV1Schema: z.ZodType<NativeCheckpointRefV1>;
export declare const nativeCheckpointRefSchema: z.ZodType<NativeCheckpointRefV1, unknown, z.core.$ZodTypeInternals<NativeCheckpointRefV1, unknown>>;
export type NativeCheckpointRef = NativeCheckpointRefV1;
export {};
//# sourceMappingURL=native-refs.d.ts.map