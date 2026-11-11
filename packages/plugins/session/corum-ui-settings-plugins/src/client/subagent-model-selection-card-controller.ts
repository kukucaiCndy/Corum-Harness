/** Staged editor for the Host-owned subagent model allowlist. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ModelProviderGroup } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { CardShell } from './card-form.ts'

/** Namespace of the Host-owned subagent model-selection preference.
 *
 * rc3: ns = entry id. The official `dsh-web-app/cordis.patch.yml` inserts
 * `subagent-model-selection-settings` (id, name
 * `@deepseek-ai/dsh-tool-subagent/model-selection-settings`). The old value
 * `'subagent-model-selection'` had no matching entry → reads returned empty,
 * writes threw `No configurable plugin entry`.
 */
export const SUBAGENT_MODEL_SELECTION_NS = 'subagent-model-selection-settings'

/** One exact provider/model route stored as user authorization. */
export interface AllowedSubagentModel {
  provider: string
  model: string
  /** Free-form capability labels (「长上下文」/「多模态」/「快速」…); rendered to the agent as-is. */
  tags?: string[]
  /** Free-form note rendered next to the route in the agent-facing prompt. */
  note?: string
}

/** Settings fields stored for subagent model selection. */
export interface SubagentModelSelectionSettings {
  /** Whether model-facing child route selection applies to new Sessions. */
  enabled: boolean
  /** Exact child routes offered to newly composed top-level Sessions. */
  allowedModels: AllowedSubagentModel[]
}

/** One catalog row joined with a stored route that may no longer be advertised. */
export interface SubagentModelCandidate extends AllowedSubagentModel {
  /** Stable opaque identity used only for lookup. */
  key: string
  /** Adapter-owned provider display name. */
  providerName: string
  /** Adapter-owned model display name. */
  modelName: string
  /** Whether the current adapter catalog advertises this exact route. */
  available: boolean
  /** Whether the current draft authorizes this route. */
  selected: boolean
  /** Capability tags stored for this route (empty when untagged). */
  tags: string[]
  /** Note stored for this route (empty when absent). */
  note: string
  /** Raw tag editor text; keeps the user's in-progress comma typing. */
  tagsText: string
  /** Raw note editor text. */
  noteText: string
}

/** State rendered by the staged allowlist card. */
export interface SubagentModelSelectionCardState extends CardShell {
  /** Whether the draft enables model-facing child route selection. */
  enabled: boolean
  /** Live catalog joined with stored routes. */
  candidates: readonly SubagentModelCandidate[]
  /** Adapter-directory request state. */
  catalogStatus: 'idle' | 'loading' | 'ready' | 'error'
  /** Whether any provider-local catalog request failed. */
  catalogPartial: boolean
  /** Whether a newer Host revision invalidated the current draft. */
  conflicted: boolean
}

/** Registration-side face for the subagent model-selection card. */
export interface SubagentModelSelectionCardFace {
  hooks: {
    /** Card snapshot bound by the renderer as useSubagentModelSelectionCard. */
    subagentModelSelectionCard: SnapshotStore<SubagentModelSelectionCardState>
  }
  /** Stage the enabled state; enabling also loads the adapter directory. */
  toggleEnabled: () => void
  /** Stage one exact route as allowed or denied. */
  toggleModel: (key: string) => void
  /** Stage the capability tags typed into one candidate's editor (comma separated). */
  editTags: (key: string, text: string) => void
  /** Stage the free-form note typed into one candidate's editor. */
  editNote: (key: string, text: string) => void
  /** Stage one exact route the catalog does not advertise (manual provider/model entry). */
  addCandidate: (provider: string, model: string) => void
  /** Retry the adapter directory. */
  retryCatalog: () => void
  /** Persist the switch and exact routes as one revision-fenced mutation. */
  save: () => void
  /** Drop the staged enabled state and route choices. */
  discard: () => void
}

/**
 * Stable identity for one exact route; callers resolve it by lookup and never parse it.
 * @param route - Provider/model route to identify.
 * @returns Opaque key for lookup within the card.
 */
export function subagentModelKey(route: AllowedSubagentModel): string {
  return `${route.provider}\0${route.model}`
}

/**
 * Split comma-separated tag text into trimmed, de-duplicated labels.
 * Accepts the full-width comma too, so a Chinese IME needs no switching.
 * @param text - Raw editor value.
 * @returns Labels in first-seen order; blank entries dropped.
 */
export function parseSubagentModelTags(text: string): string[] {
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
export function formatSubagentModelTags(tags: readonly string[]): string {
  return tags.join(', ')
}

/**
 * Join live adapter metadata with stored routes that remain removable after disappearance.
 * @param groups - Current model directory grouped by provider.
 * @param stored - Routes in the effective settings value, with their capability annotations.
 * @param selected - Opaque route keys selected in the current draft.
 * @returns Candidate rows for the card.
 */
export function subagentModelCandidates(
  groups: readonly ModelProviderGroup[],
  stored: readonly AllowedSubagentModel[],
  selected: ReadonlySet<string>,
): SubagentModelCandidate[] {
  const storedByKey = new Map(stored.map(route => [subagentModelKey(route), route]))
  /** Annotations a catalog row inherits from its stored route. */
  const annotations = (route: AllowedSubagentModel | undefined): Pick<
    SubagentModelCandidate, 'tags' | 'note' | 'tagsText' | 'noteText'
  > => {
    const tags = route?.tags ?? []
    const note = route?.note ?? ''
    return { tags, note, tagsText: formatSubagentModelTags(tags), noteText: note }
  }
  const candidates = groups.flatMap(group => group.models.map((model): SubagentModelCandidate => {
    const route = { provider: group.id, model: model.id }
    const key = subagentModelKey(route)
    const storedRoute = storedByKey.get(key)
    storedByKey.delete(key)
    return {
      ...route,
      key,
      providerName: group.name,
      modelName: model.name,
      available: true,
      selected: selected.has(key),
      ...annotations(storedRoute),
    }
  }))
  for (const route of storedByKey.values()) {
    const key = subagentModelKey(route)
    candidates.push({
      ...route,
      key,
      providerName: route.provider,
      modelName: route.model,
      available: false,
      selected: selected.has(key),
      ...annotations(route),
    })
  }
  return candidates
}

/**
 * Compare the capability annotations of two routes.
 * @param left - Stored or drafted route.
 * @param right - Stored or drafted route.
 * @returns Whether both carry the same tags (in order) and note.
 */
function sameAnnotations(left: AllowedSubagentModel, right: AllowedSubagentModel): boolean {
  const leftTags = left.tags ?? []
  const rightTags = right.tags ?? []
  return (left.note ?? '') === (right.note ?? '')
    && leftTags.length === rightTags.length
    && leftTags.every((tag, index) => tag === rightTags[index])
}

function sameRoutes(left: readonly AllowedSubagentModel[], right: readonly AllowedSubagentModel[]): boolean {
  if (left.length !== right.length) return false
  const rightByKey = new Map(right.map(route => [subagentModelKey(route), route]))
  return left.every((route) => {
    const counterpart = rightByKey.get(subagentModelKey(route))
    return counterpart !== undefined && sameAnnotations(route, counterpart)
  })
}

/** Bridges one settings scope and the live adapter directory onto a staged card. */
export class SubagentModelSelectionCardController {
  private catalogGroups: readonly ModelProviderGroup[] = []
  private catalogPartial = false
  private catalogStatus: SubagentModelSelectionCardState['catalogStatus'] = 'idle'
  private draftEnabled: boolean | undefined
  private draftRoutes: Map<string, AllowedSubagentModel> | undefined
  /** Raw tag/note editor text, so in-progress comma typing is not normalized away. */
  private readonly draftTagText = new Map<string, string>()
  private readonly draftNoteText = new Map<string, string>()
  private draftRevision: number | undefined
  private saving = false
  private failed = false
  private conflicted = false
  private disposed = false
  private saveGeneration = 0
  private catalogGeneration = 0
  private readonly store: SnapshotStore<SubagentModelSelectionCardState>
  private readonly unsubscribe: () => void

  /**
   * @param scope - bound `subagent-model-selection` settings scope.
   * @param ctx - the card plugin's context, whose `remote.session` namespace
   * answers the Host model catalog.
   */
  constructor(
    private readonly scope: ConfigForm<SubagentModelSelectionSettings>,
    private readonly ctx: ClientContext,
  ) {
    this.store = createSnapshotStore(this.projection())
    this.unsubscribe = scope.subscribe(() => {
      if (!this.saving && this.draftRoutes !== undefined
        && this.scope.getSnapshot().revision !== this.draftRevision) {
        if (this.currentEnabled() === this.enabled()
          && sameRoutes(this.currentRoutes(), this.desiredRoutes())) this.clearDraft()
        else this.conflicted = true
      }
      if (this.enabled() && this.catalogStatus === 'idle') void this.loadCatalog()
      this.publish()
    })
    if (this.enabled() && this.catalogStatus === 'idle') void this.loadCatalog()
  }

  /** Stop observing settings and suppress late directory/write settlements. */
  dispose(): void {
    this.disposed = true
    this.saveGeneration += 1
    this.catalogGeneration += 1
    this.unsubscribe()
  }

  /**
   * Build the renderer face for this card.
   * @returns The snapshot and staged card actions injected into the renderer.
   */
  inject(): SubagentModelSelectionCardFace {
    return {
      hooks: { subagentModelSelectionCard: this.store },
      toggleEnabled: () => { this.toggleEnabled() },
      toggleModel: (key) => { this.toggleModel(key) },
      editTags: (key, text) => { this.editTags(key, text) },
      editNote: (key, text) => { this.editNote(key, text) },
      addCandidate: (provider, model) => { this.addCandidate(provider, model) },
      retryCatalog: () => { void this.loadCatalog() },
      save: () => { void this.save() },
      discard: () => { this.discard() },
    }
  }

  private currentRoutes(): AllowedSubagentModel[] {
    return this.scope.getSnapshot().value?.allowedModels.map(route => ({ ...route })) ?? []
  }

  private currentEnabled(): boolean {
    return this.scope.getSnapshot().value?.enabled ?? false
  }

  private selected(): Set<string> {
    return new Set(this.draftRoutes?.keys() ?? this.currentRoutes().map(subagentModelKey))
  }

  private enabled(): boolean {
    return this.draftEnabled ?? this.currentEnabled()
  }

  private beginDraft(): Map<string, AllowedSubagentModel> {
    if (this.draftRoutes === undefined) {
      const snapshot = this.scope.getSnapshot()
      this.draftEnabled = snapshot.value?.enabled ?? false
      this.draftRoutes = new Map(
        snapshot.value?.allowedModels.map(route => [subagentModelKey(route), { ...route }]) ?? [],
      )
      this.draftRevision = snapshot.revision
    }
    return this.draftRoutes
  }

  private toggleEnabled(): void {
    const snapshot = this.scope.getSnapshot()
    if (this.disposed || snapshot.status !== 'ready' || !snapshot.writable || this.saving) return
    this.beginDraft()
    this.draftEnabled = !this.draftEnabled
    this.failed = false
    if (this.draftEnabled && this.catalogStatus === 'idle') void this.loadCatalog()
    this.publish()
  }

  private toggleModel(key: string): void {
    if (!this.enabled() || this.saving || !this.scope.getSnapshot().writable) return
    const candidate = this.candidates().find(candidate => candidate.key === key)
    if (candidate === undefined) return
    const routes = this.beginDraft()
    if (routes.has(key)) routes.delete(key)
    else routes.set(key, { provider: candidate.provider, model: candidate.model })
    this.failed = false
    this.publish()
  }

  /** Stage one candidate's capability tags (comma-separated editor text). */
  private editTags(key: string, text: string): void {
    if (!this.enabled() || this.saving || !this.scope.getSnapshot().writable) return
    const route = this.beginDraft().get(key)
    if (route === undefined) return
    const tags = parseSubagentModelTags(text)
    this.draftTagText.set(key, text)
    const updated: AllowedSubagentModel = { provider: route.provider, model: route.model }
    if (route.note !== undefined) updated.note = route.note
    if (tags.length > 0) updated.tags = tags
    this.beginDraft().set(key, updated)
    this.failed = false
    this.publish()
  }

  /** Stage one candidate's free-form note. */
  private editNote(key: string, text: string): void {
    if (!this.enabled() || this.saving || !this.scope.getSnapshot().writable) return
    const route = this.beginDraft().get(key)
    if (route === undefined) return
    this.draftNoteText.set(key, text)
    const note = text.trim()
    const updated: AllowedSubagentModel = { provider: route.provider, model: route.model }
    if (route.tags !== undefined) updated.tags = route.tags
    if (note !== '') updated.note = note
    this.beginDraft().set(key, updated)
    this.failed = false
    this.publish()
  }

  /** Stage one exact route the catalog does not advertise (manual provider/model entry). */
  private addCandidate(provider: string, model: string): void {
    if (!this.enabled() || this.saving || !this.scope.getSnapshot().writable) return
    const providerId = provider.trim()
    const modelId = model.trim()
    if (providerId === '' || modelId === '') return
    this.beginDraft().set(subagentModelKey({ provider: providerId, model: modelId }), {
      provider: providerId,
      model: modelId,
    })
    this.failed = false
    this.publish()
  }

  private clearDraft(): void {
    this.draftEnabled = undefined
    this.draftRoutes = undefined
    this.draftTagText.clear()
    this.draftNoteText.clear()
    this.draftRevision = undefined
    this.failed = false
    this.conflicted = false
  }

  private discard(): void {
    if (this.saving) return
    this.clearDraft()
    this.publish()
  }

  private candidates(): SubagentModelCandidate[] {
    const retained = new Map(this.currentRoutes().map(route => [subagentModelKey(route), route]))
    for (const [key, route] of this.draftRoutes ?? []) retained.set(key, route)
    return subagentModelCandidates(this.catalogGroups, [...retained.values()], this.selected())
      .map((row) => {
        const tagsText = this.draftTagText.get(row.key)
        const noteText = this.draftNoteText.get(row.key)
        if (tagsText === undefined && noteText === undefined) return row
        return {
          ...row,
          ...tagsText === undefined ? {} : { tagsText },
          ...noteText === undefined ? {} : { noteText },
        }
      })
  }

  private desiredRoutes(): AllowedSubagentModel[] {
    return [...this.draftRoutes?.values() ?? this.currentRoutes()].map(route => ({
      ...route,
      ...route.tags === undefined ? {} : { tags: [...route.tags] },
    }))
  }

  /**
   * Project a staged route onto the value written into settings: annotations are
   * omitted when blank, so an untagged route keeps the exact shape it had before
   * capability tags existed.
   * @param route - Staged route.
   * @returns The settings value for one route.
   */
  private storedRoute(route: AllowedSubagentModel): {
    provider: string
    model: string
    tags?: string[]
    note?: string
  } {
    const note = route.note?.trim() ?? ''
    return {
      provider: route.provider,
      model: route.model,
      ...route.tags === undefined || route.tags.length === 0 ? {} : { tags: [...route.tags] },
      ...note === '' ? {} : { note },
    }
  }

  private async save(): Promise<void> {
    const snapshot = this.scope.getSnapshot()
    const desiredEnabled = this.enabled()
    const desired = this.desiredRoutes()
    if (this.disposed || snapshot.status !== 'ready' || !snapshot.writable || this.saving
      || (this.currentEnabled() === desiredEnabled && sameRoutes(this.currentRoutes(), desired))
      || (desiredEnabled && desired.length === 0)) return
    if (this.draftRoutes !== undefined && snapshot.revision !== this.draftRevision) {
      this.conflicted = true
      this.publish()
      return
    }
    const generation = this.saveGeneration
    this.saving = true
    this.failed = false
    this.conflicted = false
    this.publish()
    await this.scope.mutate([
      { op: 'set', path: ['enabled'], value: desiredEnabled },
      {
        op: 'set',
        path: ['allowedModels'],
        value: desired.map(route => this.storedRoute(route)),
      },
    ], this.draftRevision)
    if (generation !== this.saveGeneration) return
    const landed = this.currentEnabled() === desiredEnabled && sameRoutes(this.currentRoutes(), desired)
    this.saving = false
    this.failed = !landed
    if (landed) this.clearDraft()
    this.publish()
  }

  /** Invalidate and reload model candidates after a Host model input changes. */
  refreshCatalog(): void {
    if (this.disposed) return
    this.catalogGeneration += 1
    this.catalogStatus = 'idle'
    this.catalogPartial = false
    if (this.enabled()) void this.loadCatalog()
    else this.publish()
  }

  /** Drop Host-specific candidates and drafts, then reload after reconnecting. */
  resetConnection(): void {
    if (this.disposed) return
    this.saveGeneration += 1
    this.saving = false
    this.clearDraft()
    this.catalogGroups = []
    this.refreshCatalog()
  }

  private async loadCatalog(): Promise<void> {
    if (this.disposed || this.catalogStatus === 'loading') return
    const generation = this.catalogGeneration
    this.catalogStatus = 'loading'
    this.catalogPartial = false
    this.publish()
    const response = await this.ctx.remote.session.modelCatalog()
    if (generation !== this.catalogGeneration) return
    if (response.ok) {
      this.catalogGroups = response.value.groups
      this.catalogPartial = response.value.failures.length > 0
      this.catalogStatus = 'ready'
    } else {
      this.catalogStatus = 'error'
    }
    this.publish()
  }

  private projection(): SubagentModelSelectionCardState {
    const snapshot = this.scope.getSnapshot()
    const current = this.currentRoutes()
    const desired = this.desiredRoutes()
    const enabled = this.enabled()
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      dirty: this.currentEnabled() !== enabled || !sameRoutes(current, desired),
      invalid: enabled && desired.length === 0,
      saving: this.saving,
      failed: this.failed,
      enabled,
      candidates: this.candidates(),
      catalogStatus: this.catalogStatus,
      catalogPartial: this.catalogPartial,
      conflicted: this.conflicted,
    }
  }

  private publish(): void {
    this.store.set(this.projection())
  }
}
