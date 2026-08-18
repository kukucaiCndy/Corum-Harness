/**
 * Combo 数据模型 — corum Agent OS 的核心设计单元。
 *
 * Combo = 工作流 = Agent 团队：一个 Combo 包含界面布局（grid）+ 绑定的
 * agent preset（决定 Agent 团队 + MCP 工具集）+ 图标。用户双击 Combo 即
 * 加载完整工作上下文。
 *
 * 详见 docs/PLAN-combo.md。
 */

import {
  defaultGrid, serializeGrid, deserializeGrid, type GridNode, type GridSlot,
} from './grid.ts'

// ── 类型 ──────────────────────────────────────────────────────────────

/** Combo 图标：支持四种类型。 */
export interface ComboIcon {
  type: 'lucide' | 'emoji' | 'image' | 'text'
  /** lucide: 图标名 | emoji: emoji 字符 | image: corumapp:// URL | text: 1-2 字符 */
  value: string
  /** 背景色（CSS color 或 token，null = 默认品牌色） */
  background?: string | null
}

/** Combo 定义。 */
export interface Combo {
  /** 唯一 ID（slug）。 */
  id: string
  /** 用户可见名。 */
  name: string
  /** 简短描述。 */
  description: string
  /** 绑定的 agent preset 名称。决定 Agent 团队 + MCP 工具集。 */
  agentPreset: string
  /** 此 Combo 需要加载的插件包名列表。切换 Combo 时动态加载/卸载。 */
  plugins: string[]
  /** 工作台布局（grid.ts 分割树）。 */
  grid: GridNode
  /** Combo 图标。 */
  icon: ComboIcon
  /** 主题覆盖（null = 跟随全局）。 */
  theme?: 'light' | 'dark' | null
  /** 底部面板默认高度（0 = 收起）。 */
  bottomPanelHeight?: number
  /** 详情抽屉默认宽度（0 = 关闭）。 */
  detailsWidth?: number
  /** 创建时间戳。 */
  createdAt: number
  /** 最后使用时间戳。 */
  lastUsedAt: number
  /** 是否内置（不可删除）。 */
  builtin: boolean
}

// ── 内置 Combo ────────────────────────────────────────────────────────

/** 构建内置 Combo 的网格（简化定义，运行时生成 GridNode）。 */
function row(slots: { slot: GridSlot; weight: number }[]): GridNode {
  return {
    type: 'branch',
    id: `b-${Math.random().toString(36).slice(2, 7)}`,
    direction: 'row',
    children: slots.map((s) => ({ type: 'leaf' as const, id: `l-${Math.random().toString(36).slice(2, 7)}`, slot: s.slot })),
    weights: slots.map((s) => s.weight),
  }
}

const now = Date.now()

/** 内置 Combo 列表。plugins 字段当前用 S0 测试插件占位，S3 替换为真实功能插件。 */
export const BUILTIN_COMBOS: Combo[] = [
  {
    id: 'coding',
    name: '编码',
    description: '全栈编码：会话列表 + 对话 + 编辑器 + 文件树',
    agentPreset: 'standard',
    plugins: ['@corum/ide-test-sidebar', '@corum/ide-test-conversation'],
    grid: row([
      { slot: 'corum.sidebar', weight: 280 },
      { slot: 'conversation', weight: 800 },
      { slot: 'corum.editor', weight: 430 },
      { slot: 'corum.explorer', weight: 210 },
    ]),
    icon: { type: 'lucide', value: 'code-2' },
    bottomPanelHeight: 0,
    detailsWidth: 0,
    createdAt: now,
    lastUsedAt: now,
    builtin: true,
  },
  {
    id: 'design',
    name: '设计',
    description: 'UI/UX 设计：Pencil MCP 产设计稿',
    agentPreset: 'designer',
    plugins: ['@corum/ide-test-sidebar', '@corum/ide-test-conversation'],
    grid: row([
      { slot: 'corum.sidebar', weight: 280 },
      { slot: 'conversation', weight: 800 },
      { slot: 'corum.explorer', weight: 210 },
    ]),
    icon: { type: 'lucide', value: 'palette' },
    bottomPanelHeight: 0,
    detailsWidth: 0,
    createdAt: now,
    lastUsedAt: now,
    builtin: true,
  },
  {
    id: 'debug',
    name: '调试',
    description: '调试排障：终端 + 编辑器 + 对话',
    agentPreset: 'standard',
    plugins: ['@corum/ide-test-sidebar', '@corum/ide-test-conversation', '@corum/ide-test-panel'],
    grid: row([
      { slot: 'corum.sidebar', weight: 280 },
      { slot: 'conversation', weight: 600 },
      { slot: 'corum.editor', weight: 430 },
    ]),
    icon: { type: 'lucide', value: 'bug' },
    bottomPanelHeight: 150,
    detailsWidth: 0,
    createdAt: now,
    lastUsedAt: now,
    builtin: true,
  },
  {
    id: 'minimal',
    name: '极简',
    description: '纯对话：极简聊天',
    agentPreset: 'minimal',
    plugins: ['@corum/ide-test-conversation'],
    grid: row([{ slot: 'conversation', weight: 1200 }]),
    icon: { type: 'lucide', value: 'message-circle' },
    bottomPanelHeight: 0,
    detailsWidth: 0,
    createdAt: now,
    lastUsedAt: now,
    builtin: true,
  },
  {
    id: 'frontend',
    name: '前端',
    description: '前端开发：Chrome DevTools + Pencil 读设计稿',
    agentPreset: 'frontend',
    plugins: ['@corum/ide-test-sidebar', '@corum/ide-test-conversation'],
    grid: row([
      { slot: 'corum.sidebar', weight: 280 },
      { slot: 'conversation', weight: 800 },
      { slot: 'corum.editor', weight: 430 },
      { slot: 'corum.explorer', weight: 210 },
    ]),
    icon: { type: 'lucide', value: 'monitor-smartphone' },
    bottomPanelHeight: 0,
    detailsWidth: 0,
    createdAt: now,
    lastUsedAt: now,
    builtin: true,
  },
]

// ── 持久化 ────────────────────────────────────────────────────────────

const COMBOS_KEY = 'corum.ide.combos.v1'
const CURRENT_COMBO_KEY = 'corum.ide.current-combo'

/** 序列化 Combo（grid 用 serializeGrid 压缩）。 */
export function serializeCombo(combo: Combo): string {
  return JSON.stringify({
    id: combo.id,
    name: combo.name,
    description: combo.description,
    agentPreset: combo.agentPreset,
    plugins: combo.plugins,
    grid: JSON.parse(serializeGrid(combo.grid)),
    icon: combo.icon,
    theme: combo.theme ?? null,
    bottomPanelHeight: combo.bottomPanelHeight ?? 0,
    detailsWidth: combo.detailsWidth ?? 0,
    createdAt: combo.createdAt,
    lastUsedAt: combo.lastUsedAt,
    builtin: combo.builtin,
  })
}

/** 反序列化 Combo（grid 用 deserializeGrid 重建）。 */
export function deserializeCombo(json: string): Combo | null {
  try {
    const raw = JSON.parse(json) as Record<string, unknown>
    if (typeof raw.id !== 'string' || typeof raw.name !== 'string') return null
    const gridJson = JSON.stringify(raw.grid)
    const grid = deserializeGrid(gridJson) ?? defaultGrid()
    return {
      id: raw.id,
      name: raw.name as string,
      description: raw.description as string ?? '',
      agentPreset: raw.agentPreset as string ?? 'standard',
      plugins: Array.isArray(raw.plugins) ? raw.plugins as string[] : [],
      grid,
      icon: raw.icon as ComboIcon ?? { type: 'text', value: '?' },
      theme: raw.theme as 'light' | 'dark' | null ?? null,
      bottomPanelHeight: raw.bottomPanelHeight as number ?? 0,
      detailsWidth: raw.detailsWidth as number ?? 0,
      createdAt: raw.createdAt as number ?? Date.now(),
      lastUsedAt: raw.lastUsedAt as number ?? Date.now(),
      builtin: raw.builtin === true,
    }
  } catch {
    return null
  }
}

/** 读取所有 Combo（内置 + 用户自定义）。 */
export function loadAllCombos(): Combo[] {
  const userCombos: Combo[] = []
  if (typeof localStorage !== 'undefined') {
    const raw = localStorage.getItem(COMBOS_KEY)
    if (raw !== null) {
      try {
        const arr = JSON.parse(raw) as string[]
        for (const json of arr) {
          const combo = deserializeCombo(json)
          if (combo !== null) userCombos.push(combo)
        }
      } catch { /* corrupted — ignore */ }
    }
  }
  // 内置 Combo 优先，用户 Combo 在后
  return [...BUILTIN_COMBOS, ...userCombos]
}

/** 保存用户 Combo 列表（不含内置）。 */
export function saveUserCombos(combos: Combo[]): void {
  if (typeof localStorage === 'undefined') return
  const userCombos = combos.filter((c) => !c.builtin)
  const arr = userCombos.map(serializeCombo)
  localStorage.setItem(COMBOS_KEY, JSON.stringify(arr))
}

/** 读取上次使用的 Combo ID。 */
export function loadCurrentComboId(): string | null {
  if (typeof localStorage === 'undefined') return null
  return localStorage.getItem(CURRENT_COMBO_KEY)
}

/** 记录当前 Combo ID。 */
export function saveCurrentComboId(id: string): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(CURRENT_COMBO_KEY, id)
}

/** 按 ID 查找 Combo。 */
export function findCombo(id: string): Combo | null {
  return loadAllCombos().find((c) => c.id === id) ?? null
}

/** 保存一个新 Combo（用户自定义）。 */
export function addUserCombo(combo: Combo): void {
  const all = loadAllCombos()
  all.push(combo)
  saveUserCombos(all)
}

/** 更新已有 Combo（内置只更新 grid/panel/details，用户可全改）。 */
export function updateCombo(id: string, updates: Partial<Combo>): void {
  const all = loadAllCombos()
  const idx = all.findIndex((c) => c.id === id)
  if (idx === -1) return
  const original = all[idx]
  if (original.builtin) {
    // 内置：只更新布局和面板配置
    all[idx] = {
      ...original,
      grid: updates.grid ?? original.grid,
      bottomPanelHeight: updates.bottomPanelHeight ?? original.bottomPanelHeight ?? 0,
      detailsWidth: updates.detailsWidth ?? original.detailsWidth ?? 0,
      lastUsedAt: Date.now(),
    }
  } else {
    // 用户：全可改
    all[idx] = { ...original, ...updates, lastUsedAt: Date.now() }
  }
  saveUserCombos(all)
}

/** 删除用户 Combo（内置不可删）。 */
export function deleteCombo(id: string): void {
  const all = loadAllCombos()
  const filtered = all.filter((c) => !(c.id === id && !c.builtin))
  saveUserCombos(filtered)
}

// ── URL 路由 ───────────────────────────────────────────────────────────

/** 从 URL 参数读取当前 Combo ID（?combo=<id>）。 */
export function getComboIdFromUrl(): string | null {
  if (typeof window === 'undefined') return null
  const id = new URLSearchParams(window.location.search).get('combo')
  return id === null || id === '' ? null : id
}

/** 跳转到某 Combo（修改 URL 参数，不刷新页面）。 */
export function navigateToCombo(id: string | null): void {
  const url = new URL(window.location.href)
  if (id === null) {
    url.searchParams.delete('combo')
  } else {
    url.searchParams.set('combo', id)
  }
  window.history.pushState({}, '', url.toString())
}
