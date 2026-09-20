/** Pinned codex-acp 1.12.0 calls its workspace-write mode "read-only". Fail the build if these seams change. */
export function discussionSandbox(source) {
 const replacements = [
  ['    this.sandboxPolicy = sandboxPolicy;\n    this.sandboxMode = sandboxMode;',
   '    this.sandboxPolicy = process.env.DSH_DISCUSSION_READ_ONLY === "1" ? { type: "readOnly" } : sandboxPolicy;\n    this.sandboxMode = process.env.DSH_DISCUSSION_READ_ONLY === "1" ? "read-only" : sandboxMode;'],
  ['    const configWithWorkspaceRoots = mergeSandboxWorkspaceWriteRoots(mergedConfig, additionalDirectories);',
   `    const configWithWorkspaceRoots = mergeSandboxWorkspaceWriteRoots(mergedConfig, additionalDirectories);
    if (process.env.DSH_DISCUSSION_READ_ONLY === "1") {
      const names = await this.getConfigMcpServerNames(projectPath);
      return { ...configWithWorkspaceRoots,
        sandbox_mode: "read-only", approval_policy: "on-request",
        features: { ...configWithWorkspaceRoots.features, apps: false, multi_agent: false, hooks: false, plugins: false,
          computer_use: false, browser_use: false, browser_use_external: false, in_app_browser: false,
          in_app_local_automation: false, image_generation: false, code_mode_host: false,
          skill_mcp_dependency_install: false, workspace_dependencies: false },
        mcp_servers: Object.fromEntries([...names].map(name => [name, { enabled: false }])),
      };
    }`],
 ];
 for (const [before, after] of replacements) {
  if (source.split(before).length !== 2) throw new Error('codex-acp discussion sandbox seam changed');
  source = source.replace(before, after);
 }
 return source;
}
