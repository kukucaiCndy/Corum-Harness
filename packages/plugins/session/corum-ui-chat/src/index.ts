/** Host registration for browser Chat preferences. */

import type {} from '@deepseek-ai/dsh-settings'
import type { Volatile, Context } from '@deepseek-ai/cordis'
import type { ChatSettings } from './chat-settings.ts'
import z from '@deepseek-ai/schemastery'
import { TRANSCRIPT_VIEW_FIELD, ChatSettingsFields } from './chat-settings.ts'

export {
  CHAT_SETTINGS_NAMESPACE, DEFAULT_TRANSCRIPT_VIEW_MODE, TRANSCRIPT_VIEW_FIELD,
  TRANSCRIPT_VIEW_MODES, type ChatSettings, type TranscriptViewMode,
} from './chat-settings.ts'

/** Runtime preferences projected to the browser. */
export interface Config {
  /** Completed turn transcript presentation. */
  transcriptView: Volatile<ChatSettings['transcriptView']>
}

/** Live preferences projected to the browser. */
export const Config = z.object({
  [TRANSCRIPT_VIEW_FIELD]: ChatSettingsFields[TRANSCRIPT_VIEW_FIELD].volatile(),
})

/**
 * Host preferences are consumed through the configuration form projection.
 * rc3: `settings.register(namespace, schema)` was removed — the `static Config`
 * schemastery schema + `settings.configure({auto: false})` replaces it.
 * @param ctx Plugin context used for optional settings presentation.
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })
}
