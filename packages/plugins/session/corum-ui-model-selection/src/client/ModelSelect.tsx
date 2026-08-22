/**
 * ModelSelect: the composer's named model seat (`conversation.input.model`).
 * Single-level dropdown: the trigger shows model name + current effort, and
 * clicking opens the provider-grouped model list directly. Hovering a model
 * with reasoning support reveals a submenu for selecting its effort level.
 * Data and submission ride the SAME per-session ModelDirectory as the
 * /model popup; exact-model reasoning metadata and the selected effort come
 * from the Host rather than a client-owned vocabulary. A rejected selection
 * announces through the shared transient Toast anchored to the composer
 * card; the in-menu strip with Retry remains the catalog-load surface.
 */
import {
  useEffect, useId, useMemo, useRef, useState, useSyncExternalStore,
  type KeyboardEvent, type FocusEvent,
} from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import type { ModelReasoningEffort, ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import {
  IconCheckOutline16, IconChevronDownOutline14, IconChevronRightOutline14,
  IconQuestionOutline14, IconWarningOutline16, Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelSelectInjected } from './slots.ts'
import css from './ModelSelect.module.css'

/** One dynamic effort row; undefined means preserve the provider default. */
interface EffortChoice {
  key: string
  effort: string | undefined
  label: string
  description?: string
}

/**
 * Render the composer model seat.
 * @param props - owner share (locked) + injected face (shared directory
 * store/verbs) + the standard locale seat.
 * @returns the trigger and, while open, the single-level menu with hover submenus.
 */
export function ModelSelect(
  { locked, available, directory, load, select, t }:
  ModelSelectInjected & { locked: boolean } & PropsLocale<'model'>,
) {
  const state = useSyncExternalStore(
    fn => directory.subscribe(fn),
    () => directory.getSnapshot(),
  )
  const [open, setOpen] = useState(false)
  const [hoveredModelId, setHoveredModelId] = useState<string | null>(null)
  // The submenu is position:fixed (it must escape the main menu's overflow
  // clipping), so it anchors to the hovered row's viewport rect.
  const [submenuAnchor, setSubmenuAnchor] = useState<{ top: number; left: number } | null>(null)
  // The in-menu error strip serves catalog loads (its Retry re-runs the
  // load); a rejected SELECTION announces through the transient toast
  // instead, so the strip renders only while the latest failure-capable
  // action was a load.
  const lastActionRef = useRef<'load' | 'select'>('load')
  const [toast, setToast] = useState<{ seq: number; text: string; kind: 'error' | 'info' } | null>(null)
  const toastSeq = useRef(0)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const submenuRefs = useRef<Map<string, HTMLDivElement | null>>(new Map())
  // Bridge the physical gap between a model row and its portaled submenu: the
  // pointer crosses dead space on the way over, which would otherwise fire the
  // row's mouseleave and dismiss the submenu before it can be reached.
  const submenuCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const id = useId()

  const choices = useMemo(() => state.groups.flatMap(group =>
    group.models.map(model => ({
      group,
      model,
      selection: {
        provider: group.id,
        model: model.id,
        ...model.reasoning?.defaultEffort === undefined
          ? {}
          : { reasoningEffort: model.reasoning.defaultEffort },
      } satisfies ModelSelection,
    }))), [state.groups])
  const selectedIndex = state.current === null
    ? -1
    : choices.findIndex(c => c.selection.provider === state.current?.provider && c.selection.model === state.current.model)
  const currentChoice = choices[selectedIndex]
  const reasoning = currentChoice?.model.reasoning
  const effectiveEffort = state.current?.reasoningEffort ?? reasoning?.defaultEffort
  const effortLabel = reasoning === undefined
    ? undefined
    : effectiveEffort === undefined
      ? t('effort.providerDefault')
      : reasoning.efforts.find(level => level.id === effectiveEffort)?.name ?? effectiveEffort
  const busy = state.status === 'selecting'

  const reload = (): void => {
    lastActionRef.current = 'load'
    load()
  }

  // Mount-time load resolves the trigger label; every open refreshes.
  useEffect(() => {
    if (available) {
      lastActionRef.current = 'load'
      load()
    }
  }, [available, load])

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: MouseEvent): void => {
      const target = event.target as Node
      if (rootRef.current?.contains(target)) return
      // The portaled submenu lives outside rootRef's DOM subtree; treat clicks
      // inside it as inside so choosing an effort doesn't dismiss the menu.
      for (const node of submenuRefs.current.values()) {
        if (node?.contains(target)) return
      }
      close()
    }
    document.addEventListener('mousedown', closeOutside)
    return () => { document.removeEventListener('mousedown', closeOutside) }
  }, [open])

  if (!available) return null

  const show = (): void => {
    setOpen(true)
    setHoveredModelId(null)
    setSubmenuAnchor(null)
    reload()
  }

  const close = (restoreFocus = false): void => {
    if (submenuCloseTimer.current !== null) {
      clearTimeout(submenuCloseTimer.current)
      submenuCloseTimer.current = null
    }
    setOpen(false)
    setHoveredModelId(null)
    setSubmenuAnchor(null)
    if (restoreFocus) queueMicrotask(() => { triggerRef.current?.focus() })
  }

  const openSubmenu = (modelId: string, row: HTMLElement): void => {
    if (submenuCloseTimer.current !== null) {
      clearTimeout(submenuCloseTimer.current)
      submenuCloseTimer.current = null
    }
    const rect = row.getBoundingClientRect()
    setHoveredModelId(modelId)
    setSubmenuAnchor({ top: rect.top, left: rect.right + 4 })
  }

  const closeSubmenu = (): void => {
    if (submenuCloseTimer.current !== null) clearTimeout(submenuCloseTimer.current)
    // Delay so the pointer can travel from the row into the portaled submenu
    // without the submenu vanishing mid-move; cancelled by entering either.
    submenuCloseTimer.current = setTimeout(() => {
      submenuCloseTimer.current = null
      setHoveredModelId(null)
      setSubmenuAnchor(null)
    }, 150)
  }

  // Entering the portaled submenu keeps it open (cancels the pending close).
  const keepSubmenu = (): void => {
    if (submenuCloseTimer.current !== null) {
      clearTimeout(submenuCloseTimer.current)
      submenuCloseTimer.current = null
    }
  }

  const moveFocus = (offset: number): void => {
    const items = itemRefs.current.filter(item => item !== null)
    if (items.length === 0) return
    const active = items.findIndex(item => item === document.activeElement)
    const next = (Math.max(active, 0) + offset + items.length) % items.length
    items[next]?.focus()
  }

  const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      close(true)
      return
    }
    if (!open) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveFocus(event.key === 'ArrowDown' ? 1 : -1)
    }
  }

  const onBlur = (event: FocusEvent<HTMLDivElement>): void => {
    const next = event.relatedTarget
    if (next instanceof Node) {
      if (rootRef.current?.contains(next)) return
      // Focus may move into the portaled submenu; that is still "inside".
      for (const node of submenuRefs.current.values()) {
        if (node?.contains(next)) return
      }
    }
    close()
  }

  const settleSelection = (accepted: boolean): void => {
    if (accepted) {
      if (rootRef.current !== null) close(true)
      return
    }
    const state = directory.getSnapshot()
    // CORUM-PATCH: a rejected model switch because the session already contains
    // images is a CONSTRAINT, not a defect — present it as a friendly info
    // hint instead of a generic "operation failed" error.
    if (state.errorKind === 'model-unavailable') {
      toastSeq.current += 1
      setToast({ seq: toastSeq.current, text: t('error.modelUnavailable'), kind: 'info' })
      return
    }
    const message = state.error
    if (message !== null) {
      toastSeq.current += 1
      setToast({ seq: toastSeq.current, text: t('error.action', { message }), kind: 'error' })
    }
  }

  const choose = (selection: ModelSelection): void => {
    if (state.current?.provider === selection.provider && state.current.model === selection.model) {
      close(true)
      return
    }
    lastActionRef.current = 'select'
    void select(selection).then(settleSelection)
  }

  const chooseEffort = (modelSelection: ModelSelection, effort: string | undefined): void => {
    const selection: ModelSelection = {
      provider: modelSelection.provider,
      model: modelSelection.model,
      ...effort === undefined ? {} : { reasoningEffort: effort },
    }
    if (state.current?.provider === selection.provider
      && state.current.model === selection.model
      && state.current?.reasoningEffort === selection.reasoningEffort) {
      close(true)
      return
    }
    lastActionRef.current = 'select'
    void select(selection).then(settleSelection)
  }

  const modelLabel = currentChoice?.model.name ?? t('trigger.fallback')
  const triggerLabel = effortLabel === undefined ? modelLabel : `${modelLabel} · ${effortLabel}`
  const triggerAria = currentChoice === undefined
    ? t('trigger.selectAria')
    : effortLabel === undefined
      ? t('trigger.aria', { model: modelLabel })
      : t('trigger.ariaEffort', { model: modelLabel, effort: effortLabel })
  itemRefs.current = []
  let itemIndex = 0
  const itemRef = () => {
    const at = itemIndex++
    return (node: HTMLButtonElement | null) => { itemRefs.current[at] = node }
  }

  const getEffortChoices = (modelReasoning: typeof reasoning): readonly EffortChoice[] => {
    if (modelReasoning === undefined) return []
    return [
      ...modelReasoning.defaultEffort === undefined
        ? [{ key: 'provider-default', effort: undefined, label: t('effort.providerDefault') }]
        : [],
      ...modelReasoning.efforts.map((effort: ModelReasoningEffort) => ({
        key: `effort:${effort.id}`,
        effort: effort.id,
        label: effort.name,
        ...effort.description === undefined ? {} : { description: effort.description },
      })),
    ]
  }

  return (
    <div ref={rootRef} className={css.root} onKeyDown={onRootKeyDown} onBlur={onBlur}>
      <button
        ref={triggerRef}
        type="button"
        className={css.trigger}
        aria-label={triggerAria}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        title={triggerLabel}
        disabled={locked}
        onClick={() => {
          if (open) {
            close()
          } else {
            show()
          }
        }}
      >
        <span className={css.triggerLabel}>{modelLabel}</span>
        {effortLabel !== undefined && <span className={css.triggerEffort}>{effortLabel}</span>}
        <IconChevronDownOutline14 className={clsx(css.chevron, open && css.chevronOpen)} />
      </button>

      {open && (
        <div
          id={`${id}-menu`}
          className={css.menu}
          role="menu"
          aria-label={t('menu.aria')}
          aria-busy={state.status === 'loading' || busy}
        >
          {state.status === 'loading' && (
            <div className={css.status}>{t('status.loading')}</div>
          )}
          {state.error !== null && lastActionRef.current === 'load' && (
            <div className={css.error}>
              <span>{t('error.action', { message: state.error })}</span>
              <button type="button" className={css.retry} onClick={reload}>{t('action.reload')}</button>
            </div>
          )}
          {state.failures.map(failure => (
            <div className={css.warning} key={failure.id}>
              <span>{t('warning.groupLoad', { name: failure.name, message: failure.message })}</span>
              <button type="button" className={css.retry} onClick={reload}>{t('action.reload')}</button>
            </div>
          ))}
          <div className={clsx(css.groups, 'scrollable')}>
            {state.groups.map((group) => {
              const headingId = `${id}-${group.id}`
              return (
                <section role="group" aria-labelledby={headingId} className={css.group} key={group.id}>
                  <div className={css.groupTitle} id={headingId}>{group.name}</div>
                  {group.models.map((model) => {
                    const selected = state.current?.provider === group.id && state.current.model === model.id
                    const hasReasoning = model.reasoning !== undefined
                    const isHovered = hoveredModelId === model.id
                    const modelEffortChoices = getEffortChoices(model.reasoning)
                    const modelEffectiveEffort = selected
                      ? effectiveEffort
                      : model.reasoning?.defaultEffort

                    return (
                      <div
                        key={model.id}
                        className={css.optionWrapper}
                        onMouseEnter={(event) => {
                          if (hasReasoning) openSubmenu(model.id, event.currentTarget)
                        }}
                        onMouseLeave={closeSubmenu}
                      >
                        <button
                          ref={itemRef()}
                          type="button"
                          role="menuitemradio"
                          aria-checked={selected}
                          className={clsx(css.option, selected && css.selected)}
                          title={model.name}
                          disabled={busy}
                          onClick={() => { choose({ provider: group.id, model: model.id }) }}
                        >
                          <span className={css.optionCopy}>
                            <span className={css.modelName}>{model.name}</span>
                            {model.description !== undefined && (
                              <span className={css.description}>{model.description}</span>
                            )}
                          </span>
                          <span className={css.check}>
                            {selected ? <IconCheckOutline16 /> : null}
                          </span>
                          {hasReasoning && (
                            <IconChevronRightOutline14 className={css.cellChevron} />
                          )}
                        </button>

                        {/* Hover submenu for reasoning effort. Portaled to body so it
                            escapes the composer card's backdrop-filter containing block
                            and renders as a true flyout beside the hovered row. */}
                        {hasReasoning && isHovered && submenuAnchor !== null && createPortal(
                          <div
                            ref={node => { submenuRefs.current.set(model.id, node) }}
                            className={css.submenu}
                            style={{ top: submenuAnchor.top, left: submenuAnchor.left }}
                            role="menu"
                            aria-label={t('menu.effort')}
                            onMouseEnter={keepSubmenu}
                            onMouseLeave={closeSubmenu}
                          >
                            {modelEffortChoices.map(level => {
                              const isEffortSelected = selected && modelEffectiveEffort === level.effort
                              return (
                                <button
                                  key={level.key}
                                  type="button"
                                  role="menuitemradio"
                                  aria-checked={isEffortSelected}
                                  className={clsx(css.submenuOption, isEffortSelected && css.selected)}
                                  disabled={busy}
                                  onClick={() => {
                                    chooseEffort(
                                      { provider: group.id, model: model.id },
                                      level.effort
                                    )
                                  }}
                                >
                                  <span className={css.optionCopy}>
                                    <span className={css.modelName}>{level.label}</span>
                                    {level.description !== undefined && (
                                      <span className={css.description}>{level.description}</span>
                                    )}
                                  </span>
                                  <span className={css.check}>
                                    {isEffortSelected ? <IconCheckOutline16 /> : null}
                                  </span>
                                </button>
                              )
                            })}
                          </div>,
                          document.body,
                        )}
                      </div>
                    )
                  })}
                </section>
              )
            })}
          </div>
          {state.status === 'ready' && choices.length === 0 && (
            <div className={css.empty}>{t('empty.models')}</div>
          )}
        </div>
      )}
      {toast !== null && (
        <Toast
          key={toast.seq}
          text={toast.text}
          icon={toast.kind === 'info' ? <IconQuestionOutline14 /> : <IconWarningOutline16 />}
          anchor={rootRef.current?.closest<HTMLElement>('[data-composer-card]') ?? null}
          onDone={() => { setToast(null) }}
        />
      )}
    </div>
  )
}
