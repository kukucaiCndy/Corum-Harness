/**
 * 强调色真源（PRD v2 §4.3.2 AP2）。
 *
 * ## 为什么放在这里（而不是新建 settings ns）
 *
 * PRD 记 AP2「强调色 ❌ 无真源 ⇒ 需新建」。本仓已有**成熟的等价先例**：
 * 纯 UI 偏好走 `corum.*` localStorage 键（`corum.diff.sideBySide`、
 * `corum.settings.developerMode` —— 后者在 PRD 里被记为 ✅ 真实项）。
 * 强调色是同一类东西：**只影响观感、无跨 bundle 语义**，故沿用同一模式，
 * 不为此新增 host 侧 settings 段（那需要 host 插件改动 + 重启 + 三层验证）。
 *
 * ⚠️ 若将来要求「强调色随 settings.yaml 同步/可导出」，再迁到 settings ns；
 * 届时本模块只改 `read`/`write` 两个函数即可，消费方不变。
 *
 * ## 如何生效
 *
 * 经 `ctx.theme.overrideTokens('corum-accent', tokens)` 叠加**第二层** token 覆盖
 * （第一层是 `theme-layer.ts` 的 `corum-glass`；官方实现允许按 source 叠加多层）。
 * 覆盖 `--dsw-alias-brand-primary` / `-brand-text` / `-button-primary-fill`
 * 三个品牌 token，各带 light/dark 一对值 —— 与 `GLASS_TOKENS` 同构，
 * 因此切换明暗主题时**不会失配**。
 *
 * ## 本模块是同一 bundle 内的模块级 store（不违反红线 1）
 *
 * 消费方（`index.tsx` 注册覆盖层、`SettingsAppearanceSection` 选色）都在
 * **同一个 `corum-ide-ui` bundle** 内 ⇒ 模块级单例安全。
 * 红线 1 禁止的是**跨 bundle** 的 window 全局/模块单例，不是同 bundle 内共享。
 *
 * @module corum-ide-ui/client/appearance-accent
 */

import type { ThemeTokenOverrides } from '@deepseek-ai/dsh-client-ui-theme/client'

/** 持久化键（沿用 `corum.*` UI 偏好命名）。 */
const ACCENT_KEY = 'corum.appearance.accent'

/** 一个强调色选项：id + 展示名 + 明/暗两套值。 */
export interface AccentOption {
  /** 稳定 id（持久化用）。 */
  readonly id: string
  /** 展示名。 */
  readonly label: string
  /** 浅色主题下的值。 */
  readonly light: string
  /** 深色主题下的值。 */
  readonly dark: string
}

/**
 * 内置强调色。
 *
 * 第一项 `violet` 的取值**与 `theme-layer.ts` 的 `GLASS_TOKENS` 品牌值完全一致**
 * （浅 `#5B21F5` / 深 `#01CDFE`）⇒ 选它等价于「默认」，不会产生视觉跳变。
 */
export const ACCENT_OPTIONS: readonly AccentOption[] = [
  { id: 'violet', label: '电紫（默认）', light: '#5B21F5', dark: '#01CDFE' },
  { id: 'indigo', label: '靓蓝', light: '#3A3EA8', dark: '#A9ACFF' },
  { id: 'green', label: '青绿', light: '#0BA57C', dark: '#3EE6B0' },
  { id: 'amber', label: '琥珀', light: '#C2410C', dark: '#FFB45C' },
]

/** 默认强调色 id。 */
export const DEFAULT_ACCENT_ID = 'violet'

/** 强调色驱动的品牌 token（与 GLASS_TOKENS 的键同名，靠 source 分层覆盖）。 */
const ACCENT_TOKEN_NAMES = [
  '--dsw-alias-brand-primary',
  '--dsw-alias-brand-text',
  '--dsw-alias-button-primary-fill',
] as const

/**
 * 读持久化的强调色 id（异常 / 未知 id 一律回落默认）。
 * @returns 生效的强调色 id。
 */
export function readAccentId(): string {
  if (typeof localStorage === 'undefined') return DEFAULT_ACCENT_ID
  try {
    const raw = localStorage.getItem(ACCENT_KEY)
    if (raw === null) return DEFAULT_ACCENT_ID
    // pink 已由 indigo 替代；迁移旧偏好，避免换肤后用户选择静默回落默认 violet。
    if (raw === 'pink') return 'indigo'
    return ACCENT_OPTIONS.some(o => o.id === raw) ? raw : DEFAULT_ACCENT_ID
  } catch {
    return DEFAULT_ACCENT_ID
  }
}

/** 订阅者集合（同 bundle 内共享）。 */
const listeners = new Set<() => void>()

/** 当前强调色 id（内存镜像，避免每次读 localStorage）。 */
let currentId: string | null = null

/**
 * 取当前强调色 id（首次调用时从 localStorage 惰性读取）。
 * @returns 生效的强调色 id。
 */
export function getAccentId(): string {
  if (currentId === null) currentId = readAccentId()
  return currentId
}

/**
 * 设置强调色并持久化，随后通知订阅者（Shell 据此重注册 token 覆盖层）。
 * @param id - 目标强调色 id；未知 id 回落默认。
 */
export function setAccentId(id: string): void {
  const next = ACCENT_OPTIONS.some(o => o.id === id) ? id : DEFAULT_ACCENT_ID
  if (next === getAccentId()) return
  currentId = next
  try {
    localStorage.setItem(ACCENT_KEY, next)
  } catch { /* 容量满 / 隐私模式：仅本次会话生效 */ }
  for (const fn of listeners) fn()
}

/**
 * 订阅强调色变更。
 * @param fn - 变更回调。
 * @returns 取消订阅。
 */
export function subscribeAccent(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/**
 * 由强调色 id 生成 token 覆盖层。
 * @param id - 强调色 id。
 * @returns 三个品牌 token 的明/暗取值。
 */
export function accentTokens(id: string = getAccentId()): ThemeTokenOverrides {
  const opt = ACCENT_OPTIONS.find(o => o.id === id) ?? ACCENT_OPTIONS[0]
  const tokens: Record<string, { light: string; dark: string }> = {}
  for (const name of ACCENT_TOKEN_NAMES) {
    tokens[name] = { light: opt.light, dark: opt.dark }
  }
  return tokens as ThemeTokenOverrides
}
