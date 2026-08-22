/**
 * @corum/dev-agent build: host-only library (no browser half yet). tsdown
 * bundles the tsc-emitted ESM from lib/types into lib/index.js consumed by the
 * shell host. The client half (settings UI + dialog) lands in a later increment.
 */
import { defineConfig } from 'tsdown'

export default defineConfig(() => [
  {
    name: '@corum/dev-agent',
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
      '@deepseek-ai/dsh-agent',
      '@deepseek-ai/dsh-agent-default-model',
      '@deepseek-ai/dsh-agent-presets',
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-persona',
      '@deepseek-ai/dsh-session',
      '@deepseek-ai/dsh-system-prompt',
      '@deepseek-ai/dsh-tools',
    ],
  },
])
