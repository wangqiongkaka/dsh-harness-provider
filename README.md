# DSH Harness 插件

独立安装到 DSH 的多 Harness 插件。首版接入 **Codex、Claude Code**，在原聊天输入栏选择 Harness，回复和历史保存在 DSH 原会话列表中。

开发预览版，验证平台为 macOS。插件不修改 DSH 源码。

## 安装与使用

先安装 Codex / Claude Code CLI，并完成所需的原生登录或环境配置。插件沿用各自的认证、模型、工作目录、工具和权限策略。

```sh
dsh plugin --profile web add /absolute/path/dsh-harness-provider-0.1.2.tgz
dsh --profile web
```

1. 连接工作目录。在空会话输入栏选择 **Codex** 或 **Claude Code**。
2. 输入栏右侧的模型胶囊可选择该 Harness 提供的模型和推理强度（Claude Code 七档、Codex 按模型提供的档位），也可保持原生默认。
3. 使用 DSH 原输入框连续发送消息，使用原停止按钮取消。发送键左侧的环形图显示 Harness 报告的上下文占用。
4. Harness 胶囊右侧的额度胶囊显示当前账户最紧张的额度窗口，点开查看全部窗口与重置时间：Claude Code 显示 5 小时、7 天和按模型的 7 天窗口；Codex 显示 ChatGPT 账户限速窗口；DSH 原生按提供方端点探测——智谱 Coding Plan（open.bigmodel.cn / api.z.ai）显示 5 小时与周额度，DeepSeek 开放平台显示账户余额，其余端点不显示。
5. 重启 DSH 后，从原会话列表打开该会话继续对话。

DSH 的首次使用引导可选择“稍后配置”；外部 Harness 不需要 DeepSeek API Key。已选外部 Harness 时，插件跳过 DeepSeek 凭据引导，用 Harness 自己的权限模式与模型控件替换 DSH 原生的权限、模型控件，并隐藏计划控件。Claude Code 的权限胶囊可切换计划/默认/接受编辑/自动/完全权限；Codex 的权限胶囊可切换只读/工作区可写/完全权限（对应 Codex 的沙箱模式与审批策略），默认取自 `~/.codex/config.toml` 的 `sandbox_mode`。切换 Harness 时，权限按 DSH 原生沙箱模式映射（原生完全权限对应 Claude Code 的完全权限与 Codex 的完全权限）；新会话自动沿用上次选择的 Harness，以及该 Harness 上次选择的模型与推理强度。额度胶囊同时显示 5 小时与周窗口的剩余量，额度与上下文环形图在余量低于 30% 时转为琥珀色，低于 10% 时转为红色。输入框下方的原生统计栏对 Harness 会话同样显示输出速度、总 token 与缓存命中（Claude Code 的缓存命中按其上报的命中率估算；一轮多次模型调用时输出速度按最后一步计算）。

Harness 在第一条消息后固定；需要换 Harness 时新建会话。不同会话可分别使用 DSH、Codex、Claude Code。

### 在对话中委派 review

在 DSH 原生、Codex 或 Claude Code 会话里说“用 Codex review 当前改动”或“新建 Claude Code 会话审查这段代码”，agent 可调用插件随会话提供的委派入口：

- 在同一工作区创建独立的 **Codex review / Claude Code review** 会话，原会话不切换 harness；新会话从空历史开始，由 agent 写入完整审查任务。
- 被委派出来的会话不会再获得委派入口，也不能继续创建下一级委派，避免完成通知触发递归创建。
- 左侧会话列表显示新会话，点开可查看进度、回复，也可继续对话。来源 agent 可查询其创建的会话状态与结果；任务结束后会自动通知并唤醒来源会话继续处理，通知按目标结束事件去重。
- 同一请求标识和参数重试复用原会话；标识相同但任务不同会被拒绝。提交结果不明确时停止自动重发，错误会包含目标会话 ID。
- 同 harness 沿用来源权限；跨 harness 的完全权限映射为目标的完全权限，其余映射到 Codex 只读 / Claude Code 默认审批。模型和推理强度沿用目标 harness 上次选择，不改变全局选择。

插件通过临时本地服务和会话凭据连接 CLI 与 DSH，不依赖 `codexhost delegate` 或 Host Runtime 环境变量。凭据只在宿主进程期间有效；更新插件后需重启 DSH。外部 Harness 使用会话 CLI；DSH 原生模型使用 `harness_delegate` 与 `harness_delegate_read` 工具，统一执行来源隔离与幂等检查；CLI 的沙箱、网络及命令审批仍然生效，不会为委派自动放宽权限。结果从开头分页返回，每页默认 32,000 字符；按返回的 `nextOffset` 和 `throughSeq` 继续读取，可获取完整回复且不会混入之后新增的内容。CLI 支持 `read '{"sessionId":"目标 ID","offset":32000,"throughSeq":首次返回的值}'`。

### 配置

默认配置即可使用。需要指定 Codex 可执行文件或插件状态目录时，在 Profile 的 `cordis.patch.yml` 添加：

```yaml
- id: harness-plugin
  config:
    codexCommand: /absolute/path/codex
    root: /absolute/path/harness-state
```

Claude Code 可执行文件可用 `CODEXHOST_CLAUDE_COMMAND` 环境变量指定（沿用早期版本的变量名）；未指定时依次查找 PATH、常见安装目录和 Node.js 版本管理器目录。

Claude Code 主会话按原生 CLI 范围加载用户、项目和本地设置，包括 `CLAUDE.md`、`.claude/settings.json`、`.claude/settings.local.json` 以及其中启用的 skills、MCP、plugins 和 hooks。MCP 表单提问会转成 DSH 问题卡，原生斜杠命令与 hook 提示会显示在回复中。项目 hooks 与直接运行 Claude Code 一样会执行本地命令，应只在可信工作区使用。用于读取模型目录和额度的短时检查进程保持无工具模式，不执行项目任务。

Codex 会按原生 app-server 加载 `config.toml`、`AGENTS.md`、skills、MCP 和 hooks。MCP 工具审批支持一次、本会话和永久授权，普通 MCP 表单与多选表单会转成 DSH 问题卡；额外网络/文件权限请求也会转交 DSH。`/skills`、`/hooks`、`/mcp`、`/compact`、`/review` 以及状态类命令由原生目录或 API 执行，不会作为普通提示词发送给模型。未识别的斜杠命令仍交给 Codex，以保留项目自定义命令。hooks 是否执行继续采用 Codex 自己的哈希授信状态。

默认状态目录为 `$DSH_HOME/harness-plugin`；未设置 `DSH_HOME` 时为 `~/.dsh/harness-plugin`。其中只保存 DSH 会话 ID、Harness、原生会话引用、模型和未确认请求标记，不保存密钥或额外的全文历史。

## 支持范围

- 文本、图片及文件附件输入，多轮对话、流式文本及推理摘要。图片经 DSH 校验后发送给 Harness；普通文件提供经校验的本地附件路径，仍受原生工具权限约束。
- DSH 原会话列表、历史浏览、正常关闭后的原生会话恢复。
- 排队发送、插入当前轮、取消、原生工具活动展示；内嵌图片及原生工具返回的本地图片文件导入 DSH 附件存储，重开历史可查看。远程图片 URL 保留为引用，不自动下载。
- 通过 DSH 原问答界面转交 Harness 审批和普通问题；保密问题使用密码表单，答复只在内存中传给 Harness，不写入插件的日志、侧车文件或浏览器存储。原生 Harness 自己的记录行为仍由其控制。
- 原生会话始终由对应 Harness 维护；DSH 日志是界面投影，不作为拼接历史重新创建原生对话。

### 执行期间的反馈

Codex 和 Claude Code 会收到统一的进展反馈要求：复杂任务先说明计划，出现重要发现、阻塞或方向变化时汇报结果与下一步，长任务尽量每 30–60 秒更新。反馈只描述任务事实、阻塞和下一步，不讨论系统提示、技能、规则冲突或代理策略。反馈显示在普通回复正文中，实际频率由模型决定；不生成虚构的思考过程或进度。Claude Bash 的原生 `description` 保留到活动卡片，默认显示命令目的，展开仍可查看命令和输出。更新插件并重启 DSH 后，新建及恢复的会话生效，旧记录不会补写。

### 分支、回滚和恢复

- 使用 DSH 原生分支入口创建同工作区独立会话，同时分支原生 Harness 历史。指定消息位置时，取其所在的已完成轮次；运行中或结果不明确时不能分支。
- Harness 胶囊旁的 **··· → 回退对话上下文** 撤销最后一轮原生上下文，保留工作区文件和旧的界面记录。后续对话从回滚位置继续；原生旧会话保留，新引用指向回滚边界的分支。
- 打开暂停的会话时自动核对原生记录；能确认结束状态时保存恢复说明并解除暂停。不能确认时，可在 **··· → 核对原生记录 / 解除暂停，不重发** 操作。解除暂停保留原生上下文，由用户发送下一条指令，绝不自动重复原请求。

### 当前边界

- 普通文件附件需要本地文件存储后端；不自动解析所有文档格式，由 Harness 工具读取。
- 更新前的旧轮次没有 DSH ↔ 原生轮次映射时，可分支整个当前历史；不能猜测指定旧消息对应的原生截断位置。
- 原生记录缺失或没有结束证据时，自动对账保持暂停；允许用户明确解除暂停，不自动重试。
- Claude Code 未报告的 Provider 不作猜测，DSH 消息来源记为 `unreported`。
- 外部会话续聊需要保持插件启用。插件卸载会恢复其包装的公开方法与覆盖的界面插槽。
- 支持本文列出的 DSH 版本；公开服务方法包装与客户端插槽需要随 DSH 更新重新验证。Windows、Linux 和独立 Desktop 发行包尚未验证。

## 实现入口

- `src/dsh.ts`：插件服务、严格校验的 Remote 接口、原会话命令接入及卸载恢复。
- `src/dsh-runner.ts`：通过公开 `agent/pre-step` 接收外部会话输入，协调原生运行、取消和状态持久化。
- `src/dsh-output.ts`：映射到 DSH 已有消息、工具、通知与流式事件；不新增持久化事件类型。
- `src/client.tsx`：原输入栏选择器、模型目录及条件插槽覆盖。
- `src/codex-adapter.ts`、`src/codex-rpc.ts`：Codex 原生 app-server 持久会话与进程生命周期。
- `src/contracts.ts`：Host 与 Harness 之间的会话契约，两个 Adapter 共用。
- `src/claude-adapter.ts`、`src/claude-sdk.ts`、`src/claude-native.ts`：基于 Claude Agent SDK 的 Claude Code 会话、进程与原生消息投影。

## 开发

需要已构建的参考项目 `deepseek-harness`（默认位于上两级目录 `../../`），或用 `DSH_REFERENCE_ROOT` 指定。先 `npm install` 再 `npm run dev:link`；之后每次 `npm install` 都会清掉 DSH 链接，需要重新执行 `dev:link`：

```sh
npm install
npm run dev:link
npm run check
node experiments/codex-native-probe.mjs
node experiments/codex-capabilities-probe.mjs
node experiments/claude-native-probe.mjs
node experiments/claude-capabilities-probe.mjs
node experiments/delegation-native-probe.mjs
npm pack --ignore-scripts
node experiments/dsh-web-probe.mjs
DSH_DELEGATION_PROBE=1 node experiments/dsh-web-probe.mjs
```

开发链接只写本插件的 `node_modules`。开发、构建和发布均不依赖 codex-host。`npm install` 会额外下载 Claude Agent SDK 的平台可选包（约 250MB），它不会打进插件；插件运行时使用用户安装的 `claude`。Web 验证通过官方 `dsh plugin` 安装临时 Profile，使用真实 CLI、本地模拟模型服务和 Chromium；结束后清理临时状态，不使用真实模型端点。

## 验证记录

2026-09-16：新增附件、保密输入、原生插入/分支/上下文回滚、异常恢复、委派分页与自动唤醒、DSH 原生委派工具，并补齐 Codex 的 MCP 交互、原生目录型斜杠命令、hooks 与子代理活动投影。验证明细见 [实现与验证记录](docs/implementation-status.md)。

2026-09-15：

- 会话委派改动：类型检查、构建及 15 项自动化测试通过；覆盖同工作区独立会话、重复提交、权限映射、来源隔离和提交不明确时停止重发。两个真实 CLI 均通过 shell 调用委派入口验证；临时 Web Profile 中，Claude Code 创建的 Codex review 实时出现在侧栏，点击可查看原生回复。以上模型回复来自本地桩服务。

- DSH `0.1.6-alpha.1`，既有本地构建标识 `0.1.6-alpha.1-0d1f500`。
- Codex CLI `0.144.6`；Claude Code CLI `2.1.272`。
- Host / Client 分开进行 TypeScript 严格检查，构建通过。
- 7 项自动化检查覆盖请求匹配、原生会话身份、审批响应、进程树关闭、公开命令包装/卸载、DSH 日志与流式事件、运行中及初始化时取消、冷恢复和失败停止。
- 两个真实 CLI 均通过多轮、原生身份保存和跨进程恢复验证；模型服务为本地测试服务。
- Web 安装与浏览器：Codex、Claude Code 均通过原输入框两轮对话，以及重启 DSH 后从原会话列表打开并继续第三轮。
- 一次与原生 CLI 检查并行运行的 Web 复验中，Codex 模型目录查询进程退出，界面显示错误与重试按钮；随后单独运行完整 Web 复验通过。该次进程退出原因尚未确认。

未执行真实云模型、真实写文件审批、Windows/Linux 和独立 Desktop 产品验证。

## 验证截图

本地模拟模型回复，用于验证真实 CLI 与 DSH 界面链路：

![Codex 原生聊天页](docs/codex-web.png)

![Claude Code 原生聊天页](docs/claude-web.png)
