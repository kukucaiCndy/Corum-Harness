/** Registers the target-neutral Conversation assembly, shell, input, and docks. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import { createSnapshotStore, type BoundActions } from '@deepseek-ai/dsh-client-store'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only service and declaration merges used by this assembly.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { UiConversation } from './conversation/assembly.ts'
import { makeCorumRpcCall } from '@corum/corum-rpc-client/client'
// C3b：corum-agent 跨域 RPC 契约——方法名常量 + args/result 类型（type-only；
// 服务端改 @Remote 方法名/参数时本文件编译期报错，而非运行时发现）。
// 项目模式剥离（2026-09-26）：`CORUM_PROJECT_METHODS` 与 project 侧 args/result
// （ListProjectsResult / OpenProjectArgs / OpenProjectByPathArgs）已随项目模式
// 迁到闭源仓的契约子路径，本文件不再引入。
import {
  CORUM_AGENT_METHODS,
  type CreateTaskAgentArgs, type CreateTaskAgentResult,
  type ListProfilesResult, type ListModelsResult, type ListPermissionPresetsResult,
  type ListTaskAgentsResult,
} from '@corum/corum-agent/contract'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
// C3a：侧栏模式写（openProject/newProject→project、openTask/newTask→task）收敛进
// IDE 壳 cordis 服务 ctx.layout.setSidebarMode（跨 bundle 单例）——原 ui-base
// window 全局 __corumSidebarMode 死写已退役（ui-base sidebar-mode.ts 随之删除）。
// 项目模式剥离（2026-09-26）后本插件只剩 'task' 一侧的写（'project' 由闭源
// `@corum/corum-ide-project-ui` 写；侧栏模式按钮本体仍由 corum-ide-sidebar-ui
// 两侧都提供）。
// 类型说明见下方 SidebarModeCapableLayout：本插件 inject 的 ctx.layout 类型来自
// 官方基座 dsh-client-ui-layout 的窄 ILayout（3 方法），corum IDE 壳的运行时
// LayoutController 是其超集（另含侧栏模式面）；用局部能力接口收窄，与 C3b 契约
// 同思路——编译期类型保障、零运行时改动、不强耦合 @corum/corum-ide-ui 包。
import type { ViewTab } from './contract/views.ts'
import type {
  ComposerBarInjected, ConversationInjected, ConversationSessionHeaderInjected,
  ConversationSessionInjected, DraftFileUploads, NewTaskOptions,
} from './contract/slots.ts'
import type { InputNotice } from './contract/input.ts'
import { createConversationStore, readConversationViewPreference } from './stores.ts'
import { ConversationController, UnsupportedImageMediaTypeError } from './service.ts'
import type { IConversation } from './service.ts'
import { ComposerBlockRegistry } from './input/blocks.ts'
import type { ComposerBlock } from './contract/composer-blocks.ts'
import { InputHub } from './input/hub.ts'
import { ComposerSubmissionPolicy } from './input/submission-policy.ts'
import { queueDockEntry } from './queue/QueueDock.tsx'
import { goalDockEntry } from './goal/GoalDock.tsx'
import { EnterBehaviorRow } from './settings/EnterBehaviorRow.tsx'
import type { EnterBehaviorRowInjected } from './settings/EnterBehaviorRow.tsx'
import { ConversationRoot } from './skeleton/ConversationRoot.tsx'
import { ConversationSession, ConversationSessionHeader } from './skeleton/ConversationSession.tsx'
import { InputBar } from './skeleton/InputBar.tsx'
import { todoDockEntry } from './skeleton/TodoPanel.tsx'
import { resolveActiveView } from './view-selection.ts'
import { en, NS, zh, type ConversationKey } from './locales.ts'
import { CONVERSATION_SETTINGS_NAMESPACE, type ConversationSettings } from '../submission-settings.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Conversation shell, composer, queue, and dock copy. */
    conversation: ConversationKey
  }
}

/** Services required by the Conversation plugin. */
export const inject = [
  // fork（corum）：移除 'uiWorkspace'——kkc IDE 禁用官方 ui-workspace（uiWorkspace 服务
  // 不存在），工作区导航由 corum 侧栏自研。uiWorkspace 改 ctx.get 可选获取 + 降级。
  // fork（corum 修正 2026-09-07）：'fileUpload' 必须保留——官方 0.1.3 把它作为必需
  // inject，createDrafts→beginFileUpload 链经 ctx.fileUpload.upload 真上传（此前按
  // 「空态操作卡不需上传」的旧假设误删，导致文件附件上传 fail，CDP 实测抓出）。
  // workspaces 补回：空态操作卡「打开目录」需要 ctx.workspaces.create（2026-08-30）。
  // layout 补入：「新建任务表单」打开信号面（newTaskForm）桥到 ctx.layout 的
  // grid actions（AppFrame 持有），替代原 OPEN_NEW_TASK_FORM_EVENT 窗口事件桥。
  'slots', 'sessions', 'fileUpload', 'uiSession', 'locale', 'settingsScope', 'workspaces', 'layout',
  // P2-3（2026-09-09 复核补齐）：空态操作卡 2 处 ctx.get('connection')（RPC 桥 /
  // 润色 RPC）此前未声明 inject——红线 4 违规，补齐后由 cordis 保证激活时序。
  'connection',
]

/** Conversation runtime configuration. */
export interface Config {
  /** Maximum generic-file uploads allowed to run concurrently in browser Workers. */
  maxConcurrentFileUploads?: number
}

/** Validated Conversation runtime configuration. */
export const Config: z<Config> = z.object({
  maxConcurrentFileUploads: z.natural().min(1).default(2),
})

// Stable no-session sources keep the renderer's observable-hook cache and
// hook order unchanged across current-Session transitions.
const ABSENT_NOTICES = {
  getSnapshot: (): InputNotice | null => null,
  subscribe: () => () => {},
}
const ABSENT_BLOCK = {
  getSnapshot: (): ComposerBlock | undefined => undefined,
  subscribe: () => () => {},
}
const EMPTY_LEXICON: ReadonlyMap<'/' | '@', readonly string[]> = new Map()
const ABSENT_LEXICON = {
  getSnapshot: () => EMPTY_LEXICON,
  subscribe: () => () => {},
}
const ABSENT_MENU_LAUNCHER = {
  getSnapshot: (): string | null => null,
  subscribe: () => () => {},
}
const EMPTY_FILE_UPLOADS: DraftFileUploads = {}
const ABSENT_FILE_UPLOADS = {
  getSnapshot: () => EMPTY_FILE_UPLOADS,
  subscribe: () => () => {},
}

interface WorkspaceNavigation {
  connectWorkspace(
    workspaceId: Parameters<ConversationInjected['selectWorkspace']>[0],
  ): Promise<SessionId>
}

/** 侧栏模式（design mode-switch：任务=默认 / 项目）。 */
type SidebarMode = 'task' | 'project'

/**
 * ctx.layout 的侧栏模式能力面（corum IDE 壳 LayoutController 提供，超出官方
 * 基座窄 ILayout 的部分）。cordis 服务跨 bundle 单例（实证 .dbg/cordis-
 * singleton-probe.md），本插件经它写模式，侧栏骨架（corum-ide-sidebar-ui）
 * 经同一服务读——空态操作卡与侧栏 tab 由此联动。
 */
interface SidebarModeCapableLayout {
  setSidebarMode(mode: SidebarMode): void
}

/** 取 ctx.layout 的侧栏模式面（cordis 服务单例；壳未提供时理论上是装配错误）。 */
function sidebarModeLayout(ctx: Context): SidebarModeCapableLayout {
  return ctx.layout as unknown as SidebarModeCapableLayout
}

/** Resolve the session-scoped Conversation action face, failing loud. */
function scopedConversation(sessions: ISessions, id: SessionId): IConversation {
  const scoped = sessions.scope(id)
  if (scoped === undefined) throw new Error(`ui-conversation: session "${id}" resolved no scope`)
  const conversation = scoped.get('conversation')
  if (conversation === undefined) {
    throw new Error('ui-conversation: conversation service unavailable through the session scope')
  }
  return conversation
}

/** Resolve package-internal attachment operations from the public service. */
function concreteConversation(ctx: Context): ConversationController {
  const conversation = ctx.get('conversation') as ConversationController | undefined
  if (conversation === undefined) throw new Error('ui-conversation: conversation service unavailable')
  return conversation
}

/**
 * Mount the Conversation core and target-neutral presentation.
 * @param ctx - Client root context.
 */
export function apply(ctx: Context, config: Config = Config({})): void {
  const sessions = ctx.sessions
  const slots = ctx.slots
  // Schemastery's field default is materialized before Cordis calls apply.
  const maxConcurrentFileUploads = config.maxConcurrentFileUploads as number
  // fork（corum）：uiWorkspace 在 kkc IDE 不存在（已禁 ui-workspace）——可选获取，undefined
  // 时 selectWorkspace 降级为抛错（kkc 用侧栏自研工作区导航，不经此入口）。
  const workspaceNavigation = ctx.get('uiWorkspace') as unknown as WorkspaceNavigation | undefined
  const uiConversation = new UiConversation(ctx, sessions)

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-conversation: dictionaries')
  const t = ctx.locale.bind(NS)
  const conversationStore = createConversationStore()
  const submissionPolicy = new ComposerSubmissionPolicy(
    ctx.settingsScope.bind<ConversationSettings>({ namespace: CONVERSATION_SETTINGS_NAMESPACE }),
  )

  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'composer-enter',
    order: 20,
    locale: NS,
    inject: (): EnterBehaviorRowInjected => ({
      hooks: { busyEnter: submissionPolicy.busyEnter },
      setBusyEnter: (behavior) => { submissionPolicy.setBusyEnter(behavior) },
    }),
  }, EnterBehaviorRow))

  const viewTabs = (): ViewTab[] => {
    const tabs: ViewTab[] = []
    for (const entry of slots.entries('conversation.view')) {
      /* v8 ignore next -- list registration validates id at load. */
      if (entry.options.id === undefined) continue
      tabs.push({
        id: entry.options.id,
        label: resolveSlotLabel(entry.options.label) ?? entry.options.id,
      })
    }
    return tabs
  }
  const activateView = (sessionId: SessionId, preferred: string | null): void => {
    const active = resolveActiveView(viewTabs(), preferred)
    if (active !== undefined) uiConversation.binding(sessionId).activate(active.id)
  }
  const restoreView = (sessionId: SessionId): void => {
    activateView(sessionId, readConversationViewPreference(sessionId))
  }
  const restoreCurrentView = (): void => {
    const sessionId = sessions.list.getSnapshot().current
    if (sessionId !== undefined && sessions.binding(sessionId) !== undefined) {
      restoreView(sessionId)
    }
  }
  const conversationViews = createSnapshotStore<readonly ViewTab[]>(viewTabs())
  const refreshViews = (): void => {
    const current = conversationViews.getSnapshot()
    const next = viewTabs()
    const unchanged = current.length === next.length
      && current.every((tab, index) => {
        const candidate = next.at(index)
        return candidate !== undefined && tab.id === candidate.id && tab.label === candidate.label
      })
    if (!unchanged) conversationViews.set(next)
    restoreCurrentView()
  }
  ctx.effect(() => {
    let currentSessionId = sessions.list.getSnapshot().current
    const disposeViews = slots.subscribe('conversation.view', refreshViews)
    const disposeLocale = ctx.locale.subscribe(refreshViews)
    const disposeCurrent = sessions.list.subscribe(() => {
      const nextSessionId = sessions.list.getSnapshot().current
      if (nextSessionId === currentSessionId) return
      currentSessionId = nextSessionId
      restoreCurrentView()
    })
    return () => {
      disposeCurrent()
      disposeLocale()
      disposeViews()
    }
  }, 'ui-conversation: View selection')

  const inputHub = new InputHub(ctx, t)
  const composerBlocks = new ComposerBlockRegistry()

  // Conversation assembly and input share the Session binding lifecycle. The
  // source roster is installed before any consuming Slot entry.
  ctx.uiSession.provide({
    hooks: ['conversation', 'input'],
    props: ['inputActions'],
    resolve: (binding) => {
      const shell = inputHub.shellFor(binding)
      const conversation = uiConversation.binding(binding)
      restoreView(binding.sessionId)
      return {
        hooks: {
          conversation: conversation.snapshot,
          input: shell.state,
        },
        props: { inputActions: shell.actions },
      }
    },
  })

  const registerConversationRoot = () => slots.register({
    name: 'conversation',
    locale: NS,
    children: {
      'conversation.session': { kind: 'single', scope: 'session' },
      // CORUM-PATCH(P2, 2026-09-30)：`conversation.session.header` 子槽退役——
      // 会话顶栏的宿主搬到统一标题栏（@corum/corum-ui-titlebar 的
      // `corum.titlebar.session`，声明权在那边）。本条目不再渲染它。
      'conversation.composer': { kind: 'chain', scope: 'session' },
      'conversation.composer.bar': { kind: 'single', scope: 'session-maybe' },
      'conversation.input.dock': { kind: 'list', scope: 'session' },
      'conversation.hero.brand.mark': { kind: 'single', scope: 'root' },
      'conversation.hero.workspace': { kind: 'single', scope: 'root' },
      'conversation.hero.agentPreset': { kind: 'single', scope: 'root' },
    },
    inject: (sessionId: SessionId | undefined): ConversationInjected => ({
      hooks: {
        composerBlock: sessionId === undefined ? ABSENT_BLOCK : composerBlocks.storeFor(sessionId),
      },
      selectWorkspace: async (workspaceId) => {
        // fork（corum）：uiWorkspace 缺失时降级（kkc 不经 hero 工作区切换入口）。
        if (workspaceNavigation === undefined) throw new Error('uiWorkspace unavailable in corum IDE (use sidebar workspace navigation)')
        const nextId = await workspaceNavigation.connectWorkspace(workspaceId)
        if (sessionId !== undefined && nextId !== sessionId) {
          const from = inputHub.shell(sessionId)
          const draft = from.snapshot.draft
          const attachmentIds = from.snapshot.attachmentIds
          const next = inputHub.shell(nextId)
          if (attachmentIds.length === 0 || next.addAttachments(attachmentIds)) {
            if (sessions.binding(nextId) === undefined) {
              throw new Error(`ui-conversation: session "${nextId}" resolved no binding`)
            }
            concreteConversation(ctx).rebindDraftFiles(nextId, attachmentIds)
            if (draft !== '') {
              next.setDraft(draft)
              from.setDraft('')
            }
            if (attachmentIds.length > 0) {
              for (const id of attachmentIds) from.removeAttachment(id)
            }
          }
        }
        sessions.open(nextId)
      },
      // 空态操作卡（2026-08-30 圆桌收敛）：最近项目 + 任务/项目两进入动作。
      emptyActions: (() => {
        const connection = ctx.get('connection') as ConnectionHandle
        const call = makeCorumRpcCall(connection)
        /**
         * 目录选择（host directoryPicker Remote，native OS 对话框）。
         *
         * **坑（2026-08-30 实测）**：`ctx.remote.directoryPicker` 在**本插件的
         * fiber** 里取不到——dsh 的 Context 代理 getter 对未注入的命名空间抛错
         * （console: Uncaught (in promise) at get → apply.ts），点「选择」静默
         * 无反应。侧栏 corum-ide-sidebar-ui 能用的原因是它的 inject 声明了
         * `connection`（`ctx.remote` 由 connection 服务随 fiber 装配）。
         * 当时本插件 inject 没有 connection，故 `ctx.remote` 不存在。
         *
         * ⚠️ **2026-09-10 更正**：上面这条「inject 没有 connection」的**前提已不成立**——
         * 2026-09-09 P2-3 复核已把 `'connection'` 补进本插件 inject（见文件顶部
         * inject 声明，红线 4 违规修复）。`ctx.remote` 命名空间现在应当可用。
         *
         * 但**本处继续用 `connection.rpc.call` 直打**，这是有意保留的：走显式
         * `{args}` 契约、不依赖命名空间代理的装配时序，行为与 `makeCorumRpcCall`
         * 同通道。**不要**因为 inject 补齐就顺手改回 `ctx.remote.directoryPicker`
         * ——那是无收益的重构，且会重新引入对 fiber 装配时序的隐式依赖。
         * （新代码若需要 `ctx.remote`（如统一事件中心的 `$on` 订阅）可直接用。）
         *
         * 修法：不碰 `ctx.remote`，直接用官方 `connection.rpc.call` 打同一个
         * Remote 端点 `directoryPicker/pick`——与 `makeCorumRpcCall` 同通道、
         * 同 `{args}` 契约，且**不依赖 fiber 上的 remote 命名空间**。实测可正常
         * 唤起 native 对话框（osascript choose folder）。
         */
        const pickDir = async (): Promise<string | null> => {
          const result = await connection.rpc.call('/api', 'directoryPicker/pick', { args: {} })
          if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
          return result.value as string | null
        }
        /** 当前/最近工作区路径（task 泳道 cwd 寻址，与侧栏 startSession 同源）。 */
        const currentCwd = (): string | undefined => {
          const cur = sessions.list.getSnapshot().current
          if (cur !== undefined) {
            const cwd = sessions.list.getSnapshot().byId[cur]?.cwd
            if (cwd !== undefined && cwd !== '') return cwd
          }
          return ctx.workspaces.list.getSnapshot().items[0]?.path
        }
        /**
         * 兑现「新建任务」表单选的模型/推理等级（BUG-25）。
         *
         * 为什么必须补这一步：**blank 泳道没有会话级模型选择**，composer 的
         * `ModelDirectory` 取值口径是 `projected.next ?? catalog.default`
         * （见 corum-ui-model-selection/directory.ts），其中 `catalog.default`
         * 是**部署默认**（`agentDefaultModel.currentSelection()`）。于是表单里选的
         * 模型/档位只被 host 记进了 request 覆盖（见 corum-agent 的
         * `installTaskModelSelection`），**没进会话的 modelSelection 投影**——用户
         * 实测：表单填 `Kimi-k3 · High`，进会话却显示部署默认（`… · Default`），
         * 「所选非所得」。这里用官方 `session/selectModel` 通道补一次显式选择：
         * 落 `model/selection` 事件 → 投影 next 成立 → composer 显示的就是表单选的那项，
         * 且与真实请求一致（不再依赖 request 覆盖兜底）。
         *
         * 副作用与 composer 里手动换模型**完全一致**（官方 selectModel 会把该选择存为
         * 部署默认）——同一交互的同一语义，不自造第二套。
         *
         * 失败不阻断建任务：泳道已可用，请求侧仍有 `installTaskModelSelection` 兜底。
         */
        const applyFormModel = async (sessionId: string, model: NewTaskOptions['model']): Promise<void> => {
          if (model === undefined) return
          try {
            const result = await connection.rpc.call('/api', 'session/selectModel', {
              args: {
                request: {
                  sessionId,
                  provider: model.provider,
                  model: model.model,
                  ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort }),
                },
              },
            })
            if (!result.ok) {
              console.warn('[new-task] selectModel rejected', result.error)
            }
          } catch (error) {
            console.warn('[new-task] selectModel failed', error)
          }
        }
        const startTaskLane = async (cwd: string, profileId?: string, permission?: string, model?: NewTaskOptions['model']): Promise<void> => {
          const args: CreateTaskAgentArgs = {
            cwd,
            ...(profileId === undefined || profileId === '' ? {} : { profileId }),
            ...(permission === undefined || permission === '' ? {} : { permission }),
            ...(model === undefined ? {} : { model }),
          }
          const { sessionId } = await call<CreateTaskAgentResult>('corumAgent', CORUM_AGENT_METHODS.createTaskAgent, args)
          sessions.open(sessionId as SessionId)
          await applyFormModel(sessionId, model)
        }
        return {
          // 项目模式剥离（2026-09-26）：原 `listProjects` / `openProject` /
          // `newProject` 三个 emptyActions 分支（走 corumProject RPC）已随项目模式
          // 迁到闭源仓 Corum-Harness-Project 的 `@corum/corum-ide-project-ui`
          // ——项目模式的空态入口由那个插件自己提供，开源侧只留任务模式。
          openTask: async (sessionId) => {
            sidebarModeLayout(ctx).setSidebarMode('task')
            sessions.open(sessionId as SessionId)
          },
          newTask: async (options) => {
            sidebarModeLayout(ctx).setSidebarMode('task')
            if (options !== undefined) {
              await startTaskLane(options.cwd, options.profileId, options.permission, options.model)
              return
            }
            // 无表单参数（兼容旧调用）：cwd 取当前/最近工作区，无则先选目录。
            const cwd = currentCwd()
            if (cwd === undefined || cwd === '') {
              const path = await pickDir()
              if (path === null || path === '') return
              // fork（corum）：新建工作区的 git 保证（2026-09-11 用户定调）。行为固定为
              // 「探测，没有就初始化」——不再读开关、也不再询问（原 autoInitGit 设置已移除）。
              // 建任务流程里不插确认框；`ensureRepo` 幂等（已是仓库直接返回）。
              try {
                await connection.rpc.call('/api', 'corumGit/ensureRepo', { args: { path } })
              } catch {
                // git 初始化失败不阻断建任务（隔离等能力由 spawnOne 的非 git 降级兜底）。
              }
              await ctx.workspaces.create({ path })
              await startTaskLane(path)
              return
            }
            await startTaskLane(cwd)
          },
          listAgents: async () => {
            const result = await call<ListProfilesResult>('corumAgent', CORUM_AGENT_METHODS.listProfiles, {})
            return (result.profiles ?? []).map((p) => ({
              id: p.id,
              name: p.nickname ?? p.title ?? p.id,
              ...(p.model === undefined ? {} : { defaultModel: p.model }),
              ...(p.source === undefined ? {} : { source: p.source }),
              ...(p.trust === undefined ? {} : { trust: p.trust as 'system' | 'user' }),
              ...(p.title === undefined ? {} : { title: p.title }),
              ...(p.dimension === undefined ? {} : { dimension: p.dimension }),
            }))
          },
          defaultAgentPreset: async () => {
            // 复用同一条 listProfiles RPC（host 侧已把 agent-presets.default
            // 解析进 result.defaultProfileId）——不新造 RPC 端点（RPC 面冻结）。
            const result = await call<ListProfilesResult>('corumAgent', CORUM_AGENT_METHODS.listProfiles, {})
            return result.defaultProfileId
          },
          listModels: async () => {
            const result = await call<ListModelsResult>('corumAgent', CORUM_AGENT_METHODS.listModels, {})
            return (result.providers ?? []).map((p) => ({ id: p.id, name: p.name, models: p.models ?? [] }))
          },
          listModelCatalog: async () => {
            // session/modelCatalog（与 composer 模型选择器同源）——含推理元数据。
            // 用 connection.rpc.call 直打（不依赖 ctx.remote 的 fiber inject，与
            // pickDir 同通道同契约）。
            const result = await connection.rpc.call('/api', 'session/modelCatalog', { args: {} })
            if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
            const catalog = result.value as { groups?: { id: string; name?: string; models?: { id: string; name?: string; reasoning?: { efforts?: { id: string; name: string; description?: string }[]; defaultEffort?: string } }[] }[] }
            return (catalog.groups ?? []).map((g) => ({
              id: g.id,
              name: g.name ?? g.id,
              models: (g.models ?? []).map((m) => ({
                id: m.id,
                name: m.name ?? m.id,
                ...(m.reasoning === undefined
                  ? {}
                  : {
                    reasoning: {
                      efforts: (m.reasoning.efforts ?? []).map((e) => ({
                        id: e.id,
                        name: e.name,
                        ...(e.description === undefined ? {} : { description: e.description }),
                      })),
                      ...(m.reasoning.defaultEffort === undefined ? {} : { defaultEffort: m.reasoning.defaultEffort }),
                    },
                  }),
              })),
            }))
          },
          listPermissions: async () => {
            const result = await call<ListPermissionPresetsResult>('corumAgent', CORUM_AGENT_METHODS.listPermissionPresets, {})
            return { presets: result.presets ?? [], defaultPreset: result.defaultPreset ?? '' }
          },
          getTaskAgentName: async (sessionId) => {
            // task 泳道会话的 Agent 显示名（设计稿副标语「由 X 执行」）：
            // listTaskAgents 拿 profileId → listProfiles 映射名称。任一步失败回退 undefined。
            try {
              const [tasks, profiles] = await Promise.all([
                call<ListTaskAgentsResult>('corumAgent', CORUM_AGENT_METHODS.listTaskAgents, {}),
                call<ListProfilesResult>('corumAgent', CORUM_AGENT_METHODS.listProfiles, {}),
              ])
              const task = (tasks.tasks ?? []).find((x) => x.sessionId === sessionId)
              if (task === undefined) return undefined
              const profile = (profiles.profiles ?? []).find((p) => p.id === task.profileId)
              return profile === undefined ? undefined : (profile.nickname ?? profile.title ?? profile.id)
            } catch {
              return undefined
            }
          },
          getTaskAgentProfileId: async (sessionId) => {
            try {
              const tasks = await call<ListTaskAgentsResult>('corumAgent', CORUM_AGENT_METHODS.listTaskAgents, {})
              return (tasks.tasks ?? []).find((x) => x.sessionId === sessionId)?.profileId
            } catch {
              return undefined
            }
          },
          getTaskAgentInfo: async (sessionId) => {
            // task 泳道 Agent 的名片信息（对话起始页按专业方向定制推荐命令）：
            // listTaskAgents 拿 profileId → listProfiles 映射 name/title/dimension。
            // 任一步失败回退 undefined（推荐命令回退通用集）。
            try {
              const [tasks, profiles] = await Promise.all([
                call<ListTaskAgentsResult>('corumAgent', CORUM_AGENT_METHODS.listTaskAgents, {}),
                call<ListProfilesResult>('corumAgent', CORUM_AGENT_METHODS.listProfiles, {}),
              ])
              const task = (tasks.tasks ?? []).find((x) => x.sessionId === sessionId)
              if (task === undefined) return undefined
              const profile = (profiles.profiles ?? []).find((p) => p.id === task.profileId)
              if (profile === undefined) return undefined
              return {
                name: profile.nickname ?? profile.title ?? profile.id,
                ...(profile.title === undefined ? {} : { title: profile.title }),
                ...(profile.dimension === undefined ? {} : { dimension: profile.dimension }),
              }
            } catch {
              return undefined
            }
          },
          selectTaskAgent: async (sessionId, profileId) => {
            await call('corumAgent', 'selectTaskAgentProfile', { sessionId, profileId })
            /**
             * ★ 2026-09-21 修：把**该 Agent 的模型**补写进会话的 `model/selection` 投影。
             *
             * ## 用户实测缺陷（指挥模式会话的空态）
             *
             * 截图现场：Agent chip = 「指挥模式-编排指挥」（预设 `conductor-lead`，其
             * `model` = `localhost/kimi-k3-1 · high`），而模型 chip 显示
             * **`glm-5.3-flash · Default`**。经 RPC 实证：
             *   · `session/modelCatalog.default` = `localhost/glm-5.3-flash` ← 就是它；
             *   · `conductor-lead` 自己的模型 = `localhost/kimi-k3-1 · high`。
             *
             * ## 根因
             *
             * composer 的模型 chip 取值口径是 `projected.next ?? catalog.default`
             * （见 `corum-ui-model-selection/directory.ts:174`）。而本函数此前只调
             * `selectTaskAgentProfile` —— 那只改 **host 侧的 request 覆盖**
             * （`selection.current`，见 agent-service 的 `installTaskModelSelection`），
             * **从不写会话的 `modelSelection` 投影**。于是 `projected.next` 一直是空，
             * chip 恒落回部署默认。
             *
             * 这不是「覆盖没生效」—— 请求侧其实是对的；是**显示与请求不一致**，
             * 而用户看到的就是显示。
             *
             * ## 为什么用官方 `session/selectModel`（而不是自造一套）
             *
             * 与新建任务流程的 `applyFormModel` **完全同一条通路、同一语义**（见上方
             * 那段注释：它修的是「表单填 Kimi-k3 · High，进会话显示部署默认」的同一个
             * 家族缺陷）。官方 `selectModel` 会落 `model/selection` 事件 ⇒ 投影 `next`
             * 成立 ⇒ chip 显示该项，且与真实请求一致。
             *
             * 失败不阻断切换：Agent 已换成功（请求侧覆盖已生效），只是 chip 可能仍显示
             * 部署默认 —— 如实告警，不静默吞。
             */
            try {
              const { profiles } = await call<{ profiles: Array<{ id: string, model?: { provider: string, model: string, reasoningEffort?: string } }> }>(
                'corumAgent', 'listProfiles', {},
              )
              const model = profiles.find(p => p.id === profileId)?.model
              if (model === undefined) return
              const result = await connection.rpc.call('/api', 'session/selectModel', {
                args: {
                  request: {
                    sessionId,
                    provider: model.provider,
                    model: model.model,
                    ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort }),
                  },
                },
              })
              if (!result.ok) console.warn('[conversation] switch agent → selectModel rejected', result.error)
            } catch (error) {
              console.warn('[conversation] switch agent → selectModel failed', error)
            }
          },
          pickDirectory: pickDir,
          listWorkspaces: async () => {
            // 官方 ctx.workspaces.list 快照（与侧栏工作区分组同源）。
            const items = ctx.workspaces.list.getSnapshot().items
            return items.map((w) => ({ id: String(w.workspaceId), title: w.title, path: w.path }))
          },
        }
      })(),
      polishDraft: (() => {
        const connection = ctx.get('connection') as ConnectionHandle
        const call = makeCorumRpcCall(connection)
        return async (sid: string, text: string) => {
          // 拉泳道事件 → 最近 6 条「user 提问 + AI 最终输出」（text 块，不含 reasoning/tool）。
          const r = await call<{ events: Array<{ type: string; data: unknown }> }>('corumAgent', 'getTaskSessionEvents', { sessionId: sid, fromSeq: 0 })
          const history: Array<{ role: 'user' | 'assistant'; text: string }> = []
          for (const e of r.events) {
            const content = (e.data as { content?: Array<{ type: string; text?: string }> } | undefined)?.content ?? []
            const text2 = content.filter(c => c.type === 'text').map(c => c.text ?? '').join('\n').trim()
            if (text2 === '') continue
            if (e.type === 'user/message') history.push({ role: 'user', text: text2 })
            else if (e.type === 'assistant/message') history.push({ role: 'assistant', text: text2 })
          }
          const out = await call<{ polished: string }>('corumAgent', 'polishConversation', { text, history: history.slice(-6) })
          return out.polished
        }
      })(),
      // 提示词中英互译（corumAgent/translatePrompt，方向自动判定）——单段文本，
      // 不需会话历史，与 polishDraft 同型下发供 InputBar 翻译按钮调用。
      translateDraft: (() => {
        const connection = ctx.get('connection') as ConnectionHandle
        const call = makeCorumRpcCall(connection)
        return async (text: string) => {
          const out = await call<{ translated: string }>('corumAgent', 'translatePrompt', { text })
          return out.translated
        }
      })(),
      // 「新建任务表单」打开信号面：桥到 ctx.layout 的 grid actions（AppFrame
      // 持有的监听者集 + pending 标记）。grid actions 尚未 attach（AppFrame
      // 首渲染前）时退化为 no-op——空态此时也不可能已挂载，调用方无可损失。
      newTaskForm: {
        onOpen: (listener) => {
          const grid = (ctx.layout as { gridActions?: () => { onOpenNewTaskForm: (l: () => void) => () => void } | undefined }).gridActions?.()
          return grid?.onOpenNewTaskForm(listener) ?? (() => {})
        },
        consumePending: () => {
          const grid = (ctx.layout as { gridActions?: () => { consumePendingNewTaskForm: () => boolean } | undefined }).gridActions?.()
          return grid?.consumePendingNewTaskForm() ?? false
        },
      },
    }),
  }, ConversationRoot)

  const registerConversationSession = () => slots.register({
    name: 'conversation.session',
    children: {
      'conversation.view': { kind: 'list', scope: 'session' },
    },
    store: conversationStore,
    inject: (sessionId: SessionId, actions: BoundActions<typeof conversationStore>): ConversationSessionInjected => ({
      hooks: { conversationViews },
      bindDraftMirror: write => inputHub.shell(sessionId).bindMirror(write),
      openView: (view, focus) => {
        activateView(sessionId, view)
        actions.openView(view, focus)
      },
    }),
  }, ConversationSession)

  // CORUM-PATCH(P2, 2026-09-30)：会话顶栏改为统一标题栏的**会话段** occupant
  // （宿主 = @corum/corum-ui-titlebar 的 corum.titlebar occupant，声明权在那边）。
  // 它同时声明并渲染 `.actions` / `.utilities` 两个 list 子槽——名字保持官方原样
  // （壳的 session-bar 与官方生态的注册面零改签），只换了宿主。
  // 官方 `conversation.session.header.lineage` 子槽随宿主退役（本改版从不渲染它，
  // 且它的占位者官方 ui-subagent 在 IDE 组合里因缺 uiWorkspace 服务永久 pending）。
  // 多视图 tabs 行不再渲染（40px 带子放不下；IDE 里 conversation.view 只有 chat
  // 一个 occupant ⇒ tabs.length > 1 不可达），故本条目不再需要会话 store。
  const registerConversationHeader = () => slots.register({
    name: 'corum.titlebar.session',
    locale: NS,
    children: {
      'conversation.session.header.actions': { kind: 'list', scope: 'session' },
      'conversation.session.header.utilities': { kind: 'list', scope: 'session' },
    },
    inject: (sessionId: SessionId): ConversationSessionHeaderInjected => ({
      open: (id) => { sessions.open(id) },
    }),
  }, ConversationSessionHeader)

  const registerComposerBar = () => slots.register({
    name: 'conversation.composer.bar',
    locale: NS,
    children: {
      'conversation.input.attachments': { kind: 'single', scope: 'session-maybe' },
      'conversation.input.overlay': { kind: 'list', scope: 'session' },
      'conversation.input.left': { kind: 'list', scope: 'session' },
      'conversation.input.plan': { kind: 'single', scope: 'session' },
      'conversation.input.right': { kind: 'list', scope: 'session' },
      'conversation.input.model': { kind: 'single', scope: 'session' },
      'conversation.composer.dock': { kind: 'list', scope: 'session' },
    },
    inject: (sessionId: SessionId | undefined): ComposerBarInjected => {
      if (sessionId === undefined) {
        return {
          keyboard: undefined,
          addFiles: undefined,
          removeAttachment: undefined,
          resolveDraftAttachments: undefined,
          retryFileUpload: undefined,
          resolveSubmitMode: (running, gesture, steeringAvailable) =>
            submissionPolicy.resolve(running, gesture, steeringAvailable),
          toggleCommandMenu: undefined,
          stop: undefined,
          command: undefined,
          hooks: {
            fileUploads: ABSENT_FILE_UPLOADS,
            notices: ABSENT_NOTICES,
            lexicon: ABSENT_LEXICON,
            menuLauncher: ABSENT_MENU_LAUNCHER,
          },
        }
      }
      const conversation = concreteConversation(ctx)
      const shell = inputHub.shell(sessionId)
      const inputTriggers = inputHub.inputTriggers(sessionId)
      return {
        keyboard: shell,
        addFiles: (files) => {
          if (sessions.binding(sessionId) === undefined) return t('file.sessionUnavailable')
          try {
            const drafts = conversation.createDrafts(sessionId, files)
            if (!shell.addAttachments(drafts.map(draft => draft.id))) {
              conversation.releaseDraftAttachments(drafts)
            }
            return null
          } catch (error: unknown) {
            if (error instanceof UnsupportedImageMediaTypeError) return t('image.unsupportedType')
            return error instanceof Error ? error.message : String(error)
          }
        },
        removeAttachment: (id) => {
          if (shell.removeAttachment(id)) conversation.releaseDraftAttachment(id)
        },
        resolveDraftAttachments: ids => conversation.resolveDraftAttachments(ids),
        retryFileUpload: (id) => {
          if (sessions.binding(sessionId) !== undefined) conversation.retryFileUpload(sessionId, id)
        },
        resolveSubmitMode: (running, gesture, steeringAvailable) =>
          submissionPolicy.resolve(running, gesture, steeringAvailable),
        toggleCommandMenu: inputTriggers === undefined
          ? undefined
          : (selection) => {
            shell.dismissPopup()
            const snapshot = shell.snapshot
            inputTriggers.toggleSource('command', {
              trigger: '/',
              query: '',
              quoted: false,
              position: snapshot.draft.slice(0, selection.start).trim() === '' ? 'leading' : 'inline',
              span: { ...selection, draftRev: snapshot.draftRev },
            })
          },
        stop: () => {
          scopedConversation(sessions, sessionId).cancel().catch(() => {
            // Stop failure is published through Session promptError.
          })
        },
        command: async (line) => {
          const session = sessions.binding(sessionId)?.session
          if (session === undefined) return false
          const result = await session.command(line)
          return result.ok && result.value.matched
        },
        hooks: {
          fileUploads: conversation.fileUploads,
          notices: shell.notices,
          lexicon: shell.lexicon,
          menuLauncher: inputTriggers?.launcher ?? ABSENT_MENU_LAUNCHER,
        },
      }
    },
  }, InputBar)

  slots.inject('conversation', function* () {
    yield registerConversationRoot()
    yield registerConversationSession()
    yield registerConversationHeader()
    yield registerComposerBar()
  })

  ctx.plugin(ConversationController, {
    input: inputHub,
    blocks: composerBlocks,
    maxConcurrentFileUploads,
  })
  ctx.plugin(todoDockEntry)
  ctx.plugin(goalDockEntry)
  ctx.plugin(queueDockEntry)
}
