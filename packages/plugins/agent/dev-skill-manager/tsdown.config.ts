/**
 * @corum/dev-skill-manager build: host-only library (no browser half). tsdown
 * bundles the tsc-emitted ESM from lib/types into lib/index.js consumed by the
 * shell host. The client half (settings UI + dialog) lives in dev-agent-shell.
 */
import { defineConfig } from 'tsdown'

export default defineConfig(() => [
  {
    name: '@corum/dev-skill-manager',
    entry: ['lib/types/index.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    external: [
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-typert-protocol',
      '@deepseek-ai/dsh-home-paths',
    ],
  },
])
