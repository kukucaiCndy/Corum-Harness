/** Registers the target-neutral Conversation assembly, shell, input, and docks. */
import type { Context } from '@deepseek-ai/cordis'
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
// C3b：dev-agent 跨域 RPC 契约——方法名常量 + args/result 类型（type-only；
// 服务端改 @Remote 方法名/参数时本文件编译期报错，而非运行时发现）。
import {
  CORUM_AGENT_METHODS, CORUM_PROJECT_METHODS,
  type CreateTaskAgentArgs, type CreateTaskAgentResult,
  type ListProjectsResult,
  type OpenProjectArgs, type OpenProjectByPathArgs,
  type ListProfilesResult, type ListModelsResult, type ListPermissionPresetsResult,
  type ListTaskAgentsResult,
} from '@corum/corum-agent-dev/contract'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
// C3a：侧栏模式写（openProject/newProject→project、openTask/newTask→task）收敛进
// IDE 壳 cordis 服务 ctx.layout.setSidebarMode（跨 bundle 单例）——原 ui-base
// window 全局 __corumSidebarMode 死写已退役（ui-base sidebar-mode.ts 随之删除）。
// 类型说明见下方 SidebarModeCapableLayout：本插件 inject 的 ctx.layout 类型来自
// 官方基座 dsh-client-ui-layout 的窄 ILayout（3 方法），corum IDE 壳的运行时
// LayoutController 是其超集（另含侧栏模式面）；用局部能力接口收窄，与 C3b 契约
// 同思路——编译期类型保障、零运行时改动、不强耦合 @corum/corum-ide-ui 包。
import type { ViewTab } from './contract/views.ts'
import type {
  ComposerBarInjected, ConversationInjected, ConversationSessionHeaderInjected,
  ConversationSessionInjected, NewTaskOptions,
} from './contract/slots.ts'
import type { InputNotice } from './contract/input.ts'
import { createConversationStore } from './stores.ts'
import { ConversationController, UnsupportedImageMediaTypeError } from './service.ts'
import type { IConversation } from './service.ts'
import { ComposerBlockRegistry } from './input/blocks.ts'
import type { ComposerBlock } from './contract/composer-blocks.ts'
import { InputHub } from './input/hub.ts'
import { ComposerSubmissionPolicy } from './input/submission-policy.ts'
import { queueDockEntry } from './queue/QueueDock.tsx'
import { EnterBehaviorRow } from './settings/EnterBehaviorRow.tsx'
import type { EnterBehaviorRowInjected } from './settings/EnterBehaviorRow.tsx'
import { ConversationRoot } from './skeleton/ConversationRoot.tsx'
import { ConversationSession, ConversationSessionHeader } from './skeleton/ConversationSession.tsx'
import { InputBar } from './skeleton/InputBar.tsx'
import { todoDockEntry } from './skeleton/TodoPanel.tsx'
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
  // workspaces 补回：空态操作卡「打开目录」需要 ctx.workspaces.create（2026-08-30）。
  // layout 补入：「新建任务表单」打开信号面（newTaskForm）桥到 ctx.layout 的
  // grid actions（AppFrame 持有），替代原 OPEN_NEW_TASK_FORM_EVENT 窗口事件桥。
  'slots', 'sessions', 'uiSession', 'locale', 'settingsScope', 'workspaces', 'layout',
]

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
export function apply(ctx: Context): void {
  const sessions = ctx.sessions
  const slots = ctx.slots
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
  const conversationViews = createSnapshotStore<readonly ViewTab[]>(viewTabs())
  const refreshViews = (): void => {
    const current = conversationViews.getSnapshot()
    const next = viewTabs()
    if (current.length === next.length
      && current.every((tab, index) => {
        const candidate = next.at(index)
        return candidate !== undefined && tab.id === candidate.id && tab.label === candidate.label
      })) return
    conversationViews.set(next)
  }
  ctx.effect(() => {
    const disposeViews = slots.subscribe('conversation.view', refreshViews)
    const disposeLocale = ctx.locale.subscribe(refreshViews)
    return () => {
      disposeLocale()
      disposeViews()
    }
  }, 'ui-conversation: View roster')

  const inputHub = new InputHub(ctx, t)
  const composerBlocks = new ComposerBlockRegistry()

  // Conversation assembly and input share the Session binding lifecycle. The
  // source roster is installed before any consuming Slot entry.
  ctx.uiSession.provide({
    hooks: ['conversation', 'input'],
    props: ['inputActions'],
    resolve: (binding) => {
      const shell = inputHub.shellFor(binding)
      return {
        hooks: {
          conversation: uiConversation.binding(binding).snapshot,
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
      'conversation.session.header': { kind: 'single', scope: 'session' },
      'conversation.composer': { kind: 'chain', scope: 'session' },
      'conversation.composer.bar': { kind: 'single', scope: 'session-maybe' },
      'conversation.input.overlay': { kind: 'list', scope: 'session' },
      'conversation.input.dock': { kind: 'list', scope: 'session' },
      'conversation.composer.dock': { kind: 'list', scope: 'session' },
      'conversation.input.left': { kind: 'list', scope: 'session' },
      'conversation.input.right': { kind: 'list', scope: 'session' },
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
          const imageIds = from.snapshot.imageIds
          const next = inputHub.shell(nextId)
          if (imageIds.length === 0 || next.addImages(imageIds)) {
            if (draft !== '') {
              next.setDraft(draft)
              from.setDraft('')
            }
            if (imageIds.length > 0) {
              for (const id of imageIds) from.removeImage(id)
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
         * `connection`（`ctx.remote` 由 connection 服务随 fiber 装配）。本插件的
         * inject 没有 connection（fork 时按官方形状保留了别的服务名），故
         * `ctx.remote` 不存在。
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
        const startTaskLane = async (cwd: string, profileId?: string, permission?: string, model?: NewTaskOptions['model']): Promise<void> => {
          const args: CreateTaskAgentArgs = {
            cwd,
            ...(profileId === undefined || profileId === '' ? {} : { profileId }),
            ...(permission === undefined || permission === '' ? {} : { permission }),
            ...(model === undefined ? {} : { model }),
          }
          const { sessionId } = await call<CreateTaskAgentResult>('corumAgent', CORUM_AGENT_METHODS.createTaskAgent, args)
          sessions.open(sessionId as SessionId)
        }
        return {
          listProjects: async () => {
            const result = await call<ListProjectsResult>('corumProject', CORUM_PROJECT_METHODS.listProjects, {})
            return result.projects ?? []
          },
          openProject: async (projectId) => {
            sidebarModeLayout(ctx).setSidebarMode('project')
            // C3b 类型保障实证：wire 参数名是 id（不是 projectId）——原裸传
            // { projectId } 与 host @Remote('openProject')(id) 签名不符（运行时
            // 静默错位）；契约类型 OpenProjectArgs 在此编译期拦截并纠正。
            const args: OpenProjectArgs = { id: projectId }
            await call('corumProject', CORUM_PROJECT_METHODS.openProject, args)
          },
          newProject: async () => {
            sidebarModeLayout(ctx).setSidebarMode('project')
            const path = await pickDir()
            if (path === null || path === '') return
            const args: OpenProjectByPathArgs = { cwd: path }
            await call('corumProject', CORUM_PROJECT_METHODS.openProjectByPath, args)
          },
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
            }))
          },
          listModels: async () => {
            const result = await call<ListModelsResult>('corumAgent', CORUM_AGENT_METHODS.listModels, {})
            return (result.providers ?? []).map((p) => ({ id: p.id, name: p.name, models: p.models ?? [] }))
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
          pickDirectory: pickDir,
          listWorkspaces: async () => {
            // 官方 ctx.workspaces.list 快照（与侧栏工作区分组同源）。
            const items = ctx.workspaces.list.getSnapshot().items
            return items.map((w) => ({ id: String(w.workspaceId), title: w.title, path: w.path }))
          },
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
    inject: (sessionId: SessionId, _actions: BoundActions<typeof conversationStore>): ConversationSessionInjected => ({
      hooks: { conversationViews },
      bindDraftMirror: write => inputHub.shell(sessionId).bindMirror(write),
    }),
  }, ConversationSession)

  const registerConversationHeader = () => slots.register({
    name: 'conversation.session.header',
    locale: NS,
    children: {
      'conversation.session.header.lineage': { kind: 'single', scope: 'session' },
      'conversation.session.header.actions': { kind: 'list', scope: 'session' },
      'conversation.session.header.utilities': { kind: 'list', scope: 'session' },
    },
    store: conversationStore,
    inject: (): ConversationSessionHeaderInjected => ({
      hooks: { conversationViews },
      open: (id) => { sessions.open(id) },
    }),
  }, ConversationSessionHeader)

  const registerComposerBar = () => slots.register({
    name: 'conversation.composer.bar',
    locale: NS,
    children: {
      'conversation.input.attachments': { kind: 'single', scope: 'session-maybe' },
      'conversation.input.plan': { kind: 'single', scope: 'session' },
      'conversation.input.model': { kind: 'single', scope: 'session' },
    },
    inject: (sessionId: SessionId | undefined): ComposerBarInjected => {
      if (sessionId === undefined) {
        return {
          keyboard: undefined,
          addImages: undefined,
          removeImage: undefined,
          draftImages: undefined,
          resolveSubmitMode: (running, gesture, steeringAvailable) =>
            submissionPolicy.resolve(running, gesture, steeringAvailable),
          toggleCommandMenu: undefined,
          stop: undefined,
          command: undefined,
          hooks: {
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
        addImages: (files) => {
          try {
            const images = conversation.createDraftImages(files)
            if (!shell.addImages(images.map(image => image.id))) {
              conversation.releaseDraftImages(images)
            }
            return null
          } catch (error: unknown) {
            if (error instanceof UnsupportedImageMediaTypeError) return t('image.unsupportedType')
            return error instanceof Error ? error.message : String(error)
          }
        },
        removeImage: (id) => {
          conversation.releaseDraftImage(id)
          shell.removeImage(id)
        },
        draftImages: ids => conversation.draftImages(ids),
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

  ctx.plugin(ConversationController, { input: inputHub, blocks: composerBlocks })
  ctx.plugin(todoDockEntry)
  ctx.plugin(queueDockEntry)
}
