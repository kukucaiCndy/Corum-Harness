/**
 * 扩展包归属台账的 UI 投影（P5d provenance + locked uninstall）。
 *
 * 与 host 侧 `extensionManager/ownership` + `extensionManager/list` 两个 RPC
 * 对齐（见 P5 设计 §4.3：页面 mount 时调一次 `ownership()` 本地 join）。
 *
 * ## fail-soft 纪律
 * 两个 RPC 都不可用（`extensionManager` 未注册 / 非桌面壳）时降级为**空归属**，
 * 即「没有任何资源由扩展包拥有」——四个资源页的卸载/删除按钮全部可点、
 * 与未接入 P5d 前的既有行为逐字一致（P5 设计 §4.3「fail-soft：若 RPC 不可用，
 * 行为与今天完全一致」）。
 *
 * ## 数据流
 *   - `ownership()` → `Record<kind, Record<name, packId>>`（六个 kind 键都在）。
 *   - `list()` → `{ packs: [{ id, name?, version, ... }] }`（pack 显示名）。
 * 页面 mount 时并发取两份，join 成 `{ packId → displayName }` 一张表，
 * 再把 ownership 的 packId 翻译成可读的 `「<pack name or id>」`。
 *
 * ## visible 刷新
 * 页面重新可见时（document.visibilityState 回 visible）补一次刷新——
 * 只在 RPC 可用且上次取成功时才补，避免对未装配的环境反复打空 RPC。
 *
 * @module corum-ide-integrations-pages-ui/client/ownership
 */
import { useCallback, useEffect, useState } from 'react'
import type { CorumRpcCall } from '@corum/corum-rpc-client/client'

/** 六类资源类别（与 host 侧 ExtensionItemKind 同口径）。 */
export type OwnershipKind = 'presets' | 'skills' | 'mcp' | 'plugins' | 'themes' | 'ui'

/** ownership() 返回的 wire 形状（六个 kind 键都在）。 */
type OwnershipWire = Readonly<Record<OwnershipKind, Readonly<Record<string, string>>>>

/** list() 返回的包摘要（只取 id + name 用于显示名 join）。 */
interface PackSummaryWire {
  readonly id: string
  readonly name?: string
  readonly version: string
}

/** list() 返回形状。 */
interface ListWire {
  readonly packs: readonly PackSummaryWire[]
}

/**
 * 归属台账的 UI 投影（页面级单例 hook）。
 *
 * - `ownership`: 与 wire 同形的归属映射（RPC 不可用时为全空对象）。
 * - `packNames`: `packId → displayName`（name 优先，回落 id）。
 * - `loading`: 首次取是否在途（取完即落定，后续 visible 刷新不回 true）。
 *
 * 两个表都 fail-soft：RPC 抛错时 `ownership` 留空、`packNames` 留空，
 * 调用方 `ownerOf(kind, name)` 返回 `null` ⇒ 按无归属处理。
 */
export interface ExtensionOwnership {
  readonly ownership: OwnershipWire
  readonly packNames: Readonly<Record<string, string>>
  readonly loading: boolean
  /**
   * 查某资源归属的包显示名（name ?? id）；无归属返回 null。
   * 这是页面渲染 provenance 行 + 决定是否禁用卸载的唯一入口。
   */
  ownerOf: (kind: OwnershipKind, name: string) => string | null
}

/** 全空归属（fail-soft 兜底；六个 kind 键都在，调用方无需判空）。 */
const EMPTY_OWNERSHIP: OwnershipWire = {
  presets: {},
  skills: {},
  mcp: {},
  plugins: {},
  themes: {},
  ui: {},
}

/**
 * 取扩展包归属台账（页面 mount 时调一次，visible 时补一次）。
 *
 * @param rpc - `useIntegrationsRpc()` 返回的调用函数；null 时直接降级为空归属。
 * @returns 归属投影（见 {@link ExtensionOwnership}）。
 */
export function useExtensionOwnership(rpc: CorumRpcCall | null): ExtensionOwnership {
  const [ownership, setOwnership] = useState<OwnershipWire>(EMPTY_OWNERSHIP)
  const [packNames, setPackNames] = useState<Readonly<Record<string, string>>>({})
  const [loading, setLoading] = useState(true)

  const load = useCallback(async (rpcFn: CorumRpcCall): Promise<void> => {
    try {
      const [own, list] = await Promise.all([
        rpcFn<OwnershipWire>('extensionManager', 'ownership', {}),
        rpcFn<ListWire>('extensionManager', 'list', {}),
      ])
      const names: Record<string, string> = {}
      for (const p of list.packs) {
        names[p.id] = p.name !== undefined && p.name !== '' ? p.name : p.id
      }
      setOwnership(own)
      setPackNames(names)
    } catch {
      // fail-soft：RPC 不可用 / 抛错时留空归属，行为与未接入 P5d 一致。
      setOwnership(EMPTY_OWNERSHIP)
      setPackNames({})
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (rpc === null) {
      setLoading(false)
      return
    }
    void load(rpc)
  }, [rpc, load])

  // 页面重新可见时补一次刷新（只在 RPC 可用时；失败静默，不阻塞页面）。
  useEffect(() => {
    if (rpc === null) return
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void load(rpc)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => { document.removeEventListener('visibilitychange', onVisible) }
  }, [rpc, load])

  const ownerOf = useCallback((kind: OwnershipKind, name: string): string | null => {
    const packId = ownership[kind]?.[name]
    if (packId === undefined) return null
    return packNames[packId] ?? packId
  }, [ownership, packNames])

  return { ownership, packNames, loading, ownerOf }
}

/* ── provenance 文案（四页共用，保持口径一致）─────────────────────────── */

/**
 * provenance 行的值文案：「扩展包 · <pack name>」或「用户导入」。
 * 调用方只在 ownerOf 返回非 null 时走扩展包分支，否则保留既有 provenance。
 */
export function provenanceLabel(ownerName: string | null, fallback: string): string {
  if (ownerName !== null) return `扩展包 · ${ownerName}`
  return fallback
}

/**
 * pack-owned 资源的卸载禁用 title（四页共用同一句话）。
 * 「由扩展包「<name>」统一管理，请到 集成中心 › 扩展包 卸载整包」。
 */
export function packOwnedTitle(ownerName: string): string {
  return `由扩展包「${ownerName}」统一管理，请到 集成中心 › 扩展包 卸载整包`
}
