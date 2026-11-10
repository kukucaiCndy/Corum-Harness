/**
 * Welcome-notice state derived from the welcome settings config form. The form is
 * the transport: a loopback browser follows the durable Host section, while a
 * remote browser's unavailable form never answers and the acknowledgement
 * stays process-local here.
 */

import { type ConfigForm, type ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { type SnapshotStore, createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  WELCOME_NOTICE_ACK_FIELD, WELCOME_NOTICE_VERSION,
} from '../onboarding-copy.ts'

/** State rendered by the welcome step. */
export interface WelcomeNoticeState {
  status: 'idle' | 'loading' | 'ready' | 'saving' | 'error'
  acknowledged: boolean
  error: string | null
}

/** The welcome section as the notice reads it. */
export type WelcomeSection = Record<string, unknown>

/**
 * Accept any object section verbatim; a malformed durable value reads as an
 * empty section, so the notice treats it as unacknowledged instead of leaving
 * the form stuck on its previous value.
 * @param section - the wire section value.
 * @returns the section object, or an empty one for non-object values.
 */
export function decodeWelcomeSection(section: unknown): WelcomeSection {
  return typeof section === 'object' && section !== null && !Array.isArray(section)
    ? section as WelcomeSection
    : {}
}

/* v8 ignore next 3 -- closed-union default only defends future source widening */
function assertNever(_value: never): never {
  throw new Error('unexpected welcome settings status')
}

/** Coordinates durable Host acknowledgement or a process-local remote fallback. */
export class WelcomeNoticeStore {
  /** uSES-safe state source shared by the registered welcome step. */
  readonly store: SnapshotStore<WelcomeNoticeState> = createSnapshotStore<WelcomeNoticeState>({
    status: 'idle', acknowledged: false, error: null,
  })

  private localAcknowledged = false
  private saving = false
  private following: (() => void) | undefined

  /**
   * @param form - the welcome settings namespace config form.
   */
  constructor(private readonly form: ConfigForm<WelcomeSection>) {}

  /**
   * Begin following the form (idempotent) and publish its current answer.
   * @returns settlement after the current answer is published.
   */
  load(): Promise<void> {
    this.following ??= this.form.subscribe(() => { this.derive() })
    this.derive()
    return Promise.resolve()
  }

  /**
   * Persist this copy version, or advance only this process for a remote
   * browser. Success is judged against the state the write left behind, so a
   * refused or failed write reports false after its recovery read settles.
   * @returns true when the selected persistence mode holds the acknowledgement.
   */
  async acknowledge(): Promise<boolean> {
    const snapshot = this.form.getSnapshot()
    // rc3: `unavailable` replaces the old `memory` mode — a remote browser's
    // form never answers, so the acknowledgement stays process-local.
    if (snapshot.status === 'unavailable') {
      this.localAcknowledged = true
      this.derive()
      return true
    }
    this.saving = true
    this.store.update((state) => { state.status = 'saving'; state.error = null })
    try {
      await this.form.set(WELCOME_NOTICE_ACK_FIELD, WELCOME_NOTICE_VERSION)
    } catch {
      this.saving = false
      this.derive()
      const { error } = this.store.getSnapshot()
      if (error === null) {
        this.store.update((state) => {
          state.status = 'error'
          state.error = 'the acknowledgement did not persist'
        })
      }
      return false
    } finally {
      this.saving = false
    }
    this.derive()
    const { acknowledged } = this.store.getSnapshot()
    if (!acknowledged) {
      this.store.update((state) => {
        state.status = 'error'
        state.error = 'the acknowledgement did not persist'
      })
    }
    return acknowledged
  }

  /** Stop following the form. */
  dispose(): void {
    this.following?.()
    this.following = undefined
  }

  private derive(): void {
    if (this.saving) return
    const snapshot: ConfigFormSnapshot<WelcomeSection> = this.form.getSnapshot()
    if (snapshot.status === 'unavailable') {
      this.store.update((state) => {
        state.status = 'ready'
        state.acknowledged = this.localAcknowledged
        state.error = null
      })
      return
    }
    switch (snapshot.status) {
      case 'loading':
        this.store.update((state) => { state.status = 'loading'; state.error = null })
        return
      case 'ready': {
        const acknowledged = snapshot.value?.[WELCOME_NOTICE_ACK_FIELD] === WELCOME_NOTICE_VERSION
        this.store.update((state) => {
          state.status = 'ready'
          state.acknowledged = acknowledged
          state.error = null
        })
        return
      }
      /* v8 ignore next -- every current settings form status is handled above */
      default: return assertNever(snapshot.status)
    }
  }
}
