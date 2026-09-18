# DSH Harness Provider

将 Codex 和 Claude Code 接入 DSH 的独立插件，无需修改 DSH 源码。

插件通过 [Agent Client Protocol](https://agentclientprotocol.com)（ACP v1）连接随包提供的官方适配器：`codex-acp` 驱动本机 Codex CLI，`claude-agent-acp` 驱动本机 Claude Code CLI。对话、工具活动、提问、历史、分支和恢复都保留在 DSH 原生会话中；认证、模型推理、工具、沙箱、hooks 和权限策略仍由对应 CLI 管理。

> 当前为开发预览版，仅在 macOS 上验证。

![Codex 原生聊天页](docs/codex-web.png)

## 功能特性

- 在 DSH 输入栏切换 DSH 原生、Codex 或 Claude Code。
- 使用 Harness 原生的模型、推理强度和权限配置。
- 流式显示回复、Claude Code 思考、命令、文件操作、网页访问、计划、提问和审批；Codex 的 reasoning summary 不展示。
- 支持图片输入、工具图片输出和本地文件附件。
- 显示上下文用量、账户额度、输出速度、token 和缓存命中。
- 支持停止、运行中追加消息、分支、回滚和异常恢复。
- 可将独立任务委派到新的 DSH 原生、Codex 或 Claude Code 会话。

## 前置条件

- Node.js 22 或更高版本。
- 已安装 DSH 0.1.6-alpha.2 或更高版本，并使用 Web Profile。更早的版本中，Harness 会话的模型选择器和右侧栏“子代理”卡片的插件来源说明无法正常显示。
- 已安装并完成登录或环境配置的 [Codex CLI](https://developers.openai.com/codex/cli/) 或 [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code/overview)。

## 安装

将发布包加入 DSH Profile，然后启动 DSH：

```sh
dsh plugin --profile web add /absolute/path/dsh-harness-provider-0.1.6.tgz
dsh --profile web
```

外部 Harness 不需要 DeepSeek API Key。首次引导时可以选择“稍后配置”；插件会在当前会话使用外部 Harness 时跳过 DeepSeek 凭据引导。

## 快速开始

1. 新建一个空会话。
2. 在输入栏选择 **Codex** 或 **Claude Code**。
3. 按需选择模型、推理强度和权限模式。
4. 发送第一条消息。

第一条消息发送后，当前会话的 Harness 将被锁定；如需切换，请新建会话。新会话会沿用上次选择的 Harness，以及该 Harness 最近使用且仍可用的模型和推理强度。

运行中的主要行为：

- 使用 DSH 输入框继续对话，使用原停止按钮取消当前轮次。
- 运行中发送的消息会插入当前原生轮次；如果 Agent 未确认插入，本轮会取消并暂停，等待恢复。
- 图片由 DSH 校验后发送给 Harness；普通文件以本地路径提供，由 CLI 按其权限读取。
- 外部 Harness 的 `/` 菜单显示 Agent 公布的技能和本地命令。Codex 技能会在发送时由 `/name` 转为 `$name`。

### 权限模式

| Harness | 可选模式 | 默认值 |
| --- | --- | --- |
| Codex | 逐项审批、自动审批、完全权限 | 自动审批（`agent`） |
| Claude Code | 默认、接受编辑、计划、自动；符合条件时提供完全权限 | Claude 设置中的 `permissions.defaultMode` |

新会话首次绑定时，插件会将 DSH 的只读、工作区可写和完全权限映射到对应 Harness。运行期间不能切换模型、推理强度或权限模式。

### 活动映射

| Harness 活动 | DSH 显示 |
| --- | --- |
| 回复、Claude Code 思考 | 回复流、思考行；Codex reasoning summary 不展示 |
| 命令 | Bash 行 |
| 读取、搜索、编辑文件 | Read、Grep、Glob、Edit 或 Write 行 |
| 网页访问 | Web 行 |
| 计划 | 待办行 |
| 提问 | DSH 问题卡 |
| 审批 | DSH 审批卡 |
| 上下文压缩、失败说明 | 通知或说明消息 |

未识别的工具显示为通用工具行，工具输出超过 64,000 字符时会截断。密码类问题使用插件自己的保密表单，答案仅在内存中转交 Harness，不写入日志、状态文件或浏览器存储。

## 委派会话

在 DSH 原生、Codex 或 Claude Code 会话中明确要求“交给 DSH 原生”“交给 Codex”或“新建 Claude Code 会话”即可创建委派会话。委派会话：

- 使用同一工作区，但拥有独立历史，并显示在 DSH 左侧会话列表中。
- 可执行实现、修复、调研、审查和测试等任务。
- 完成一轮后会通知并唤醒来源会话；只有创建者可以读取结果。
- 创建成功后，来源 Agent 结束当前轮次并等待完成通知，不使用 `sleep` 或定时读取进行轮询；收到通知后再分页读取结果。
- 同 Harness 沿用来源权限；跨 Harness 使用与来源权限相匹配的目标权限。
- DSH 原生目标使用宿主当前的默认 Agent preset 与模型；权限取与来源沙箱级别相同的权限预设（来源为 Codex / Claude Code 时，完全权限对应完全权限，只读或计划对应只读，其余对应工作区可写），没有匹配预设时拒绝创建。
- 读取结果为 `not-started` 时，使用相同 `requestId` 和参数重试创建；结果为 `interrupted` 时，进入目标会话检查和处理，不自动重发。
- 不能继续委派其他会话，但可以正常分支。

DSH 原生模型通过 `harness_delegate` 和 `harness_delegate_read` 工具操作；Codex 和 Claude Code 会在原生会话中收到插件提供的委派 CLI 说明。创建操作使用 `requestId` 保证幂等，结果分页读取，避免重试产生重复会话。

## 会话恢复与数据

插件在提交每轮消息前记录“未确认”状态。进程退出或协议错误导致结果不明确时，会话会暂停；重新打开后，插件会回放原生历史并尝试确认结果：

- Codex 通过 `codex app-server` 读取原生轮次状态。
- Claude Code 根据 ACP 回放中的消息和工具状态推断结果。

无法确认时，界面会显示 **恢复会话**，可选择重新核对原生记录，或解除暂停且不重发。插件不会自动重发结果不明确的请求。

状态目录仅保存会话侧车文件和 `defaults.json`，不保存密钥或对话全文。侧车文件名使用会话 ID 的 SHA-256，权限为 `0600`。

## 配置

插件无需额外配置即可使用。可在 Profile 的 `cordis.patch.yml` 中覆盖以下选项：

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `codexCommand` | `codex` | Codex 可执行文件，也用于额度探测 |
| `root` | `$DSH_HOME/harness-plugin` | 插件状态目录；未设置 `DSH_HOME` 时使用 `~/.dsh/harness-plugin` |

```yaml
- id: harness-plugin
  config:
    codexCommand: /absolute/path/codex
    root: /absolute/path/harness-state
```

支持的环境变量：

| 环境变量 | 说明 |
| --- | --- |
| `CODEXHOST_CLAUDE_COMMAND` | Claude Code 可执行文件；未设置时从 PATH、常见安装目录和版本管理器目录中查找 |
| `DSH_HARNESS_ACP_STDERR=1` | 将 ACP Agent 的 stderr 输出到 DSH，仅用于排查启动问题；输出可能包含提示词或凭据 |

从图形界面启动 DSH 时，插件会读取登录 shell 的环境。

## 工作原理

```text
DSH Host
└── HarnessService
    ├── DshRunner              运行、取消、插入消息和持久化状态
    ├── DshOutput              将 Harness 事件转换为 DSH 消息
    ├── DelegationBridge       创建并读取委派会话
    └── AcpAdapter
        ├── codex-acp          → 本机 Codex CLI
        └── claude-agent-acp   → 本机 Claude Code CLI
```

两个 Harness 共用同一个 ACP 适配层，差异集中在 `src/acp-profiles.ts`。插件不向 Agent 声明文件系统或终端能力，也不传入 MCP 服务器；工具始终由各 CLI 在自己的权限策略下执行。

## 开发

开发需要一个已构建的 `deepseek-harness` 参考仓库，默认位于 `../../deepseek-harness`。也可以通过 `DSH_REFERENCE_ROOT` 指定路径。

```sh
npm install
npm run dev:link
npm run check
```

`npm run dev:link` 会链接参考仓库中的 `@deepseek-ai/*` 包，每次运行 `npm install` 后都需要重新执行。`npm run check` 依次执行类型检查、构建和全部测试。

其他验证命令：

| 命令 | 用途 |
| --- | --- |
| `npm run probe:acp` | 使用本机 CLI 和本地模型桩验证 ACP 目录、对话、历史、分支、技能、恢复和插入 |
| `npm pack && npm run probe:web` | 使用临时 DSH Web Profile 运行 Playwright 端到端验证 |
| `npm run probe -- <DSH 构建目录>` | 在指定 DSH 检出中验证进程内扩展点 |
| `node scripts/install-test-profile.mjs` | 打包并离线安装到隔离的测试 Profile |

贡献或修改前请阅读 [AGENTS.md](AGENTS.md)。更多实现决定和历史验证记录见 [docs/implementation-status.md](docs/implementation-status.md)。

## 已知限制

- Claude Code 的 ACP 回放不提供原生轮次结束状态，只能根据消息和工具状态推断；回复后被中断的轮次可能仍被判定为成功。
- 普通文件附件需要本地文件存储后端。
- 外部会话续聊依赖插件保持启用；DSH 更新后需要重新验证公开方法包装和客户端插槽。
- Windows、Linux 和独立 Desktop 发行包尚未验证。
- 项目级 hooks 与直接运行 CLI 一样会执行本地命令，只应在可信工作区使用。

## 许可证

本项目采用 [MIT License](LICENSE)。第三方依赖许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
