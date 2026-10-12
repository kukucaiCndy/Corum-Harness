/**
 * Agent 预设**模块**的格式定义与校验（P0）。
 *
 * ## 为什么需要「模块」这一层
 *
 * 现状：一个 Agent 预设的能力分散在三处——
 *   · 预设本体 `~/.corum/.agent-presets/<id>/agent.json`；
 *   · 技能 `~/.corum/skills/<name>/`（预设只**按名字**引用）；
 *   · MCP 配置 `~/.corum/mcp-servers.json`（预设同样只**按名字**引用）。
 *
 * 于是「把一个 Agent 分享给别人」这件事今天做不到：拷 `agent.json` 过去，引用的技能与
 * MCP 全都不存在，而**同一个技能名**在不同机器上还可能是完全不同的内容。
 * 模块把这四样收进一个自洽的目录，使「分享一个 Agent」成为一次原子操作。
 *
 * ## 设计要点（每条都有理由，改前先读）
 *
 * 1. **不带 `agent.cordis.yml`**：它是 `compile.ts` 从 `agent.json` 生成的**派生产物**。
 *    带上会制造「派生件与源不一致」的隐患（本仓已为同类问题付过学费）。
 * 2. **模型字段一律不带**（`model`/`subagentModel`/`researchModel`）：用户定调
 *    「模型预设不打包，跟随用户实际情况」。剥掉后键不存在 ⇒ 按三档语义正好落到
 *    「走全局 ⇒ 全局也没配才跟随主 Agent」= 用户要的「跟随实际情况」。**不需要新机制。**
 * 3. **`trust` 不带**：它是**本地**概念（`system` = 本机内置、不可删除）。导出者机器上的
 *    `corum-dev` 是 `system`，原样带上会让导入者**删不掉**一个并非内置的 Agent。
 *    导入时按**来源**定：随产品的内置模块库 ⇒ `system`，用户从文件装 ⇒ `user`。
 * 4. **`requires` 依赖声明**：MCP 配置里的 `command` 可能是平台绝对路径
 *    （实测 `pencil-mcp` → `/Applications/Pen.app/...`）或包管理器命令
 *    （实测 `chrome-devtools-9333` → `npx`）。两者在**别的机器上都可能不成立**，而
 *    「配置在、程序不在」时现在的报错是一句 `spawn ENOENT` —— 用户读不出该做什么。
 *    故模块必须能声明「我需要什么才能跑」，导入向导据此给出可操作的指引。
 *
 * @module @corum/corum-preset-modules/module-format
 */

/** 模块清单文件名（模块根下一份）。 */
export const MODULE_MANIFEST_FILE = 'module.json'

/** 模块内约定目录名。 */
export const MODULE_SKILLS_DIR = 'skills'
export const MODULE_MCP_DIR = 'mcp'
export const MODULE_ASSETS_DIR = 'assets'
/** 模块内可携带的头像文件名（用户定调「自带必须」）。 */
export const MODULE_AVATAR_FILE = 'avatar.png'

/** 当前模块格式版本（将来改格式时用它做兼容判断）。 */
export const MODULE_FORMAT_VERSION = 1

/** `source.kind` 的取值：这份预设是**从模块装进来的**。 */
export const MODULE_SOURCE_KIND = 'module'

/**
 * 写进 `agent.json` 的**来源标记**：回答「这份预设哪来的」。
 *
 * 为什么必须有它（用户 2026-10-11 拍板 Q1 = 装进用户根）：模块装的与用户自建的
 * **同目录**（`<home>/.agent-presets/<id>/`），没有这个字段就分不清——升级/卸载/
 * 「这个预设能不能删」都无处下手。
 *
 * ⚠️ **护栏（给后人）**：本字段**不由 `SaveProfileInput` 承载**，而
 * `corum-agent/src/agent-service.ts` 的 `saveProfileRemote` 用**白名单**构造 `AgentProfile`
 * （只带 SaveProfileInput 字段 + 显式补带的 `specBaseline`）。也就是说：**只要有任何一条
 * 保存路径走 RPC，`source` 就会被静默抹掉**（P0 的实现是直接写文件，故不受影响）。
 * 将来若让导入/编辑走 RPC，必须在那个白名单里一并带过 `source`（P2 前置项）。
 */
export interface ModuleSource {
  readonly kind: typeof MODULE_SOURCE_KIND
  /** 模块 id（= 安装后的预设 id）。 */
  readonly id: string
  /** 模块版本（取自 `module.json` 的 `version`，供升级判断）。 */
  readonly version: string
  /** 安装时间（ISO 8601）。 */
  readonly installedAt: string
}

/**
 * MCP 的**前置依赖声明**——「这套配置要能跑，机器上必须有什么」。
 *
 * 判别联合，按依赖性质分三类（与实测到的真实形态一一对应）：
 *   · `app`      需要某个宿主程序（如 Pen.app）⇒ 具体路径按平台不同；
 *   · `command`  需要一个 PATH 上的命令（如 npx）⇒ 需 Node/网络；
 *   · `service`  需要一个已在跑的服务（streamable-http 端点）。
 */
export type McpRequirement =
  | {
    readonly kind: 'app'
    /**
     * 按平台给出可执行文件路径。键是 `process.platform` 的值
     * （`darwin` / `win32` / `linux`）。
     *
     * ⚠️ 刻意**不**用一个 `command` 字段糊弄过去：绝对路径在别的平台上必然不同，
     * 按平台声明才不会「换个系统静默失效」（规范 §16 的平台分叉纪律）。
     */
    readonly platforms?: Readonly<Record<string, string>>
    /** 给人看的说明（「需要先安装 Pen」）。 */
    readonly hint: string
    /** 去哪装（下载页）。 */
    readonly url?: string
  }
  | {
    readonly kind: 'command'
    /** 需要在 PATH 上可解析的命令名（如 `npx`）。 */
    readonly command: string
    readonly hint: string
    readonly url?: string
  }
  | {
    readonly kind: 'service'
    /** 期望可达的 URL。 */
    readonly url: string
    readonly hint: string
  }

/** 模块里的一个 MCP 服务条目（配置本体 + 前置依赖声明）。 */
export interface ModuleMcpEntry {
  /** 服务名（预设按此名引用）。 */
  readonly name: string
  readonly transport: 'stdio' | 'streamable-http'
  /** stdio：可执行命令。 */
  readonly command?: string
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  /** streamable-http：端点。 */
  readonly url?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly description?: string
  /** 写给模型的使用指导（原样透传到 `mcp-servers.json`）。 */
  readonly guidance?: string
  /** 前置依赖（缺省 = 无外部依赖，如纯内置命令）。 */
  readonly requires?: McpRequirement
}

/** 模块清单（`module.json`）。 */
export interface ModuleManifest {
  /** 格式版本（见 {@link MODULE_FORMAT_VERSION}）。 */
  readonly formatVersion: number
  /** 预设 id（= 安装后的目录名；须满足 `isValidProfileId`）。 */
  readonly id: string
  /** 模块自身版本（如 `1.0.0`），供升级判断。 */
  readonly version: string
  /** 显示名。 */
  readonly name: string
  readonly description?: string
  readonly author?: string
  /**
   * 内容清单（给人看 + 供导入向导在**不解包全量**时预览）。
   * 真实文件才是权威——这里是**摘要**，不一致时以文件为准（并在导入时报出来）。
   */
  readonly contents: {
    readonly skills: readonly string[]
    readonly mcp: readonly string[]
    readonly hasAvatar: boolean
  }
}

/** 校验失败的原因（fail-loud，不用 undefined 表示）。 */
export interface ModuleValidationError {
  readonly field: string
  readonly message: string
}

/** 合法预设 id（与 `corum-agent/src/profile.ts` 的 `isValidProfileId` 同规则）。 */
export function isValidModuleId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(id)
}

/**
 * 校验一份模块清单。
 *
 * @param value - 已 `JSON.parse` 的原始值。
 * @returns 错误列表（空数组 = 合法）。**不抛异常**：导入向导要一次性把所有问题
 *   展示给用户，而不是修一个报一个。
 */
export function validateManifest(value: unknown): ModuleValidationError[] {
  const errors: ModuleValidationError[] = []
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [{ field: '(root)', message: '模块清单必须是一个 JSON 对象' }]
  }
  const m = value as Record<string, unknown>

  if (m.formatVersion !== MODULE_FORMAT_VERSION) {
    errors.push({
      field: 'formatVersion',
      message: `不支持的格式版本 ${String(m.formatVersion)}（本机支持 ${MODULE_FORMAT_VERSION}）`,
    })
  }
  if (typeof m.id !== 'string' || !isValidModuleId(m.id)) {
    errors.push({ field: 'id', message: 'id 必须是小写字母/数字/连字符，且以字母或数字开头' })
  }
  if (typeof m.version !== 'string' || m.version.trim() === '') {
    errors.push({ field: 'version', message: 'version 不能为空' })
  }
  if (typeof m.name !== 'string' || m.name.trim() === '') {
    errors.push({ field: 'name', message: 'name 不能为空' })
  }
  const contents = m.contents
  if (typeof contents !== 'object' || contents === null || Array.isArray(contents)) {
    errors.push({ field: 'contents', message: '缺少 contents 清单' })
  } else {
    const c = contents as Record<string, unknown>
    for (const key of ['skills', 'mcp'] as const) {
      if (!Array.isArray(c[key]) || (c[key] as unknown[]).some(x => typeof x !== 'string')) {
        errors.push({ field: `contents.${key}`, message: `${key} 必须是字符串数组` })
      }
    }
    if (typeof c.hasAvatar !== 'boolean') {
      errors.push({ field: 'contents.hasAvatar', message: 'hasAvatar 必须是布尔值' })
    }
  }
  return errors
}

/**
 * 校验一个 MCP 条目（结构与依赖声明的完整性）。
 *
 * ## `requires` 强制（2026-10-11 用户裁定「强制补全」）
 *
 * MCP 配置对应的实际运行程序和服务在**别的机器上可能不存在**——`command` 可能是
 * 平台绝对路径或包管理器命令。「配置在、程序不在」时现在的报错只是一句 `spawn ENOENT`，
 * 用户读不出该做什么。故模块里的**每个** MCP 条目必须有 `requires`，且按 `kind` 校验
 * 非空字段；缺失 ⇒ 校验失败（`field: 'requires'`）。导出/导入路径据此拦截，绝不静默放过。
 */
export function validateMcpEntry(value: unknown): ModuleValidationError[] {
  const errors: ModuleValidationError[] = []
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [{ field: '(root)', message: 'MCP 条目必须是一个 JSON 对象' }]
  }
  const e = value as Record<string, unknown>
  if (typeof e.name !== 'string' || e.name.trim() === '') {
    errors.push({ field: 'name', message: 'MCP 条目必须有 name' })
  }
  if (e.transport !== 'stdio' && e.transport !== 'streamable-http') {
    errors.push({ field: 'transport', message: 'transport 必须是 stdio 或 streamable-http' })
  }
  if (e.transport === 'stdio' && (typeof e.command !== 'string' || e.command.trim() === '')) {
    errors.push({ field: 'command', message: 'stdio 条目必须有 command' })
  }
  if (e.transport === 'streamable-http' && (typeof e.url !== 'string' || e.url.trim() === '')) {
    errors.push({ field: 'url', message: 'streamable-http 条目必须有 url' })
  }
  // requires 强制：没有它，导入者拿到「配置在程序不在」时只有一句 spawn ENOENT。
  const r = e.requires
  if (typeof r !== 'object' || r === null || Array.isArray(r)) {
    errors.push({ field: 'requires', message: 'MCP 条目必须有 requires（声明运行程序/服务的安装要求）' })
    return errors
  }
  const req = r as Record<string, unknown>
  if (req.kind !== 'app' && req.kind !== 'command' && req.kind !== 'service') {
    errors.push({ field: 'requires.kind', message: 'requires.kind 必须是 app / command / service' })
    return errors
  }
  if (typeof req.hint !== 'string' || req.hint.trim() === '') {
    errors.push({ field: 'requires.hint', message: 'requires.hint 不能为空（给人看的安装指引）' })
  }
  // 按 kind 校验：app ⇒ 必须有非空 platforms（至少一个平台键）；command ⇒ 非空 command；service ⇒ 非空 url。
  // 平台分叉纪律（规范 §16）：app 类型按平台声明可执行路径，否则换系统静默失效。
  if (req.kind === 'app') {
    const platforms = req.platforms
    if (typeof platforms !== 'object' || platforms === null || Array.isArray(platforms)
      || Object.keys(platforms).length === 0) {
      errors.push({ field: 'requires.platforms', message: 'app 类型必须有非空 platforms（至少 1 个平台键）' })
    }
  }
  if (req.kind === 'command') {
    if (typeof req.command !== 'string' || (req.command as string).trim() === '') {
      errors.push({ field: 'requires.command', message: 'command 类型必须有非空 command' })
    }
  }
  if (req.kind === 'service') {
    if (typeof req.url !== 'string' || (req.url as string).trim() === '') {
      errors.push({ field: 'requires.url', message: 'service 类型必须有非空 url' })
    }
  }
  return errors
}

/**
 * 从预设配置里剥掉「不该进模块」的字段。
 *
 * 三类，各有理由（见文件头 1-3）：派生产物、模型、本地信任。
 *
 * @param profile - `agent.json` 解析结果。
 * @returns 可安全写进模块的副本（浅拷贝 + 删键，不改入参）。
 */
export function stripForModule(profile: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...profile }
  // 模型三态一律不带（用户定调「模型不打包，跟随用户实际情况」）。
  delete out.model
  delete out.subagentModel
  delete out.researchModel
  // 本地信任：导入时按来源重定（见文件头 3）。
  delete out.trust
  // 本地版本号与 spec 基线：都是本机记账，带过去会误导（`specBaseline` 会在
  // 导入后让 `refreshFromSpec` 误判「用户没改过」）。
  delete out.version
  delete out.specBaseline
  // `moduleSource` 也是本机记账（「这份预设是哪装来的、什么时候装的」），且这一层是
  // **派生**关系：导出的模块再被装一次时，安装路径会写**新的** moduleSource。
  // 带上它会泄露导出者的安装时间、并在手工检视时造成"这模块是我装的？"的误解。
  // 2026-10-11 实机核对导出包时发现漏删。
  delete out.moduleSource
  return out
}
