/**
 * InputHub: the SessionInputResolver implementation (`ctx.conversation.input`) — one
 * SessionInputShell per session, created inside the uiSession provide
 * materialization (the 'input' standard-kit entry IS the
 * creation trigger) and torn down by the scope disposer (instance-and-scope
 * share one lifecycle). The hub registers the scoped input-mutation
 * listeners on each Session context and owns the default-sink choreography: every session is a
 * real host entity, so the sink is one unconditional prompt path.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {
  ISessions, SessionBinding, SessionFace,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import { queueReadFaceOf } from './queue-store.ts'
import type {
  ComposerKeyboard, DraftAttachmentId, DraftAttachmentSerializationResult, InputTriggerController,
  SessionInputResolver, SessionInput, SubmitOutcome,
} from '../contract/input.ts'
import type { InputSubmitMode } from '../contract/composer-submission.ts'
import type { PopupDismissFace } from './facade.ts'
import { SessionInputShell } from './facade.ts'

/** Structural command face for per-session popup resolution. */
interface CommandFace {
  popupFor(actx: Context): PopupDismissFace
}

/** Optional input-trigger service resolved without importing its implementation. */
interface InputTriggerServiceFace {
  /** @param actx - Session scope. @returns that Session's trigger provider. */
  sessionOf(actx: Context): InputTriggerController
}

/** Attachment-send face resolved lazily to keep hub/service construction acyclic. */
interface ConversationAttachmentFace {
  sendSession(
    session: SessionFace,
    text: string,
    attachmentIds: readonly DraftAttachmentId[],
    mode: InputSubmitMode,
    signal?: AbortSignal,
  ): Promise<SubmitOutcome>
  serializeDraftAttachments(attachmentIds: readonly DraftAttachmentId[]): Promise<DraftAttachmentSerializationResult>
  releaseDraftAttachment(id: DraftAttachmentId): void
}

/** Session-addressed input facade registry (SessionInputResolver face + composer-layer extras). */
export class InputHub implements SessionInputResolver {
  private readonly shells = new Map<SessionId, SessionInputShell>()

  /**
   * @param ctx - client root context (services resolved lazily per call — boot order stays free).
   * @param t - conversation-namespace translate thunk (reads the active locale at call time).
   */
  constructor(
    private readonly rootCtx: Context,
    private readonly t: TranslateNS<'conversation'>,
  ) {}

  /**
   * Resolve the facade for one session-scope ctx (SessionInputResolver face).
   * @param actx - session-scope context.
   * @returns the resident per-session facade.
   */
  for(actx: Context): SessionInput {
    const sessions = this.sessions()
    const id = sessions.scopeOf(actx)
    if (id === undefined) throw new Error('conversation.input.for requires a session scope')
    return this.shell(id)
  }

  /**
   * Resident shell for one session binding — the provide-channel entry
   * (called during scope materialization, BEFORE the scope record is
   * queryable, hence binding-fed and hence the thunked slash/popup deps).
   * Wires the scoped event listeners + teardown into the session scope.
   * @param binding - session assembly handle.
   * @returns the shell.
   */
  shellFor(binding: SessionBinding): SessionInputShell {
    const existing = this.shells.get(binding.sessionId)
    if (existing !== undefined) return existing
    const { sessionId: id, session, ctx: actx } = binding
    const shell = new SessionInputShell({
      actx,
      inputTriggers: () => this.controller(actx),
      popup: () => this.popup(actx),
      queue: queueReadFaceOf(session),
      defaultSink: (text, attachmentIds, mode, signal) => this.sink(session, text, attachmentIds, mode, signal),
      steerQueue: () => { void this.steerQueue(session, shell) },
      commandAttachments: {
        serialize: async (ids) => {
          const result = await this.conversation().serializeDraftAttachments(ids)
          return result.attachments
        },
        // Asymmetric with serialize on purpose: release settles AFTER the
        // submit RPC, where session teardown may already have unloaded the
        // conversation service (the same tolerance as the scope disposer
        // above); leaked preview URLs then die with the document.
        release: (ids) => {
          const conversation = this.rootCtx.get('conversation') as ConversationAttachmentFace | undefined
          for (const attachmentId of ids) conversation?.releaseDraftAttachment(attachmentId)
        },
        unsupportedNotice: token => this.t('command.attachmentsUnsupported', {
          command: token.trim().replace(/^\//u, ''),
        }),
      },
    })
    this.shells.set(id, shell)
    // The one teardown axis: listeners, shell, and map entries all ride the
    // scope fiber (nothing here outlives the scope).
    actx.effect(() => {
      const offs = [
        actx.on('slash/input-begin-command', req =>
          shell.beginCommand(req.claim, req.span) ? true : undefined),
        actx.on('slash/input-insert-reference', req =>
          shell.insertReference(req.reference, req.span) ? true : undefined),
        actx.on('slash/input-consume-token', req =>
          shell.consumeToken(req.guard) ? true : undefined),
        actx.on('slash/input-insert-text', req =>
          shell.insertText(req.text, req.span, req.continue === true) ? true : undefined),
      ]
      return () => {
        for (const off of offs) off()
        const drafts = shell.dispose()
        this.shells.delete(id)
        const conversation = this.rootCtx.get('conversation') as ConversationAttachmentFace | undefined
        for (const attachmentId of drafts) conversation?.releaseDraftAttachment(attachmentId)
      }
    }, 'conversation.input: session shell')
    return shell
  }

  /**
   * Resident shell by session id (service-face path; the provide channel has
   * normally created it already — this covers direct id-addressed access).
   * @param id - session id.
   * @returns the shell.
   */
  shell(id: SessionId): SessionInputShell {
    const existing = this.shells.get(id)
    if (existing !== undefined) return existing
    const binding = this.sessions().binding(id)
    if (binding === undefined) throw new Error(`conversation.input: session "${id}" resolved no binding`)
    return this.shellFor(binding)
  }

  /**
   * The InputBar-exclusive keyboard command face: the shell
   * satisfies it structurally; package-internal — handed through the
   * composer-bar entry's inject, never across a plugin boundary.
   * @param id - session id.
   * @returns the shell as the keyboard face.
   */
  keyboard(id: SessionId): ComposerKeyboard {
    return this.shell(id)
  }

  /**
   * Resolve the optional slash controller for composer chrome that launches
   * the shared candidate menu without typing a trigger.
   * @param id - session id.
   * @returns the resident controller, or undefined when no trigger provider is installed.
   */
  inputTriggers(id: SessionId): InputTriggerController | undefined {
    const sessions = this.sessions()
    /**
     * rc3 契约（2026-10-29 实机）：官方 `inputTriggers.sessionOf(actx)` 要求该 ctx
     * 属于**已保留绑定的 Session 世代**（`sessions.binding(id).session` 必须就是它），
     * 否则抛 `slash.sessionOf requires a retained Session scope`。
     *
     * 历史会话（例如迁移进隔离 home 的旧 v4 会话）在**未物化**时没有 binding：
     * `sessions.scope(id)` 仍可能给出一个 scope ctx，但 `sessionOf` 会抛 —— 旧实现
     * 直接透传，于是渲染期整条集成分支崩（console 成对报错）。这里按契约先判绑定：
     * 未物化会话没有 slash 控制器，返回 undefined（调用方已有「缺席即降级」分支）。
     */
    if (sessions.binding(id) === undefined) return undefined
    const actx = sessions.scope(id)
    return actx === undefined ? undefined : this.controller(actx)
  }

  /**
   * Default sink: optimistic clear + prompt. The session is always a real
   * host entity (materialized when its workspace was picked), so there is
   * exactly one path; a failed first prompt is an ordinary prompt failure
   * (banner via promptError, draft restored only while untouched).
   */
  private sink(
    session: SessionFace,
    text: string,
    attachmentIds: readonly DraftAttachmentId[],
    mode: InputSubmitMode,
    signal: AbortSignal,
  ): Promise<SubmitOutcome> {
    if (text === '' && attachmentIds.length === 0) return Promise.resolve({ kind: 'success' })
    return this.conversation().sendSession(session, text, attachmentIds, mode, signal)
  }

  /**
   * Steer every still-pending queued message into the running turn, in FIFO
   * order — the same strict-steer operation as the queue dock's per-row
   * button. A turn closing mid-way (`session/steer-unavailable`) or a row already
   * claimed by the agent (`session/queue-item-not-found`) converges silently, while a
   * genuine failure surfaces as one composer notice. Repeated triggers
   * (e.g. two rapid empty-draft chords) rely on that `session/queue-item-not-found`
   * convergence: the snapshot may still list a row the host already steered,
   * and the duplicate strict steer is a silent no-op.
   * @param session - the addressed host session.
   * @param shell - the resident shell (notice outlet).
   */
  private async steerQueue(session: SessionFace, shell: SessionInputShell): Promise<void> {
    // rc3: SessionSnapshot.queue was removed; inbox `next-turn` entries are the
    // queued items. Each is a UserMessage whose `id` is the queue item id.
    const inbox = session.projections.faceOf('inbox').getSnapshot() as
      | { readonly 'next-turn'?: readonly { readonly id: string }[] }
      | undefined
    const queued = inbox?.['next-turn'] ?? []
    if (queued.length === 0) return
    for (const item of queued) {
      const result = await session.updateQueue(item.id as Parameters<typeof session.updateQueue>[0], { kind: 'steer' })
      if (result.ok) continue
      if (result.error.code === 'session/steer-unavailable' || result.error.code === 'session/queue-item-not-found') return
      shell.notify('error', this.t('queue.steerFailed'))
      return
    }
  }

  private controller(actx: Context): InputTriggerController | undefined {
    const inputTriggers = this.rootCtx.get('inputTriggers') as InputTriggerServiceFace | undefined
    if (inputTriggers === undefined) return undefined
    /**
     * rc3 契约（2026-10-29 实机）：官方 `sessionOf(actx)` **只在**该 ctx 仍属于
     * 当前保留的 Session 世代时可用，否则抛 `slash.sessionOf requires a retained
     * Session scope`。而 `SessionInputShell.onEditorUpdate` 会在**编辑器内容变化**时
     * 异步回调 `inputTriggers()` —— 此时会话可能已被释放/重新物化（快速切会话、
     * 清空回空态都会发生），shell 手里的 ctx 就成了上一代 ⇒ 官方侧必抛。
     *
     * 修法：先把官方的前置条件自己判一遍（`sessions.binding(id).ctx === actx`），
     * 不满足就当作「本代没有 slash 控制器」（返回 undefined，调用方已有降级分支）。
     * 这样既不吞真实错误、也不把一次过期回调升级成整条集成崩溃。
     */
    const id = this.sessions().scopeOf(actx)
    const binding = id === undefined ? undefined : this.sessions().binding(id)
    if (binding === undefined || binding.ctx !== actx) return undefined
    return inputTriggers.sessionOf(actx)
  }

  private popup(actx: Context): PopupDismissFace | undefined {
    const command = this.rootCtx.get('commandUi') as CommandFace | undefined
    return command?.popupFor(actx)
  }

  private sessions(): ISessions {
    const sessions = this.rootCtx.get('sessions')
    if (sessions === undefined) throw new Error('conversation.input: sessions service unavailable')
    return sessions
  }

  private conversation(): ConversationAttachmentFace {
    const conversation = this.rootCtx.get('conversation') as ConversationAttachmentFace | undefined
    if (conversation === undefined) throw new Error('conversation.input: conversation service unavailable')
    return conversation
  }
}
