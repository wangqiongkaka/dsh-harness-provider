# DSH Harness 插件

**版本 0.1.4** · 把 **Codex** 和 **Claude Code** 接进 DSH 的独立插件，不修改 DSH 源码。

在 DSH 原输入栏选择 Harness 后，对话、工具活动、提问、历史、分支和恢复都留在 DSH 原会话列表里。两个 Harness 都经 [Agent Client Protocol](https://agentclientprotocol.com)（ACP v1）连接随插件打包的官方适配器：`codex-acp` 驱动本机 `codex`，`claude-agent-acp` 驱动本机 `claude`。认证、模型推理、工具、沙箱、hooks 与权限策略都由各 CLI 自己负责。

开发预览版，需要 Node ≥ 22，仅在 macOS 上验证。

![Codex 原生聊天页](docs/codex-web.png)

## 安装

先安装 Codex CLI / Claude Code CLI 并完成各自的登录或环境配置，再把打包好的插件加入 DSH Profile：

```sh
dsh plugin --profile web add /absolute/path/dsh-harness-provider-0.1.4.tgz
dsh --profile web
```

DSH 首次引导可选“稍后配置”：当前会话使用外部 Harness 时，插件会跳过 DeepSeek 凭据引导，外部 Harness 不需要 DeepSeek API Key。

## 使用

### 选择 Harness

在空会话的输入栏选择 **DSH 原生**、**Codex** 或 **Claude Code**。第一条消息发出后 Harness 固定，要换就新建会话；不同会话可以各用各的。新会话自动沿用上次选择的 Harness。

选中外部 Harness 后，输入栏的模型、权限控件换成该 Harness 自己的控件，计划控件隐藏，DSH 原生模型选择器对该会话不可用。

### 模型、强度与权限

- **模型与强度**：列表来自 Harness 公布的配置项，默认取 Harness 推荐值。Codex 的强度按模型给出；Claude Code 的强度按模型支持的档位给出（推荐 `medium`）。某个 Harness 上手动选过的模型和强度会记住，下次新会话在目录仍提供时沿用。运行中不能切换。
- **权限模式**：
  - Codex：逐项审批（`read-only`）/ 自动审批（`agent`）/ 完全权限（`agent-full-access`）。默认 `agent`，可由环境变量 `INITIAL_AGENT_MODE` 改变。
  - Claude Code：默认 / 接受编辑 / 计划 / 自动，非 root 运行（或设置 `IS_SANDBOX`）时另有完全权限（`bypassPermissions`）。默认取自 Claude 设置的 `permissions.defaultMode`。
  - 新会话首次绑定时按 DSH 原生沙箱模式映射：只读 / 工作区可写 / 完全权限 → Codex 的逐项审批 / 自动审批 / 完全权限；完全权限 → Claude Code 的完全权限；其余沿用 Harness 默认。
- 升级前保存的 Codex 权限标识（`readOnly` / `workspaceWrite` / `dangerFullAccess`）在打开原生会话时映射到新标识；旧的 Claude Code 强度 `auto` / `off` 已不在目录中，改用 Claude Code 的默认强度。

### 对话

- 用 DSH 原输入框发送，原停止按钮取消（ACP `session/cancel`）。
- 运行中追加的消息通过 `_session/steering` 插入当前原生轮；Agent 未确认插入时，本轮取消并暂停会话，等待恢复。
- 图片经 DSH 校验后发给 Harness；普通文件以经校验的本地路径提供，由原生工具按其权限读取，插件不解析文档。工具返回的图片（内嵌或本地绝对路径的 png/jpeg/webp/gif）导入 DSH 附件存储。

### 活动在界面上的样子

Harness 的活动尽量落到 DSH 原生的行类型上，和 DSH 自己的会话一致：

| 活动 | 来源 | DSH 显示 |
| --- | --- | --- |
| 回复、思考 | `agent_message_chunk`、`agent_thought_chunk` | 回复流、「思考」行 |
| 命令 | `kind: execute` 且带命令 | Bash · 用途说明（Claude Code 的 `description`）或命令 |
| 读文件 | Claude `Read`；Codex `Read file '…'` | Read · 路径 |
| 搜索 | Claude `Grep` / `Glob`；Codex `Search for '…'` | Grep / Glob · 关键词 |
| 改文件 | Claude `Edit` / `Write`；其他 Agent 上报的 diff 每个一行 | Edit / Write · 路径，带 diff 卡片 |
| 网页 | Claude `WebFetch` / `WebSearch`；Codex web search | Web 行 |
| 计划 | ACP `plan` / `plan_update`（条目列表） | 待办行（已完成 x/y · 当前项） |
| 提问 | MCP 表单、Codex `requestUserInput`、Claude `AskUserQuestion` | DSH 问题卡；回答后留下「提问 · n/n 已回答」行，取消或中断也会记录 |
| 审批 | `session/request_permission`、URL 流程 | DSH 审批卡，不留记录行（与 DSH 原生一致） |
| 上下文压缩、失败说明 | `compaction_update`、`session_info_update` | 通知 / 说明消息 |

未识别的工具显示为通用工具行（「工具调用 · 名称 · 参数」）。读文件、搜索、网页行展开后显示纯文本输出，没有 DSH 原生的结构化卡片；工具输出超过 64,000 字符会截断。

保密问题（`writeOnly`、`format: password` 或 Codex `isSecret` 字段）改用插件自己的密码表单，答复只在内存中转交 Harness，不写入日志、状态文件或浏览器存储，也不留提问记录行。

### 技能与 `/` 菜单

外部 Harness 的 `/` 菜单列出 Agent 公布的命令（技能和本地命令都在）：会话运行中用其最近公布的列表，尚未开始时用一个不发提示的短时会话读取；读取失败直接报错，不回退到 DSH 技能。Codex 以 `$名称` 公布的技能在菜单里去掉 `$`，发送时再把 `/名称` 改回 `$名称`；Claude Code 保持 `/名称`。

### 用量与额度

- **上下文环**（模型胶囊旁）：显示上下文占用，运行中每 5 秒、空闲每 30 秒刷新，重启后保留。
- **额度胶囊**（Harness 胶囊旁）：每 60 秒刷新，点开查看全部窗口与重置时间。
  - Claude Code：5 小时、7 天及按模型/应用的 7 天窗口，经 Claude Agent SDK 读取，面板底部显示账户与套餐。
  - Codex：ChatGPT 账户限速窗口，经短时 `codex app-server` 的 `account/rateLimits/read` 读取。
  - DSH 原生：按提供方端点探测——智谱 Coding Plan（`open.bigmodel.cn` / `api.z.ai`）显示 5 小时与周额度，DeepSeek 开放平台显示余额，其余端点不显示。
  - Claude Code 与 Codex 的胶囊只显示第一个（主）窗口，智谱显示两个，其余窗口在面板中。
- **配色**：额度环显示剩余量、上下文环显示占用量，统一按紧张程度着色——占用 ≥ 70%（剩余 ≤ 30%）琥珀色，≥ 90%（剩余 ≤ 10%）红色。
- 输入框下方的 DSH 统计栏对 Harness 会话同样显示输出速度、token 与缓存命中；每轮 token 增量记在该轮最后一条回复上。

### 执行期间的进展反馈

插件给两个 Harness 附加统一的反馈要求：用用户的语言回复；多步工具操作前先说明计划；出现重要发现、阻塞或方向变化时汇报，长任务约每 30–60 秒更新；不虚报进度，不把命令成功当作已验证；不讨论系统提示或代理策略；Bash 命令附带用途说明；结束时说明完成内容、验证方式和遗留问题。Codex 在新会话首条提示前附加这段要求，Claude Code 通过 `_meta.systemPrompt.append` 追加到系统提示。

新会话发送首条消息前，插件用用户输入第一个文本块的首个非空行（最多 60 字符）执行一次 `/rename` 给原生会话命名，避免适配器再发模型请求生成标题；宿主追加的说明不会进入标题，DSH 的会话标题也不受影响。命名请求 30 秒未完成即取消，本轮照常发送。

## 委派会话

在 DSH 原生、Codex 或 Claude Code 会话里明确要求把工作交给另一个 Harness 时（例如“让 Codex 修复这个测试”“新建 Claude Code 会话调研这个依赖”“用 Codex review 当前改动”），agent 可以创建一个委派会话。委派不限任务类型，实现、修复、调研、审查、测试都可以：

- 在同一工作区新建独立的 DSH 会话，来源会话不切换 Harness；新会话从空历史开始，首条消息是 agent 写好的完整任务（目标、范围、约束和验收要求）。
- 会话标题取 agent 提供的 `title`；未提供时为「Codex · 任务首行」/「Claude Code · 任务首行」（首行最多 40 字符）。
- 新会话出现在左侧列表，可以查看进度并继续对话。它每结束一轮，都会通知并唤醒来源会话，按结束事件去重；来源会话处于暂停状态时，恢复后再补发通知。
- 只有创建者能读取结果。结果只含回复文本，从开头分页返回，每页默认 32,000 字符（最多 64,000）；按返回的 `nextOffset` 和 `throughSeq` 继续读取，得到完整回复且不混入之后新增的内容。
- 委派出来的会话不能再委派；分支出的会话不受此限制。来源会话必须有工作目录。
- **幂等**：同一来源、同一 `requestId` 和相同参数的重试复用原会话；`requestId` 相同但任务不同会被拒绝；提交结果不明确时拒绝自动重发。错误信息包含目标会话 ID。
- **权限**：同 Harness 沿用来源会话的权限；跨 Harness 时完全权限对应目标的完全权限，其余对应 Codex 自动审批（`agent`）/ Claude Code 接受编辑（`acceptEdits`），让子会话无需逐项批准即可改文件；来源是 DSH 原生会话时按上文的沙箱映射。模型和强度沿用目标 Harness 上次的选择。

入口：

- **DSH 原生模型**：工具 `harness_delegate`（`requestId`、`harness`、`prompt`，可选 `title`）与 `harness_delegate_read`（`sessionId`、`offset`、`throughSeq`）。
- **Codex / Claude Code**：插件在打开原生会话时附加能力说明，其中给出 `dist/delegate-cli.mjs` 的完整命令。Claude Code 通过 `_meta.systemPrompt.append` 放进系统提示，不出现在用户消息里，上下文压缩后仍有效；Codex 没有系统提示通道，说明追加在每轮提示末尾，并用空行与用户原话隔开。委派出来的会话不附加说明。CLI 支持 `create '<JSON>'`（字段同上）与 `read '<sessionId>'` / `read '{"sessionId":"…","offset":32000,"throughSeq":N}'`。CLI 通过注入的 `DSH_DELEGATE_ENDPOINT` / `DSH_DELEGATE_TOKEN` 访问仅监听 `127.0.0.1` 的本地服务；令牌按来源会话生成，只在 DSH 进程存活期间有效，更新插件后需重启 DSH。CLI 的沙箱、网络与命令审批照常生效，不依赖 `codexhost delegate`。

## 分支、回滚与恢复

- **轮次键**：每个已完成轮次以“提示文本哈希.出现序号”为键记在状态文件中；打开原生会话时从 `session/load` 的回放重建，跨进程一致。
- **分支**：使用 DSH 原生分支入口。插件在独立短时进程中执行 `session/fork`，指定消息位置时以所在已完成轮次的最后一条 Agent 消息为边界；不指定时分支整个历史。轮次运行中、排队中或结果不明确时不能分支。
- **回滚**：Remote 方法 `harness/rollback` 撤销最后一轮的原生上下文（分支到上一轮边界，只有一轮时下次从新原生会话开始），保留工作区文件、旧的原生会话和界面记录。界面没有入口。
- **恢复**：每轮提交前先写入“未确认”标记。进程退出或协议错误等结果不明确时会话暂停；打开会话时自动回放原生历史核对，从未确认轮起每轮都有确定结果才解除暂停，并把核对到的回复贴进会话。每轮结果这样判断：
  - **Codex**：核对时另启动一个短时 `codex app-server`，用 `thread/turns/list` 读取每轮的原生状态（已完成 / 已中断 / 失败 / 执行中），不靠推断；执行中的轮次保持未知，读取失败时改用与 Claude Code 相同的推断规则。
  - **Claude Code**：按回放内容推断。回放保留工具的完成或失败状态与输出，恢复出的额度耗尽通知判为失败；只有所有工具都已结束、并以 Agent 的回复收尾的轮次才算成功。有未完成的工具、停在工具调用或没有任何输出的轮次保持未知。

  无法确认时，核对结果会写明原因，Harness 胶囊旁出现 **恢复会话**，可选 **核对原生记录** 或 **解除暂停，不重发**；插件绝不自动重发原请求。

  打开会话时界面多处同时读取状态，自动核对共用同一次，结束后 30 秒内不重复；手动 **核对原生记录** 或 **解除暂停** 总会立即执行。

## 配置

默认配置即可使用。插件配置项（严格校验）：

| 配置项 | 默认值 | 含义 |
| --- | --- | --- |
| `codexCommand` | `codex` | Codex 可执行文件，同时用于额度探测 |
| `root` | `$DSH_HOME/harness-plugin`（未设置 `DSH_HOME` 时为 `~/.dsh/harness-plugin`） | 插件状态目录 |

在 Profile 的 `cordis.patch.yml` 中设置：

```yaml
- id: harness-plugin
  config:
    codexCommand: /absolute/path/codex
    root: /absolute/path/harness-state
```

环境变量：

- `CODEXHOST_CLAUDE_COMMAND`：Claude Code 可执行文件（沿用早期变量名；设置后不再回退查找）。未设置时依次查 PATH 中的 `claude`、`~/.npm-global/bin`、`~/.local/bin`、`~/.claude/local`、nvm/fnm/volta/asdf 等版本管理器目录和 Homebrew 目录。从图形界面启动 DSH 时，插件会读取登录 shell 的环境。
- `DSH_HARNESS_ACP_STDERR=1`：把 ACP Agent 进程的 stderr 原样输出到 DSH，用于排查启动问题；默认丢弃，因为其中可能含提示词或凭据。

**状态目录**只保存每个会话一个侧车文件（文件名为会话 ID 的 SHA-256，权限 0600）和 `defaults.json`（上次选择的 Harness、模型与强度）。侧车文件记录 Harness、工作目录、原生会话引用、模型/强度/权限、累计用量、轮次键、未确认标记和委派来源，不保存密钥或对话全文。原生会话引用校验 `harnessId`，不能交给另一个 Harness 续聊。

## 实现结构

```
DSH Host
  └─ HarnessService            src/dsh.ts          Remote 接口、Harness 选择、目录、委派、分支/回滚/恢复、技能目录
       ├─ DshRunner            src/dsh-runner.ts   通过 agent/pre-step 运行轮次：取消、插入、交互、状态持久化
       ├─ DshOutput            src/dsh-output.ts   Harness 事件 → DSH 消息、工具行、提问行、通知与流式帧
       ├─ Bindings             src/bindings.ts     会话侧车文件（原子替换）
       ├─ DelegationBridge     src/delegation.ts   本地委派服务；src/delegate-cli.mjs 为 Harness 侧 CLI
       └─ AcpAdapter × 2       src/acp-adapter.ts  ACP 客户端：进程、会话、轮次、交互、回放、分支、工具行映射
            ├─ codexProfile    src/acp-profiles.ts → dist/codex-acp.mjs        → 本机 codex
            └─ claudeProfile   src/acp-profiles.ts → dist/claude-agent-acp.mjs → 本机 claude
```

- 两个 Harness 是同一个 `AcpAdapter` 的两个配置档，差异集中在 `src/acp-profiles.ts`：可执行文件、系统提示注入、技能名拼写、旧标识映射和额度探针。
- 每个运行中的 DSH 会话拥有一个 ACP Agent 进程（由 DSH 的 Node 运行内置脚本，Agent 再启动用户的 CLI）。读取模型目录和技能用不发提示的短时进程；分支用独立短时进程。模型目录按 Harness 与工作目录缓存：成功结果保留 60 秒，失败（未安装、未登录等）保留 10 秒，同时发起的读取共用一个探测进程。
- 插件向 Agent 声明的客户端能力只有会话压缩、配置项、表单/URL 交互、计划、插入和 AIR 扩展（`sessionFailure`、`recommendedValue`；分支另经 `_meta.jetbrains.air.fork` 指定边界），不声明文件系统或终端能力，也不传入 MCP 服务器；工具由各 CLI 在自己的沙箱与权限策略下执行。
- ACP 不传输账户额度和轮次结束状态，因此保留原生补充：`src/codex-rpc.ts`（Codex app-server：额度与轮次状态）与 `src/claude-sdk.ts`（Claude Agent SDK 额度与可执行文件发现）。
- 其余文件：`src/contracts.ts`（Host ⇄ Harness 契约）、`src/remote.ts`（Remote 方法与 schema）、`src/client.tsx`（界面插槽，中英文文案）、`src/native-quota.ts`（DSH 原生额度探测）、`src/media.ts`（附件）、`src/secret-questions.ts`（保密问题）、`src/feedback.ts`（进展反馈要求）。

| 维度 | Codex | Claude Code |
| --- | --- | --- |
| ACP Agent | `codex-acp` 1.12.0，`CODEX_PATH` 指向 `codexCommand` | `claude-agent-acp` 0.78.0，`CLAUDE_CODE_EXECUTABLE` 指向发现的 `claude` |
| 原生会话 ID | ACP session ID = Codex thread ID | ACP session ID = Claude Code session ID |
| 模型与强度 | 配置项 `model`、`reasoning_effort` | 配置项 `model`、`effort` |
| 进展反馈 | 新会话首条提示前缀 | `_meta.systemPrompt.append` |
| 委派说明 | 每轮提示末尾 | `_meta.systemPrompt.append` |
| 技能调用 | `/名称` 改写为 `$名称` | 保持 `/名称` |
| 账户额度 | `codex app-server` `account/rateLimits/read` | Claude Agent SDK 用量快照 |

## 当前边界

- 0.1.3 之前保存的 Codex 轮次 ID / Claude 消息 UUID 与新轮次键不匹配：这类会话回滚最后一轮会失败，分支只能选最新轮或整个历史。
- ACP 回放不含每轮的结束状态。Codex 的轮次状态从原生记录读取，是准确的；Claude Code 只能按回放内容推断，模型回复一段话后被中断的轮次仍会判为成功。
- DSH 消息来源的 Provider 使用实际 Harness 标识（`codex` / `claude-code`）；ACP 不报告更下游的模型供应商时不再记为 `unreported`。
- ACP 的额外会话配置已接入模型菜单，包括 Codex 快速模式与默认/计划协作模式。目标可通过 Harness 的 `/goal` 命令使用；原生子代理、后台终端任务和原生会话列表/删除仍缺少与 DSH 对应子系统的身份与生命周期桥接。
- 普通文件附件需要本地文件存储后端。
- 外部会话续聊需要保持插件启用；卸载插件会恢复其包装的公开方法与覆盖的界面插槽。公开方法包装和客户端插槽需要随 DSH 更新重新验证。Windows、Linux 与独立 Desktop 发行包未验证。
- 项目级 hooks 与直接运行 CLI 一样会执行本地命令，只应在可信工作区使用。

## 开发

需要已构建的参考仓库 `deepseek-harness`（默认 `../../deepseek-harness`，或用 `DSH_REFERENCE_ROOT` 指定）。`dev:link` 把其中的 `@deepseek-ai/*` 包链接进 `node_modules`，每次 `npm install` 后都要重新执行：

```sh
npm install
npm run dev:link
npm run check          # 类型检查、构建、node --test
```

修改前先阅读 [AGENTS.md](AGENTS.md) 中的项目规则（Claude Code 经 `CLAUDE.md` 引用同一份）：交付前运行 `npm run check`，新测试须在改动前的代码上失败，宿主给模型的文字不得混进用户输入，判断 ACP 适配器行为前先读 `node_modules` 中的实现。

构建（`scripts/build.mjs`）把 ACP SDK、`codex-acp` 与 `claude-agent-acp` 打进 `dist/` 并复制许可证到 `dist/licenses`；`@openai/codex` 与 Claude Agent SDK 的平台二进制包不打包，运行时使用用户安装的 CLI。开发、构建和发布均不依赖 codex-host。

探针：

| 命令 | 内容 |
| --- | --- |
| `npm run probe:acp` | 内置适配器 + 本机真实 CLI + 本地模型桩（不调用真实模型端点）：目录、对话、历史、分支、技能、恢复、插入。可用 `CODEX_COMMAND`、`CLAUDE_COMMAND` 指定 CLI |
| `node experiments/delegation-native-probe.mjs` | 真实 CLI 通过委派 CLI 创建会话 |
| `npm pack && npm run probe:web` | 装入临时 `DSH_HOME` 的 DSH Web + Playwright：选择、对话、重启续聊、恢复、回滚、分支。开关：`DSH_SKILLS_PROBE=1`、`DSH_IMAGE_PROBE=1`、`DSH_DELEGATION_PROBE=1`；`DSH_PLUGIN_TAR` 指定包，`KEEP_DSH_PROBE` 保留临时目录 |
| `npm run probe -- <DSH 构建目录>` | 在指定 DSH 检出上验证进程内扩展点 |
| `node scripts/install-test-profile.mjs` | 打包并以 `--offline` 安装到隔离的 `.cache/dsh-install` Profile |

实现决定与历次验证记录见 [实现与验证记录](docs/implementation-status.md)。
