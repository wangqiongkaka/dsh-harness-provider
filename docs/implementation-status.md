# Harness 能力补齐

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

- `npm run check`：类型检查、构建及 33 项测试通过。覆盖附件校验和图片落盘、保密答复隔离及关闭、运行中插入去重、历史分支和回滚、未知结果不重发、委派分页及自动唤醒、原生 DSH 工具调用，以及 Claude/Codex 的 MCP elicitation、权限请求、斜杠命令、hooks、子代理活动和增量工具输出投影。
- `node experiments/codex-native-probe.mjs`：真实 Codex CLI 的多轮、历史读取、指定边界分支及跨进程续聊通过。
- `node experiments/codex-capabilities-probe.mjs`：真实 Codex CLI 加载项目 skill 与 MCP；MCP 工具审批和表单问答经 DSH 往返；`/skills`、`/mcp` 不触发模型请求；Codex 哈希授信后的用户 hook 实际执行、反馈注入模型上下文并投影活动。模型端仅使用本地 fixture。
- `node experiments/claude-native-probe.mjs`：真实 Claude Code CLI 的多轮、历史读取、指定边界分支、跨进程续聊及运行中插入通过。原始回复先结束时，仍等待插入消息对应的后续回复完成。
- `node experiments/claude-capabilities-probe.mjs`：真实 Claude Code CLI 的项目 MCP 工具与表单提问、项目 hook 上下文与阻断反馈、原生 `/help` 斜杠命令通过；模型端仅使用本地 fixture。
- `node experiments/secret-ui-probe.mjs`：实际密码组件的浏览器输入、提交及提交后清除通过。
- `DSH_PLUGIN_TAR=.cache/dsh-harness-provider-0.1.2.tgz node experiments/dsh-web-probe.mjs`：临时 DSH Profile 安装、两种 Harness 原输入框续聊及重启恢复通过；回滚后下一请求不再包含被撤销轮；分支保留 Harness 绑定；未知结果核对保持暂停，手动解除没有增加模型请求。
- 同一 Web 检查加 `DSH_DELEGATION_PROBE=1`：真实 Claude Code 工具创建的 Codex review 出现在侧栏，能查看回复；完成通知实际进入来源 Claude Code 的下一次模型请求，自动唤醒通过。

以上真实 CLI 与浏览器检查使用本地模拟模型服务，没有调用真实云模型。未执行真实云模型、真实写文件审批、Windows/Linux 和独立 Desktop 发行包验证；未安装到用户日常 Profile。

## 图片发送修复

修复 `cannot get property "attachments" without inject (gateway/internal)`：插件入口漏声明 `attachments` 和 `fileUploads`，导致真实 Cordis 插件作用域拒绝访问。直接在根 Context 上验证附件转换无法发现这一问题。

回归检查改为通过声明依赖的插件作用域发送图片，并验证文件上传票据隔离。`npm run check` 的类型检查、构建和 28 项测试通过。`DSH_IMAGE_PROBE=1 DSH_PLUGIN_TAR=.cache/dsh-harness-provider-0.1.2.tgz node experiments/dsh-web-probe.mjs` 使用真实输入框上传 PNG，并检查实际原生模型请求包含图片；模型服务仍使用本地模拟端点。

## 保留的边界

- 普通文件提供已校验的本地附件路径，由原生工具按权限读取；不内置通用文档解析器。远程图片 URL 保留引用，不自动下载。
- 更新前缺少轮次映射的历史可以整体分支，不能按旧消息猜测截断位置。
- 回滚保留旧界面记录并新增说明；只改变后续原生上下文。无法确认的原生执行结果保持暂停，等待手动解除。
- 插件保密答复通道不落盘；原生 Harness 自己的日志行为由其控制。

## 嵌套委派修复

修复委派子会话收到委派说明和凭据后，在完成通知触发的续轮中再次创建 review 会话的问题。宿主现在拒绝委派子会话再次委派，并且不再向它注入委派说明或环境凭据；来源主会话仍可在用户提出新任务时继续创建独立委派。回归测试先复现“子会话可再次委派”，修复后 `npm run check` 的类型检查、构建及 28 项测试通过。

## Claude Code 原生配置范围

Claude Code 主会话的 SDK `settingSources` 使用 `user`、`project`、`local`，与直接运行 CLI 的默认文件设置范围一致。项目 `CLAUDE.md`、项目与本地 settings，以及由这些设置启用的 skills、MCP、plugins 和 hooks 均由原生 Claude Code 加载。MCP 表单 elicitation 通过 DSH 问题卡交互，原生斜杠命令及 hooks 的 informational 消息投影为可见回复。短时模型与额度检查仍使用无工具查询，避免检查动作执行项目任务。

## Codex 原生能力补齐

Codex app-server 初始化现在声明标准及扩展 MCP 表单能力。MCP 工具调用审批会按原生元数据提供一次、本会话和永久授权；普通表单、多选表单、URL 流程和额外权限请求通过 DSH 交互返回。命令与 MCP 进度、hooks、子代理委派及新出现的原生活动都有安全投影，未知展示型 item 不再导致会话故障。原生 `skills/list`、`hooks/list`、`mcpServerStatus/list`、上下文压缩和 review API 接到对应斜杠命令；未识别命令保留给 Codex 处理。
