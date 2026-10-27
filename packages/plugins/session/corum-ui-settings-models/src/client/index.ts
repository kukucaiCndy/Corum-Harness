/**
 * Models settings and product-onboarding plugin, browser half. It registers
 * the Models page plus the ordered internal-testing and official-DeepSeek
 * onboarding dialogs, whose UI shares this package's modal wrapper. The Host
 * settings and credential contracts stay behind their existing wire APIs.
 * Export discipline:
 * packages/client/AGENTS.md.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the ctx.remote merge and the forwarded-event key face
// (settings/credentials invalidations ride the allowlist) into this program.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { ModelsSection } from './ModelsSection.tsx'
import type { ModelsSectionInjected } from './ModelsSection.tsx'
import { DeepSeekOnboardingDialog } from './DeepSeekOnboardingDialog.tsx'
import type { DeepSeekOnboardingInjected } from './DeepSeekOnboardingDialog.tsx'
import { WelcomeNotice } from './WelcomeNotice.tsx'
import type { WelcomeNoticeInjected } from './WelcomeNotice.tsx'
import { decodeWelcomeSection, WelcomeNoticeStore, type WelcomeSection } from './welcome-store.ts'
import { ModelsSettingsStore, createLocalLlmModels } from './store.ts'
import type { LocalLlmConnection, ModelsWire } from './store.ts'
import { createSettingsSchemaOperations } from './schema-operations.ts'
import { en, zh, type ModelsKey } from './locales.ts'
import { WELCOME_NOTICE_SETTINGS_NAMESPACE } from '../onboarding-copy.ts'

export type { ModelsSectionInjected, ModelsSectionProps } from './ModelsSection.tsx'
export type { ModelsFooterOwnerProps, ProviderCardExtrasOwnerProps } from './slot-contract.ts'
export type { ModelsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Models page + product-onboarding copy. */
    'settings.models': ModelsKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.models'
export type {
  LocalLlmConnection, LocalLlmModels, ModelsCredentials, ModelsLlm, ModelsSettingsState, ModelsWire,
  ProviderDirectoryEntry, ProviderRow,
} from './store.ts'

/**
 * Refetch the page snapshot only after its first load: an unopened Models
 * page must not fetch on background invalidations.
 * @param controller - the page store.
 */
export function refreshIfLoaded(controller: ModelsSettingsStore): void {
  if (controller.store.getSnapshot().status === 'idle') return
  void controller.load()
}

/**
 * Required services (cordis fiber inject). The target slot is declared by
 * ui-settings' apply, whose activation order relative to this one is NOT
 * constrained; registration depends on each slot through `slots.inject()`.
 */
export const inject = [
  'slots', 'locale', 'remote', 'remote.credentials', 'remote.llm', 'remote.settings',
  'configForms', 'settingsSchema',
  // fork（corum）：本机 Ollama 模型列表改走 host RPC（`localLlm/status`），
  // `connection.rpc.call('/api', …)` 是唯一入口 ⇒ 必须声明服务依赖（红线 4：
  // 声明式注入，不用 `ctx.get` 摸未装配的服务）。
  'connection',
]

/**
 * Register the Models section once the `settings.section` declaration is on
 * the ledger, wire its store to the connection, and keep it fresh on every
 * pushed invalidation (settings, credentials, or provider topology).
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-models: copy dictionaries')

  const schema = createSettingsSchemaOperations(ctx.settingsSchema)
  // Every configuration operation rides its owning Remote namespace.
  const wire: ModelsWire = {
    credentials: ctx.remote.credentials,
    llm: ctx.remote.llm,
    settings: ctx.remote.settings,
  }
  const controller = new ModelsSettingsStore(
    wire,
    schema,
    ctx.configForms.describe(),
    // fork（corum）：本机 Ollama 模型列表的唯一读取点。渲染层不再向
    // 127.0.0.1:11434 发请求（失败的 fetch 会在浏览器网络层留
    // `net::ERR_CONNECTION_REFUSED`，JS 抑制不了）。
    createLocalLlmModels(ctx.get('connection') as LocalLlmConnection | undefined),
  )
  // Registration-time text (the nav label thunk) and the inject faces share
  // one bound translate; copy freshness rides the locale revision.
  const t = ctx.locale.bind(NS) as ModelsSectionInjected['t']
  // Provider names are product nouns, not UI copy: they ride each brand as a
  // `{ en, zh }` map instead of dictionary keys (a key per vendor would rebuild the
  // self-maintained list this page just got rid of). The active locale id is read
  // from the service on each render, so switching language re-renders the names.
  const activeLocale = (): string => ctx.locale.getLocale().active
  const injected = (): ModelsSectionInjected => ({
    controller,
    hooks: { snapshot: controller.store },
    api: wire,
    schema,
    t,
    activeLocale,
  })
  const deepSeekOnboardingInjected = (): DeepSeekOnboardingInjected => ({
    controller,
    hooks: { models: controller.store },
    api: wire,
    schema,
    t,
  })
  // The scope's own memory mode is what keeps a remote browser process-local,
  // so the store needs no isLoopback branch of its own.
  const welcomeController = new WelcomeNoticeStore(
    ctx.configForms.get<WelcomeSection>(WELCOME_NOTICE_SETTINGS_NAMESPACE),
  )
  const welcomeInjected = (): WelcomeNoticeInjected => ({
    controller: welcomeController,
    hooks: { welcome: welcomeController.store },
    t,
  })

  // Pushed invalidations converge every open surface without polling. The
  // settingsScope injection makes ui-settings activate first, and remote
  // dispatch preserves listener order; its listener therefore starts the
  // mirror refresh before this store joins that refresh. The welcome notice
  // follows its settings scope, so it needs no subscription here.
  ctx.effect(() => {
    const refreshModels = (): void => { refreshIfLoaded(controller) }
    const disposers = [
      ctx.remote.$on('settings/document-updated', () => { refreshModels() }),
      ctx.remote.$on('credentials/reference-updated', refreshModels),
      ctx.remote.$on('llm/adapters-updated', refreshModels),
      ctx.on('connection/reset', refreshModels),
    ]
    return () => {
      welcomeController.dispose()
      for (const dispose of disposers) dispose()
    }
  }, 'ui-settings-models: pushed invalidations')

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'models',
    order: 10,
    label: () => t('nav'),
    inject: injected,
    children: {
      'settings.models.provider-card': { kind: 'keyed', scope: 'root' },
      'settings.models.footer': { kind: 'list', scope: 'root' },
    },
  }, ModelsSection))
  ctx.slots.inject('settings.onboarding', () => ctx.slots.register({
    name: 'settings.onboarding',
    id: 'welcome-notice',
    order: -100,
    inject: welcomeInjected,
  }, WelcomeNotice))
  ctx.slots.inject('settings.onboarding', () => ctx.slots.register({
    name: 'settings.onboarding',
    id: 'deepseek-official',
    order: 0,
    inject: deepSeekOnboardingInjected,
  }, DeepSeekOnboardingDialog))
}
