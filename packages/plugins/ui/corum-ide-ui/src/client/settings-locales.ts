/** Shell chrome and General-nav dictionaries (fork of official
 *  ui-settings-general/src/client/locales.ts); feature rows own their copy.
 *
 * 1:1 复刻 design.pen 设置中心文案：
 * - trigger / title / close / general.nav（原有）
 * - search: 搜索设置…
 * - scope.global: 全局 / scope.project: 本项目
 */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'trigger': '设置',
  'title': '设置',
  'close': '关闭',
  'search': '搜索设置…',
  'scope.global': '全局',
  'scope.project': '本项目',
  // 导航分组标题（SettingsShell 的 NAV_GROUPS）
  'group.general': '通用',
  'group.agent': '智能体',
  'group.memory': '记忆',
  'group.data': '数据与隐私',
  'group.extensions': '扩展',
  'group.advanced': '高级',
  // section 导航标签（SECTION_DEFS 的 label key）
  'nav.appearance': '外观',
  'nav.editor': '编辑器',
  'nav.notifications': '通知',
  'nav.shortcuts': '快捷键',
  'nav.permissions': '权限',
  'nav.memory': '记忆',
  'nav.terminal': '终端',
  'nav.hooks': 'Hooks 与自动化',
  'nav.agentSettings': '智能体设置',
  'nav.agentPresets': 'Agent 预设',
  'nav.account': '账户与用量',
  'nav.privacy': '隐私',
  'nav.data': '数据管理',
  // 「会话管理」独立 section 页（issue #121 修订版，设计稿 mdBB5）——
  // 归档会话的还原 / 导出 / 删除 / 导入全生命周期管理。
  'nav.sessionManagement': '会话管理',
  // ✂️ 'nav.mcp' / 'nav.skills' 已随两个分区迁出删除（PR6：MCP 与技能成为集成中心
  //    的内容页，文案由 @corum/corum-ide-integrations-pages-ui 自持）。
  //    ⚠️ 不要加回：本字典只服务设置中心剩下的 section，留着是死键。
  'nav.aiPolish': 'AI 润色',
  'nav.advanced': '高级',
  // ✂️ 'nav.extensions' 已随「插件管理」分区删除（2026-10-03：插件管理由集成中心
  //    「插件」页接管）。⚠️ 不要加回：本字典只服务设置中心剩下的 section，留着是死键。
} satisfies Record<string, string>

/** The settings namespace key union. */
export type SettingsKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'trigger': 'Settings',
  'title': 'Settings',
  'close': 'Close',
  'search': 'Search settings…',
  'scope.global': 'Global',
  'scope.project': 'Project',
  'group.general': 'General',
  'group.agent': 'Agents',
  'group.memory': 'Memory',
  'group.data': 'Data & Privacy',
  'group.extensions': 'Extensions',
  'group.advanced': 'Advanced',
  'nav.appearance': 'Appearance',
  'nav.editor': 'Editor',
  'nav.notifications': 'Notifications',
  'nav.shortcuts': 'Shortcuts',
  'nav.permissions': 'Permissions',
  'nav.memory': 'Memory',
  'nav.terminal': 'Terminal',
  'nav.hooks': 'Hooks & Automation',
  'nav.agentSettings': 'Agent Settings',
  'nav.agentPresets': 'Agent Presets',
  'nav.account': 'Account & Usage',
  'nav.privacy': 'Privacy',
  'nav.data': 'Data Management',
  'nav.sessionManagement': 'Session Management',
  'nav.aiPolish': 'AI Polish',
  'nav.advanced': 'Advanced',
} satisfies Record<SettingsKey, string>
