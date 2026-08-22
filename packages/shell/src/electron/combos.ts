/**
 * corum-shell 壳层 combo 数据模型。
 *
 * 壳（Electron 第一进程）是 combo 管理页面：读取所有已配置且可用的 combo，
 * 为每组 combo 注入环境变量 / 工作目录 / 覆盖规则，然后按 combo spawn 一个
 * 独立的 dsh host 子进程。combo 切换 = 换进程，不做进程内动态插件增删。
 *
 * 与旧版（@corum/ide-shell 插件内 combos.ts）的区别：
 * - 数据从渲染端 localStorage 迁到壳层文件（~/.corum-shell/combos.json）
 * - 新增 env / cwd / patches 三个启动注入字段（combo 的启动参数）
 * - 切换从「运行时 loader.create/remove」改为「按 combo 起新进程」
 *
 * plugins 字段决定 composition：壳层在 spawn host 时把它以
 * CORUM_COMBO_PLUGINS（逗号分隔包名）注入环境，boot 端把它作为 insert 行
 * 加入 composition（见 boot.ts resolveComboOverlays）。
 * @module corum-shell/electron/combos
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { dirname, join } from 'node:path'

/** 壳层 combo 配置文件。壳自己的数据，不通过环境变量传给 dsh 进程。 */
const COMBO_CONFIG_PATH = join(os.homedir(), '.corum-shell', 'combos.json')

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
 * 用 S0 测试插件占位，S3 替换为真实功能插件。env.CORUM_DESKTOP_MODE=ide
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
    plugins: ['@corum/ide-test-sidebar', '@corum/ide-test-conversation'],
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
    description: 'Agent 实例开发验证：AgentProfile + preset 编译 + 真正绑定能力的 root Agent',
    agentPreset: 'standard',
    plugins: ['@corum/dev-agent'],
    env: {},
    cwd: '',
    patches: [],
    icon: { type: 'lucide', value: 'bot' },
    createdAt: now,
    lastUsedAt: now,
    builtin: true,
  },
]

// ── 持久化（壳层文件） ────────────────────────────────────────────────

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
        cwd: (c.cwd as string) ?? '',
        patches: Array.isArray(c.patches) ? (c.patches as string[]) : [],
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
  writeFileSync(COMBO_CONFIG_PATH, JSON.stringify(payload, null, 2))
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
