/**
 * corum-ui-distill-card —— 经验沉淀完成 dock 卡片。
 *
 * ## 二期改造（2026-11-19）
 *
 * 官方架构（dsh known-event-types.ts 注释 + surface.ts:306）明确拒绝外部事件名
 * 注册，ignorable 事件不进 surface 流 ⇒ 二期「durable 自定义事件卡片锚点」架构上
 * 不可行（实机已证卡片不渲染）。卡片改 **host 状态投影 + 会话 dock 区**。
 *
 * ## 挂载
 *
 * 与 model-ask / questions / todo 同槽位 `conversation.input.dock`（输入框正上方，
 * 不遮盖对话与输入框）。dock 的 owner 是 `InputZone`，scope 是 `session`，故 slot
 * props 带 `sessionId`。
 *
 * ## 数据
 *
 * 挂载时 RPC `corumAgent/distillListPending`（wire {}）按当前会话 sessionId 过滤
 * pending 候选 → 有 pending 候选的 job → 渲染卡片「经验沉淀完成 · N 条候选待取舍
 * [查看归档]」；点击 → 能力探测 `layout.openDistillArchive({jobId, sessionId})`
 * （回落 `openSettingsSection`）。
 *
 * ## 实时
 *
 * `remote.$on('corum/distill/completed')` 按 sessionId 过滤 → 重查；卡片显示期间
 * 10s 轮询 distillListPending（取舍完成后卡片自动消失）；卸载清订阅/定时器。
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { useEffect, useRef, useState } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
// type-only：拉入 corum-ui-conversation 的 SlotMap 声明（conversation.input.dock
// 槽由它声明）与 corum-api-remotes 的 corum 事件声明（`corum/distill/completed`
// 的 $on key 面由此投影），让本插件的 dock 注册与 remote 监听通过类型检查。
import type {} from '@corum/corum-ui-conversation/client'
import type {} from '@corum/corum-api-remotes/client'
import type { DistillArchiveCapableLayout, DistillPendingJob } from './contract.ts'
import { DistillCard } from './DistillCard.tsx'
import { en, NS, zh } from './locales.ts'

export type { DistillArchiveCapableLayout, DistillPendingJob } from './contract.ts'

/** Required services: Slot registry, Remote Events, Connection (for RPC), and copy. layout via ctx.get (capability probe). */
export const inject = ['slots', 'remote', 'connection', 'locale']

/**
 * ctx.layout 的记忆归档能力面收窄（红线 3：不 import 壳实现包、本地能力接口收窄）。
 * 运行时探测：layout 具备 openDistillArchive 时返回收窄面，否则返回 undefined
 * ⇒ 卡片「查看归档」按钮禁用（不伪造行为）。
 *
 * 导出供单测断言（distill-card-node.spec.ts）。
 */
export function distillArchiveLayout(layout: unknown): DistillArchiveCapableLayout | undefined {
  if (layout === null || typeof layout !== 'object') return undefined
  const l = layout as Record<string, unknown>
  // openDistillArchive 是 corum 壳新增能力，旧基座不具备 ⇒ 探测。
  // openSettingsSection 是壳的基本能力（fallback 用）。
  if (typeof l.openDistillArchive !== 'function' && typeof l.openSettingsSection !== 'function') return undefined
  return layout as unknown as DistillArchiveCapableLayout
}

/**
 * 基于 ConnectionHandle 构造 RPC 调用函数（照 corum-memory makeCall 同款信封）。
 *
 * @param connection - 官方 client connection 服务。
 * @returns 命名空间化调用函数；`!result.ok` 时抛 `<code>: <message>`。
 */
function makeCall(connection: ConnectionHandle) {
  return async function call<T>(
    service: string,
    method: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    const result = await connection.rpc.call('/api', `${service}/${method}`, { args })
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    return result.value as T
  }
}

/** distillListPending 返回的 wire 类型（与 host DistillJob 逐字段一致）。 */
interface DistillListPendingResult {
  jobs: readonly DistillPendingJob[]
}

/** dock 卡片：按 sessionId 查 pending 候选，渲染卡片。 */
function DistillDock({
  sessionId,
  call,
  layout,
  remote,
}: {
  sessionId: SessionId
  call: <T>(service: string, method: string, args: Record<string, unknown>) => Promise<T>
  layout: DistillArchiveCapableLayout | undefined
  remote: ClientContext['remote']
}) {
  const [job, setJob] = useState<DistillPendingJob | null>(null)
  /** 轮询定时器 ref。 */
  const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined)
  /** 当前 sessionId ref（闭包用）。 */
  const sidRef = useRef(sessionId)
  sidRef.current = sessionId
  /** 已卸载标记。 */
  const disposedRef = useRef(false)

  /** 查 distillListPending 按 sessionId 过滤 pending 候选。 */
  const refresh = async (): Promise<void> => {
    try {
      // distillListPending 无参 → wire {}。
      const result = await call<DistillListPendingResult>('corumAgent', 'distillListPending', {})
      if (disposedRef.current) return
      const sid = String(sidRef.current)
      // 过滤：job 的 sessionId 匹配当前会话 + 有至少一条 pending 候选。
      const found = result.jobs.find(
        j => String(j.sessionId) === sid
          && j.candidates !== undefined
          && j.candidates.some(c => c.state === 'pending'),
      )
      setJob(found ?? null)
    } catch {
      // RPC 失败静默（卡片不出现即可，不弹错——host 可能未加载）。
      if (!disposedRef.current) setJob(null)
    }
  }

  // 挂载时查一次 + 10s 轮询 + remote.$on 重查。
  useEffect(() => {
    disposedRef.current = false
    void refresh()
    pollRef.current = setInterval(() => void refresh(), 10_000)
    // corum/distill/completed emit 事件 → 按 sessionId 过滤重查。
    // $on 返回 dispose 函数（cordis remote 惯例），卸载时调它清订阅。
    const onCompleted = (data: { sessionId?: string }): void => {
      if (data?.sessionId === undefined) {
        void refresh()
        return
      }
      if (String(data.sessionId) === String(sidRef.current)) void refresh()
    }
    const disposeListener = remote.$on('corum/distill/completed', onCompleted as never)
    return () => {
      disposedRef.current = true
      if (pollRef.current !== undefined) {
        clearInterval(pollRef.current)
        pollRef.current = undefined
      }
      disposeListener()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call, remote])

  if (job === null) return null

  return (
    <DistillCard
      key={job.jobId}
      jobId={job.jobId}
      sessionId={String(job.sessionId)}
      factCount={job.factCount}
      layout={layout}
    />
  )
}

/**
 * Client plugin body: register dictionaries + the input-dock distill card.
 * @param ctx - client root context。
 */
export function apply(ctx: ClientContext): void {
  const connection = ctx.get('connection') as ConnectionHandle
  const call = makeCall(connection)
  // layout 经 ctx.get 取（不 inject：本插件不强依赖壳的 layout 服务，
  // 运行时可能不具备 ⇒ 能力探测）。与 notification-bridge.ts:321 同款手法。
  const layout = distillArchiveLayout(ctx.get('layout' as never))
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'corum-ui-distill-card: dictionaries')
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register(
    { name: 'conversation.input.dock', id: 'distill-card', order: 5, locale: NS },
    (props: { sessionId?: SessionId }) => (
      props.sessionId === undefined
        ? null
        : <DistillDock sessionId={props.sessionId} call={call} layout={layout} remote={ctx.remote} />
    ),
  ))
}
