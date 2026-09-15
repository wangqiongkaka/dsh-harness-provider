declare module '*.mjs' {
  export function createHarnessAdapter(context: {
    environment: NodeJS.ProcessEnv; platform: NodeJS.Platform; managedRemoteHost: boolean;
  }): Promise<import('@codexhost/harness-adapter').HarnessAdapter>;
}
