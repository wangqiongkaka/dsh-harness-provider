# DSH Harness 插件

**版本 0.1.3** · 独立安装到 DSH 的多 Harness 插件。

插件把 **Codex** 和 **Claude Code** 接到 DSH 里：在原有输入栏选择 Harness 后，回复、活动、历史、分支和恢复都留在 DSH 原会话列表中。两个 Harness 都通过 [Agent Client Protocol](https://agentclientprotocol.com)（ACP v1）连接各自的官方适配器——`@agentclientprotocol/codex-acp` 驱动本机的 Codex CLI，`@agentclientprotocol/claude-agent-acp` 驱动本机的 Claude Code CLI。适配器随插件打包；模型推理仍由各 CLI 自己的云端服务完成，认证、模型、工具、沙箱与权限策略也沿用各 CLI 自己的。

插件不修改 DSH 源码。开发预览版，验证平台为 macOS。

## 安装与使用

先安装 Codex / Claude Code CLI，并完成各自的登录或环境配置。

```sh
dsh plugin --profile web add /absolute/path/dsh-harness-provider-0.1.3.tgz
dsh --profile web
```

1. **选 Harness**。在空会话的输入栏选择 **Codex** 或 **Claude Code**。Harness 在第一条消息后固定，要换 Harness 就新建会话；不同会话可分别使用 DSH、Codex、Claude Code。
2. **选模型与强度**。输入栏右侧的模型胶囊列出该 Harness 公布的模型和推理强度（Claude Code：默认/低/中/高/极高/最大；Codex：按模型提供的档位），默认取 Harness 的推荐值。
3. **选权限**。权限胶囊切换 Harness 自己的权限模式：Claude Code 为计划/默认/接受编辑/自动/完全权限；Codex 为逐项审批（`read-only`）/自动审批（`agent`）/完全权限（`agent-full-access`），默认取自 `~/.codex/config.toml`。
4. **对话**。用 DSH 原输入框发送消息，用原停止按钮取消；运行中追加的消息插入当前原生轮。审批、提问、保密输入都以 DSH 原生的卡片弹出。
5. **看用量**。发送键左侧的环形图显示上下文占用；Harness 胶囊右侧的额度胶囊显示账户额度窗口（Claude Code：5 小时、7 天与按模型的 7 天窗口；Codex：ChatGPT 账户限速窗口；DSH 原生按提供方端点探测——智谱 Coding Plan 显示 5 小时与周额度，DeepSeek 开放平台显示余额，其余不显示）。额度环按剩余量着色（≤30% 琥珀、≤10% 红色），上下文环按占用量着色（≥70% 琥珀、≥90% 红色）；两个环弧线方向相反，同一紧张程度用同一种颜色。输入框下方的原生统计栏同样显示输出速度、总 token 与缓存命中。
6. **重启后继续**。重启 DSH 后从原会话列表打开该会话即可续聊。

其他行为：

- DSH 首次引导可选择“稍后配置”，外部 Harness 不需要 DeepSeek API Key。已选外部 Harness 时，插件跳过 DeepSeek 凭据引导，用 Harness 的权限与模型控件替换 DSH 原生控件，并隐藏计划控件。
- 新会话自动沿用上次选择的 Harness，以及该 Harness 上次选择的模型与强度。切换 Harness 时，权限按 DSH 原生沙箱模式映射（只读 / 工作区可写 / 完全权限分别对应 Codex 的逐项审批 / 自动审批 / 完全权限；原生完全权限对应 Claude Code 的完全权限）。
- 升级前保存的 Codex 权限标识（`readOnly` / `workspaceWrite` / `dangerFullAccess`）与 Claude Code 推理标识（`auto` / `off`）在打开会话时自动映射到新的标识。

## 实现结构

插件只有一个 Host 接入点、一个界面选择入口，两个 Harness 是同一个 ACP Adapter 的两个配置档。

```
DSH Host
  └─ HarnessService            src/dsh.ts          Remote 接口、选择、委派、技能目录
       ├─ DshRunner            src/dsh-runner.ts   轮次、取消、插入、状态持久化
       ├─ DshOutput            src/dsh-output.ts   Harness 事件 → DSH 消息/工具/通知
       ├─ Bindings             src/bindings.ts     DSH 会话 ↔ 原生会话引用（侧车文件）
       └─ AcpAdapter × 2       src/acp-adapter.ts  ACP 客户端：进程、会话、轮次、交互、回放、分支
            ├─ codexProfile    src/acp-profiles.ts → dist/codex-acp.mjs        → 本机 codex
            └─ claudeProfile   src/acp-profiles.ts → dist/claude-agent-acp.mjs → 本机 claude
```

`src/dsh.ts` 用两个配置档创建 Adapter 后，其余逻辑只按会话绑定的 `harness` 取值，没有 `if codex / else claude` 分支。每个 DSH 会话拥有一个独立的 ACP Agent 进程（插件内置的适配器脚本，由 DSH 的 Node 运行），Agent 再启动用户安装的 CLI；读取目录、技能与分支使用不发提示的短时进程，用完即关。

| 维度 | Codex | Claude Code |
| --- | --- | --- |
| ACP Agent | `codex-acp` 1.12.0，`CODEX_PATH` 指向用户的 `codex` | `claude-agent-acp` 0.78.0，`CLAUDE_CODE_EXECUTABLE` 指向用户的 `claude` |
| 可执行文件 | 插件配置 `codexCommand`（默认 `codex`） | 环境变量 `CODEXHOST_CLAUDE_COMMAND`，否则查 PATH 与常见安装/版本管理器目录 |
| 原生会话 ID | ACP session ID = Codex thread ID | ACP session ID = Claude Code session ID |
| 模型与强度 | 配置项 `model`、`reasoning_effort`，按模型限定档位 | 配置项 `model`、`effort` |
| 权限模式 | 会话模式 `read-only` / `agent` / `agent-full-access` | 会话模式 `default` / `acceptEdits` / `plan` / `auto` / `bypassPermissions` |
| 进展反馈指令 | 作为新会话首条提示的前缀 | `_meta.systemPrompt.append` 追加到系统提示 |
| 账户额度（ACP 不传输） | 原生 `codex app-server` 的 `account/rateLimits/read`（`src/codex-rpc.ts`） | Claude Agent SDK 账户快照（`src/claude-sdk.ts`） |

ACP 之外只保留两处原生补充：账户额度窗口和 Claude 可执行文件发现。

**原生会话彼此隔离**：每个 DSH 会话最多绑定一个 Harness，绑定同时校验原生会话引用的 `harnessId`，不能把原生会话交给另一个 Harness 续聊。

### 现有功能到 ACP 的对应

| 功能 | ACP 方法 / 通知 / 扩展 |
| --- | --- |
| 建会话、续聊、重启恢复 | `session/new`、`session/load`（回放历史） |
| 流式回复、推理摘要 | `agent_message_chunk`、`agent_thought_chunk` |
| 命令 / 工具 / 文件改动活动卡 | `tool_call`、`tool_call_update`（`execute` 类为命令卡，diff 内容为文件改动卡；卡片在拿到输入或终态后才建立） |
| 审批 | `session/request_permission`，标题与说明取权限展示扩展 `_meta.permission` |
| MCP 表单 / URL 流程 / Codex `requestUserInput` / Claude `AskUserQuestion` | `elicitation/create`（form / url）；保密字段来自 `_meta.codex.isSecret`，“其他答案”来自 `_askUserQuestionCustomAnswer` |
| 模型 / 强度 / 权限切换 | `session/set_config_option`、`session/set_mode`、`config_option_update`、`current_mode_update` |
| 上下文占用、累计 token | `usage_update`、`PromptResponse.usage` 累加 |
| 插入当前轮 | `_session/steering` |
| 取消 | `session/cancel` |
| `/` 技能菜单 | `available_commands_update` |
| 历史读取、恢复对账 | 回放重建的转录 |
| 分支、回滚 | `session/fork` + AIR fork 消息边界 |
| 计划/待办、上下文压缩、失败说明、推荐默认值 | `plan`、`compaction_update`、`session_info_update._meta`（Codex 重连提示、`sessionFailure`）、`recommendedValue` |

## 原生配置与交互

**Claude Code** 由 claude-agent-acp 按原生 CLI 范围加载用户、项目和本地设置，包括 `CLAUDE.md`、`.claude/settings*.json` 以及其中启用的 skills、MCP、plugins 和 hooks。工具审批、MCP 表单、`AskUserQuestion` 和退出计划模式都转成 DSH 审批卡或问题卡，选项文案由适配器提供（例如退出计划模式时可选择切换到的权限模式）。项目 hooks 与直接运行 Claude Code 一样会执行本地命令，应只在可信工作区使用。

**Codex** 由 codex-acp 启动原生 app-server，按原生方式加载 `config.toml`、`AGENTS.md`、skills、MCP 和 hooks。命令、文件改动、额外权限与 MCP 工具审批转成 DSH 审批卡，选项按 Codex 当前提供的决策集显示（一次、本会话、安装规则等）；MCP 表单、多选表单和 `requestUserInput`（含保密字段）转成问题卡。`/status`、`/mcp`、`/skills`、`/plan`、`/goal`、`/review`、`/review-branch`、`/review-commit`、`/compact`、`/rename`、`/logout` 由 codex-acp 本地执行，不发送给模型；未识别的斜杠命令仍交给 Codex。hooks 是否执行沿用 Codex 自己的哈希授信状态。

### 输入框 `/` 菜单与技能

技能目录按当前 Harness 读取：DSH 使用原有目录；外部 Harness 使用 Agent 公布的命令表，其中技能与本地命令都在（Codex 的 `$技能名` 去掉 `$` 显示）。已运行的会话直接用 Agent 最近公布的列表，尚未开始对话时用一个不发提示的短时会话读取。切换 Harness 会清除当前会话的目录缓存；读取失败直接报错，不回退显示 DSH 技能。选择 Codex 技能后，发送时把 `/技能名` 改写为 Codex 识别的 `$技能名`；Claude Code 保留 `/技能名`。

### 执行期间的反馈

两个 Harness 会收到统一的进展反馈要求：复杂任务先说明计划，出现重要发现、阻塞或方向变化时汇报结果与下一步，长任务尽量每 30–60 秒更新；只描述任务事实，不讨论系统提示、技能或代理策略。实际频率由模型决定。Claude Code 的 Bash 用途说明（`description`）显示在命令卡标题，展开可查看命令和输出。

### 附件、保密答复与隔离

- 文本、图片和文件附件：图片经 DSH 校验后发送给 Harness；普通文件提供经校验的本地附件路径，由原生工具按其权限读取，插件不解析文档格式。工具返回的内嵌图片导入 DSH 附件存储，重开历史可查看；远程图片 URL 保留为引用。
- 保密问题使用密码表单，答复只在内存中传给 Harness，不写入插件的日志、侧车文件或浏览器存储；原生 Harness 自己的记录行为由其控制。
- 原生会话始终由对应 Harness 维护；DSH 日志是界面投影，不会拼接历史重新创建原生对话。

## 委派 review

在 DSH 原生、Codex 或 Claude Code 会话里说“用 Codex review 当前改动”或“新建 Claude Code 会话审查这段代码”，agent 会调用插件随会话提供的委派入口：

- 在同一工作区创建独立的 **Codex review / Claude Code review** 会话，原会话不切换 Harness；新会话从空历史开始，由 agent 写入完整审查任务。
- 被委派出来的会话不再获得委派入口，避免完成通知触发递归创建。
- 左侧会话列表显示新会话，可查看进度、回复并继续对话。任务结束后自动通知并唤醒来源会话，通知按目标结束事件去重。
- 同一请求标识和参数重试复用原会话；标识相同但任务不同会被拒绝。提交结果不明确时停止自动重发，错误包含目标会话 ID。
- 同 Harness 沿用来源权限；跨 Harness 时完全权限映射为目标的完全权限，其余映射到 Codex 逐项审批 / Claude Code 默认审批。模型与强度沿用目标 Harness 上次选择。

插件通过临时本地服务和会话凭据连接 CLI 与 DSH，不依赖 `codexhost delegate` 或 Host Runtime 环境变量；凭据只在宿主进程期间有效，更新插件后需重启 DSH。外部 Harness 使用会话 CLI；DSH 原生模型使用 `harness_delegate` 与 `harness_delegate_read` 工具，统一执行来源隔离与幂等检查。CLI 的沙箱、网络及命令审批仍然生效。结果按字符分页返回，每页默认 32,000 字符；按 `nextOffset` 和 `throughSeq` 继续读取可得到完整回复且不混入之后新增的内容：`read '{"sessionId":"目标 ID","offset":32000,"throughSeq":首次返回的值}'`。

## 分支、回滚和恢复

- **轮次映射**：每个已完成轮次以“提示文本哈希.出现序号”为键保存在绑定文件中，从 ACP 会话回放重建，跨进程一致。
- **分支**：使用 DSH 原生分支入口创建同工作区独立会话，同时分支原生历史（`session/fork`）。指定消息位置时取其所在的已完成轮次，以该轮最后一条 Agent 消息为分支点（AIR fork 扩展）；分支在独立的短时 Agent 进程中执行，分支出的会话可立即在另一个进程中续聊。运行中或结果不明确时不能分支。
- **回滚**：`harness.rollback` Remote 方法撤销最后一轮原生上下文，保留工作区文件和旧的界面记录，后续对话从回滚位置继续；原生旧会话保留，新引用指向回滚边界的分支。界面未提供入口，只能由 API 调用。
- **恢复**：打开暂停的会话时自动核对原生回放；有回复或工具活动的轮次视为已执行，能确认时保存恢复说明并解除暂停。不能确认时，Harness 胶囊旁出现 **恢复会话** 按钮，提供 **核对原生记录** 与 **解除暂停，不重发**；解除暂停保留原生上下文，由用户发送下一条指令，绝不自动重复原请求。

## 配置

默认配置即可使用。需要指定 Codex 可执行文件或插件状态目录时，在 Profile 的 `cordis.patch.yml` 添加：

```yaml
- id: harness-plugin
  config:
    codexCommand: /absolute/path/codex
    root: /absolute/path/harness-state
```

- Claude Code 可执行文件用 `CODEXHOST_CLAUDE_COMMAND` 环境变量指定（沿用早期版本的变量名）。
- 状态目录默认 `$DSH_HOME/harness-plugin`（未设置 `DSH_HOME` 时为 `~/.dsh/harness-plugin`），只保存 DSH 会话 ID、Harness、原生会话引用、模型、轮次键和未确认请求标记，不保存密钥或全文历史。
- 排查 ACP Agent 启动问题时可设置 `DSH_HARNESS_ACP_STDERR=1`，让 Agent 进程的 stderr 原样输出到 DSH 的 stderr；默认丢弃，因为其中可能包含提示词或凭据。

## 当前边界

- 本版本之前保存的 Codex 轮次 ID / Claude 消息 UUID 无法再匹配新的轮次键：这些旧会话只能分支整个当前历史、不能回滚最后一轮，其余功能不受影响。
- ACP 回放不含每轮的结束状态；没有任何输出的轮次在恢复对账时保持未知，需要用户明确解除暂停。
- Claude Code 的“关闭思考”“自动”两档不在 ACP 强度选项中，升级后映射为“默认”。
- 新会话会用首条提示的第一行给原生会话命名（`/rename`），以避免两个适配器各自多发一次生成标题的模型请求；DSH 的会话标题不受影响。
- ACP 已公布但本版本未接入界面的能力：Codex 快速模式与计划协作模式、目标（goal）扩展、原生子代理会话、后台终端任务、按轮文件改动报告、会话列表/删除。客户端文件系统与终端能力未向 Agent 声明，工具继续由各 CLI 在自己的沙箱与权限策略下执行。
- 普通文件附件需要本地文件存储后端。Claude Code 未报告的 Provider 不作猜测，DSH 消息来源记为 `unreported`。
- 外部会话续聊需要保持插件启用；插件卸载会恢复其包装的公开方法与覆盖的界面插槽。公开服务方法包装与客户端插槽需要随 DSH 更新重新验证。Windows、Linux 和独立 Desktop 发行包尚未验证。

## 源码入口

Host 侧：

- `src/dsh.ts`：插件服务、严格校验的 Remote 接口、原会话命令接入、技能目录包装及卸载恢复。
- `src/dsh-runner.ts`：通过公开 `agent/pre-step` 接收外部会话输入，协调原生运行、取消、插入和状态持久化。
- `src/dsh-output.ts`：映射到 DSH 已有消息、工具、通知与流式事件；不新增持久化事件类型。
- `src/bindings.ts`：每会话一个原子替换的侧车文件。
- `src/delegation.ts`、`src/delegate-cli.mjs`：会话委派、来源隔离与结果分页读取。
- `src/remote.ts`：Host 与浏览器共享的 Remote 方法与 schema；`src/client.tsx`：界面插槽。

Harness 侧：

- `src/contracts.ts`：Host ⇄ Harness 会话契约。
- `src/acp-adapter.ts`：ACP 客户端实现。
- `src/acp-profiles.ts`：Codex 与 Claude Code 配置档（内置 Agent 脚本、可执行文件、系统提示注入、旧标识映射、账户额度探针）。
- `src/codex-rpc.ts`、`src/claude-sdk.ts`：账户额度探针和 Claude 可执行文件发现。

## 开发

需要已构建的参考项目 `deepseek-harness`（默认位于上两级目录 `../../`），或用 `DSH_REFERENCE_ROOT` 指定。先 `npm install` 再 `npm run dev:link`；之后每次 `npm install` 都会清掉 DSH 链接，需要重新执行 `dev:link`：

```sh
npm install
npm run dev:link
npm run check          # 类型检查、构建、node --test
```

真实 CLI 探针（内置 ACP Agent + 本机 Codex / Claude Code + 本地模型桩，不调用真实模型端点）：

```sh
node experiments/acp-native-probe.mjs
node experiments/delegation-native-probe.mjs
```

浏览器端探针（先打包，再按需打开各开关；通过官方 `dsh plugin` 安装临时 Profile，结束后清理）：

```sh
npm pack
node experiments/dsh-web-probe.mjs
DSH_SKILLS_PROBE=1 node experiments/dsh-web-probe.mjs
DSH_IMAGE_PROBE=1 node experiments/dsh-web-probe.mjs
DSH_DELEGATION_PROBE=1 node experiments/dsh-web-probe.mjs
```

构建会把 `@agentclientprotocol/sdk`、`codex-acp` 与 `claude-agent-acp` 打进 `dist/`，不打包 `@openai/codex` 与 Claude Agent SDK 的平台可选包；插件运行时使用用户安装的 `codex` 与 `claude`。开发、构建和发布均不依赖 codex-host。

## 验证记录

**2026-09-16（0.1.3，ACP 重构）**：两个 Harness 改经 ACP v1 连接内置的 `codex-acp` 1.12.0 / `claude-agent-acp` 0.78.0（SDK 1.4.0），删除直连 app-server 与 Agent SDK 的适配器。完整决定与对应表见 [实现与验证记录](docs/implementation-status.md#acp-重构2026-09-16)。

- `npm run check`：类型检查、构建及 23 项测试通过（`tests/acp-adapter.test.mjs` 用官方 SDK 写的假 Agent 覆盖目录、轮次、插入、取消、审批、表单、工具投影、回放、分支与崩溃场景）。
- `node experiments/acp-native-probe.mjs`：真实 Codex CLI 0.154.0 与 Claude Code CLI 2.1.273 经内置适配器完成目录/技能读取（无模型请求）、两轮对话、历史快照、指定轮次分支、技能调用、跨进程恢复与 Claude 运行中插入。
- `node experiments/delegation-native-probe.mjs`：两个真实 CLI 的 shell 工具通过委派 CLI 创建会话。
- `node experiments/dsh-web-probe.mjs`：默认模式（Codex/Claude 原输入框对话、重启续聊、恢复入口、回滚、分支）、`DSH_SKILLS_PROBE=1`（三种 `/` 目录切换）、`DSH_IMAGE_PROBE=1`（图片到达原生模型请求）、`DSH_DELEGATION_PROBE=1`（Bash 卡片显示用途说明、创建可见的 Codex review、完成后自动唤醒来源会话）全部通过。
- 未执行：真实云模型、真实写文件审批、Windows/Linux 与独立 Desktop 发行包验证；未安装到用户日常 Profile。

更早版本（直连 app-server / Agent SDK 时期）的验证记录见 [实现与验证记录](docs/implementation-status.md)。

## 验证截图

本地模拟模型回复，用于验证真实 CLI 与 DSH 界面链路：

![Codex 原生聊天页](docs/codex-web.png)

![Claude Code 原生聊天页](docs/claude-web.png)
