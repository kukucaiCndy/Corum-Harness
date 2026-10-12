/**
 * Settings sections 跨文件共享类型（重构 2 拆文件后，多个 section 文件共用的
 * skill / MCP 投影类型——原先散落在 SettingsSections.tsx 各段）。
 */
export interface SkillInfo {
  name: string
  description: string
  path: string
  currentVersion?: string
  versionCount: number
  createdAt?: string
}
export interface SkillVersion { id: string; date: string; label: string }
export interface SkillBinding { name: string; versionId: string }
export interface ProfileSummary { id: string; nickname?: string; skills: SkillBinding[] }
export interface ScannedSkill { name: string; description: string; sourcePath: string }
/** 绑定某 skill 的 Agent 投影（详情页「绑定关系」列表用）。 */
export interface SkillAgentBind { agentId: string; agentName: string; versionId: string }
/** 「导入内置技能」的结构化摘要（host 侧 skillManager/importBuiltinSkills 返回）。 */
export interface BuiltinSkillImportResult {
  ok: boolean
  error?: string
  /** 随包内置技能目录（排查用）。 */
  shippedRoot?: string
  /** 本次新装上的技能名。 */
  installed: string[]
  /** 因同名已存在而原样保留（不覆盖）的技能名。 */
  skipped: string[]
  /** 因用户删除过而不复活的技能名。 */
  tombstoned: string[]
}
/** MCP 绑定弹窗的 host 服务投影（mcpManager/listServers 返回项）。 */
export interface McpServerSummaryWire {
  name: string
  description?: string
  transport: string
  endpoint: string
  disabled?: boolean
}

/* ── Agent 预设「模块」投影 ──────────────────────────────────────────────
 * 为什么这里要镜像而不是直接 import @corum/corum-preset-modules：
 * 该包是 host 侧（agent group）纯函数库，不是本 UI 包的依赖（见 corum-ide-ui
 * 的 package.json）。本仓既有约定就是「跨包类型在 UI 侧镜像同名结构 + 一行注释
 * 指回契约」（ProfileSummary / McpServerSummaryWire 都这么做）。名字/签名/语义
 * 的事实源 = /tmp/corum-preset-modules-contract.md（含 §7 勘误），改前先读它。
 */

/**
 * MCP 前置依赖声明（契约 §1 McpRequirement，判别联合的 UI 镜像）。
 *
 * host 侧是判别联合（app/command/service），字段随 kind 不同；UI 侧为简化渲染
 * 镜像成一个扁平可选结构——`url` 在 app/command 下是「去哪装」，在 service 下是
 * 「期望可达的端点」。字段含义以 `kind` 为准。
 */
export interface ModuleMcpRequirement {
  kind: 'app' | 'command' | 'service'
  /** app：按平台给出可执行文件路径（键 = process.platform）。 */
  platforms?: Record<string, string>
  /** command：PATH 上待解析的命令名。 */
  command?: string
  /** app/command：去哪装（下载页）；service：期望可达的 URL。 */
  url?: string
  /** 给人看的安装指引。 */
  hint: string
}

/** 第 ① 层探测结果（契约 mcp-requirements.ts RequirementStatus）。 */
export interface ModuleRequirementStatus {
  name: string
  ok: boolean
  kind: 'path-exists' | 'command-resolvable' | 'service' | 'none'
  detail: string
  hint?: string
  url?: string
}

/** 模块清单（契约 §1 ModuleManifest）。 */
export interface ModuleManifest {
  formatVersion: number
  id: string
  version: string
  name: string
  description?: string
  author?: string
  contents: {
    skills: readonly string[]
    mcp: readonly string[]
    hasAvatar: boolean
  }
}

/**
 * 写进 agent.json 的**来源标记**（契约 §7.1：落盘键名 `moduleSource`，不是 `source`）。
 *
 * `ProfileSummary.source` 已被占用（表示「从哪个目录读到的」），故模块来源用
 * `moduleSource`，UI 据此给「模块装来的」预设加「模块」徽标（用户 Q1 直接产物）。
 */
export interface ModuleSource {
  kind: 'module'
  id: string
  version: string
  installedAt: string
}

/** 模块检查结果（契约 §2.1 ModuleInspection）——导入向导第 ②③④ 步的数据源。 */
export interface ModuleInspection {
  dir: string
  manifest: ModuleManifest
  /**
   * 模块要装的预设。
   *
   * `exists` 决定第 ④ 步**预设冲突组**渲染不渲染（2026-10-11 实机补漏：先前 UI 只能
   * 猜——按 `warnings` 里有没有「预设已存在」字样判断，而 host 从不发那条 warning，
   * 于是该组永不出现，默认冲突策略被 blind 应用）。镜像 host 的
   * `ModuleInspection.profile`（契约 §2.1 + 本轮补的 exists/existingNickname）。
   */
  profile: { id: string; name: string; persona?: string; personaPreset?: string; duties?: string; exists: boolean; existingNickname?: string }
  skills: readonly { name: string; exists: boolean }[]
  mcp: readonly { name: string; exists: boolean; status: ModuleRequirementStatus }[]
  hasAvatar: boolean
  warnings: readonly string[]
}

/** 安装输入（契约 §2.1 InstallModuleInput）。 */
export interface InstallModuleInput {
  sourceDir: string
  home: string
  conflict: {
    profile: 'overwrite' | 'skip' | 'rename'
    skills: 'skip' | 'overwrite'
    mcp: 'keep' | 'overwrite'
  }
}

/** 安装结果（契约 §2.1 InstallModuleResult）。 */
export interface InstallModuleResult {
  profileId: string
  skipped: boolean
  installedSkills: readonly string[]
  skippedSkills: readonly string[]
  mcpApplied: readonly string[]
  mcpKept: readonly string[]
  warnings: readonly string[]
}

/** 导出结果（契约 §2.1 ExportModuleResult）。 */
export interface ExportModuleResult {
  dir: string
  manifest: ModuleManifest
  skills: readonly string[]
  mcp: readonly string[]
  warnings: readonly string[]
  /** 致命：这些 MCP 缺合法 requires ⇒ 导出被拦。空 = 可导出。 */
  blocked: readonly { name: string; reason: string }[]
  /** W4 补充：导出的 zip 路径（若已打包）。 */
  archive?: string
}

/** authorModuleRequires 的返回（契约 §2.3）。 */
export interface AuthorModuleRequiresResult {
  entries: Record<string, ModuleMcpRequirement>
  unconfirmed: readonly string[]
  notes?: string
}

/** 第 ② 层可达性探测结果（契约 §3 ReachabilityResult，host 侧 W2 实现）。 */
export interface ReachabilityResult {
  ok: boolean
  started: boolean
  kind: 'stdio' | 'streamable-http'
  detail: string
}
