const tokenFields = [
    "inputTokens",
    "cachedInputTokens",
    "cacheWriteInputTokens",
    "outputTokens",
    "outputTokensPerSecond",
    "reasoningOutputTokens",
    "totalTokens",
    "contextWindowTokens",
    "contextUsedTokens",
];
const safeIntegerFields = [
    "planFiveHourResetsAtUnix",
    "planSevenDayResetsAtUnix",
];
const percentFields = [
    "cacheHitRatePercent",
    "planFiveHourUsedPercent",
    "planSevenDayUsedPercent",
];
const usageFields = new Set([
    ...tokenFields,
    ...safeIntegerFields,
    ...percentFields,
    "totalCostUsd",
    "totalCredits",
    "contextUsagePercent",
]);
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function parseHostUsage(value) {
    if (!isRecord(value))
        throw new Error("Harness Usage must be an object");
    const keys = Object.keys(value);
    if (keys.length === 0)
        throw new Error("Harness Usage must contain a reliable field");
    for (const key of keys) {
        if (!usageFields.has(key)) {
            throw new Error(`Harness Usage contains unknown field '${key}'`);
        }
    }
    for (const field of ["totalCredits", "contextUsagePercent"]) {
        const candidate = value[field];
        if (candidate !== undefined &&
            (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < 0)) {
            throw new Error(`Harness Usage '${field}' must be a finite non-negative number`);
        }
    }
    for (const field of tokenFields) {
        const candidate = value[field];
        if (candidate !== undefined &&
            (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < 0)) {
            throw new Error(`Harness Usage '${field}' must be a non-negative safe integer`);
        }
    }
    for (const field of safeIntegerFields) {
        const candidate = value[field];
        if (candidate !== undefined &&
            (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < 0)) {
            throw new Error(`Harness Usage '${field}' must be a non-negative safe integer`);
        }
    }
    if (value.outputTokensPerSecond !== undefined &&
        (typeof value.outputTokensPerSecond !== "number" ||
            !Number.isFinite(value.outputTokensPerSecond) ||
            value.outputTokensPerSecond < 0)) {
        throw new Error("Harness Usage 'outputTokensPerSecond' must be a finite non-negative number");
    }
    if (value.totalCostUsd !== undefined &&
        (typeof value.totalCostUsd !== "number" ||
            !Number.isFinite(value.totalCostUsd) ||
            value.totalCostUsd < 0)) {
        throw new Error("Harness Usage 'totalCostUsd' must be a finite non-negative number");
    }
    for (const field of percentFields) {
        const candidate = value[field];
        if (candidate !== undefined &&
            (typeof candidate !== "number" ||
                !Number.isFinite(candidate) ||
                candidate < 0 ||
                candidate > 100)) {
            throw new Error(`Harness Usage '${field}' must be between 0 and 100`);
        }
    }
    const hasContextUsed = value.contextUsedTokens !== undefined;
    const hasContextWindow = value.contextWindowTokens !== undefined;
    if (hasContextUsed !== hasContextWindow) {
        throw new Error("Harness Usage context fields must be provided together");
    }
    if (hasContextWindow && value.contextWindowTokens === 0) {
        throw new Error("Harness Usage 'contextWindowTokens' must be greater than zero");
    }
    if (value.planFiveHourResetsAtUnix !== undefined && value.planFiveHourUsedPercent === undefined) {
        throw new Error("Harness Usage 'planFiveHourResetsAtUnix' must be provided with 'planFiveHourUsedPercent'");
    }
    if (value.planSevenDayResetsAtUnix !== undefined && value.planSevenDayUsedPercent === undefined) {
        throw new Error("Harness Usage 'planSevenDayResetsAtUnix' must be provided with 'planSevenDayUsedPercent'");
    }
    return { ...value };
}
//# sourceMappingURL=usage.js.map