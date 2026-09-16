# Third-party code

The plugin bundles Zod 4.4.3 (MIT), the Agent Client Protocol TypeScript SDK
`@agentclientprotocol/sdk` 1.4.0 (Apache-2.0), the ACP agent adapters
`@agentclientprotocol/codex-acp` 1.12.0 (Apache-2.0) and
`@agentclientprotocol/claude-agent-acp` 0.78.0 (Apache-2.0), and the Anthropic Claude
Agent SDK 0.3.270 (used by claude-agent-acp and by the plugin's account-quota probe). The
Claude Agent SDK is governed by Anthropic's own terms, not this project's MIT license. The
Host–Harness contract is adapted from codexhost (MIT, Copyright 2026 BytePioneer-AI).
Original notices and the SDK README are included in `dist/licenses/`.

DSH and Cordis are supplied by the host. Codex and Claude Code executables are installed
separately and retain their own licenses and authentication; the bundled `@openai/codex`
package dependency of codex-acp is not shipped.
