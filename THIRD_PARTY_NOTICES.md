# 第三方代码

本插件打包以下依赖：

- Zod 4.4.3，以及 Claude ACP 使用的 Zod 4.6.5（MIT）。
- `@agentclientprotocol/sdk` 1.5.1（Apache-2.0）。
- `@agentclientprotocol/codex-acp` 2.1.0（Apache-2.0）。
- `@agentclientprotocol/claude-agent-acp` 0.84.0（Apache-2.0）。
- Anthropic Claude Agent SDK 0.3.284，用于 Claude ACP 和账户额度探测；适用 Anthropic 自有条款，不适用本项目 MIT 许可证。

Host–Harness 契约改编自 codexhost（MIT，Copyright 2026 BytePioneer-AI）。原始许可证和 SDK README 位于 `dist/licenses/`。

DSH 和 Cordis 由宿主提供。Codex 和 Claude Code 可执行文件由用户单独安装，保留其原有许可证和认证方式；Codex ACP 的 `@openai/codex` 依赖不随插件打包。
