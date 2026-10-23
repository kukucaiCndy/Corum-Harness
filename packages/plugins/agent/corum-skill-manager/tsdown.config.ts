/**
 * @corum/corum-skill-manager build: host-only library (no browser half). tsdown
 * bundles the tsc-emitted ESM from lib/types into lib/index.js consumed by the
 * shell host. The client half (settings UI + dialog) lives in IDE shell.
 */
import { definePluginBundle } from '@corum/plugin-build'

export default definePluginBundle({
  id: '@corum/corum-skill-manager',
  host: {
    external: ['@corum/corum-extension-registry', '@deepseek-ai/cordis', '@deepseek-ai/dsh-typert-protocol', '@deepseek-ai/dsh-home-paths'],
  },
  client: false,
})
