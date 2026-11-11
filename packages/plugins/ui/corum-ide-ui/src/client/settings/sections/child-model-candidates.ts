/**
 * Agent 预设的「子 Agent 候选模型」——草稿形状与保存载荷（issue #165）。
 *
 * 两层配置面的关系（见 @corum/corum-ui-settings-plugins 的 client 文件头）：全局候选集
 * 是默认档，本预设的 `childModelCandidates` 是**覆盖**——host 侧只有在「开启且有非空
 * 候选」时才让它盖过全局（`corum-agent/src/compile.ts`），运行期优先级
 * = 预设 > 全局 > 无。
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
 * ## 为什么标签解析在这里有一份镜像
 *
 * 规则与全局候选集卡片（`@corum/corum-ui-settings-plugins` 的
 * `subagent-model-selection-card-controller.ts` 里 `parseSubagentModelTags` /
 * `formatSubagentModelTags`）逐字一致：中英文逗号都切、trim、去重、丢空项。
 * **不是新规则，是同一规则的镜像**：本仓跨 client 插件包的值 import 不可行
 * （每个 client 半是独立闭包 bundle，`@corum/plugin-build` 只放行模块表与
 * `ui-base`/`rpc-client` 两个共享库，见 AGENTS 红线 2），所以两处无法共用一个函数。
 * 改规则时**两处一起改**。
 */

/** 候选集来源：`global` = 用全局候选集（不写键）；`custom` = 本预设自带。 */
export type ChildModelCandidatesMode = 'global' | 'custom'

/** host `AgentProfile.childModelCandidates.models` 的一项（wire 形状）。 */
export interface ProfileChildModelCandidate {
  provider: string
  model: string
  tags?: string[]
  note?: string
}

/** host `AgentProfile.childModelCandidates`（wire 形状）。 */
export interface ProfileChildModelCandidates {
  enabled: boolean
  models: ProfileChildModelCandidate[]
}

/** 编辑器里的一行候选（标签/备注存原始文本，见不变式 ②）。 */
export interface ChildModelCandidateDraft {
  provider: string
  model: string
  tagsText: string
  noteText: string
}

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

/** 一行空白候选（「添加候选」按钮的产物）。 */
export function emptyCandidateDraft(): ChildModelCandidateDraft {
  return { provider: '', model: '', tagsText: '', noteText: '' }
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
): { candidatesMode: ChildModelCandidatesMode; candidates: ChildModelCandidateDraft[] } {
  if (value === undefined || !value.enabled || value.models.length === 0) {
    return { candidatesMode: 'global', candidates: [] }
  }
  return {
    candidatesMode: 'custom',
    candidates: value.models.map(model => ({
      provider: model.provider,
      model: model.model,
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
  candidates: readonly ChildModelCandidateDraft[],
): ProfileChildModelCandidates | undefined {
  if (mode !== 'custom') return undefined
  const models: ProfileChildModelCandidate[] = []
  for (const row of candidates) {
    const provider = row.provider.trim()
    const model = row.model.trim()
    if (provider === '' || model === '') continue
    const tags = parseCandidateTags(row.tagsText)
    const note = row.noteText.trim()
    models.push({
      provider,
      model,
      ...tags.length === 0 ? {} : { tags },
      ...note === '' ? {} : { note },
    })
  }
  return models.length === 0 ? undefined : { enabled: true, models }
}