import { z } from "zod";
export type JsonPrimitive = string | number | boolean | null;
export type JsonArray = JsonValue[];
export type JsonObject = {
    [key: string]: JsonValue;
};
export type JsonValue = JsonPrimitive | JsonArray | JsonObject;
export declare function rejectExplicitUndefined(keys: readonly string[]): (value: object, context: z.RefinementCtx) => void;
export declare const jsonPrimitiveSchema: z.ZodType<JsonPrimitive>;
export declare const jsonValueSchema: z.ZodType<JsonValue>;
export declare const jsonArraySchema: z.ZodType<JsonArray>;
export declare const jsonObjectSchema: z.ZodType<JsonObject>;
//# sourceMappingURL=json-value.d.ts.map