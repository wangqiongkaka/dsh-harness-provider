# 项目规则

- 禁止修改 DSH 宿主代码，包括宿主源码、构建产物，以及 `node_modules` 或符号链接指向的宿主文件；宿主代码仅供只读调查，功能与修复须在本插件内实现。

## 验证

- 交付前运行 `npm run check`（类型检查、构建、全部测试）。测试直接引用 `dist/` 的构建产物，只跑单个测试或跳过构建不能证明改动生效。
- 修复缺陷或新增行为时，新测试必须在改动前的代码上失败。可以临时改坏实现确认测试会失败，确认后还原源码并重跑 `npm run check`；无法做到时说明原因。

## 宿主给模型的文字

- 宿主给模型的说明（委派能力、进展反馈等）不得混进用户输入。打开会话时通过 `OpenSessionInput.instructions` 交给适配器：Claude Code 放进 `sessionMeta`（系统提示）；Codex 由配置档的 `spawn` 写入 `CODEX_CONFIG.developer_instructions`（codex-acp 在创建和恢复线程时合并该配置）。
- 这些文字不得影响原生会话标题（只取用户第一个文本块）。轮次标识由各文本块直接拼接后计算，实时轮次与历史回放必须一致；改动发送内容或顺序时，补充或运行“关掉再恢复会话后轮次标识一致”的测试。

## 第三方适配器

- 判断 `@agentclientprotocol/codex-acp`、`@agentclientprotocol/claude-agent-acp` 或 ACP SDK 的行为（回放方式、`_meta` 字段、取消语义等）前，先读 `node_modules` 中对应版本的实现，不凭记忆或文档转述下结论；结论中注明依据的文件位置。
