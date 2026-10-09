/**
 * 子 Agent 花名册条目的**合并规则**（会话顶栏胶囊 + 详情浮层共用的纯逻辑）。
 *
 * 为什么单独成文件：这条规则有**清除语义**（见下），而它是「同一子会话被重新唤起
 * 后能不能翻回运行中」的唯一判据——放在 `.tsx` 里就没法做单元断言（组件文件带着
 * React 与 CSS module 依赖，vitest 起不来）。抽出来之后 `mergeRosterEntry` 是纯函数，
 * `tests/subagent-roster-merge.spec.ts` 直接钉死它的四个分支。
 *
 * @module corum-ide-ui/client/subagent-roster-merge
 */

/** 终局原因（与 `@corum/corum-api-remotes/corum-events` 的 `SubagentStopReason` 同词表）。 */
export type SubagentStopReason = 'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal'

/** 子 Agent 花名册条目（会话顶栏常驻胶囊 + 详情浮层的子 Agent 区数据源）。 */
export interface SubagentRosterEntry {
  readonly childSessionId: string
  readonly label: string
  /**
   * 前后台 / 隔离：**只有 corum 推送帧带这两个字段**（官方目录不带）。
   * 故它们是 optional 而非默认值——基线行不能凭空声明「后台」，否则浮层会对
   * 每个历史子 Agent 都挂一个不成立的徽标（用户看到的正是「全是后台」）。
   */
  readonly mode?: 'foreground' | 'background'
  readonly isolated?: boolean
  /** 子 Agent 实际在跑的模型（child 帧携带 + session/list 冷启动补强）。 */
  readonly model?: { provider: string; model: string }
  /**
   * 委派角色（`corum/subagent/child` 帧按工具名派生；卡片与会话条同一来源）。
   * 官方目录基线不带这一轴，故 optional——取不到就不挂小标，不按 label 文案猜。
   */
  readonly role?: 'worker' | 'research' | 'fork'
  readonly step: number
  readonly currentAction?: string
  /** 最新 turn 已闭合（turn/end）；只表示 turn 闭合，不代表终态。 */
  readonly done: boolean
  /** 终局原因；仅在该 turn 闭合时给出（undefined = 运行中/未结束）。 */
  readonly stopReason?: SubagentStopReason
  /** 宿主判定的「半途失去运行」（进程被杀/重启留下的未闭合 turn）——冷启动 RPC 补。 */
  readonly interrupted?: boolean
  readonly lastActive: number
}

/**
 * 把一帧补丁并进已有花名册条目。
 *
 * 合并默认是「新值覆盖、缺省继承」——`{...prev, ...patch}` 只会*省略*键、
 * **不会清除**；对绝大多数字段这正是想要的（progress 帧不带 label/role/model，
 * 别把它们抹掉）。但 `stopReason` 是个例外：同一个子会话被重新唤醒/续跑时，
 * 帧会继续发 `done:false` 且**不带** stopReason，照「缺省继承」处理就会让旧的
 * `completed` 永远留着，花名册行与会话条胶囊恒显示「已完成」、再也不会翻回
 * 「运行中」（2026-10-09 用户报的缺口 B）。
 *
 * 故这里对那一种组合显式删键：**帧说「又在跑」且没给原因 ⇒ 旧终态作废**。
 *
 * @param prev - 该行已有条目。
 * @param patch - 本帧补丁（未给出的键不参与覆盖）。
 * @returns 合并后的新条目（不修改入参）。
 */
export function mergeRosterEntry(
  prev: SubagentRosterEntry,
  patch: Partial<SubagentRosterEntry>,
): SubagentRosterEntry {
  const merged = { ...prev, ...patch } as SubagentRosterEntry
  if (patch.done === false && patch.stopReason === undefined) {
    // exactOptionalPropertyTypes 下清可选属性只能删键，不能赋 undefined。
    const { stopReason: _stale, ...rest } = merged
    return rest as SubagentRosterEntry
  }
  return merged
}
