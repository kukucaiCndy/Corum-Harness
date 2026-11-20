/**
 * 「记忆 › 全局设置」产品页（设计稿 `doc/UXDesign/design.pen` → `设置 · 记忆 · 全局设置 · 深色 v3`）。
 *
 * ## 页面职责
 *
 * 记忆底座的**全局策略**（与「哪条记忆」无关）：机制开关、沉淀与存续、注入策略、清理。
 * 导航结构（2026-09-22 用户裁定「移除项目记忆」后，记忆维度收敛为 Agent 单一维度）：
 *
 * ```
 * 设置 › 记忆（独立分组，紧邻「智能体」下方）
 *   ├─ 全局设置（本页）—— 全局策略
 *   └─ 智能体记忆      —— Agent 记忆空间（见 MemorySpace）
 * ```
 *
 * ⚠️ **记忆只归属 Agent**（2026-09-22 裁定）：`scope` / `projectId` 字段已从底座
 * 删除，「项目记忆」section 已移除。
 *
 * ## 诚实性纪律（PRD §6.1）
 *
 * **未就绪的条目一律「禁用 + 标注未上线」，禁止「能点但不落盘」**。本页三类落点：
 *   1. **已接线**（真源 = `corum-memory` settings ns，改了立刻生效）：
 *      启用记忆 / 存续期默认档 / 读取升级阈值 / 衰减强度 / 容量上限 / 超限策略 /
 *      自动清理已到期 / 压缩时自动提炼 / 注入模式 / 注入预算。
 *   2. **禁用占位**：「发起做梦」能力未实现 ⇒ disabled + 标「能力未上线 · 规划中」。
 *
 * @module @corum/corum-memory/client/MemorySettingsPage
 */
import { useCallback, useEffect, useState } from 'react'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import {
  Badge, Button, Divider, ErrorNote, GroupCard, Hint, Row, RowDesc, RowLabel, Segmented, Select, Toggle, fmtAbsolute,
} from './ui.tsx'

/* ── 与 host 同形的投影类型（client bundle 独立，不 import host 值）── */

type MemoryRetention = 'temporary' | 'short' | 'long' | 'permanent'
type DecayStrength = 'fast' | 'standard' | 'slow'
type OverflowPolicy = 'oldest' | 'least-used' | 'stop'
type InjectionMode = 'session-start' | 'recall' | 'never'

/** host `ResolvedMemoryConfig` 的同形投影。 */
interface MemoryConfigView {
  enabled: boolean
  defaultRetention: MemoryRetention
  readPromoteThreshold: number
  decayStrength: DecayStrength
  capacity: number | null
  overflowPolicy: OverflowPolicy
  autoCleanExpired: boolean
  autoDistillOnCompress: boolean
  injectionMode: InjectionMode
  injectionBudget: number
}

/** 设置面的窄化能力接口（红线 3：不耦合官方 SettingsScope 实现的全面）。 */
export interface MemorySettingsFace {
  /** 同步快照（uSES 源）。 */
  getSnapshot(): {
    status: string
    value: unknown
    user: unknown
    revision: number | undefined
    writable: boolean
  }
  subscribe(listener: () => void): () => void
  /** 写一个字段。 */
  set(field: string, value: unknown): Promise<void>
  /** 清一个字段（回到内置默认）。 */
  unset(field: string): Promise<void>
}

/** 设置面消费的 RPC 调用（与 corum-rpc-client 的 CorumRpcCall 同形，此处窄化）。 */
export type MemoryCall = <T, A extends object = Record<string, unknown>>(service: string, method: string, args: A) => Promise<T>

/* ── 选项表（display label 与真源取值一一对应，不自造枚举）──────────── */

const RETENTION_OPTIONS = [
  { value: 'temporary', label: '临时 · 2 天' },
  { value: 'short', label: '短期 · 3 个月' },
  { value: 'long', label: '长期 · 1 年' },
  { value: 'permanent', label: '永久 · 不遗忘' },
] as const

const THRESHOLD_OPTIONS = [
  { value: '3', label: '3 次' },
  { value: '5', label: '5 次' },
  { value: '10', label: '10 次' },
] as const

const DECAY_OPTIONS = [
  { value: 'fast', label: '快 · 偏近的优先' },
  { value: 'standard', label: '标准' },
  { value: 'slow', label: '慢 · 偏重要优先' },
] as const

const CAPACITY_OPTIONS = [
  { value: 'none', label: '不限' },
  { value: '100', label: '100 条' },
  { value: '500', label: '500 条' },
  { value: '1000', label: '1000 条' },
] as const

const OVERFLOW_OPTIONS = [
  { value: 'least-used', label: '淘汰最少使用' },
  { value: 'oldest', label: '淘汰最旧' },
  { value: 'stop', label: '停止沉淀' },
] as const

const INJECTION_MODE_OPTIONS = [
  { value: 'recall', label: '按需召回 · 协议+工具' },
  { value: 'session-start', label: '会话开始 · 仅协议' },
  { value: 'never', label: '关闭注入与召回' },
] as const

const INJECTION_BUDGET_OPTIONS = [
  { value: '100', label: '100 字符' },
  { value: '500', label: '500 字符' },
  { value: '1000', label: '1000 字符' },
  { value: '2000', label: '2000 字符' },
] as const

/** 真源里的默认值（用于「已修改」badge 与「恢复默认」判据）。 */
const DEFAULTS: MemoryConfigView = {
  enabled: true,
  defaultRetention: 'temporary',
  readPromoteThreshold: 5,
  decayStrength: 'standard',
  capacity: null,
  overflowPolicy: 'least-used',
  autoCleanExpired: false,
  autoDistillOnCompress: false,
  injectionMode: 'recall',
  injectionBudget: 500,
}

/** 受设置面管理的键（「恢复默认」逐个 unset 这些键）。 */
const MANAGED_KEYS: readonly (keyof MemoryConfigView)[] = [
  'enabled', 'defaultRetention', 'readPromoteThreshold', 'decayStrength',
  'capacity', 'overflowPolicy', 'autoCleanExpired', 'autoDistillOnCompress',
  'injectionMode', 'injectionBudget',
]

/** 从设置面快照里取出本 ns 的**用户层**（presence = 被覆盖过）。 */
function userLayer(settings: MemorySettingsFace): Partial<Record<keyof MemoryConfigView, unknown>> {
  const u = settings.getSnapshot().user
  return (u !== null && typeof u === 'object' ? u : {}) as Partial<Record<keyof MemoryConfigView, unknown>>
}

/**
 * 「记忆 · 全局设置」页。
 *
 * @param props.settings - 设置面（由 client/index.tsx 从 ctx.settingsScope 绑定后下发）。
 * @param props.call - host RPC（用于「立即清理已到期」这类动作型端点）。
 * @returns 设置页节点。
 */
export function MemorySettingsPage({ settings, call }: { settings: MemorySettingsFace; call: MemoryCall }) {
  const [, force] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => settings.subscribe(() => force(v => v + 1)), [settings])

  const snapshot = settings.getSnapshot()
  const resolved: MemoryConfigView = { ...DEFAULTS, ...(snapshot.value as Partial<MemoryConfigView> | undefined ?? {}) }
  const user = userLayer(settings)
  const writable = snapshot.writable === true && snapshot.status !== 'loading' && snapshot.status !== 'unavailable'
  const disabled = !writable || busy

  /** 是否被用户覆盖过（presence 判定——值等于默认仍算覆盖，与官方语义一致）。 */
  const overridden = useCallback((key: keyof MemoryConfigView) => user[key] !== undefined, [user])

  /**
   * 写一个字段。
   *
   * 失败一律回显错误、不做乐观更新——设置面自己的 mirror 会在写入落定后刷新快照，
   * 乐观改本地值只会在失败时留下「界面说改了、磁盘没改」的假象。
   */
  const write = useCallback(async (key: keyof MemoryConfigView, value: unknown) => {
    setBusy(true); setError(null); setNote(null)
    try {
      await settings.set(key, value)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [settings])

  const resetAll = useCallback(async () => {
    setBusy(true); setError(null); setNote(null)
    try {
      for (const k of MANAGED_KEYS) {
        if (overridden(k)) await settings.unset(k)
      }
      setNote('已恢复默认')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [settings, overridden])

  /** 「立即清理」：把已过存续期的记忆真正删掉（返回删了几条）。 */
  const cleanNow = useCallback(async () => {
    setBusy(true); setError(null); setNote(null)
    try {
      // cleanExpiredRemote() 无参 ⇒ SRC 信封为空对象。
      const n = await call<number>('memory', 'cleanExpired', {})
      setNote(n === 0 ? '没有已到期的记忆' : `已清理 ${n} 条已到期记忆`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [call])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, position: 'relative' }}>
      {error !== null && <ErrorNote>{error}</ErrorNote>}

      {/* ── 记忆机制 ─────────────────────────────────────────────── */}
      <GroupCard title="记忆机制">
        <Row control={<Toggle checked={resolved.enabled} disabled={disabled} onChange={v => void write('enabled', v)} />}>
          <RowLabel>启用记忆{overridden('enabled') && <Badge tone="brand">已修改</Badge>}</RowLabel>
          <RowDesc>总开关。关闭后不再自动沉淀、检索不召回，但已有记忆保留（可在「智能体记忆」页修剪或清空）。</RowDesc>
        </Row>
        <Divider />
        <Row control={<Hint>事实级存储 · corum_memory</Hint>}>
          <RowLabel>存储</RowLabel>
          <RowDesc>单域单表（facts），复用官方存储层；每条记忆都有归属（Agent）与两个正交的时间（断言窗口 / 存续期）。</RowDesc>
        </Row>
        <Divider />
        <Row control={
          <Button onClick={() => { void cleanNow() }} disabled={disabled} title="立即删除所有已过存续期的记忆">立即清理</Button>
        }>
          <RowLabel>已到期记忆</RowLabel>
          <RowDesc>存续期耗尽 = 真正遗忘。开启下方「自动清理」后会在写入时顺手删；此处可手动立即清理。</RowDesc>
        </Row>
        {note !== null && <Hint>{note}</Hint>}
      </GroupCard>

      {/* ── 沉淀与存续 ───────────────────────────────────────────── */}
      <GroupCard title="沉淀与存续">
        <Row control={
          <Select
            width={200}
            value={resolved.defaultRetention}
            disabled={disabled}
            options={RETENTION_OPTIONS}
            onChange={v => void write('defaultRetention', v)}
          />
        }>
          <RowLabel>存续期默认档{overridden('defaultRetention') && <Badge tone="brand">已修改</Badge>}</RowLabel>
          <RowDesc>新记忆未显式声明存续期时用哪一档。手动添加的记忆按底座规则落「长期」；「永久」需写方显式声明为纪律。</RowDesc>
        </Row>
        <Divider />
        <Row control={
          <Select
            width={140}
            value={String(resolved.readPromoteThreshold)}
            disabled={disabled}
            options={THRESHOLD_OPTIONS}
            onChange={v => void write('readPromoteThreshold', Number(v))}
          />
        }>
          <RowLabel>读取升级阈值{overridden('readPromoteThreshold') && <Badge tone="brand">已修改</Badge>}</RowLabel>
          <RowDesc>一条记忆被读取命中多少次后自动升级为「长期」。越小越容易记住，但噪音也越多。</RowDesc>
        </Row>
        <Divider />
        <Row control={
          <Select
            width={200}
            value={resolved.decayStrength}
            disabled={disabled}
            options={DECAY_OPTIONS}
            onChange={v => void write('decayStrength', v)}
          />
        }>
          <RowLabel>衰减强度{overridden('decayStrength') && <Badge tone="brand">已修改</Badge>}</RowLabel>
          <RowDesc>记忆强度随时间衰减的快慢，影响检索排序：偏「近的优先」还是「重要的优先」。</RowDesc>
        </Row>
      </GroupCard>

      {/* ── 注入与召回 ───────────────────────────────────────────── */}
      <GroupCard title="注入与召回">
        <Row control={
          <Select
            width={220}
            value={resolved.injectionMode}
            disabled={disabled}
            options={INJECTION_MODE_OPTIONS}
            onChange={v => void write('injectionMode', v)}
          />
        }>
          <RowLabel>注入模式{overridden('injectionMode') && <Badge tone="brand">已修改</Badge>}</RowLabel>
          <RowDesc>
            记忆如何进入 Agent 的上下文。
            <strong>按需召回</strong>：注入协议段 + 提供按需 search/get 工具，Agent 在需要时可主动检索记忆——不强制每次使用。
            <strong>会话开始</strong>：仅注入协议段（无工具），Agent 被告知记忆存在但无法按需查询。
            <strong>关闭</strong>：不注入协议、不提供工具，Agent 对记忆底座无感知。
          </RowDesc>
        </Row>
        <Divider />
        <Row control={
          <Select
            width={160}
            value={String(resolved.injectionBudget)}
            disabled={disabled || resolved.injectionMode === 'never'}
            options={INJECTION_BUDGET_OPTIONS}
            onChange={v => void write('injectionBudget', Number(v))}
          />
        }>
          <RowLabel>注入预算{overridden('injectionBudget') && <Badge tone="brand">已修改</Badge>}</RowLabel>
          <RowDesc>按需召回时注入到上下文的字符预算上限（100~2000）。较大的预算能塞入更多线索，但占更多上下文空间。</RowDesc>
        </Row>
      </GroupCard>

      {/* ── 容量与清理 ───────────────────────────────────────────── */}
      <GroupCard title="容量与清理">
        <Row control={
          <Select
            width={140}
            value={resolved.capacity === null ? 'none' : String(resolved.capacity)}
            disabled={disabled}
            options={CAPACITY_OPTIONS}
            onChange={v => void write('capacity', v === 'none' ? null : Number(v))}
          />
        }>
          <RowLabel>容量上限{overridden('capacity') && <Badge tone="brand">已修改</Badge>}</RowLabel>
          <RowDesc>库里最多保留多少条事实。默认「不限」——不主动丢用户的记忆。</RowDesc>
        </Row>
        <Divider />
        <Row control={
          <Select
            width={180}
            value={resolved.overflowPolicy}
            disabled={disabled || resolved.capacity === null}
            options={OVERFLOW_OPTIONS}
            onChange={v => void write('overflowPolicy', v)}
          />
        }>
          <RowLabel>超限策略{overridden('overflowPolicy') && <Badge tone="brand">已修改</Badge>}</RowLabel>
          <RowDesc>超过上限时淘汰谁。淘汰顺序先看记忆强度（弱先走），再按此策略区分：最少使用 / 最旧。</RowDesc>
        </Row>
        <Divider />
        <Row control={<Toggle checked={resolved.autoCleanExpired} disabled={disabled} onChange={v => void write('autoCleanExpired', v)} />}>
          <RowLabel>自动清理已到期{overridden('autoCleanExpired') && <Badge tone="brand">已修改</Badge>}</RowLabel>
          <RowDesc>写入时顺手删掉已过存续期的记忆（此前只是检索不召回、仍占库）。</RowDesc>
        </Row>
        <Divider />
        <Row control={<Toggle checked={resolved.autoDistillOnCompress} disabled={disabled} onChange={v => void write('autoDistillOnCompress', v)} />}>
          <RowLabel>压缩时自动提炼经验{overridden('autoDistillOnCompress') && <Badge tone="brand">已修改</Badge>}</RowLabel>
          <RowDesc>会话上下文压缩完成时，自动把被压缩的内容提炼成记忆写入（后台并行执行，不阻塞压缩）。</RowDesc>
        </Row>
      </GroupCard>

      {/* ── 维护 ─────────────────────────────────────────────────── */}
      <GroupCard title="维护">
        <Row control={
          <Button
            variant="ghost"
            disabled={disabled || !MANAGED_KEYS.some(overridden)}
            onClick={() => { void resetAll() }}
            title="清空以上全部覆盖值，跟随内置默认"
          >恢复默认</Button>
        }>
          <RowLabel>恢复默认参数</RowLabel>
          <RowDesc>清空本页全部覆盖值（临时 / 5 次 / 标准 / 不限 / 最少使用 / 不自动清理 / 不自动提炼 / 按需召回 / 500 字符），不碰任何记忆数据。</RowDesc>
        </Row>
        <Divider />
        <Row control={
          <Button variant="ghost" disabled title="dream 能力后续上线">发起做梦</Button>
        }>
          <RowLabel>
            发起做梦
            <Badge tone="neutral">能力未上线 · 规划中</Badge>
          </RowLabel>
          <RowDesc>
            深度整理全部记忆：合并零散事实、临时→长期/永久跃迁、确认无用则清扫。能力尚未实现，
            此入口为占位（禁用，不伪造行为）。
          </RowDesc>
        </Row>
        {snapshot.revision !== undefined && (
          <Hint>设置版本 revision {snapshot.revision} · 最后读取 {fmtAbsolute(Date.now())}</Hint>
        )}
      </GroupCard>
    </div>
  )
}
