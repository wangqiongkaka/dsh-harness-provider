import { z } from "zod";
export declare const HARNESS_PLUGIN_API_VERSION = 1;
export declare const HARNESS_PLUGIN_MANIFEST_MAX_BYTES: number;
export declare const HARNESS_PLUGIN_ICON_MAX_BYTES: number;
export declare const HARNESS_PLUGIN_LIMIT = 128;
/** Plugin identities are portable directory/route keys, not arbitrary Native Session IDs. */
export declare const harnessPluginIdSchema: z.ZodPipe<z.ZodString, z.core.$ZodBranded<z.ZodString, "HarnessId", "out">>;
/** A manifest is data only. It must be validated before importing any plugin code. */
export declare const harnessPluginManifestSchema: z.ZodObject<{
    adapterApiVersion: z.ZodNumber;
    entry: z.ZodString;
    icon: z.ZodOptional<z.ZodString>;
    id: z.ZodPipe<z.ZodString, z.core.$ZodBranded<z.ZodString, "HarnessId", "out">>;
    name: z.ZodString;
    version: z.ZodString;
    links: z.ZodOptional<z.ZodObject<{
        documentation: z.ZodOptional<z.ZodURL>;
        installation: z.ZodOptional<z.ZodURL>;
    }, z.core.$strict>>;
    manifestVersion: z.ZodLiteral<1>;
}, z.core.$strict>;
export type HarnessPluginManifest = z.infer<typeof harnessPluginManifestSchema>;
/** Images are presentation data; consumers must use an img, never inline markup. */
export declare const harnessPluginIconSchema: z.ZodString;
export declare const harnessPluginDescriptorSchema: z.ZodObject<{
    icon: z.ZodOptional<z.ZodString>;
    id: z.ZodPipe<z.ZodString, z.core.$ZodBranded<z.ZodString, "HarnessId", "out">>;
    name: z.ZodString;
    version: z.ZodString;
    links: z.ZodOptional<z.ZodObject<{
        documentation: z.ZodOptional<z.ZodURL>;
        installation: z.ZodOptional<z.ZodURL>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type HarnessPluginDescriptor = z.infer<typeof harnessPluginDescriptorSchema>;
export declare const harnessPluginListParamsSchema: z.ZodObject<{}, z.core.$strict>;
export declare const harnessPluginListResultSchema: z.ZodObject<{
    plugins: z.ZodArray<z.ZodObject<{
        icon: z.ZodOptional<z.ZodString>;
        id: z.ZodPipe<z.ZodString, z.core.$ZodBranded<z.ZodString, "HarnessId", "out">>;
        name: z.ZodString;
        version: z.ZodString;
        links: z.ZodOptional<z.ZodObject<{
            documentation: z.ZodOptional<z.ZodURL>;
            installation: z.ZodOptional<z.ZodURL>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type HarnessPluginListResult = z.infer<typeof harnessPluginListResultSchema>;
/** Entries are explicit trust grants. Discovery alone never enables a plugin. */
export declare const harnessPluginConfigurationSchema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    enabled: z.ZodArray<z.ZodPipe<z.ZodString, z.core.$ZodBranded<z.ZodString, "HarnessId", "out">>>;
}, z.core.$strict>;
export type HarnessPluginConfiguration = z.infer<typeof harnessPluginConfigurationSchema>;
//# sourceMappingURL=harness-plugins.d.ts.map