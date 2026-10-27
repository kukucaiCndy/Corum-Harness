/** Platform-neutral assembly of generated Host Remote contributions. */

import type { Context } from '@deepseek-ai/cordis'
import agentPresetsRemote from '@deepseek-ai/dsh-agent-preset-registry/remote'
import commandsRemote from '@deepseek-ai/dsh-commands/remote'
import settingsControllerRemote from '@deepseek-ai/dsh-api-settings-controller/remote'
import goalsRemote from '@deepseek-ai/dsh-goal/remote'
import llmRemote from '@deepseek-ai/dsh-llm/remote'
import dynamicRemote from '@deepseek-ai/dsh-cordis-host-runner/remote'
import pluginInventoryRemote from '@deepseek-ai/dsh-host-plugin-inventory/remote'
import messageFeedbackRemote from '@deepseek-ai/dsh-message-feedback/remote'
import sessionFeedbackRemote from '@deepseek-ai/dsh-command-feedback/remote'
import fileUploadsRemote from '@deepseek-ai/dsh-client-file-upload/remote'
import sessionReferencesRemote from '@deepseek-ai/dsh-session-reference/remote'
import subagentsRemote from '@deepseek-ai/dsh-subagent/remote'
import sessionRemote from '@deepseek-ai/dsh-api-session-controller/remote'
import workspaceRemote from '@deepseek-ai/dsh-api-workspace-controller/remote'
import workspaceFilesRemote from '@deepseek-ai/dsh-api-workspace-files/remote'
import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'

export type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
export type { PluginInventorySnapshot } from '@deepseek-ai/dsh-host-plugin-inventory/types'
export type {} from '@deepseek-ai/dsh-agent-preset-registry/remote'
export type {} from '@deepseek-ai/dsh-commands/remote'
export type {} from '@deepseek-ai/dsh-api-settings-controller/remote'
export type {} from '@deepseek-ai/dsh-goal/remote'
export type {} from '@deepseek-ai/dsh-llm/remote'
export type {} from '@deepseek-ai/dsh-host-plugin-inventory/remote'
export type {} from '@deepseek-ai/dsh-message-feedback/remote'
export type {} from '@deepseek-ai/dsh-command-feedback/remote'
export type {} from '@deepseek-ai/dsh-client-file-upload/remote'
export type {} from '@deepseek-ai/dsh-session-reference/remote'
export type {} from '@deepseek-ai/dsh-subagent/remote'
export type * from '@deepseek-ai/dsh-subagent/client'
export type {} from '@deepseek-ai/dsh-api-session-controller/remote'
export type * from '@deepseek-ai/dsh-api-session-controller/types'
export type {} from '@deepseek-ai/dsh-api-workspace-controller/remote'
export type * from '@deepseek-ai/dsh-api-workspace-controller/types'
export type {} from '@deepseek-ai/dsh-api-workspace-files/remote'
export type * from '@deepseek-ai/dsh-api-workspace-files/types'
export type { SessionJob as JobView } from '@deepseek-ai/dsh-api-session-controller/types'
// The forwarded-event allowlist's selection seat: without it in the consumer's
// compilation face `TypertRemoteEvent` is `never` and every `$on` call fails.
export type { ApiRemoteForwardedEvent } from '../types.ts'
// The owner packages' client-safe `./types` exports supply the `Events`
// signatures `$on` hands to a listener, so a consumer reads the very
// declaration the Host emits rather than a flattened restatement of it.
export type {} from '@deepseek-ai/dsh-commands/types'
export type {} from '@deepseek-ai/dsh-cordis-host-runner/types'
export type {} from '@deepseek-ai/dsh-credentials/types'
export type {} from '@deepseek-ai/dsh-llm/types'
export type {} from '@deepseek-ai/dsh-agent-preset-registry/types'
export type {} from '@deepseek-ai/dsh-settings/types'
export type {} from '@deepseek-ai/dsh-user-approval/types'
export type {} from '@deepseek-ai/dsh-user-questions/types'
export type {} from '@deepseek-ai/dsh-api-session-controller/types'

/**
 * The carrier's Client-facing types, re-exported so a business package names one
 * assembly package instead of both this facade and the Connection plugin. Type-only:
 * the carrier's runtime values stay behind their own module edge.
 */
export type {
  ConnectionHandle, ConnectionSinks, ContentBlock,
  MessageId,
  RpcId, RpcRequest, RpcResponse, RpcResult, SessionId,
  StreamChunk,
} from '@deepseek-ai/dsh-client-connection/client'
export type {} from '@deepseek-ai/dsh-api-gateway/client'
export type {} from '@deepseek-ai/dsh-cordis-host-runner/remote'

// The payload vocabulary of the selected namespaces, re-exported so a Client
// contribution can name what it sends and receives without importing a Host
// package: this assembly is the one place both planes legitimately meet.
export type {
  ApprovalRequestId,
  CordisHalfState,
  CordisDynamicPackageId,
  CordisDynamicPluginId,
  CordisDynamicPluginRunId,
  CordisDynamicRunMode,
  CordisInspectMethodManifest,
  CordisInspectPlatform,
  CordisInspectProviderManifest,
  CordisInspectProviderView,
  CordisInspectQueryRequest,
  CordisInspectQueryResolution,
  CordisInspectQueryResolved,
  CordisInspectRequestId,
  CordisInspectResolveAck,
  CordisRunDiagnostic,
  CordisRunStatus,
  DynamicCordisClientSource,
  DynamicCordisHostHalfResult,
  DynamicCordisInventoryRow,
  DynamicCordisInvokeResult,
  DynamicCordisPackage,
  DynamicCordisRequestResolved,
  DynamicCordisResolveAck,
  DynamicCordisRetracted,
  DynamicCordisRunRequest,
  DynamicCordisRunResolution,
  DynamicCordisRunAttempt,
  DynamicCordisRunResponse,
  DynamicCordisStopResponse,
  DynamicCordisUndefineReceipt,
  RequestRunOutcome,
} from '@deepseek-ai/dsh-cordis-host-runner/types'
// Credential state vocabulary for the credentials namespace (values never ride it).
export type { CredentialInfo } from '@deepseek-ai/dsh-credentials/types'
// Redacted namespace vocabulary for the settings namespace (secrets never ride
// it). It travels with its seam, whose `./types` the Client face already reads.
export type {
  SettingsDescribeValue, SettingsNamespaceView, SettingsPathOpView, SettingsSecretView,
} from '@deepseek-ai/dsh-settings/types'
// Provider registry and discovery vocabulary for the llm namespace.
export type {
  LlmConfigurableProvider, LlmDiscoveredModel,
  LlmModelDiscoveryRequest, LlmProviderInfo,
} from '@deepseek-ai/dsh-llm/types'
// Reference-discovery result vocabulary for the fileReferences and
// sessionReferenceResolver namespaces.
export type { FileReferenceCandidate } from '@deepseek-ai/dsh-file-reference/types'
export type { SessionReferenceMentionCandidate } from '@deepseek-ai/dsh-session-reference/types'

// The Remote failure vocabulary, re-exported so business packages keep naming
// this assembly alone. Types only: a value export would make spec imports load
// this module's owner /remote artifacts; specs take RemoteError from
// dsh-client-test-runtime instead.
export type {
  RemoteErrorCode, RemoteErrorDetailsMap, RemoteFailure, RemoteResult,
} from '@deepseek-ai/dsh-typert-protocol'
export type { RemoteHostFacts } from '@deepseek-ai/dsh-api-gateway/client'
// fork（corum）：corum 领域事件的 cordis Events 声明 + TypertRemoteEventSelection
// 合并——renderer 消费方经本面拿到 `$on('corum/...', cb)` 的 key 面与 listener 签名。
export type {} from '../corum-events.ts'


declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Generated Remote namespaces selected by this Client assembly. */
    remote: ClientRemote
  }
}

/** Required service: the typed Client Remote contribution mount. */
export const inject = ['remote']

/**
 * Mount the Host capabilities explicitly selected for this Client assembly.
 * @param ctx - Client Cordis root carrying the typed API service.
 * @returns disposer after every selected Remote namespace is ready.
 */
// ── fork（corum）三-1：事件可观测性计数面 ────────────────────────────────
// renderer 端此前零调试面，排查「事件没到」只能重新埋探针。本段在 $mount 全部
// 完成后包一层 ctx.remote.$on：每事件名维护 { frames, lastAt, listeners }
// 只读计数，挂 window.__corumEventStats（write-once-read-only 桥——规范 §1
// 例外：只暴露 getter，JSON.stringify 即可取快照，外部无法写入内部表）。
// localStorage `corum.debug.events=1` 时逐帧 console.debug。
// CDP 排查用法：JSON.stringify(window.__corumEventStats) 看帧到没到 renderer。
/** 单事件计数行（frames 累计帧数 / lastAt 最近一帧 ms 时间戳 / listeners 当前订阅数）。 */
interface CorumEventStatRow { frames: number; lastAt: number; listeners: number }
const corumEventStatsTable = new Map<string, CorumEventStatRow>()

/** 安装 $on 统计包装（apply 内调用一次；返回的 facade 只含 getter）。 */
function installCorumEventStats(ctx: Context): void {
  const remote = ctx.remote
  const raw$on = remote.$on.bind(remote)
  const debugOn = (): boolean => {
    try { return globalThis.localStorage?.getItem('corum.debug.events') === '1' } catch { return false }
  }
  // 类型面上保持 ClientRemote 不变（$on 签名经泛型原样透传）。
  remote.$on = function $onWithStats(event: string, listener: (...args: never[]) => unknown): () => void {
    let row = corumEventStatsTable.get(event)
    if (row === undefined) {
      row = { frames: 0, lastAt: 0, listeners: 0 }
      corumEventStatsTable.set(event, row)
    }
    row.listeners++
    const wrapped = (...args: unknown[]): unknown => {
      row.frames++
      row.lastAt = Date.now()
      if (debugOn()) console.debug('[corum-event]', event, ...args)
      return listener(...(args as never[]))
    }
    const dispose = raw$on(event as never, wrapped as never)
    let active = true
    return () => {
      if (!active) return
      active = false
      row.listeners--
      dispose()
    }
  } as ClientRemote['$on']
  // write-once-read-only：只读 facade（getters 每次调用取最新值，返回快照副本）。
  Object.defineProperty(globalThis, '__corumEventStats', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze({
      get events(): Record<string, CorumEventStatRow> {
        const out: Record<string, CorumEventStatRow> = {}
        for (const [name, row] of corumEventStatsTable) out[name] = { ...row }
        return out
      },
      toJSON(): Record<string, CorumEventStatRow> { return this.events },
    }),
  })
}

export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const disposers: Array<() => Promise<void>> = []
  try {
    for (const contribution of [
      agentPresetsRemote, commandsRemote, settingsControllerRemote, goalsRemote, llmRemote, dynamicRemote,
      pluginInventoryRemote, messageFeedbackRemote, sessionFeedbackRemote, fileUploadsRemote, sessionReferencesRemote,
      subagentsRemote, sessionRemote, workspaceRemote, workspaceFilesRemote,
    ]) {
      disposers.push(await ctx.remote.$mount(contribution))
    }
  } catch (error) {
    for (const dispose of disposers.reverse()) await dispose()
    throw error
  }
  // fork（corum）三-1：$mount 就绪后装事件计数面（immediately:true 装配 →
  // 后续所有插件的 $on 订阅都走统计包装）。
  installCorumEventStats(ctx)

  // Unwound in reverse mount order, so a namespace never outlives one mounted
  // after it.
  return async () => {
    for (const dispose of disposers.reverse()) await dispose()
  }
}
