/**
 * @corum/corum-ui-navigation build: standalone tsdown config mirroring
 * corum-ui-conversation. The browser bundle is a closure-factory artifact —
 * it calls window.__ModuleLoader__.load({id, factory}) and resolves externals
 * through the loader module table. This package has no CSS (no inline-css
 * step needed), but the build script includes it for parity — corum-inline-css
 * is a no-op when lib/style.css is absent.
 *
 * External rule (same contract as the official clientBundle preset): the
 * desktop seed module table answers the shell baseline (react, cordis,
 * ui-slots) plus every specifier this package declares in dsh.client.external;
 * inline-safe wire layers (dsh-session) are bundled.
 */
import { definePluginBundle } from '@corum/plugin-build'

export default definePluginBundle({
  id: '@corum/corum-ui-navigation',
  client: {
    extraExternals: ['@deepseek-ai/dsh-api-session-controller/client', '@deepseek-ai/dsh-client-store'],
    pinConditionNames: true,
  },
})
