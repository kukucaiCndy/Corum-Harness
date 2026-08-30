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
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { setSidebarMode } from '@corum/corum-ui-base/client'
import type { ViewTab } from './contract/views.ts'
import type {
  ComposerBarInjected, ConversationInjected, ConversationSessionHeaderInjected,
  ConversationSessionInjected,
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
  'slots', 'sessions', 'uiSession', 'locale', 'settingsScope', 'workspaces',
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
        const startTaskLane = async (cwd: string, profileId?: string, permission?: string): Promise<void> => {
          const { sessionId } = await call<{ sessionId: string }>('corumAgent', 'createTaskAgent', {
            cwd,
            ...(profileId === undefined || profileId === '' ? {} : { profileId }),
            ...(permission === undefined || permission === '' ? {} : { permission }),
          })
          sessions.open(sessionId as SessionId)
        }
        return {
          listProjects: async () => {
            const result = await call<{ projects: readonly { id: string; name: string; memberCount?: number; updatedAt?: number }[] }>('corumProject', 'listProjects', {})
            return result.projects ?? []
          },
          openProject: async (projectId) => {
            setSidebarMode('project')
            await call('corumProject', 'openProject', { projectId })
          },
          newProject: async () => {
            setSidebarMode('project')
            const path = await pickDir()
            if (path === null || path === '') return
            await call('corumProject', 'openProjectByPath', { cwd: path })
          },
          openTask: async (sessionId) => {
            setSidebarMode('task')
            sessions.open(sessionId as SessionId)
          },
          newTask: async (options) => {
            setSidebarMode('task')
            if (options !== undefined) {
              await startTaskLane(options.cwd, options.profileId, options.permission)
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
            const result = await call<{ profiles: readonly { id: string; nickname?: string; title?: string }[] }>('corumAgent', 'listProfiles', {})
            return (result.profiles ?? []).map((p) => ({ id: p.id, name: p.nickname ?? p.title ?? p.id }))
          },
          listPermissions: async () => {
            const result = await call<{ presets: readonly { id: string; name: string; description?: string }[]; defaultPreset: string }>('corumAgent', 'listPermissionPresets', {})
            return { presets: result.presets ?? [], defaultPreset: result.defaultPreset ?? '' }
          },
          pickDirectory: pickDir,
          listWorkspaces: async () => {
            // 官方 ctx.workspaces.list 快照（与侧栏工作区分组同源）。
            const items = ctx.workspaces.list.getSnapshot().items
            return items.map((w) => ({ id: String(w.workspaceId), title: w.title, path: w.path }))
          },
        }
      })(),
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
