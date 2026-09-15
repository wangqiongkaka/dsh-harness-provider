import { z } from "zod";
export declare const UPDATE_ERROR_MAX_LENGTH = 500;
export declare const UPDATE_SEMVER_PATTERN: RegExp;
export declare const updateSemanticVersionSchema: z.ZodString;
export declare const updateInstallationSchema: z.ZodEnum<{
    npm: "npm";
    "windows-installer": "windows-installer";
    "macos-dmg": "macos-dmg";
}>;
export declare const updatePhaseSchema: z.ZodEnum<{
    prepared: "prepared";
    downloading: "downloading";
    "waiting-for-exit": "waiting-for-exit";
    installing: "installing";
    restarting: "restarting";
    succeeded: "succeeded";
    failed: "failed";
}>;
export declare const updateStatusSchema: z.ZodObject<{
    version: z.ZodString;
    installation: z.ZodEnum<{
        npm: "npm";
        "windows-installer": "windows-installer";
        "macos-dmg": "macos-dmg";
    }>;
    phase: z.ZodEnum<{
        prepared: "prepared";
        downloading: "downloading";
        "waiting-for-exit": "waiting-for-exit";
        installing: "installing";
        restarting: "restarting";
        succeeded: "succeeded";
        failed: "failed";
    }>;
    updatedAt: z.ZodNumber;
    downloadedBytes: z.ZodOptional<z.ZodNumber>;
    totalBytes: z.ZodOptional<z.ZodNumber>;
    error: z.ZodNullable<z.ZodString>;
}, z.core.$strict>;
export declare const updateEmptyParamsSchema: z.ZodObject<{}, z.core.$strict>;
export declare const updateCheckResultSchema: z.ZodObject<{
    currentVersion: z.ZodString;
    installation: z.ZodNullable<z.ZodEnum<{
        npm: "npm";
        "windows-installer": "windows-installer";
        "macos-dmg": "macos-dmg";
    }>>;
    latestVersion: z.ZodNullable<z.ZodString>;
    updateAvailable: z.ZodBoolean;
    installationAvailable: z.ZodBoolean;
    releaseNotes: z.ZodNullable<z.ZodString>;
    releaseNotesUrl: z.ZodNullable<z.ZodString>;
    status: z.ZodNullable<z.ZodObject<{
        version: z.ZodString;
        installation: z.ZodEnum<{
            npm: "npm";
            "windows-installer": "windows-installer";
            "macos-dmg": "macos-dmg";
        }>;
        phase: z.ZodEnum<{
            prepared: "prepared";
            downloading: "downloading";
            "waiting-for-exit": "waiting-for-exit";
            installing: "installing";
            restarting: "restarting";
            succeeded: "succeeded";
            failed: "failed";
        }>;
        updatedAt: z.ZodNumber;
        downloadedBytes: z.ZodOptional<z.ZodNumber>;
        totalBytes: z.ZodOptional<z.ZodNumber>;
        error: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    error: z.ZodNullable<z.ZodString>;
}, z.core.$strict>;
export declare const updateStartResultSchema: z.ZodObject<{
    status: z.ZodObject<{
        version: z.ZodString;
        installation: z.ZodEnum<{
            npm: "npm";
            "windows-installer": "windows-installer";
            "macos-dmg": "macos-dmg";
        }>;
        phase: z.ZodEnum<{
            prepared: "prepared";
            downloading: "downloading";
            "waiting-for-exit": "waiting-for-exit";
            installing: "installing";
            restarting: "restarting";
            succeeded: "succeeded";
            failed: "failed";
        }>;
        updatedAt: z.ZodNumber;
        downloadedBytes: z.ZodOptional<z.ZodNumber>;
        totalBytes: z.ZodOptional<z.ZodNumber>;
        error: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>;
}, z.core.$strict>;
export declare const updateStatusResultSchema: z.ZodObject<{
    status: z.ZodNullable<z.ZodObject<{
        version: z.ZodString;
        installation: z.ZodEnum<{
            npm: "npm";
            "windows-installer": "windows-installer";
            "macos-dmg": "macos-dmg";
        }>;
        phase: z.ZodEnum<{
            prepared: "prepared";
            downloading: "downloading";
            "waiting-for-exit": "waiting-for-exit";
            installing: "installing";
            restarting: "restarting";
            succeeded: "succeeded";
            failed: "failed";
        }>;
        updatedAt: z.ZodNumber;
        downloadedBytes: z.ZodOptional<z.ZodNumber>;
        totalBytes: z.ZodOptional<z.ZodNumber>;
        error: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type UpdateInstallation = z.infer<typeof updateInstallationSchema>;
export type UpdatePhase = z.infer<typeof updatePhaseSchema>;
export type UpdateStatus = z.infer<typeof updateStatusSchema>;
export type UpdateCheckResult = z.infer<typeof updateCheckResultSchema>;
export type UpdateStartResult = z.infer<typeof updateStartResultSchema>;
export type UpdateStatusResult = z.infer<typeof updateStatusResultSchema>;
//# sourceMappingURL=updates.d.ts.map