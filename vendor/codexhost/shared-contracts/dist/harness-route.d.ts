import { z } from "zod";
export declare const HARNESS_PLUGIN_ROUTE_PREFIX = "codexhost/plugin-v1@";
export declare const harnessPluginRouteSchema: z.ZodObject<{
    harnessId: z.ZodPipe<z.ZodString, z.core.$ZodBranded<z.ZodString, "HarnessId", "out">>;
    model: z.ZodOptional<z.ZodObject<{
        id: z.core.$ZodBranded<z.ZodString, "HarnessModelRefId", "out">;
    }, z.core.$strict>>;
    thinkingOptionId: z.ZodOptional<z.core.$ZodBranded<z.ZodString, "HarnessThinkingOptionId", "out">>;
    permissionModeId: z.ZodOptional<z.core.$ZodBranded<z.ZodString, "HarnessPermissionModeId", "out">>;
}, z.core.$strict>;
export type HarnessPluginRoute = z.infer<typeof harnessPluginRouteSchema>;
/** All identity fields are transport-safe ASCII; no Node.js Buffer dependency. */
export declare function encodeHarnessPluginRoute(route: HarnessPluginRoute): string;
/** null means another protocol, not an invalid or unavailable external Harness. */
export declare function decodeHarnessPluginRoute(value: unknown): HarnessPluginRoute | null;
//# sourceMappingURL=harness-route.d.ts.map