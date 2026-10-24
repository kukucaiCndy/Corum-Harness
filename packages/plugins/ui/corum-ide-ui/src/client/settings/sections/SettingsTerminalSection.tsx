/**
 * SettingsTerminalSection — 终端分区（PRD v2 §4.2）。
 *
 * ## M3「终端收拢」：从纯空壳改为接线
 *
 * 本页原先是**纯空壳**：5 个控件全部是空回调，**不读任何字段**
 * （`useCorumSettings` / `settingsScope` 命中数 = 0），且「超时」硬编码显示 `120s`。
 * 而真源 `shell` ns 的字段是**真实存在**的 ⇒ 现按 PRD §4.2 接线。
 * ⚠️ 此处**故意不写出空回调的字面形式**：写了会让「全仓审计空回调」的脚本
 * 命中本注释自身（本项目已因此踩过四次同类问题）。
 *
 * ## 甲类 / 乙类分组（用户裁定 `Q3`）
 *
 * | 类 | 组标题 | 语义 | 真源 |
 * |---|---|---|---|
 * | **甲类** | shell 护栏（**影响 AI 行为**）| Agent 跑命令时的沙箱与护栏 | ✅ `shell` ns |
 * | **乙类** | 内置终端外观（**只影响你的观感**）| 只在终端内的字体字号 | ❌ 需新建 |
 *
 * ⚠️ 分组的**唯一目的是让用户分清「这个开关会不会改变 AI 的行为」** ——
 * 甲类改了会影响 Agent 执行命令，乙类只影响自己看起来怎样。
 *
 * ## 真源字段（`SHELL_SETTINGS_NAMESPACE = 'shell'`，bash 与 pwsh **共用**同一 ns）
 *
 * | 字段 | schema 默认 | 说明 |
 * |---|---|---|
 * | `cwd` | （无默认，由组合配置给） | 工作目录 |
 * | `timeoutMs` | `120_000` | 单次命令最长等待 |
 * | `maxTimeoutMs` | `600_000` | 超时上限 |
 * | `maxOutputBytes` | `64_000` | 输出保留上限 |
 * | `maxSpillBytes` | 组合默认 | 溢出落盘上限 |
 * | `graceMs` | 组合默认 | 终止宽限 |
 *
 * ⚠️ **不再硬编码示例值**：显示的一律是 `describe` 镜像里**合成后的真值**
 * （`user` 用户覆盖 → 否则 `value` 合成值 → 否则 schema 默认）。
 * 这正是原实现最大的问题 —— 它显示 `120s` 而从不读真源，用户看到的是**猜的**。
 *
 * ⚠️ 「默认 shell」**不是本 ns 的字段**（ns 里没有 shell 选择字段）⇒ 标未上线，
 * 不再假装可配。
 *
 * @module corum-ide-ui/client/settings/sections/SettingsTerminalSection
 */

import { useContext, useEffect, useState, useSyncExternalStore } from 'react'
import { SettingGroup } from '../SettingGroup.tsx'
import { SettingRow } from '../SettingRow.tsx'
import { SelectField } from '../SelectField.tsx'
import { Badge } from '../Badge.tsx'
import { GlassButton, useFontPrefs } from '../shared.tsx'
import { CorumSettingsContext } from '../shared.tsx'
import css from '../SettingsSections.module.css'

/* ── 终端（PRD §4.2）──────────────────────────────────────────────── */

/** shell 执行器的设置 namespace（bash 与 pwsh 共用）。 */
const SHELL_NS = 'shell'

/** 未上线 badge（PRD §6.1）。 */
const OFFLINE = <Badge label="未上线" variant="offline" />

/** 空回调：未上线控件均 `disabled`，此函数不可达。 */
const noop = () => { /* 控件已禁用，不可达 */ }

/** `shell` ns 的用户层/合成层形。 */
interface ShellView {
  cwd?: string
  timeoutMs?: number
  maxTimeoutMs?: number
  maxOutputBytes?: number
  maxSpillBytes?: number
  graceMs?: number
}

/** 秒 → 毫秒候选（真源以 ms 存储，UI 以秒呈现更易读）。 */
const SEC_OPTIONS = [30, 60, 120, 300, 600, 900].map(s => ({ id: String(s * 1000), label: `${s}s` }))
/** 输出上限候选（字节）。 */
const BYTES_OPTIONS = [32_000, 64_000, 128_000, 256_000, 1_048_576].map(b => ({ id: String(b), label: `${Math.round(b / 1024)} KB` }))

/**
 * 终端分区：甲类 shell 护栏（已接线）+ 乙类内置终端外观（未上线）。
 *
 * @returns the terminal settings section.
 */
export function TerminalSection() {
  const settings = useContext(CorumSettingsContext)
  const [, force] = useState(0)
  useEffect(() => {
    if (settings === null) return undefined
    void settings.describe.ensure()
    return settings.describe.subscribe(() => { force(v => v + 1) })
  }, [settings])

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cwdDraft, setCwdDraft] = useState<string | null>(null)

  if (settings === null) return <p style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>settings 服务未就绪。</p>

  const snapshot = settings.describe.getSnapshot()
  const ns = snapshot.view?.namespaces.find(n => n.ns === SHELL_NS)
  const user = (ns?.user ?? {}) as ShellView
  const resolved = (ns?.value ?? {}) as ShellView
  const writable = snapshot.view?.writable === true
  const loading = snapshot.status === 'loading' || snapshot.status === 'idle'
  const disabled = !writable || busy || loading

  /**
   * 写入 `shell` ns 的单键。
   *
   * @param field - 字段名。
   * @param value - 新值；`undefined` 表示清除覆盖、回落合成值。
   */
  const apply = async (field: string, value: unknown): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const ops = value === undefined
        ? [{ op: 'unset' as const, path: [field] }]
        : [{ op: 'set' as const, path: [field], value }]
      const res = await settings.mutate(SHELL_NS, ops, ns?.revision)
      if (!res.ok) setError(res.error?.message ?? '写入失败')
      else if (res.value !== undefined) settings.describe.acceptView(res.value)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  /** 该字段是否被用户覆盖过。 */
  const overridden = (field: keyof ShellView): boolean => user[field] !== undefined

  const cwdValue = cwdDraft ?? user.cwd ?? resolved.cwd ?? ''

  // 乙类终端字面真源（fontPrefs cordis 服务，跨 bundle 单例；context 下发）。
  const fontPrefs = useFontPrefs()
  const font = useSyncExternalStore(
    (listener) => fontPrefs?.subscribe(listener) ?? (() => {}),
    () => fontPrefs?.getPrefs() ?? null,
  )
  const fontReady = fontPrefs !== null && font !== null
  const terminalFont = font?.terminal
  /** 字族受控输入草稿（失焦写回；null = 未编辑，跟随真源）。 */
  const [familyDraft, setFamilyDraft] = useState<string | null>(null)
  useEffect(() => { setFamilyDraft(null) }, [terminalFont?.fontFamily])
  /** 字号候选（含当前真源值置顶）。 */
  const termSizeOptions = (current: number): { id: string; label: string }[] =>
    [current, ...[10, 11, 12, 13, 14, 15, 16, 18, 20].filter(v => v !== current)]
      .map(v => ({ id: String(v), label: String(v) }))

  return (
    <>
      {error !== null && <p style={{ color: 'var(--dsw-alias-state-error-primary)', fontSize: 12 }}>{error}</p>}
      <SettingGroup title="甲类 · shell 护栏（影响 AI 行为）">
        <SettingRow
          label="默认 shell"
          desc="新建终端会话使用的 shell 解释器。⚠️ 不在 shell 设置 ns 内，尚无真源。"
          badge={OFFLINE}
        >
          <SelectField value="none" options={[{ id: 'none', label: '未上线' }]} onChange={noop} disabled />
        </SettingRow>
        <SettingRow
          label="工作目录 cwd"
          desc="Agent 执行命令时的初始工作目录。"
          badge={overridden('cwd') ? <Badge label="已修改" /> : undefined}
        >
          <input
            className={css.textInput}
            value={cwdValue}
            placeholder={resolved.cwd ?? '（由组合配置提供）'}
            disabled={disabled}
            onChange={e => { setCwdDraft(e.target.value) }}
            onBlur={() => {
              if (cwdDraft === null) return
              const raw = cwdDraft.trim()
              setCwdDraft(null)
              if (raw === '') { void apply('cwd', undefined); return }
              if (raw !== (user.cwd ?? resolved.cwd ?? '')) void apply('cwd', raw)
            }}
          />
        </SettingRow>
        <SettingRow
          label="超时 timeoutMs"
          desc={`单次命令执行的最长等待时间。当前 ${resolved.timeoutMs ?? '（未提供）'} ms`}
          badge={overridden('timeoutMs') ? <Badge label="已修改" /> : undefined}
        >
          <SelectField
            value={String(user.timeoutMs ?? resolved.timeoutMs ?? 120000)}
            options={[{ id: String(resolved.timeoutMs ?? 120000), label: `${Math.round((resolved.timeoutMs ?? 120000) / 1000)}s（当前）` }].concat(SEC_OPTIONS.filter(o => Number(o.id) !== (resolved.timeoutMs ?? 120000)))}
            disabled={disabled}
            onChange={id => { void apply('timeoutMs', Number(id)) }}
          />
        </SettingRow>
        <SettingRow
          label="最大超时 maxTimeoutMs"
          desc={`超时上限，超过将被强制终止。当前 ${resolved.maxTimeoutMs ?? '（未提供）'} ms`}
          badge={overridden('maxTimeoutMs') ? <Badge label="已修改" /> : undefined}
        >
          <SelectField
            value={String(user.maxTimeoutMs ?? resolved.maxTimeoutMs ?? 600000)}
            options={[{ id: String(resolved.maxTimeoutMs ?? 600000), label: `${Math.round((resolved.maxTimeoutMs ?? 600000) / 1000)}s（当前）` }].concat(SEC_OPTIONS.filter(o => Number(o.id) !== (resolved.maxTimeoutMs ?? 600000)))}
            disabled={disabled}
            onChange={id => { void apply('maxTimeoutMs', Number(id)) }}
          />
        </SettingRow>
        <SettingRow
          label="最大输出 maxOutputBytes"
          desc={`命令输出的最大保留字节数。当前 ${resolved.maxOutputBytes ?? '（未提供）'} 字节`}
          badge={overridden('maxOutputBytes') ? <Badge label="已修改" /> : undefined}
          divider={false}
        >
          <SelectField
            value={String(user.maxOutputBytes ?? resolved.maxOutputBytes ?? 64000)}
            options={[{ id: String(resolved.maxOutputBytes ?? 64000), label: `${Math.round((resolved.maxOutputBytes ?? 64000) / 1024)} KB（当前）` }].concat(BYTES_OPTIONS.filter(o => Number(o.id) !== (resolved.maxOutputBytes ?? 64000)))}
            disabled={disabled}
            onChange={id => { void apply('maxOutputBytes', Number(id)) }}
          />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="乙类 · 内置终端外观（只影响你的观感）">
        <SettingRow label="终端字体" desc="**仅内置终端内**生效的等宽字族（含回退栈，失焦写回；空 = 回落默认）。与外观页、编辑器页各自独立。" badge={fontReady ? undefined : OFFLINE}>
          <input
            className={css.textInput}
            value={familyDraft ?? terminalFont?.fontFamily ?? ''}
            placeholder="'JetBrains Mono', 'SFMono-Regular', 'Menlo', monospace"
            disabled={!fontReady}
            onChange={e => { setFamilyDraft(e.target.value) }}
            onBlur={() => {
              if (familyDraft === null) return
              const raw = familyDraft.trim()
              setFamilyDraft(null)
              if (raw !== (terminalFont?.fontFamily ?? '')) fontPrefs?.setPrefs({ terminal: { fontFamily: raw } })
            }}
          />
        </SettingRow>
        <SettingRow label="终端字号" desc="仅内置终端内的文字大小（px，实时生效）。" badge={fontReady ? undefined : OFFLINE} divider={false}>
          <SelectField
            value={String(terminalFont?.fontSize ?? 13)}
            options={termSizeOptions(terminalFont?.fontSize ?? 13)}
            onChange={id => { fontPrefs?.setPrefs({ terminal: { fontSize: Number(id) } }) }}
            disabled={!fontReady}
          />
        </SettingRow>
      </SettingGroup>
    </>
  )
}
