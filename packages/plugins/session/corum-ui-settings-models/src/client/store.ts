/**
 * Models settings page store: one snapshot joining the configurable-provider
 * directory (`llm/listProviders` joined with `llm/listConfigurableProviders`),
 * the settings namespaces (shared settings mirror),
 * and the referenced credentials (`credentials/describe`). The host stays the
 * single fact source — every mutation writes through the wire and the page
 * re-renders from the next describe, pushed or refetched.
 */

import type {
  ClientRemote, CredentialInfo, LlmConfigurableProvider, LlmProviderInfo, SettingsNamespaceView, SettingsPathOpView,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsDescribeFace } from '@deepseek-ai/dsh-client-ui-settings/client'
// fork（corum）：官方 0.1.3 删除 SettingsRemote 导出，settings Remote 命名空间
// 类型改从 ClientRemote 索引（含 mutate/replace/update，见 dsh-api-settings-controller remote face）。
type SettingsRemote = ClientRemote['settings']
import type { SettingsSchemaOperations } from './schema-operations.ts'
import type { ModelCard } from './model-cards.ts'

/**
 * Any route key walks a dict schema to the same profile node, so the lookup
 * names one that cannot collide with a configured route.
 */
const PROBE_ROUTE = '\u0000probe'

/** The credentials Remote methods the Models page reads and writes through. */
export type ModelsCredentials = Pick<ClientRemote['credentials'], 'describe' | 'set' | 'unset'>

/** LLM Remote methods used by the Models page. */
export type ModelsLlm = Pick<
  ClientRemote['llm'],
  'discoverModels' | 'listConfigurableProviders' | 'listProviders'
>

/** One provider row after joining the configurable directory with live routes. */
export interface ProviderDirectoryEntry {
  readonly provider: string
  readonly displayName: string
  readonly settingsNs: string
  readonly settingsPath: readonly string[]
  readonly active: boolean
  readonly declared?: boolean
}

/**
 * Join declared configurable providers with the currently registered routes.
 * @param registered - live provider routes in registration order.
 * @param directory - declared configurable providers in declaration order.
 * @returns declared rows followed by live routes with no declaration.
 */
export function joinProviderDirectory(
  registered: readonly LlmProviderInfo[],
  directory: readonly LlmConfigurableProvider[],
): ProviderDirectoryEntry[] {
  const active = new Set(registered.map(provider => provider.id))
  const declared = new Set(directory.map(entry => entry.provider))
  const rows: ProviderDirectoryEntry[] = directory.map(entry => ({
    provider: entry.provider,
    displayName: entry.displayName,
    settingsNs: entry.settingsNs,
    settingsPath: [...entry.settingsPath],
    active: active.has(entry.provider),
    ...entry.declared === undefined ? {} : { declared: entry.declared },
  }))
  for (const provider of registered) {
    if (declared.has(provider.id)) continue
    rows.push({
      provider: provider.id,
      displayName: provider.name,
      settingsNs: '',
      settingsPath: [],
      active: true,
    })
  }
  return rows
}

/**
 * Every Remote wire face the Models page reaches.
 */
export interface ModelsWire {
  /** The settings Remote namespace: the redacted read and the profile writes. */
  settings: SettingsRemote
  /** Credential state and writes for the references provider profiles name. */
  credentials: ModelsCredentials
  /** Provider directory reads and draft endpoint discovery. */
  llm: ModelsLlm
}

/** One provider row the page renders. */
export interface ProviderRow {
  /** The directory entry (route id, display name, settings address, live state). */
  entry: ProviderDirectoryEntry
  /** Whether any layer configures this provider (its profile resolves). */
  configured: boolean
  /** Whether the user layer alone carries the profile (removal restores the base). */
  removable: boolean
  /** The credential reference the resolved profile names, when one does. */
  apiKeyEnv: string | undefined
  /** Credential state for {@link apiKeyEnv}, once described. */
  credential: CredentialInfo | undefined
  /**
   * Credential state for the page's derived `<ROUTE>_API_KEY`, described only
   * while the profile names no reference — the provider-card seat's
   * `keyConfigured` fact for dormant and keyless rows, matching the editor's
   * own derivation rule.
   */
  derivedCredential?: CredentialInfo
}

/** Page snapshot. */
export interface ModelsSettingsState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** Whole-load failure text; row-level write failures stay in the editor. */
  error: string | null
  /** Credential enrichment failure; provider/settings rows remain usable. */
  credentialError: string | null
  /** Whether the settings provider accepts writes. */
  writable: boolean
  /** Every configurable provider joined with its configured/credential state. */
  rows: readonly ProviderRow[]
  /** Namespace views by ns, for the editor's schema/layers/secrets. */
  namespaces: ReadonlyMap<string, SettingsNamespaceView>
  /** fork（corum）：无 settingsNs 的 route provider（如 Ollama）的动态模型列表。 */
  routeModels: ReadonlyMap<string, ModelCard[]>
}

/**
 * Human text for a rejected wire call. A transport failure rejects with an
 * Error; a host or a runtime can reject with anything, and the page still has
 * to say something.
 * @param error - the rejection value.
 * @returns the message to show.
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * fork（corum）：本机 Ollama 的模型列表**读取器**（返回已拉取模型名，取不到 → null）。
 *
 * ## 为什么不再是渲染层 fetch
 *
 * 旧实现直接在渲染层 `fetch('http://127.0.0.1:11434/api/tags')`。`catch` 是静默的，
 * 但**浏览器网络层**仍会为失败的请求记一条 `net::ERR_CONNECTION_REFUSED`（JS 无法抑制）：
 * 大多数用户没装/没跑 Ollama，于是每次进「模型」页都往应用 Log 里写一条错误。
 * 现在改由 host 探测（`@corum/corum-ollama` 的 `LocalLlmService.status()` = `probeRunning()`
 * + `listPulledModels()`，两者都是 host 侧 fetch），渲染层只收结果、不发请求。
 */
export type LocalLlmModels = () => Promise<readonly string[] | null>

/** host `localLlm` 服务名（`@corum/corum-ollama` 的 `super(ctx, 'localLlm')`）。 */
const LOCAL_LLM_SERVICE = 'localLlm'

/** `/api` 通道（Typert 网关的唯一 HTTP 通道）。 */
const API_CHANNEL = '/api'

/** RPC 返回信封（只声明本层读得到的那几个字段）。 */
interface LocalLlmRpcOutcome {
  readonly ok: boolean
  readonly value?: unknown
  readonly error?: { readonly code?: string; readonly message?: string }
}

/**
 * 本层需要的 connection 面 —— **本地窄化能力接口**（红线 3：跨 bundle 类型面不对齐时
 * 收窄，不耦合官方实现包；形态与 corum-ollama / corum-issue-reporter 的写法一致）。
 */
export interface LocalLlmConnection {
  readonly rpc: {
    call(
      channel: string,
      endpoint: string,
      payload: { readonly args: Record<string, unknown> },
    ): Promise<LocalLlmRpcOutcome>
  }
}

/** `localLlm/status` 的返回里本层读得到的部分（`LocalEngineStatus` 的只读子集）。 */
interface LocalLlmStatusView {
  readonly running?: boolean
  readonly models?: readonly { readonly name?: string }[]
}

/**
 * 造「本机 Ollama 模型名」读取器：一次 host RPC，**绝不**在渲染层发请求。
 *
 * 永不抛：没连接、旧 host（网关不认识 `localLlm/status`）、引擎没跑、返回形态不对，
 * 一律 `null`（= 列不出模型，与旧逻辑「Ollama 没跑就没卡片」同一结果）。
 * @param connection - `ctx.get('connection')`（缺席 = 旧壳/无连接）。
 * @returns 读取器。
 */
export function createLocalLlmModels(connection: LocalLlmConnection | undefined | null): LocalLlmModels {
  return async function listLocalLlmModels(): Promise<readonly string[] | null> {
    if (connection === undefined || connection === null) return null
    let outcome: LocalLlmRpcOutcome
    try {
      outcome = await connection.rpc.call(API_CHANNEL, `${LOCAL_LLM_SERVICE}/status`, { args: {} })
    } catch {
      return null
    }
    if (!outcome.ok) return null
    const status = outcome.value as LocalLlmStatusView | undefined
    if (status === undefined || status === null || status.running !== true) return null
    const models = status.models
    if (!Array.isArray(models)) return null
    return models.map(model => (typeof model.name === 'string' ? model.name : '')).filter(name => name !== '')
  }
}

/**
 * Derive the conventional credential reference for a provider route: the v1
 * page never asks for an environment-variable name, so a typed key stores
 * under this derived reference and the profile records it as `apiKeyEnv`.
 * @param provider - provider route id (e.g. `anthropic`, `minimax-cn`).
 * @returns the derived reference name (e.g. `MINIMAX_CN_API_KEY`).
 */
export function deriveKeyRef(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

/**
 * The wire protocols a hand-declared route may name, read out of the owning
 * namespace's own schema. This stays a schema read rather than a wire field so
 * the choices the page offers cannot drift from the ones the adapter accepts:
 * both come from the same `Config`.
 * @param namespace - the namespace view whose schema declares the profile shape.
 * @param schema - settings schema operations.
 * @returns the protocol identifiers, or an empty list when the schema has none.
 */
export function protocolChoices(
  namespace: SettingsNamespaceView | undefined,
  schema: SettingsSchemaOperations,
): string[] {
  if (namespace === undefined) return []
  const node = schema.nodeAtPath(schema.rehydrate(namespace.schema), ['providers', PROBE_ROUTE, 'api'])
  const list = (node as { type?: string; list?: readonly { value?: unknown }[] } | undefined)
  if (list?.type !== 'union' || list.list === undefined) return []
  return list.list.map(entry => entry.value).filter((value): value is string => typeof value === 'string')
}

/**
 * The credential reference a resolved profile names (its `apiKeyEnv` field): the
 * profile half of the rule {@link keyRefFor} completes.
 * @param namespace - the namespace view holding the resolved profile.
 * @param path - path from the section root to this provider's profile.
 * @param schema - settings schema operations.
 * @returns the reference the profile names, or undefined when it names none.
 */
export function apiKeyEnvOf(
  namespace: SettingsNamespaceView | undefined,
  path: readonly string[],
  schema: SettingsSchemaOperations,
): string | undefined {
  if (namespace === undefined) return undefined
  const profile = schema.getPath(namespace.value, path)
  if (typeof profile !== 'object' || profile === null) return undefined
  const ref = (profile as { apiKeyEnv?: unknown }).apiKeyEnv
  return typeof ref === 'string' && ref.length > 0 ? ref : undefined
}

/**
 * The credential reference a provider resolves keys through: the one its
 * resolved profile names, else the conventional derived name. This is the single
 * home for that rule — the surface that stores a typed key and the runtime that
 * reads it must agree on the reference, and a profile updated by one code path
 * but not the other leaves the key under a name nothing reads.
 * @param provider - provider route id (e.g. `anthropic`, `minimax-cn`).
 * @param named - the `apiKeyEnv` the resolved profile carries, when it carries one.
 * @returns the reference to read and write.
 */
export function keyRefFor(provider: string, named: string | undefined): string {
  return named === undefined || named.length === 0 ? deriveKeyRef(provider) : named
}

/** The models settings page controller (one per settings surface). */
export class ModelsSettingsStore {
  /** The snapshot the section renders from (uSES-safe store). */
  readonly store: SnapshotStore<ModelsSettingsState> = createSnapshotStore<ModelsSettingsState>({
    status: 'idle', error: null, credentialError: null, writable: false, rows: [], namespaces: new Map(), routeModels: new Map(),
  })

  /** Latest load wins; an older response never overwrites a newer one. */
  private generation = 0

  /**
   * @param api - the page's credentials Remote and LLM wire faces.
   * @param describeFace - the shared mirror's describe face (namespace views and writability).
   * @param localLlmModels - fork（corum）：本机 Ollama 模型名读取器（host
   *   `localLlm/status`）。缺省 = 列不出本机模型（旧行为是渲染层 fetch，
   *   现已在渲染层彻底移除，见 {@link createLocalLlmModels}）。
   */
  constructor(
    private readonly api: Pick<ModelsWire, 'credentials' | 'llm'>,
    private readonly schema: SettingsSchemaOperations,
    private readonly describeFace: SettingsDescribeFace,
    private readonly localLlmModels: LocalLlmModels | undefined = undefined,
  ) {}

  /**
   * Refresh the whole page snapshot: the provider directory and the mirror's
   * settings answer in parallel, then one batched credential describe over
   * every referenced ref. Provider failure or absence of an initial settings
   * answer keeps the last good rows and surfaces an error; a failed settings
   * refresh reuses the mirror's held view.
   * @returns nothing; the snapshot carries the outcome.
   */
  async load(): Promise<void> {
    const generation = ++this.generation
    this.store.update((s) => { s.status = 'loading'; s.error = null })
    let providers: ProviderDirectoryEntry[]
    let writable: boolean
    let views: readonly SettingsNamespaceView[]
    try {
      const [registered, declared] = await Promise.all([
        this.api.llm.listProviders(),
        this.api.llm.listConfigurableProviders(),
        this.describeFace.ensure(),
      ])
      if (!registered.ok) throw new Error(registered.error.message)
      if (!declared.ok) throw new Error(declared.error.message)
      const mirrored = this.describeFace.getSnapshot()
      if (mirrored.view === undefined) {
        throw new Error(mirrored.error ?? 'settings are unavailable in this browser')
      }
      providers = joinProviderDirectory(registered.value, declared.value)
      writable = mirrored.view.writable
      views = mirrored.view.namespaces
    } catch (error) {
      if (generation !== this.generation) return
      this.store.update((s) => {
        s.status = 'error'
        s.error = error instanceof Error ? error.message : String(error)
      })
      return
    }
    const namespaces = new Map(views.map(view => [view.ns, view]))
    const rows: ProviderRow[] = providers.map((entry) => {
      const namespace = namespaces.get(entry.settingsNs)
      const configured = namespace !== undefined
        && (entry.settingsPath.length === 0 || this.schema.getPath(namespace.value, entry.settingsPath) !== undefined)
      const removable = namespace !== undefined
        && entry.settingsPath.length > 0
        && this.schema.hasPath(namespace.user, entry.settingsPath)
        && !this.schema.hasPath(namespace.base, entry.settingsPath)
      return {
        entry,
        configured,
        removable,
        apiKeyEnv: apiKeyEnvOf(namespace, entry.settingsPath, this.schema),
        credential: undefined,
      }
    })
    const refs = [...new Set(rows.map(row => row.apiKeyEnv ?? deriveKeyRef(row.entry.provider)))]
    let credentials: Record<string, CredentialInfo> = {}
    let credentialError: string | null = null
    if (refs.length > 0) {
      try {
        const response = await this.api.credentials.describe(refs)
        // Credential state is an enrichment for the Models page: neither a
        // business rejection nor a transport failure fails the load. The
        // onboarding projection below retains the failure distinction.
        if (response.ok) credentials = response.value
        else credentialError = response.error.message
      } catch (error) {
        credentialError = messageOf(error)
      }
    }
    // fork（corum）：对无 settingsNs 的 route provider（如 Ollama），模型列表走
    // **host RPC**（`localLlm/status`），不在渲染层 fetch 127.0.0.1:11434 —— 那次
    // fetch 失败会在浏览器网络层留一条 `net::ERR_CONNECTION_REFUSED` 日志
    // （JS 无法抑制），而 Ollama 没跑是大多数用户的默认状态。
    const routeProviderIds = providers.filter(p => p.settingsNs === '' && p.active).map(p => p.provider)
    const routeModels = new Map<string, ModelCard[]>()
    if (routeProviderIds.includes('ollama') && this.localLlmModels !== undefined) {
      const models = await this.localLlmModels()
      if (models !== null) {
        routeModels.set('ollama', models.map(id => ({
          provider: 'ollama',
          modelId: id,
          brand: { name: { en: 'Ollama' }, mark: '🦙', color: '#22C55E' },
          providerName: 'Ollama（本地）',
          imageInput: false,
          settingsNs: '',
          settingsPath: [],
          family: undefined,
        })))
      }
    }
    if (generation !== this.generation) return
    this.store.update((s) => {
      s.status = 'ready'
      s.error = null
      s.credentialError = credentialError
      s.writable = writable
      s.rows = rows.map((row) => {
        const named = row.apiKeyEnv === undefined ? undefined : credentials[row.apiKeyEnv]
        const derived = row.apiKeyEnv !== undefined ? undefined : credentials[deriveKeyRef(row.entry.provider)]
        return {
          ...row,
          ...named === undefined ? {} : { credential: named },
          ...derived === undefined ? {} : { derivedCredential: derived },
        }
      })
      s.namespaces = namespaces
      s.routeModels = routeModels
    })
  }
}

/** What the provider detail card's form holds when the user submits it. */
export interface ProviderProfileEdit {
  /** Path from the section root to this provider's profile. */
  readonly settingsPath: readonly string[]
  /** The `apiKeyEnv` the resolved profile already declares (undefined = none). */
  readonly declaredApiKeyEnv: string | undefined
  /** The reference a typed key is stored under ({@link keyRefFor}). */
  readonly keyRef: string
  /** The typed key, trimmed; an empty string means the field supplied none. */
  readonly key: string
  /** Official catalog routes carry neither an endpoint nor message-role compat. */
  readonly isOfficial: boolean
  /** The endpoint field's current value. */
  readonly baseURL: string
  /** The message-role switch's current value. */
  readonly systemRole: boolean
  /** The message-role switch's stored value, for the changed test. */
  readonly systemRoleStored: boolean
}

/**
 * Every profile write one save of the detail card owes, as one op list: the
 * `apiKeyEnv` declaration, the endpoint, and the message-role compat flag. The
 * declaration travels with the profile rather than with the key because a stored
 * key is invisible to the runtime until the resolved profile names the reference
 * it sits under (a missing declaration is what the pi-ai adapter reads as an
 * absent key).
 * @param edit - the card's form values.
 * @returns the ops for a single `settings/mutate`, empty when nothing changed.
 */
/**
 * 删除一个模型时要提交的 ops（纯函数，供 UI 与单测共用）。
 *
 * ## 为什么需要它（2026-11 用户实测报错）
 *
 * 只写 `models: []` 会留下一个**空供应商**，而官方 `dsh-llm-pi-ai` 在「已安装目录里
 * 没有该 provider、配置里又没列模型」时直接抛：
 *
 * ```
 * llm-pi-ai: provider "mac" resolves no models; the installed catalog does not describe
 * this route, so its models must be listed in configuration
 * ```
 *
 * 于是用户点「删除模型」看到的是这句话 —— 模型删不掉，供应商也坏了。
 *
 * 用户 2026-11 裁定：**删除最后一个模型 = 删除整个供应商**（弹窗讲清楚）。故本函数
 * 把「删到 0 个」翻译成 `unset` 整个 provider 节，绝不写空 `models`。
 *
 * @param input - provider 节路径、当前 models 值、待删 modelId。
 * @returns `removesProvider` 标记 + 本次该提交的 ops。
 */
export function planModelDeletion(input: {
  readonly settingsPath: readonly string[]
  readonly models: unknown
  readonly modelId: string
}): { readonly removesProvider: boolean; readonly remaining: readonly Record<string, unknown>[]; readonly ops: SettingsPathOpView[] } {
  const list = Array.isArray(input.models) ? input.models : []
  const remaining = list
    .filter((model): model is Record<string, unknown> => typeof model === 'object' && model !== null)
    .filter(model => model['id'] !== input.modelId)
    .map(model => ({ ...model }))
  if (remaining.length === 0) {
    // 最后一个模型：连供应商一起删（`unset` 整节），不写空 models。
    return { removesProvider: true, remaining, ops: [{ op: 'unset', path: [...input.settingsPath] }] }
  }
  return {
    removesProvider: false,
    remaining,
    ops: [{
      op: 'set',
      path: [...input.settingsPath, 'models'],
      value: remaining as unknown as import('@deepseek-ai/dsh-util-values').JsonValue,
    }],
  }
}

export function providerProfileOps(edit: ProviderProfileEdit): SettingsPathOpView[] {
  const ops: SettingsPathOpView[] = []
  // Only a profile naming no reference declares one: a reference already in the
  // profile is the user's own configuration and is never overwritten.
  if (edit.key !== '' && edit.declaredApiKeyEnv === undefined) {
    ops.push({ op: 'set', path: [...edit.settingsPath, 'apiKeyEnv'], value: edit.keyRef })
  }
  if (!edit.isOfficial) {
    ops.push({ op: 'set', path: [...edit.settingsPath, 'baseURL'], value: edit.baseURL.trim() })
    // 兼容性开关只在改动时写：开 → false，关 → 删键（回到 pi-ai 的 URL 自动判定）。
    if (edit.systemRole !== edit.systemRoleStored) {
      const compatPath = [...edit.settingsPath, 'compat', 'supportsDeveloperRole']
      ops.push(edit.systemRole
        ? { op: 'set', path: compatPath, value: false }
        : { op: 'unset', path: compatPath })
    }
  }
  return ops
}

/**
 * Commit one save of the detail card: the profile writes first, the credential
 * write second. The order is the point. A credential stored before the profile
 * names it is an orphan — no reader anywhere consults the reference, so the page
 * reports a stored key while the provider stays unusable, and no later save can
 * reach it. A profile naming a reference whose credential is missing instead
 * states what is true ("the key comes from X and X is unset"), which the page
 * shows as unconfigured and the user repairs by saving the key again.
 * @param api - the settings and credentials wire faces.
 * @param settingsNs - the namespace owning this provider's profile.
 * @param edit - the card's form values.
 * @param revision - the namespace revision the ops are written against.
 * @returns the failure message, or undefined when every write succeeded.
 */
export async function saveProviderProfile(
  api: Pick<ModelsWire, 'settings' | 'credentials'>,
  settingsNs: string,
  edit: ProviderProfileEdit,
  revision: number | undefined,
): Promise<string | undefined> {
  // One mutate for every profile field: separate calls would each carry the
  // revision read before the previous one landed, so the second would either
  // lose to a conflict or write over the first.
  const ops = providerProfileOps(edit)
  if (ops.length > 0) {
    const response = await api.settings.mutate(settingsNs, ops, revision)
    if (!response.ok) return response.error.message
  }
  if (edit.key !== '') {
    const stored = await api.credentials.set(edit.keyRef, edit.key)
    if (!stored.ok) return stored.error.message
  }
  return undefined
}

/**
 * Whether a key for this provider is on file. A row whose profile names a
 * reference is judged by that reference's own credential; a row whose profile
 * names none is judged by the derived reference this page stores typed keys
 * under — the state the row carries as `derivedCredential`, without which a
 * stored key reads as unset.
 * @param row - one joined provider row.
 * @returns whether a key for this provider is stored.
 */
export function keyConfiguredFor(row: ProviderRow): boolean {
  return (row.credential ?? row.derivedCredential)?.configured === true
}

/**
 * Whether a joined row can serve model requests as it stands: the route is
 * registered with the adapter registry, and whatever credential its resolved
 * profile names is stored. A profile naming no reference authenticates through
 * the provider's own path (the Bedrock chain, Vertex ADC, a gateway that needs
 * nothing), as does a live route with no settings address at all, so neither
 * owes this page a key.
 * @param row - one joined provider row.
 * @returns whether the user already has this provider to talk to.
 */
export function providerUsable(row: ProviderRow): boolean {
  if (!row.entry.active) return false
  if (row.apiKeyEnv === undefined) return true
  return row.credential?.configured === true
}

/** First-run onboarding readiness derived only from the shared Models join. */
export type OnboardingReadiness =
  | { kind: 'loading' }
  | { kind: 'adapter-absent' }
  | { kind: 'provider-ready' }
  | { kind: 'credential-missing' }
  | {
    kind: 'unavailable'
    reason:
      | 'load-failed'
      | 'provider-inactive'
      | 'credentials-unavailable'
      | 'settings-read-only'
      | 'credential-read-only'
  }

/**
 * Project first-run readiness from the provider/settings/credential join used
 * by the Models page. The step exists to leave the user with a model to talk
 * to, so ANY usable provider ends it; only when none exists does the official
 * DeepSeek route — the one route the prompt can offer a key field for — decide
 * whether prompting can help. A missing official configurable-provider
 * declaration means the adapter is not repairable by navigating to Models.
 * @param state - current shared Models join snapshot.
 * @returns the onboarding state without reading a parallel fact source.
 */
export function onboardingReadiness(state: ModelsSettingsState): OnboardingReadiness {
  if ((state.status === 'idle' || state.status === 'loading') && state.rows.length === 0) {
    return { kind: 'loading' }
  }
  if (state.status === 'error') {
    return {
      kind: 'unavailable',
      reason: 'load-failed',
    }
  }
  if (state.rows.some(providerUsable)) return { kind: 'provider-ready' }
  const row = state.rows.find(candidate =>
    candidate.entry.provider === 'deepseek-official'
    && candidate.entry.settingsNs === 'llm-deepseek'
    && candidate.entry.settingsPath.length === 0)
  if (row === undefined) return { kind: 'adapter-absent' }
  if (!row.entry.active) {
    return {
      kind: 'unavailable',
      reason: 'provider-inactive',
    }
  }
  // Past the usable gate an active route names a reference it has no stored
  // credential for, so the remaining questions are all about that credential.
  if (state.credentialError !== null || row.credential === undefined) {
    return {
      kind: 'unavailable',
      reason: 'credentials-unavailable',
    }
  }
  if (!state.writable) {
    return {
      kind: 'unavailable',
      reason: 'settings-read-only',
    }
  }
  if (!row.credential.writable) {
    return {
      kind: 'unavailable',
      reason: 'credential-read-only',
    }
  }
  return { kind: 'credential-missing' }
}
