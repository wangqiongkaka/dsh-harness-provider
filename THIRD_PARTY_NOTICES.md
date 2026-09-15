# Third-party code

The plugin bundles public contracts and the Claude Code Adapter from codexhost
(MIT, Copyright 2026 BytePioneer-AI), Zod 4.4.3 (MIT), and the existing Adapter's
Anthropic Claude Agent SDK 0.3.220 bundle. The SDK is governed by Anthropic's own
terms, not this project's MIT license. Original notices and the SDK README are
included in `dist/licenses/`. The codexhost sources are vendored as build output in
`vendor/codexhost/` (upstream commit in `SOURCE.json`).

DSH and Cordis are supplied by the host. Codex and Claude Code executables are
installed separately and retain their own licenses and authentication.
