/**
 * 「子 Agent 候选模型」——一行候选的草稿形状、标签规则与保存载荷（issue #165）。
 *
 * 两处配置面共用本文件（用户 2026-11-12 裁定：全局候选集搬进「智能体设置」）：
 *   · **全局候选集**：`SettingsAgentSettingsSection` 的「子 Agent 候选模型」组
 *     （namespace `subagent-model-selection-settings`，见 `subagent-candidates.ts`）；
 *   · **单预设覆盖**：Agent 预设编辑页的 `childModelCandidates` 键。
 * 运行期优先级 = 预设候选集（开启且非空）> 全局候选集 > 无（`corum-agent/src/compile.ts`
 * 与 `corum-tool-subagent` 的 `selectForAgent`）。
 *
 * ## 两条不变式
 *
 *  ① 「使用全局候选集」= **不写** `childModelCandidates` 键。理由：host 的
 *    `saveProfile` 按白名单从入参重建 profile（`agent-service.ts` 的
 *    `...(input.childModelCandidates !== undefined ? … : {})`），**不写即清掉**——
 *    正是「不覆盖」的语义。写 `{enabled:false, models:[]}` 只会留下一条与「键不存在」
 *    完全等价的墓碑，读回时还要再判一次，白留死状态。
 *  ② 候选行的能力标注/备注在编辑器里保留**原始文本**（`tagsText`/`noteText`），只在
 *    保存时折成 host 的 `tags: string[]` / `note: string`——否则用户正在敲的
 *    「长上下文, 」会被当场吃掉，逗号打不出来。
 *
 * ## 为什么标签解析只在这一处
 *
 * 中英文逗号都切、trim、去重、丢空项——全局候选集与预设候选集是**同一套规则**，
 * 两个 UI 面（`ModelCandidatesEditor` 的两个调用方）都走本文件的 `parseCandidateTags`。
 * 本仓跨 client 插件包的值 import 不可行（每个 client 半是独立闭包 bundle，`@corum/plugin-build`
 * 只放行模块表与 `ui-base`/`rpc-client` 两个共享库，见 AGENTS 红线 2）⇒ 规则只能留在
 * **同包内**：全局候选集因此搬进了本包（而不是留在 corum-ui-settings-plugins）。
 */

/** 候选集来源：`global` = 用全局候选集（不写键）；`custom` = 本预设自带。 */
export type ChildModelCandidatesMode = 'global' | 'custom'

/** host `AgentProfile.childModelCandidates.models` 的一项（wire 形状）。 */
export interface ProfileChildModelCandidate {
  provider: string
  model: string
  /** 思考程度（档位 id，如 `high`；缺省 = 跟随该模型默认档）。 */
  reasoningEffort?: string
  /** 这条候选给哪类子 Agent 用（缺省/空 = 两类都可用）。 */
  roles?: CandidateRole[]
  tags?: string[]
  note?: string
}

/** host `AgentProfile.childModelCandidates`（wire 形状）。 */
export interface ProfileChildModelCandidates {
  enabled: boolean
  models: ProfileChildModelCandidate[]
}

/**
 * 编辑器里的一行候选。
 *
 * `tagsText` / `noteText` 存**原始编辑文本**（见不变式 ②）；`reasoningEffort` 是
 * 「思考程度」下拉的当前值（`''` = 未选 / 默认档）。两个编辑面（全局候选集与预设候选集）
 * 共用同一个行形状与同一个行编辑器。
 */
/** 子 Agent 的两类角色（候选的适用范围；与 host 的 `CorumCandidateRole` 同值）。 */
export type CandidateRole = 'worker' | 'research'

/** 两类角色的界面文案（worker = 执行类，research = 只读调研类）。 */
export const CANDIDATE_ROLE_LABELS: Readonly<Record<CandidateRole, string>> = {
  worker: '执行类',
  research: '调研类',
}

export interface ModelCandidateRow {
  provider: string
  model: string
  /** 思考程度（'' = 默认档 / 未选）。 */
  reasoningEffort?: string
  /**
   * 这条候选给**哪类子 Agent** 用（用户 2026-11-12：「勾选可给哪类子 Agent 候选」）。
   *
   * 两类都勾 = 都可用（与「不勾」等价，故 wire 上省略，保持设置文件干净）；
   * 只勾一类 = 只有那类子 Agent 的候选表里出现它。
   */
  roles?: CandidateRole[]
  tagsText: string
  noteText: string
}

/** 预设编辑页沿用的旧名字（同一形状；保留导出免得到处改 import）。 */
export type ChildModelCandidateDraft = ModelCandidateRow

/**
 * 常用标签候选（直接可点的 chips，多选）。
 *
 * ⚠️ **刻意只用中文常量，不做 zh/en 两套文案**：这些标签是**用户写给 Agent 看的能力标注**，
 * 原样进入 `corum:subagent-model-candidates` 提示词段（英文提示词里也照原样列出），
 * 与 `note`（自由文本）同属用户数据而不是界面文案。做成双语字典会让**同一个已存字段**
 * 在两种界面语言下变成两个值——中文界面点「快速」存的是 `快速`，英文界面点 `Fast` 存的是
 * `Fast`，而运行期两者只是不同的自由文本。故：界面语言只影响周围的说明文字。
 */
export const COMMON_CANDIDATE_TAGS: readonly string[] = [
  '长上下文',
  '多模态',
  '快速',
  '代码强',
  '工具调用稳',
  '中文好',
]

/**
 * Split comma-separated tag text into trimmed, de-duplicated labels.
 * Accepts the full-width comma too, so a Chinese IME needs no switching.
 * @param text - Raw editor value.
 * @returns Labels in first-seen order; blank entries dropped.
 */
export function parseCandidateTags(text: string): string[] {
  const seen = new Set<string>()
  for (const raw of text.split(/[,，]/)) {
    const tag = raw.trim()
    if (tag !== '') seen.add(tag)
  }
  return [...seen]
}

/**
 * Render stored tags back into the editor's comma-separated form.
 * @param tags - Stored capability labels.
 * @returns Editor text.
 */
export function formatCandidateTags(tags: readonly string[]): string {
  return tags.join(', ')
}

/**
 * 点一次加入、再点一次移除一个常用标签（chip 的加/移除语义）。
 *
 * 结果仍写成**逗号分隔文本**（`tagsText` 是唯一事实源）：点 chip 会把「正在敲的原文」
 * 规范化为「已解析的标签 + 空格」，这是显式动作带来的可接受副作用。
 * @param text - 该行当前的标签原文。
 * @param tag - 被点击的常用标签。
 * @returns 新的标签原文。
 */
export function toggleCandidateTag(text: string, tag: string): string {
  const tags = parseCandidateTags(text)
  return formatCandidateTags(
    tags.includes(tag) ? tags.filter(existing => existing !== tag) : [...tags, tag],
  )
}

/** 一行空白候选（「添加候选」按钮的产物）。 */
export function emptyCandidateDraft(): ModelCandidateRow {
  return { provider: '', model: '', reasoningEffort: '', roles: ['worker', 'research'], tagsText: '', noteText: '' }
}

/**
 * 一行是否已填全（provider/model 都在）。未填全的行不写入任何一层候选集。
 * @param row - 编辑器里的一行。
 * @returns 是否可用于保存。
 */
export function candidateRowComplete(row: ModelCandidateRow): boolean {
  return row.provider.trim() !== '' && row.model.trim() !== ''
}

/**
 * 一行候选 → wire 形状（`provider`/`model` 任一为空 ⇒ `undefined`，调用方丢弃）。
 *
 * 空的 `tagsText` / `noteText` / `reasoningEffort` 一律不展开对应键：一条没有任何标注的
 * 候选写出来必须与「标注功能存在之前」的形状**一致**（不多出空数组/空串）。
 * @param row - 编辑器里的一行。
 * @returns wire 形状；未填全返回 `undefined`。
 */
export function candidateRowToWire(row: ModelCandidateRow): ProfileChildModelCandidate | undefined {
  if (!candidateRowComplete(row)) return undefined
  const tags = parseCandidateTags(row.tagsText)
  const note = row.noteText.trim()
  const reasoningEffort = row.reasoningEffort?.trim() ?? ''
  // 「两类都可用」= 与不写 `roles` 等价 ⇒ 省略，避免把默认值写进用户的设置文件。
  // 缺省（undefined）与空数组同义：两类都可用 ⇒ 不写 roles。
  const roles = row.roles ?? []
  const roleList = roles.length === 0 || roles.length === 2 ? undefined : roles
  return {
    provider: row.provider.trim(),
    model: row.model.trim(),
    ...reasoningEffort === '' ? {} : { reasoningEffort },
    ...roleList === undefined ? {} : { roles: [...roleList] },
    ...tags.length === 0 ? {} : { tags },
    ...note === '' ? {} : { note },
  }
}

/**
 * 从已保存的 profile 反填草稿。
 *
 * 缺省 / `enabled: false` / 候选为空 ⇒ 「使用全局候选集」（host 侧同样如此判定），
 * 否则落在「本预设自定义」并回填候选行。
 * @param value - `profile.childModelCandidates`（可能不存在）。
 * @returns 候选集来源与候选行草稿。
 */
export function childModelCandidatesDraftFrom(
  value: ProfileChildModelCandidates | undefined,
): { candidatesMode: ChildModelCandidatesMode; candidates: ModelCandidateRow[] } {
  if (value === undefined || !value.enabled || value.models.length === 0) {
    return { candidatesMode: 'global', candidates: [] }
  }
  return {
    candidatesMode: 'custom',
    candidates: value.models.map(model => ({
      provider: model.provider,
      model: model.model,
      reasoningEffort: model.reasoningEffort ?? '',
      // 缺省/空 = 两类都可用 ⇒ 界面两枚都勾上（与 wire 省略等价）。
      roles: model.roles === undefined || model.roles.length === 0 ? ['worker', 'research'] : [...model.roles],
      tagsText: formatCandidateTags(model.tags ?? []),
      noteText: model.note ?? '',
    })),
  }
}

/**
 * 草稿 → `saveProfile` 的 `childModelCandidates` 载荷。
 *
 * @param mode - 候选集来源。
 * @param candidates - 编辑器里的候选行。
 * @returns 载荷；「使用全局候选集」或没有任何填全的行时 **undefined**（= 不写该键，
 *   见不变式 ①）。`provider`/`model` 任一为空的行按未填完处理并丢弃。
 */
export function childModelCandidatesPayload(
  mode: ChildModelCandidatesMode,
  candidates: readonly ModelCandidateRow[],
): ProfileChildModelCandidates | undefined {
  if (mode !== 'custom') return undefined
  const models: ProfileChildModelCandidate[] = []
  for (const row of candidates) {
    const wire = candidateRowToWire(row)
    if (wire !== undefined) models.push(wire)
  }
  return models.length === 0 ? undefined : { enabled: true, models }
}