/**
 * 插件中心的中文展示元数据：包名 → 中文名 + 中文介绍。
 *
 * Host 端只给 package.json 的英文 description；这里给每个 corum 产品插件和
 * 全部 cordis/dsh 运行时基元补中文名与一句话中文介绍。未收录的包回退英文
 * description + 格式化包名。
 * @module ide-shell/client/plugin-meta
 */

export interface PluginMeta {
  /** 中文名。 */
  readonly zhName: string
  /** 一句话中文介绍。 */
  readonly zhDesc: string
}

/** 中文元数据表（key = 包名 moduleName）。 */
const META: Readonly<Record<string, PluginMeta>> = {
  // ── corum 产品功能插件 ──
  'corum-desktop': { zhName: 'IDE 壳', zhDesc: '桌面 IDE 外壳：Electron 壳 + Host 桥 + IPC 传输，零 HTTP。' },
  'corum-desktop/modules': { zhName: '模块加载', zhDesc: '按 corumapp:// 协议加载各插件的浏览器半 bundle。' },
  'corum-desktop/connection': { zhName: '桌面连接', zhDesc: '经 Electron IPC 把渲染端 RPC 桥接到 Host 进程。' },
  '@corum/corum-ide-ui': { zhName: 'IDE 界面壳', zhDesc: 'IDE 主界面：网格布局、顶部菜单栏、主题切换、插件中心入口。' },
  '@corum/corum-ide-sidebar-ui': { zhName: '会话列表', zhDesc: '左侧会话与项目导航栏。' },
  '@corum/corum-ide-explorer-ui': { zhName: '资源管理器', zhDesc: '右侧文件树浏览与文件打开。' },
  '@corum/corum-ide-conversation-ui': { zhName: '对话区', zhDesc: '中间对话区：消息流、工具调用、输入框、运行控制。' },
  '@corum/corum-ide-panel-bottom-ui': { zhName: '底部面板', zhDesc: '底部终端 / 待办 / 队列面板。' },
  '@corum/corum-session-archive': { zhName: '会话归档', zhDesc: '会话日志的导出与导入（原生保存对话框）。' },
  '@corum/corum-ui-settings-models': { zhName: '模型设置', zhDesc: '模型与服务商配置页（含图片输入开关）。' },
  '@corum/corum-ui-model-selection': { zhName: '模型选择器', zhDesc: '会话内的模型切换与不可用提示。' },

  // ── cordis 框架基元 ──
  'cordis:include': { zhName: '插件装配器', zhDesc: 'cordis 组合树的插件装配入口。' },
  '@deepseek-ai/cordis-plugin-timer': { zhName: '定时器', zhDesc: 'cordis 的定时任务服务。' },
  '@deepseek-ai/cordis-plugin-hmr': { zhName: '热更新', zhDesc: 'cordis 插件的模块热替换。' },

  // ── LLM / 会话核心 ──
  '@deepseek-ai/dsh-llm': { zhName: 'LLM 运行时', zhDesc: '大模型调用的统一接口（与服务商无关）。' },
  '@deepseek-ai/dsh-llm-deepseek': { zhName: 'DeepSeek 模型适配', zhDesc: 'DeepSeek 聊天补全接口的模型适配器。' },
  '@deepseek-ai/dsh-llm-pi-ai': { zhName: 'pi-ai 模型适配', zhDesc: '基于 pi-ai 的多服务商模型适配器。' },
  '@deepseek-ai/dsh-llm-retry': { zhName: 'LLM 重试', zhDesc: '按服务商路由的模型请求重试策略。' },
  '@deepseek-ai/dsh-session': { zhName: '会话核心', zhDesc: '事件溯源的会话存储核心。' },
  '@deepseek-ai/dsh-session-title': { zhName: '会话标题', zhDesc: '会话标题生成与命名服务。' },
  '@deepseek-ai/dsh-session-title-first-prompt-llm': { zhName: '首条消息命名', zhDesc: '用首条消息让模型生成会话标题。' },
  '@deepseek-ai/dsh-session-persistence-jsonl': { zhName: '会话持久化', zhDesc: '会话的 JSONL 落盘存储后端。' },
  '@deepseek-ai/dsh-session-query-sqlite': { zhName: '会话检索', zhDesc: '会话的 SQLite 全文搜索后端。' },
  '@deepseek-ai/dsh-session-projection': { zhName: '会话投影', zhDesc: '会话派生状态的投影注册表与服务。' },
  '@deepseek-ai/dsh-session-projection-cache': { zhName: '投影缓存', zhDesc: '会话投影的持久化缓存与冷读加速。' },
  '@deepseek-ai/dsh-session-stats': { zhName: '会话统计', zhDesc: '会话消息数与耗时统计投影。' },
  '@deepseek-ai/dsh-session-telemetry-otel': { zhName: '会话遥测', zhDesc: '会话记录的 OpenTelemetry 上报后端。' },
  '@deepseek-ai/dsh-session-checkpoint-policy': { zhName: '会话检查点', zhDesc: '模型请求与工具副作用前的会话持久化检查点。' },
  '@deepseek-ai/dsh-settings-file': { zhName: '设置存储', zhDesc: '把各命名空间设置持久化到 settings.yaml。' },
  '@deepseek-ai/dsh-credentials-local': { zhName: '凭据存储', zhDesc: '本地凭据（API key 等）的文件存储。' },
  '@deepseek-ai/dsh-attachment-local': { zhName: '附件存储', zhDesc: '会话附件的本地内容寻址存储。' },
  '@deepseek-ai/dsh-session-log-export': { zhName: '会话导出（旧）', zhDesc: '网页版会话日志导出（桌面由会话归档替代）。' },
  '@deepseek-ai/dsh-user-questions': { zhName: '用户提问', zhDesc: '智能体运行中向人提问的接口。' },
  '@deepseek-ai/dsh-user-approval': { zhName: '用户审批', zhDesc: '智能体操作的一次性权限审批（默认拒绝）。' },

  // ── 智能体 / 工具 ──
  '@deepseek-ai/dsh-agent': { zhName: '智能体核心', zhDesc: '智能体接口、注册表与事件体系。' },
  '@deepseek-ai/dsh-agent-loop': { zhName: '智能体循环', zhDesc: '智能体的主运行循环。' },
  '@deepseek-ai/dsh-agent-default-model': { zhName: '默认模型', zhDesc: '智能体入口共用的默认模型选择。' },
  '@deepseek-ai/dsh-agent-presets': { zhName: '智能体预设', zhDesc: '按预设组合文件装配每会话的智能体。' },
  '@deepseek-ai/dsh-agent-instructions': { zhName: '指令加载', zhDesc: '加载工作区 AGENTS.md/CLAUDE.md 指令文件。' },
  '@deepseek-ai/dsh-persona': { zhName: '人格设定', zhDesc: '组合层注入的部署人格（系统提示角色）。' },
  '@deepseek-ai/dsh-system-prompt': { zhName: '系统提示', zhDesc: '系统提示词的组装注册表。' },
  '@deepseek-ai/dsh-jobs-local': { zhName: '后台任务', zhDesc: '进程内后台任务注册表实现。' },
  '@deepseek-ai/dsh-subprocess-local': { zhName: '子进程', zhDesc: '本地子进程能力的实现。' },
  '@deepseek-ai/dsh-sandbox-local': { zhName: '沙箱', zhDesc: '本地进程沙箱后端（bwrap/Seatbelt 等，失败即拒）。' },
  '@deepseek-ai/dsh-sandbox-policy': { zhName: '沙箱策略', zhDesc: '按调用解析沙箱策略与当前模型上下文。' },
  '@deepseek-ai/dsh-bash-sandbox': { zhName: 'Bash 沙箱', zhDesc: '把 Bash 命令限制在沙箱内执行。' },
  '@deepseek-ai/dsh-pwsh-sandbox': { zhName: 'Pwsh 沙箱', zhDesc: '把 PowerShell 命令限制在沙箱内执行。' },
  '@deepseek-ai/dsh-fs-sandbox': { zhName: '文件沙箱', zhDesc: '按沙箱模式限制文件写/改（只读/工作区写）。' },
  '@deepseek-ai/dsh-permission-presets': { zhName: '权限预设', zhDesc: '面向用户的权限档位（沙箱模式 + 审批策略）。' },
  '@deepseek-ai/dsh-shell-env': { zhName: 'Shell 环境', zhDesc: '受管的 DSH_* shell 环境变量注册表。' },
  '@deepseek-ai/dsh-tool-bash': { zhName: 'Bash 工具', zhDesc: '智能体的 Bash 命令执行工具。' },
  '@deepseek-ai/dsh-tool-pwsh': { zhName: 'Pwsh 工具', zhDesc: '智能体的 PowerShell 命令工具。' },
  '@deepseek-ai/dsh-tool-jobs': { zhName: '后台任务工具', zhDesc: '智能体的后台任务查看/终止工具。' },
  '@deepseek-ai/dsh-fs-observation-policy': { zhName: '文件观测策略', zhDesc: '读前编辑、版本守卫写入的文件上下文策略。' },
  '@deepseek-ai/dsh-tool-fs': { zhName: '文件工具', zhDesc: '智能体的文件读/写/改工具。' },
  '@deepseek-ai/dsh-tool-fs-search': { zhName: '文件检索工具', zhDesc: '智能体的 glob/grep 文件发现工具。' },
  '@deepseek-ai/dsh-skill': { zhName: '技能注册', zhDesc: '智能体技能的注册表。' },
  '@deepseek-ai/dsh-skill-filesystem': { zhName: '本地技能', zhDesc: '从本地文件系统加载智能体技能。' },
  '@deepseek-ai/dsh-skill-badge': { zhName: '徽标技能', zhDesc: '内置 dsh 徽标技能。' },
  '@deepseek-ai/dsh-tool-skill': { zhName: '技能工具', zhDesc: '智能体加载技能的工具。' },
  '@deepseek-ai/dsh-commands': { zhName: '命令注册', zhDesc: '界面人类命令（斜杠命令）的注册表。' },
  '@deepseek-ai/dsh-command-feedback': { zhName: '反馈命令', zhDesc: '会话反馈的记录与斜杠命令。' },
  '@deepseek-ai/dsh-goal': { zhName: '目标管理', zhDesc: '同会话目标的状态与生命周期服务。' },
  '@deepseek-ai/dsh-goal-round-driver': { zhName: '目标轮次驱动', zhDesc: '同会话目标轮次的竞态防护驱动。' },
  '@deepseek-ai/dsh-command-goal': { zhName: '目标命令', zhDesc: '持久化同会话目标的斜杠命令。' },
  '@deepseek-ai/dsh-plan-mode': { zhName: '计划模式', zhDesc: '先规划后执行的模式与人工确认退出。' },
  '@deepseek-ai/dsh-token-meter': { zhName: 'Token 计量', zhDesc: '可重放的 Token 用量计量服务。' },
  '@deepseek-ai/dsh-compaction-basic': { zhName: '上下文压缩', zhDesc: '基于 Token 计量的会话压缩与摘要。' },
  '@deepseek-ai/dsh-command-compact': { zhName: '压缩命令', zhDesc: '手动触发会话压缩的斜杠命令。' },
  '@deepseek-ai/dsh-subagent': { zhName: '子智能体', zhDesc: '委派子智能体的注册表接口。' },
  '@deepseek-ai/dsh-subagent-spawn-in-process': { zhName: '子智能体·新建', zhDesc: '进程内新建子智能体的后端。' },
  '@deepseek-ai/dsh-subagent-fork-in-process': { zhName: '子智能体·分叉', zhDesc: '进程内分叉子智能体（继承父日志前缀）。' },
  '@deepseek-ai/dsh-tool-subagent-control': { zhName: '子智能体控制', zhDesc: '子智能体的发消息/中断/列表工具。' },
  '@deepseek-ai/dsh-tool-subagent-control/list-agents': { zhName: '子智能体列表', zhDesc: '列出子智能体的工具端点。' },
  '@deepseek-ai/dsh-tool-subagent': { zhName: '子智能体委派', zhDesc: '把任务委派给子智能体的工具。' },
  '@deepseek-ai/dsh-tool-subagent-report': { zhName: '子智能体汇报', zhDesc: '子智能体回传结果的工具。' },
  '@deepseek-ai/dsh-workflow-worker-thread': { zhName: '工作流引擎', zhDesc: '在工作线程执行模型编写的编排脚本。' },
  '@deepseek-ai/dsh-tool-workflow': { zhName: '工作流工具', zhDesc: '运行 JavaScript 编排脚本的工具。' },
  '@deepseek-ai/dsh-tool-call-timeout-policy': { zhName: '工具超时', zhDesc: '给每个工具调用加超时截止的策略。' },
  '@deepseek-ai/dsh-spill-local': { zhName: '溢出存储', zhDesc: '会话私有溢出文件的本地存储。' },
  '@deepseek-ai/dsh-spill-policy': { zhName: '溢出策略', zhDesc: '超大工具结果替换为预览 + 溢出文件路径。' },
  '@deepseek-ai/dsh-compaction-tool-result-pruner': { zhName: '结果裁剪', zhDesc: '对工具结果做头/中/尾裁剪（无模型、可重放）。' },
  '@deepseek-ai/dsh-tool-todo': { zhName: '待办工具', zhDesc: '智能体的待办事项（todo_write）工具。' },
  '@deepseek-ai/dsh-tool-goal': { zhName: '目标工具', zhDesc: '智能体的同会话目标工具（带权限校验）。' },
  '@deepseek-ai/dsh-tool-ralph': { zhName: 'Ralph 循环', zhDesc: '全新智能体的 Ralph 循环工具。' },
  '@deepseek-ai/dsh-tool-str-replace-editor': { zhName: '字符串替换编辑', zhDesc: '查看/创建/字面替换/插行的文件编辑工具。' },
  '@deepseek-ai/dsh-repeat-tool-reminder': { zhName: '重复调用提醒', zhDesc: '智能体重复同一工具调用时的提醒。' },
  '@deepseek-ai/dsh-tool-ask-user': { zhName: '提问工具', zhDesc: '智能体向用户提问的工具。' },

  // ── 网络 / 存储 ──
  '@deepseek-ai/dsh-web': { zhName: '网络能力', zhDesc: '搜索/抓取的统一接口与错误体系。' },
  '@deepseek-ai/dsh-web-search-deepseek': { zhName: 'DeepSeek 搜索', zhDesc: 'DeepSeek 后端的联网搜索提供者。' },
  '@deepseek-ai/dsh-tool-web': { zhName: '网络工具', zhDesc: '智能体的联网搜索/抓取工具。' },
  '@deepseek-ai/dsh-tools': { zhName: '工具管线', zhDesc: '工具注册表与执行管线。' },
  '@deepseek-ai/dsh-code-runtime-worker-thread': { zhName: '代码运行时', zhDesc: '工作线程的代码执行后端。' },
  '@deepseek-ai/dsh-storage': { zhName: '存储中枢', zhDesc: '命名存储后端注册表与数据形态设施。' },
  '@deepseek-ai/dsh-storage-json': { zhName: 'JSON 存储', zhDesc: 'JSON 文件键值存储后端。' },
  '@deepseek-ai/dsh-storage-domain': { zhName: '领域存储', zhDesc: '带 schema 校验与事件的键值领域存储。' },
  '@deepseek-ai/dsh-message-feedback': { zhName: '消息反馈', zhDesc: '每条消息的评分与备注侧车。' },
  '@deepseek-ai/dsh-workspace': { zhName: '工作区', zhDesc: '工作区实体注册表与会话挂载。' },
  '@deepseek-ai/dsh-host-directory-picker-auto': { zhName: '目录选择器', zhDesc: '自适应的目录选择后端（原生/浏览）。' },
  '@deepseek-ai/dsh-host-directory-picker-native': { zhName: '原生目录选择', zhDesc: '调用操作系统原生目录选择器。' },
  '@deepseek-ai/dsh-host-plugin-inventory': { zhName: '插件清单', zhDesc: '当前 Loader 插件状态的只读投影。' },
  '@deepseek-ai/dsh-host-apiproxy': { zhName: 'API 网关', zhDesc: 'ApiProxy 契约与 Host 侧网关（ctx.apiProxy）。' },
  '@deepseek-ai/dsh-cordis-host-runner': { zhName: '动态包宿主', zhDesc: '模型挂载的双半包的注册与调用处理。' },
  '@deepseek-ai/dsh-host-webserver': { zhName: 'Web 服务器', zhDesc: 'HTTP/升级路由与静态资源服务（桌面禁用）。' },
  '@deepseek-ai/dsh-web-app': { zhName: 'Web 应用壳', zhDesc: '浏览器界面 bundle（桌面壳已替换）。' },
  '@deepseek-ai/dsh-web-app/startup': { zhName: 'Web 启动', zhDesc: '浏览器界面的启动入口（桌面禁用）。' },

  // ── Typert / RPC ──
  '@deepseek-ai/dsh-typert-registry': { zhName: 'Typert 注册表', zhDesc: '生成包反射与 Zod schema 的运行时注册表。' },
  '@deepseek-ai/dsh-typert-loader': { zhName: 'Typert 加载', zhDesc: 'Typert 生成包贡献的加载集成。' },
  '@deepseek-ai/dsh-api-gateway': { zhName: 'RPC 网关', zhDesc: 'Typert Remote 的 Host 分发与端点。' },
  '@deepseek-ai/dsh-api-remotes': { zhName: 'RPC 远程面', zhDesc: 'Remote BFF 组装与 Agent/Session 查找。' },

  // ── 客户端运行时 / UI 基元 ──
  '@deepseek-ai/dsh-client-hmr': { zhName: '客户端热更新', zhDesc: '开发态客户端 bundle 的热替换驱动。' },
  '@deepseek-ai/dsh-client-modules': { zhName: '客户端模块', zhDesc: '客户端模块系统与 __DSH_BOOT__ 入口图。' },
  '@deepseek-ai/dsh-client-connection': { zhName: '客户端连接', zhDesc: 'HTTP 上行/WebSocket 下行的连接控制。' },
  '@deepseek-ai/dsh-client-runtime': { zhName: '客户端运行时', zhDesc: '槽位注册表与会话运行时核心服务。' },
  '@deepseek-ai/dsh-cordis-client-runner': { zhName: '动态包浏览器半', zhDesc: '双半包在浏览器侧的执行与装载。' },
  '@deepseek-ai/dsh-client-ui-theme': { zhName: '主题服务', zhDesc: '深浅主题注册、偏好与调色板。' },
  '@deepseek-ai/dsh-client-locale': { zhName: '多语言', zhDesc: '中/英偏好与命名空间字典。' },
  '@deepseek-ai/dsh-client-ui-layout': { zhName: '官方布局', zhDesc: '官方三栏布局（IDE 已由壳替换）。' },
  '@deepseek-ai/dsh-client-ui-sidebar': { zhName: '官方侧栏', zhDesc: '官方会话侧栏（IDE 已由壳替换）。' },
  '@deepseek-ai/dsh-client-ui-settings': { zhName: '设置基座', zhDesc: '设置命名空间作用域与槽位契约。' },
  '@deepseek-ai/dsh-client-ui-settings-general': { zhName: '官方通用设置', zhDesc: '官方通用设置页与欢迎弹窗（IDE 已接管）。' },
  '@deepseek-ai/dsh-client-ui-settings-models': { zhName: '官方模型设置', zhDesc: '官方模型设置页（IDE 已由 fork 替换）。' },
  '@deepseek-ai/dsh-client-ui-settings-plugin-inventory': { zhName: '官方插件清单', zhDesc: '设置里的插件清单只读页。' },
  '@deepseek-ai/dsh-client-ui-settings-plugins': { zhName: '官方插件设置', zhDesc: '设置里的插件管理区。' },
  '@deepseek-ai/dsh-client-ui-conversation': { zhName: '官方对话区', zhDesc: '官方对话区骨架（IDE 已由壳替换）。' },
  '@deepseek-ai/dsh-client-ui-tool': { zhName: '工具调用渲染', zhDesc: '工具调用树的渲染与展示槽。' },
  '@deepseek-ai/dsh-client-ui-cordis': { zhName: '动态插件卡', zhDesc: 'cordis_define 工具行与运行/停止开关。' },
  '@deepseek-ai/dsh-client-ui-workflow-run': { zhName: '工作流运行', zhDesc: '工作流运行的对话节点展示。' },
  '@deepseek-ai/dsh-client-ui-deliverables': { zhName: '交付物', zhDesc: '产出文件的回合计尾与可点引用。' },
  '@deepseek-ai/dsh-client-ui-workspace': { zhName: '官方工作区选择', zhDesc: '侧栏工作区选择器（IDE 已由壳替换）。' },
  '@deepseek-ai/dsh-client-ui-input-trigger': { zhName: '输入触发', zhDesc: '输入框的 / 与 @ 触发与候选菜单。' },
  '@deepseek-ai/dsh-client-ui-commands': { zhName: '命令面板', zhDesc: '客户端命令目录与弹层。' },
  '@deepseek-ai/dsh-client-ui-skill': { zhName: '技能引用', zhDesc: '界面技能引用与技能工具行。' },
  '@deepseek-ai/dsh-client-ui-subagent': { zhName: '子智能体面', zhDesc: '子智能体目录与 @ 引用源。' },
  '@deepseek-ai/dsh-client-ui-jobs': { zhName: '后台任务面', zhDesc: '会话头部的后台任务列表。' },
  '@deepseek-ai/dsh-client-ui-goal': { zhName: '目标面', zhDesc: '输入框上方的目标条。' },
  '@deepseek-ai/dsh-client-ui-message-feedback': { zhName: '消息反馈面', zhDesc: '助手消息操作条上的反馈控件。' },
  '@deepseek-ai/dsh-client-ui-model-selection': { zhName: '官方模型选择', zhDesc: '官方 /model 选择弹层（IDE 已由 fork 替换）。' },
  '@deepseek-ai/dsh-client-ui-permission-presets': { zhName: '权限面', zhDesc: '新会话默认权限与会话内 /permission 弹层。' },
  '@deepseek-ai/dsh-client-ui-agent-preset': { zhName: '智能体预设面', zhDesc: '会话智能体预设的选择与组合编辑器。' },
  '@deepseek-ai/dsh-client-ui-plan': { zhName: '计划模式面', zhDesc: '计划模式的输入控制与 /plan 通道。' },
  '@deepseek-ai/dsh-client-ui-user-questions': { zhName: '用户提问面', zhDesc: '提问工具挂载与输入框提问界面。' },
  '@deepseek-ai/dsh-client-ui-trajectory': { zhName: '轨迹面', zhDesc: '轨迹事件账与交互式耗时总览。' },
  '@deepseek-ai/dsh-client-ui-directory-picker-native': { zhName: '原生目录选择面', zhDesc: '驱动系统原生目录选择器的界面占位。' },
}

/** 取某包的中文展示元数据；未收录返回 undefined（调用方回退英文）。 */
export function pluginMeta(moduleName: string): PluginMeta | undefined {
  return META[moduleName]
}

/** 包名 → 兜底的格式化英文名（最后一段，去 dsh-/ui-/ide- 前缀，连字符转空格）。 */
export function fallbackName(moduleName: string): string {
  const last = moduleName.split('/').pop() ?? moduleName
  return last.replace(/^(dsh|ui|ide)-/g, '').replace(/-/g, ' ')
}
