/**
 * corum-desktop 壳层 combo 数据模型。
 *
 * 壳（Electron 第一进程）是 combo 管理页面：读取所有已配置且可用的 combo，
 * 为每组 combo 注入环境变量 / 工作目录 / 覆盖规则，然后按 combo spawn 一个
 * 独立的 dsh host 子进程。combo 切换 = 换进程，不做进程内动态插件增删。
 *
 * 与旧版（@corum/corum-ide-ui 插件内 combos.ts）的区别：
 * - 数据从渲染端 localStorage 迁到壳层文件（~/.corum-desktop/combos.json）
 * - 新增 env / cwd / patches 三个启动注入字段（combo 的启动参数）
 * - 切换从「运行时 loader.create/remove」改为「按 combo 起新进程」
 *
 * plugins 字段决定 composition：壳层在 spawn host 时把它以
 * CORUM_COMBO_PLUGINS（逗号分隔包名）注入环境，boot 端把它作为 insert 行
 * 加入 composition（见 boot.ts resolveComboOverlays）。
 * @module corum-desktop/electron/combos
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

/** 壳层 combo 配置文件。壳自己的数据，不通过环境变量传给 dsh 进程。 */
const COMBO_CONFIG_PATH = join(os.homedir(), '.corum-desktop', 'combos.json')

/** Combo 图标：四种类型。 */
export interface ComboIcon {
  type: 'lucide' | 'emoji' | 'image' | 'text'
  /** lucide: 图标名 | emoji: emoji 字符 | image: URL | text: 1-2 字符 */
  value: string
  /** 背景色（CSS color 或 token，null = 默认品牌色）。 */
  background?: string | null
}

/** Combo 定义（壳层模型）。 */
export interface Combo {
  /** 唯一 ID（slug）。 */
  id: string
  /** 用户可见名。 */
  name: string
  /** 简短描述。 */
  description: string
  /** 绑定的 agent preset 名称。决定 Agent 团队 + MCP 工具集。 */
  agentPreset: string
  /** 此 Combo 需要加载的插件包名列表。启动时以 CORUM_COMBO_PLUGINS 注入。 */
  plugins: string[]
  /** 注入给 dsh host 子进程的环境变量（如 CORUM_DESKTOP_MODE=ide）。 */
  env: Record<string, string>
  /** 注入给 dsh host 子进程的工作目录（空 = 继承壳进程）。 */
  cwd: string
  /** 额外覆盖规则（patch 文件绝对路径列表），boot 时作为最高 patch 层叠加。 */
  patches: string[]
  /** Combo 图标。 */
  icon: ComboIcon
  /** 主题覆盖（null = 跟随全局）。 */
  theme?: 'light' | 'dark' | null
  /** 创建时间戳。 */
  createdAt: number
  /** 最后使用时间戳。 */
  lastUsedAt: number
  /** 是否内置（不可删除）。 */
  builtin: boolean
}

// ── 内置 Combo ────────────────────────────────────────────────────────

const now = Date.now()

/**
 * 内置 Combo：当前只保留 IDE（coding）一个。combo 是独立 Agent 应用的启动
 * 入口，后续新应用通过用户自定义 combo 或新增内置项扩展。plugins 字段当前
 * 用 S0 测试插件占位，S3 替换为真实功能插件。`corum-agent-dev` 为 IDE 侧栏
 * 提供 corumProject RPC（项目列表 / 打开 / 创建）。env.CORUM_DESKTOP_MODE=ide
 * 使 boot 叠加 IDE overlay（cordis.ide.patch.yml）。
 *
 * agentPreset 仅记录该 combo 的默认 Agent；combo 未来可能管理多个 Agent，
 * 该字段不限定 combo 内的 Agent 数量。
 */
export const BUILTIN_COMBOS: Combo[] = [
  {
    id: 'coding',
    name: '编码',
    description: '全栈编码：会话列表 + 对话 + 编辑器 + 文件树',
    agentPreset: 'standard',
    plugins: ['@corum/corum-agent-dev'],
    env: { CORUM_DESKTOP_MODE: 'ide' },
    cwd: '',
    patches: [],
    icon: { type: 'lucide', value: 'code-2' },
    createdAt: now,
    lastUsedAt: now,
    builtin: true,
  },
  {
    id: 'dev-agent',
    name: 'Agent 开发',
    description: 'Agent 实例开发验证：AgentProfile + preset 编译 + 真正绑定能力的 root Agent + 交互测试 UI',
    agentPreset: 'standard',
    plugins: ['@corum/corum-agent-dev', '@corum/corum-agent-ui-dev', '@corum/corum-skill-manager-dev', '@corum/corum-mcp-manager-dev'],
    env: { CORUM_DESKTOP_MODE: 'dev-agent' },
    cwd: '',
    patches: [],
    icon: { type: 'lucide', value: 'bot' },
    createdAt: now,
    lastUsedAt: now,
    builtin: true,
  },
]

// ── 持久化（壳层文件） ────────────────────────────────────────────────

/**
 * 校验 combo.cwd（S2）：非空时必须是「存在的绝对路径目录」。cwd 决定 host
 * 子进程的工作目录，来自用户可写的 combos.json，无校验会把 host 起到任意目录。
 * 非法时降级为空（继承壳进程 cwd）并 warn（对齐 sanitizeComboEnv 的告警风格），
 * 不拒绝整个 combo（cwd 只是启动便利项，不是能力入口）。
 * @returns 合法原样返回；非法返回 '' 并写 stderr 告警。
 */
function sanitizeComboCwd(comboId: string, cwd: string): string {
  if (cwd === '') return ''
  if (!isAbsolute(cwd)) {
    process.stderr.write(`[corum-desktop] combo "${comboId}" cwd dropped (not an absolute path): ${cwd}\n`)
    return ''
  }
  try {
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      process.stderr.write(`[corum-desktop] combo "${comboId}" cwd dropped (not an existing directory): ${cwd}\n`)
      return ''
    }
  } catch {
    process.stderr.write(`[corum-desktop] combo "${comboId}" cwd dropped (stat failed): ${cwd}\n`)
    return ''
  }
  return cwd
}

/**
 * 校验 combo.patches（S2）：每个路径必须「存在且是 .yml/.yaml 文件」。patches
 * 会作为最高 patch 层叠加进 boot composition（高权限入口），来自用户可写的
 * combos.json，无校验可把任意 yml 注进 host。非法路径逐条剔除并 warn（对齐
 * sanitizeComboEnv 的告警风格），合法项保留。
 * @returns 剔除非法项后的新数组（不修改入参）。
 */
function sanitizeComboPatches(comboId: string, patches: string[]): string[] {
  const out: string[] = []
  for (const patch of patches) {
    if (typeof patch !== 'string' || patch === '') continue
    if (!/\.(ya?ml)$/i.test(patch)) {
      process.stderr.write(`[corum-desktop] combo "${comboId}" patch dropped (not a .yml/.yaml file): ${patch}\n`)
      continue
    }
    try {
      if (!existsSync(patch) || !statSync(patch).isFile()) {
        process.stderr.write(`[corum-desktop] combo "${comboId}" patch dropped (not an existing file): ${patch}\n`)
        continue
      }
    } catch {
      process.stderr.write(`[corum-desktop] combo "${comboId}" patch dropped (stat failed): ${patch}\n`)
      continue
    }
    out.push(patch)
  }
  return out
}

function readUserCombos(): Combo[] {
  if (!existsSync(COMBO_CONFIG_PATH)) return []
  try {
    const raw = JSON.parse(readFileSync(COMBO_CONFIG_PATH, 'utf8')) as unknown
    if (!Array.isArray(raw)) return []
    const combos: Combo[] = []
    for (const item of raw) {
      const c = item as Record<string, unknown>
      if (typeof c.id !== 'string' || typeof c.name !== 'string') continue
      combos.push({
        id: c.id,
        name: c.name,
        description: (c.description as string) ?? '',
        agentPreset: (c.agentPreset as string) ?? 'standard',
        plugins: Array.isArray(c.plugins) ? (c.plugins as string[]) : [],
        env: c.env !== null && typeof c.env === 'object' ? (c.env as Record<string, string>) : {},
        cwd: sanitizeComboCwd(c.id, (c.cwd as string) ?? ''),
        patches: sanitizeComboPatches(c.id, Array.isArray(c.patches) ? (c.patches as string[]) : []),
        icon: (c.icon as ComboIcon) ?? { type: 'text', value: '?' },
        theme: (c.theme as 'light' | 'dark' | null) ?? null,
        createdAt: (c.createdAt as number) ?? Date.now(),
        lastUsedAt: (c.lastUsedAt as number) ?? Date.now(),
        builtin: c.builtin === true,
      })
    }
    return combos
  } catch {
    return [] // corrupted — ignore
  }
}

function writeUserCombos(combos: Combo[]): void {
  const dir = dirname(COMBO_CONFIG_PATH)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const payload = combos.filter(c => !c.builtin).map(c => ({
    ...c,
    theme: c.theme ?? null,
  }))
  // 原子写：先写同目录临时文件再 rename 覆盖——直接截断写在进程崩溃/断电时
  // 会把全部用户 combo 丢成空文件（同目录保证 rename 同文件系统，语义原子）。
  const tmp = `${COMBO_CONFIG_PATH}.tmp`
  writeFileSync(tmp, JSON.stringify(payload, null, 2))
  renameSync(tmp, COMBO_CONFIG_PATH)
}

// ── combo env 注入黑名单 ─────────────────────────────────────────────

/**
 * 禁止 combo.env 注入的危险环境变量（大小写不敏感精确匹配）：这些 key 会改变
 * Node 解释器/动态链接器的启动行为，被注入即等于在 host 子进程里执行任意代码
 * （如 ELECTRON_RUN_AS_NODE 让 Electron 变 Node、NODE_OPTIONS=--require 注入
 * 任意脚本、DYLD_INSERT_LIBRARIES 注入动态库）。语义对齐官方 BOOTSTRAP_NAMES
 * （dsh app-boot）里「进程启动与模块解析」一类，但收敛为本壳实际危险的清单。
 */
const COMBO_ENV_BLOCKLIST = new Set([
  'NODE_OPTIONS',
  'NODE_PATH',
  'ELECTRON_RUN_AS_NODE',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
])

/**
 * 过滤 combo.env：剔除黑名单 key 并逐条告警（stderr）。combo 定义来自用户可
 * 写的 ~/.corum-desktop/combos.json，env 直进 host 子进程 spawn，必须钳制。
 * @returns 剔除危险 key 后的新对象（不修改入参）。
 */
export function sanitizeComboEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (COMBO_ENV_BLOCKLIST.has(key.toUpperCase())) {
      process.stderr.write(`[corum-desktop] combo env key blocked (interpreter/linker takeover risk): ${key}\n`)
      continue
    }
    out[key] = value
  }
  return out
}

/** 读取所有 Combo（内置 + 用户自定义）。 */
export function loadAllCombos(): Combo[] {
  return [...BUILTIN_COMBOS, ...readUserCombos()]
}

/** 按 ID 查找 Combo。 */
export function findCombo(id: string): Combo | null {
  return loadAllCombos().find(c => c.id === id) ?? null
}

/** 记录 Combo 最后使用时间（内置同样更新文件时间戳语义除外：内置只落内存）。 */
export function touchCombo(id: string): Combo | null {
  const all = loadAllCombos()
  const combo = all.find(c => c.id === id)
  if (combo === undefined) return null
  combo.lastUsedAt = Date.now()
  if (!combo.builtin) writeUserCombos(all)
  return combo
}

/** 保存一个用户 Combo（更新或新增；内置不可通过此路径覆盖启动参数）。 */
export function saveCombo(combo: Combo): void {
  const all = loadAllCombos()
  const idx = all.findIndex(c => c.id === combo.id && !c.builtin)
  if (idx === -1) {
    all.push(combo)
  } else {
    all[idx] = { ...combo, lastUsedAt: Date.now() }
  }
  writeUserCombos(all)
}

/** 删除用户 Combo（内置不可删）。 */
export function deleteCombo(id: string): boolean {
  const all = loadAllCombos()
  const target = all.find(c => c.id === id)
  if (target === undefined || target.builtin) return false
  writeUserCombos(all.filter(c => !(c.id === id && !c.builtin)))
  return true
}
