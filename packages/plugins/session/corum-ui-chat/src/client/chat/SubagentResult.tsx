// fork（corum）：子 Agent **结果**区（#98）——展开区里与「任务详情」并列的一段，
// 展示该子会话**最终返回**的内容（最后一条 assistant/message 的 text 块）。
//
// 为什么单独成组件而不是内联进 SubagentCard：编排卡的**分支行**（OrchestrateCard 的
// BranchRow）是同一个东西的另一种排版——它也是「一个子 Agent 的卡」，展开区同样要能
// 看到结果（#98 的原始报障就发生在编排工作流卡里）。两处共用同一实现，避免出现
// 「一张卡有结果、另一张没有」的分叉。
//
// 数据源 = host `corumAgent/getSubagentSessionResult`（同一份 sessionPersistence，
// 倒序取最后一条 assistant/message）。**不是** getSubagentSessionMeta——那个只给
// 父注入的任务指令（首条 user/message），回答不了「它干完回了什么」。
//
// 拉取纪律：**仅展开时拉一次**（折叠态零 RPC）；`reloadKey` 递增可手动重拉
// （子 Agent 刚跑完、展开那一刻结果还没落地时用）。
import { useEffect, useState } from 'react'
import { FileCheck, Loader, RefreshCw } from 'lucide-react'
import type { ChatNodeViewProps } from '../contract/slots.ts'
import { chatRuntimeRef } from '../chat-runtime.ts'
import css from './SubagentResult.module.css'

/** RPC 返回形（与 host getSubagentSessionResult 对齐）。 */
interface SubagentResultValue {
  result?: { text: string; truncated?: boolean }
}

/** 结果正文（含 host 侧是否截断）。 */
interface SubagentResultText {
  readonly text: string
  readonly truncated: boolean
}

/**
 * 拉取子 Agent 的最终返回内容。
 * @param childSessionId - 子会话 id（未关联时 undefined ⇒ 不拉）。
 * @param enabled - 是否应当拉取（卡片展开态）。
 * @param reloadKey - 递增触发重拉。
 * @param settled - 子会话是否已到终态；**翻转时重拉一次**。
 *   为什么需要它（2026-10 实测踩到）：展开那一刻子 Agent 常常还在跑，host 侧
 *   还没有 `assistant/message` ⇒ 拉到空。若只按 `reloadKey` 重拉，用户就得自己点
 *   刷新才能看到结果——而结果本来就在子 Agent 结束那一刻自己落地了。故把「终态」
 *   作为重拉信号：卡片的 running→done 翻转会自动带出结果。
 * @returns 结果；未拉到/还没有输出时 undefined。
 */
export function useSubagentResult(
  childSessionId: string | undefined,
  enabled: boolean,
  reloadKey: number,
  settled: boolean,
): SubagentResultText | undefined {
  const [result, setResult] = useState<SubagentResultText | undefined>(undefined)
  useEffect(() => {
    if (childSessionId === undefined || !enabled) return undefined
    let cancelled = false
    void (async () => {
      const conn = chatRuntimeRef.current?.connection
      if (conn === undefined) return
      try {
        const value = await conn.rpc.call('/api', 'corumAgent/getSubagentSessionResult', {
          args: { sessionId: childSessionId },
        })
        if (cancelled) return
        if (value.ok && value.value !== undefined) {
          const body = (value.value as SubagentResultValue).result
          // 空结果**不覆盖**已有值：首次拉可能还拿不到，刷新后有了就保留。
          if (body !== undefined && body.text !== '') {
            setResult({ text: body.text, truncated: body.truncated === true })
          }
        }
      } catch {
        // 拉取失败留空（渲染为「还没有返回内容」空态，不报错）。
      }
    })()
    return () => { cancelled = true }
  }, [childSessionId, enabled, reloadKey, settled])
  return result
}

/**
 * 子 Agent 结果区（展开区的一段）。
 *
 * 与「任务详情」分开两段：用户要在同一张卡上同时看到「让它干什么」与「它回了什么」，
 * 而不必点进子会话。没有 assistant 输出时给空态文案（**不隐藏整段**——否则用户会
 * 以为漏了功能，那正是 #98 的报障形态）。
 * @param props - 子会话 id、i18n、可选的样式族（编排分支区用 branch* 那一套）、
 *   以及子会话是否已终态（翻转时自动重拉，见 useSubagentResult 的 settled 说明）。
 */
export function SubagentResult({
  childSessionId, t, settled = false, variant = 'card',
}: {
  childSessionId: string | undefined
  t: ChatNodeViewProps<'subagent-call'>['t']
  /** 子会话是否已到终态（running→done 翻转会触发一次重拉）。 */
  settled?: boolean
  /** `card` = 子 Agent 卡展开区；`branch` = 编排卡分支行展开区（样式族不同）。 */
  variant?: 'card' | 'branch'
}) {
  const [reloadKey, setReloadKey] = useState(0)
  const result = useSubagentResult(childSessionId, true, reloadKey, settled)
  const classes = variant === 'branch'
    ? {
        section: css.branchSection,
        head: css.branchHead,
        icon: css.branchIcon,
        title: css.branchTitle,
        refresh: css.branchRefresh,
        body: css.branchBody,
        empty: css.branchEmpty,
        truncated: css.branchTruncated,
      }
    : {
        section: css.section,
        head: css.head,
        icon: css.icon,
        title: css.title,
        refresh: css.refresh,
        body: css.body,
        empty: css.empty,
        truncated: css.truncated,
      }
  return (
    <div className={classes.section}>
      <div className={classes.head}>
        {/* 设计稿：结果段图标按状态切换——执行中=loader（$state-warn + chipSpin），
            完成=file-check（$state-success）。与「任务详情」的 file-text 区分开。 */}
        {variant === 'branch' && !settled
          ? <Loader size={13} strokeWidth={2} className={`${classes.icon} ${css.branchSpin}`} />
          : variant === 'branch'
            ? <FileCheck size={13} strokeWidth={2} className={classes.icon} />
            : <FileCheck size={14} strokeWidth={2} className={classes.icon} />}
        <span className={classes.title}>{t('subagent.result')}</span>
        <button
          type="button"
          className={classes.refresh}
          title={t('subagent.result')}
          aria-label={t('subagent.result')}
          disabled={childSessionId === undefined}
          onClick={() => { setReloadKey(n => n + 1) }}
        >
          <RefreshCw size={12} strokeWidth={2} />
        </button>
      </div>
      {result === undefined
        ? <div className={classes.empty}>{t('subagent.noResult')}</div>
        : (
          <>
            <div className={classes.body}>{result.text}</div>
            {result.truncated && <div className={classes.truncated}>{t('subagent.resultTruncated')}</div>}
          </>
        )}
    </div>
  )
}
