import { z } from "zod";
export function rejectExplicitUndefined(keys) {
    return (value, context) => {
        for (const key of keys) {
            if (Object.hasOwn(value, key) && value[key] === undefined) {
                context.addIssue({
                    code: "custom",
                    path: [key],
                    message: "Explicit undefined is not valid JSON",
                });
            }
        }
    };
}
export const jsonPrimitiveSchema = z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
]);
function hasNoCircularReferences(value) {
    const ancestors = new WeakSet();
    const stack = [{ value, leaving: false }];
    try {
        while (stack.length > 0) {
            const frame = stack.pop();
            if (!frame)
                break;
            if (frame.leaving) {
                ancestors.delete(frame.value);
                continue;
            }
            if (typeof frame.value !== "object" || frame.value === null)
                continue;
            if (ancestors.has(frame.value))
                return false;
            ancestors.add(frame.value);
            stack.push({ value: frame.value, leaving: true });
            for (const child of Object.values(frame.value)) {
                stack.push({ value: child, leaving: false });
            }
        }
    }
    catch {
        return false;
    }
    return true;
}
const nonCircularSchema = z.custom(hasNoCircularReferences, {
    message: "JSON value must not contain circular references",
});
const recursiveJsonValueSchema = z.lazy(() => z.union([
    jsonPrimitiveSchema,
    z.array(recursiveJsonValueSchema),
    z.record(z.string(), recursiveJsonValueSchema),
]));
export const jsonValueSchema = nonCircularSchema.pipe(recursiveJsonValueSchema);
export const jsonArraySchema = nonCircularSchema.pipe(z.array(recursiveJsonValueSchema));
export const jsonObjectSchema = nonCircularSchema.pipe(z.record(z.string(), recursiveJsonValueSchema));
//# sourceMappingURL=json-value.js.map