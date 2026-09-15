export interface HostUsage {
    inputTokens?: number;
    cachedInputTokens?: number;
    cacheWriteInputTokens?: number;
    outputTokens?: number;
    outputTokensPerSecond?: number;
    reasoningOutputTokens?: number;
    totalTokens?: number;
    totalCostUsd?: number;
    /** Known cumulative native credits for this Thread, not account quota or USD. */
    totalCredits?: number;
    contextUsagePercent?: number;
    cacheHitRatePercent?: number;
    contextWindowTokens?: number;
    contextUsedTokens?: number;
    planFiveHourUsedPercent?: number;
    planFiveHourResetsAtUnix?: number;
    planSevenDayUsedPercent?: number;
    planSevenDayResetsAtUnix?: number;
}
export declare function parseHostUsage(value: unknown): HostUsage;
//# sourceMappingURL=usage.d.ts.map