/**
 * corum-ui-distill-card build: mirrors corum-ui-commit-card. The browser bundle
 * is a closure-factory artifact — it calls window.__ModuleLoader__.load({id,
 * factory}) and resolves externals through the loader module table. CSS
 * Modules are compiled by tsdown's own css pipeline and inlined into
 * client.js (scripts/inline-css.mjs folds the extracted sheet into the bundle).
 */
import { definePluginBundle } from '@corum/plugin-build'

export default definePluginBundle({
  id: '@corum/corum-ui-distill-card',
  client: {
    entry: 'src/client/index.tsx',
    extraExternals: ['@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-session', '@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-ui-renderer', '@deepseek-ai/dsh-api-session-controller/client', '@deepseek-ai/dsh-api-remotes/client'],
    pinConditionNames: true,
  },
})
