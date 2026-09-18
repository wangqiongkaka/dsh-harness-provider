# Harness 能力补齐

> 各节记录的测试数量是该次 `npm run check` 的结果，括号内注明对应提交；之后的改动会增减测试，当前数量以实际运行输出为准。

## 已确认决定

- 六项边界全部纳入本次实现：附件/图片工具结果、插入当前轮/分支/回滚、保密问题、异常对账与恢复界面、委派自动唤醒与完整结果、DSH 原生委派入口。
- 回滚只撤销最后一轮对话上下文，保留工作区文件。
- 委派完成后自动唤醒来源会话读取结果并继续任务。
- 无法证明原生请求结果时，允许手动解除暂停，保留原生上下文，不重发原请求。
- 保留本任务开始前四个文件中的工具展示/思考摘要改动。
- 不修改 DSH 上游；复用公开服务与现有 UI 样式。项目没有 DESIGN.md。

## 验收

1. 图片和文件经 DSH 上传校验后进入两个 Harness；图片结果入附件存储后可在历史中查看；错误输入不能绕过存储校验。
2. 运行中追加消息进入当前原生轮；分支继承选定已完成边界；回滚与后续续聊使用一致的原生上下文，不撤销文件。
3. 保密问题通过密码控件答复；插件不把答复写进日志、绑定文件或本地存储；取消/过期关闭等待。
4. 可确认的原生结果能对账；未知结果不自动重发；用户能在界面检查与恢复。
5. 委派完成通知去重并唤醒来源；结果能分页读完整；来源隔离与原有幂等规则保持。
6. DSH 原生模型可调用同一委派能力，授权、状态、分页和自动唤醒行为一致。

## 实现结果

- 附件复用 DSH 上传票据、归属校验和附件存储；两种 Harness 支持图片输入，工具内嵌图片与本地图片结果导入持久附件。
- 运行中消息转交原生插入接口；分支使用原生历史边界；回滚通过原生分支切换后续上下文，保留文件与旧界面记录。
- 保密问题采用密码表单和内存等待队列，支持取消、过期及原生关闭；答复不进入插件持久状态。
- 暂停会话自动核对原生结束证据；会话操作菜单支持主动核对及手动解除暂停，均不重发原请求。
- 委派结果支持固定事件边界的分页读取；完成通知持久去重，自动唤醒来源会话，重启后可补发未通知的结果。
- DSH 原生模型注册 `harness_delegate` 与 `harness_delegate_read`，复用外部 Harness 的授权、来源隔离和幂等实现。

## 验证记录（2026-09-16）

- `npm run check`：类型检查、构建及 33 项测试通过（提交 e213d70 时）。覆盖附件校验和图片落盘、保密答复隔离及关闭、运行中插入去重、历史分支和回滚、未知结果不重发、委派分页及自动唤醒、原生 DSH 工具调用，以及 Claude/Codex 的 MCP elicitation、权限请求、斜杠命令、hooks、子代理活动和增量工具输出投影。
- `node experiments/codex-native-probe.mjs`：真实 Codex CLI 的多轮、历史读取、指定边界分支及跨进程续聊通过。
- `node experiments/codex-capabilities-probe.mjs`：真实 Codex CLI 加载项目 skill 与 MCP；MCP 工具审批和表单问答经 DSH 往返；`/skills`、`/mcp` 不触发模型请求；Codex 哈希授信后的用户 hook 实际执行、反馈注入模型上下文并投影活动。模型端仅使用本地 fixture。
- `node experiments/claude-native-probe.mjs`：真实 Claude Code CLI 的多轮、历史读取、指定边界分支、跨进程续聊及运行中插入通过。原始回复先结束时，仍等待插入消息对应的后续回复完成。
- `node experiments/claude-capabilities-probe.mjs`：真实 Claude Code CLI 的项目 MCP 工具与表单提问、项目 hook 上下文与阻断反馈、原生 `/help` 斜杠命令通过；模型端仅使用本地 fixture。
- 以上四个 `codex-*-probe` / `claude-*-probe` 脚本驱动 ACP 重构前的直连适配器，已随提交 9eeb592 删除，可用 `git show e213d70:experiments/<脚本名>` 查看。ACP 下的多轮、历史、分支、跨进程续聊和运行中插入由 `npm run probe:acp`（`experiments/acp-native-probe.mjs`）覆盖；真实 CLI 的 MCP 审批与表单、hooks 检查目前没有对应脚本。
- `node experiments/secret-ui-probe.mjs`：实际密码组件的浏览器输入、提交及提交后清除通过。
- `DSH_PLUGIN_TAR=.cache/dsh-harness-provider-0.1.2.tgz node experiments/dsh-web-probe.mjs`：临时 DSH Profile 安装、两种 Harness 原输入框续聊及重启恢复通过；回滚后下一请求不再包含被撤销轮；分支保留 Harness 绑定；未知结果核对保持暂停，手动解除没有增加模型请求。
- 同一 Web 检查加 `DSH_DELEGATION_PROBE=1`：真实 Claude Code 工具创建的 Codex review 出现在侧栏，能查看回复；完成通知实际进入来源 Claude Code 的下一次模型请求，自动唤醒通过。

以上真实 CLI 与浏览器检查使用本地模拟模型服务，没有调用真实云模型。未执行真实云模型、真实写文件审批、Windows/Linux 和独立 Desktop 发行包验证；未安装到用户日常 Profile。

## 图片发送修复

修复 `cannot get property "attachments" without inject (gateway/internal)`：插件入口漏声明 `attachments` 和 `fileUploads`，导致真实 Cordis 插件作用域拒绝访问。直接在根 Context 上验证附件转换无法发现这一问题。

回归检查改为通过声明依赖的插件作用域发送图片，并验证文件上传票据隔离。`npm run check` 的类型检查、构建和 28 项测试通过（提交 fe3e1cb 时）。`DSH_IMAGE_PROBE=1 DSH_PLUGIN_TAR=.cache/dsh-harness-provider-0.1.2.tgz node experiments/dsh-web-probe.mjs` 使用真实输入框上传 PNG，并检查实际原生模型请求包含图片；模型服务仍使用本地模拟端点。

## 保留的边界

- 普通文件提供已校验的本地附件路径，由原生工具按权限读取；不内置通用文档解析器。远程图片 URL 保留引用，不自动下载。
- 更新前缺少轮次映射的历史可以整体分支，不能按旧消息猜测截断位置。
- 回滚保留旧界面记录并新增说明；只改变后续原生上下文。无法确认的原生执行结果保持暂停，等待手动解除。
- 插件保密答复通道不落盘；原生 Harness 自己的日志行为由其控制。

## 嵌套委派修复

修复委派子会话收到委派说明和凭据后，在完成通知触发的续轮中再次创建 review 会话的问题。宿主现在拒绝委派子会话再次委派，并且不再向它注入委派说明或环境凭据；来源主会话仍可在用户提出新任务时继续创建独立委派。回归测试先复现“子会话可再次委派”，修复后 `npm run check` 的类型检查、构建及 28 项测试通过（修复完成时；随提交 e213d70 入库，该提交包含后续新增测试，共 33 项）。

## Claude Code 原生配置范围

Claude Code 主会话的 SDK `settingSources` 使用 `user`、`project`、`local`，与直接运行 CLI 的默认文件设置范围一致。项目 `CLAUDE.md`、项目与本地 settings，以及由这些设置启用的 skills、MCP、plugins 和 hooks 均由原生 Claude Code 加载。MCP 表单 elicitation 通过 DSH 问题卡交互，原生斜杠命令及 hooks 的 informational 消息投影为可见回复。短时模型与额度检查仍使用无工具查询，避免检查动作执行项目任务。

## Codex 原生能力补齐

Codex app-server 初始化现在声明标准及扩展 MCP 表单能力。MCP 工具调用审批会按原生元数据提供一次、本会话和永久授权；普通表单、多选表单、URL 流程和额外权限请求通过 DSH 交互返回。命令与 MCP 进度、hooks、子代理委派及新出现的原生活动都有安全投影，未知展示型 item 不再导致会话故障。原生 `skills/list`、`hooks/list`、`mcpServerStatus/list`、上下文压缩和 review API 接到对应斜杠命令；未识别命令保留给 Codex 处理。

## ACP 重构（2026-09-16）

### 决定

- 两个 Harness 改为通过 Agent Client Protocol v1 连接官方适配器：`@agentclientprotocol/codex-acp` 1.12.0 与 `@agentclientprotocol/claude-agent-acp` 0.78.0，SDK 锁定 `@agentclientprotocol/sdk` 1.4.0（DSH 自带的 `dsh-acp` 也用这个版本）。两个适配器脚本随插件打包，运行用户安装的 `codex` / `claude`。
- 统一契约 `HarnessAdapter/HarnessSession` 不变；`src/acp-adapter.ts` 是唯一实现，`src/acp-profiles.ts` 提供两个配置档。删除 `codex-adapter`、`codex-items`、`claude-adapter`、`claude-native`、`claude-history*`。
- 只保留两处原生补充：账户额度窗口（Codex `account/rateLimits/read`；Claude Agent SDK 账户快照）和 Claude 可执行文件发现。
- 客户端不向 Agent 声明文件系统与终端能力，工具继续由各 CLI 在自己的沙箱和权限策略下执行。声明表单/URL 征询、计划、压缩、布尔配置项，以及 `steering`、`sessionFailure`、`recommendedValue` 扩展。
- 轮次键改为“提示文本哈希.出现序号”，由 ACP 回放重建；分支边界使用该轮最后一条 Agent 消息 ID（AIR fork 扩展），分支在独立短进程执行（Codex 会持有分支线程的写者）。
- 新会话用首行提示 `/rename` 原生会话，避免两个适配器各自多发一次标题生成的模型请求。
- Codex 技能菜单显示去掉 `$` 的名称，发送时改写为 `$技能名`（Codex 只对这种拼写注入技能正文）；Claude 保留 `/技能名`。
- 旧标识映射：Codex 权限 `readOnly/workspaceWrite/dangerFullAccess` → `read-only/agent/agent-full-access`；Claude 推理 `auto/off` → `default`；Claude 旧模型引用 `claude-model-v1.*` 解码为 ACP 配置值。

### 现有行为 → ACP 对应

| 现有行为 | ACP / 扩展 / 原生补充 |
| --- | --- |
| 建会话、续聊、重启恢复 | `session/new`、`session/load`（回放历史）、原生会话 ID 即 ACP session ID |
| 流式文本、推理摘要 | `agent_message_chunk`、`agent_thought_chunk` |
| 命令/工具/文件改动活动 | `tool_call` / `tool_call_update`（`execute` 类映射为命令卡，diff 内容映射为文件改动卡） |
| 审批（命令、文件、权限、MCP 工具） | `session/request_permission` + 权限展示扩展 `_meta.permission` |
| MCP 表单、URL 流程、Codex requestUserInput（含保密）、Claude AskUserQuestion | `elicitation/create`（form/url），保密字段来自 `_meta.codex.isSecret`，自定义答案字段来自 `_askUserQuestionCustomAnswer` |
| 模型 / 推理强度 / 权限切换 | `session/set_config_option`、`session/set_mode`、`config_option_update`、`current_mode_update` |
| 上下文占用、累计 token | `usage_update`、`PromptResponse.usage` 累加 |
| 账户额度 | 原生补充（见上） |
| 插入当前轮 | `_session/steering` |
| 取消 | `session/cancel` → `stopReason: cancelled` |
| 技能菜单、斜杠命令 | `available_commands_update`；本地命令由适配器执行 |
| 历史读取、恢复对账 | 回放重建的转录；有输出的轮次视为已执行 |
| 分支、回滚 | `session/fork` + AIR fork 消息边界 |
| 委派、保密问题、附件 | 宿主侧逻辑不变 |
| 新增：计划/待办、压缩卡、重连与会话失败说明、推荐默认值 | `plan`、`compaction_update`、`session_info_update._meta`、`recommendedValue` |

### 验证

- `npm run check`：类型检查、构建及 23 项测试通过（提交 9eeb592 时，ACP 重构删除了直连适配器的测试）；`tests/acp-adapter.test.mjs` 用官方 SDK 写的假 Agent 覆盖目录读取、轮次流、提示前缀与会话命名、插入、取消、审批、表单（保密与自定义答案）、URL 征询、工具/文件改动/计划/压缩投影、会话失败扩展、跨进程回放与分支、Agent 崩溃。
- `node experiments/acp-native-probe.mjs`：真实 Codex 0.154.0 与 Claude Code 2.1.273 经内置 ACP 适配器：目录与技能读取不发模型请求、两轮对话、历史快照、指定轮次分支、技能调用到达模型请求、跨进程恢复携带上下文、Claude 运行中插入；模型端为本地桩服务。
- `node experiments/delegation-native-probe.mjs`：两个真实 CLI 的 shell 工具继承会话凭据并调用委派 CLI 通过。
- `node experiments/dsh-web-probe.mjs`（默认模式）：临时 DSH Profile 安装、Codex 两轮、重启续聊、恢复入口、回滚后请求不含被撤销轮、分支保留绑定、Claude 两轮与重启续聊通过；`DSH_SKILLS_PROBE=1`、`DSH_IMAGE_PROBE=1`、`DSH_DELEGATION_PROBE=1` 三种模式也通过。
- 修复过程中发现并处理：Claude Code 的 Bash 工具调用先以空 `rawInput` 宣告、参数随后在更新中到达，适配器在拿到输入或终态前不建活动卡；命令卡的用途描述取 `rawInput.description`，输出取终态的 `rawOutput`。

## 历史验证记录（自 README 迁入，ACP 重构之前）

**2026-09-16（0.1.3，直连时期）**：新增按 Harness 读取的 `/` 技能菜单（切换清除缓存、失败不回退 DSH 技能）、`sessionSkillCatalog.list` 包装与卸载恢复、DSH 0.1.6 的 preset 失效通知、恢复入口改为独立的 **恢复会话** 面板，并在 `tests/` 中补充技能菜单与用量环两项测试（当时共 12 个测试文件、37 项测试；本仓库提交历史中没有对应版本，无法核对）。

**2026-09-16（直连时期）**：

- 新增附件、保密输入、原生插入/分支/上下文回滚、异常恢复、委派分页与自动唤醒、DSH 原生委派工具，并补齐 Codex 的 MCP 交互、原生目录型斜杠命令、hooks 与子代理活动投影。
- 会话委派改动：类型检查、构建及 15 项自动化测试通过；两个真实 CLI 均通过 shell 调用委派入口验证；临时 Web Profile 中，Claude Code 创建的 Codex review 实时出现在侧栏。
- 环境：DSH `0.1.6-alpha.1`（本地构建标识 `0.1.6-alpha.1-0d1f500`）；Codex CLI `0.144.6`；Claude Code CLI `2.1.272`。
- 两个真实 CLI 均通过多轮、原生身份保存和跨进程恢复验证；Web 安装后 Codex、Claude Code 均通过原输入框两轮对话及重启后续聊。
- 一次与原生 CLI 检查并行运行的 Web 复验中，Codex 模型目录查询进程退出；随后单独运行完整 Web 复验通过，该次退出原因未确认。

## 标题、委派说明与恢复开销修复（2026-09-16）

### 问题

- 宿主把委派说明作为独立文本块追加在用户输入后，而标题取所有文本块直接拼接后的首行，原生会话标题变成“用户原话[DSH 会话能力，由宿主提供]”。说明每轮都进入用户消息，Claude Code 的对话记录里每条都带着这段文字。
- 会话处于待恢复状态时，界面多处读取状态各触发一次原生核对，每次都启动 Agent 进程加载历史（Codex 另启动 app-server）。
- 模型目录探测不合并同时发起的请求，也不缓存失败结果；CLI 未安装或未登录时，每次读取都会启动探测进程。
- 新会话的 `/rename` 请求没有超时，原生端卡住时首轮无法开始。

### 决定

- 标题只取用户输入第一个文本块的首个非空行。
- 委派说明由宿主在打开会话时通过 `OpenSessionInput.instructions` 交给适配器：配置档定义了 `sessionMeta` 的（Claude Code）放进系统提示；没有的（Codex）追加在每轮提示末尾。说明以空行开头，Codex 进展反馈前缀以空行结尾。委派子会话仍不附加。依据：`codex-acp` 与 `claude-agent-acp` 逐段原样保存并回放用户文本块，加入空行不改变已有轮次键；`claude-agent-acp` 的 `newSession` 与 `loadSession` 都经 `getOrCreateSession` 读取 `_meta.systemPrompt`。
- 自动恢复核对按会话共用进行中的一次，结束后 30 秒内不重复，失败时保持暂停；用户手动核对或解除暂停不受限制。
- 模型目录按 Harness 与工作目录共用进行中的探测，成功结果缓存 60 秒、失败 10 秒，探测抛异常时删除缓存。
- `/rename` 请求 30 秒超时，超时后通过 ACP 取消信号结束请求，本轮继续。
- 新增 `AGENTS.md` 项目规则（`CLAUDE.md` 引用同一份），并同步 README。

### 验证

- `npm run check`：类型检查、构建及 30 项测试通过（未提交的工作区，基于 5a842ea）。新增或调整的测试覆盖：标题不含宿主追加的文本块；委派说明作为打开参数传给适配器、不混入用户输入；有系统提示通道时说明进入 `_meta.systemPrompt.append` 且不出现在提示中；无通道时说明追加在每轮提示末尾，关闭后在新进程恢复，轮次键与实时记录一致，恢复后的新一轮也一致；并发状态读取只触发一次自动核对，手动核对仍执行；探测失败时并发与随后的读取只启动一次探测。
- 通过临时改坏实现确认回归辨识力：把委派说明挪到记录轮次文本之后，Codex 冷恢复轮次键测试失败；源码还原后完整检查通过。
- Codex 委派会话只读审查未发现高或中严重度的功能缺陷，指出的测试缺口中“Codex 冷恢复轮次键”已补测试。

未执行：真实 Codex / Claude Code CLI 与 DSH Web 探针（`npm run probe:acp`、`npm run probe:web`），未确认 Claude Code 模型实际收到的系统提示内容；未安装到用户 Profile。

### 保留的问题

- `/rename` 超时、缓存 60 / 10 / 30 秒到期后重新执行、探测抛异常删除缓存均无自动化测试。
- 目录与核对缓存不主动清理过期条目；影响有限，未处理。
- 插件启动时同步读取登录 shell 环境（最多 3 秒），Codex 未做同样的环境补全；打开会话时最多等待 3 秒的命令列表；`updateQueue` 透传包装、`refreshUsage` 调用等死代码；构建不清理 `dist/` 旧产物。

## 编辑用户消息（2026-09-18）

- 决定：只支持 Codex / Claude Code 会话，在原会话中继续；在气泡内直接编辑，只能改文字，原附件随编辑后的消息一起发送。
- 当前会话是 Harness 时，插件以更高优先级接管 `conversation.chat.node` 的 `user` 渲染器，包装宿主原气泡并在操作行末尾加铅笔按钮；DSH 原生会话继续使用宿主渲染器。原生轮次边界已知（`binding.turns` 中存在该轮）、没有进行中的请求、也没有未确认结果时才显示铅笔。
- 发送后通过 `harness/edit` 把原生上下文分支到该轮之前（与回滚共用 `rewind`），追加“消息已编辑”说明，再按原顺序重新排队该轮开头的消息。宿主日志只能追加，旧记录保留在上方；工作区文件不还原。同一 `requestId` 重试不会重复执行。
- 验证：`npm run check` 通过 41 项测试；新测试在回退边界被改坏时失败。`DSH_PLUGIN_TAR=.cache/dsh-harness-provider-0.1.5.tgz node experiments/dsh-web-probe.mjs` 在真实浏览器中完成悬停、编辑、Enter 发送，并确认下一次 Codex 请求只包含编辑点之前的上下文和编辑后的文字，已回滚轮次不显示铅笔。模型端只使用本地 fixture。
