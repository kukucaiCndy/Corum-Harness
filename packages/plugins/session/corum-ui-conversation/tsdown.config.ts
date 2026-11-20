/**
 * corum-ui-conversation build: standalone tsdown config mirroring
 * corum-ui-model-selection. The browser bundle is a closure-factory artifact —
 * it calls window.__ModuleLoader__.load({id, factory}) and resolves externals
 * through the loader module table. CSS Modules are compiled by tsdown's own
 * css pipeline and inlined into client.js (scripts/inline-css.mjs folds the
 * extracted sheet into the bundle).
 *
 * External rule (same contract as the official clientBundle preset): the
 * desktop seed module table answers the shell baseline (react, cordis,
 * ui-slots, ui-primitives, client-store) plus every specifier this package
 * declares in dsh.client.external; inline-safe wire layers
 * (dsh-session / dsh-llm / dsh-brand / dsh-util-* / dsh-token-meter/client and
 * generated /remote contributions) are bundled.
 */
import { definePluginBundle } from '@corum/plugin-build'

export default definePluginBundle({
  id: '@corum/corum-ui-conversation',
  client: {
    extraExternals: ['@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-api-session-controller/client', '@deepseek-ai/dsh-settings', '@corum/corum-ui-renderer'],
    pinConditionNames: true,
  },
})
