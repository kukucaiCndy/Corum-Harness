/**
 * @corum/corum-project-core build: host-only library (no browser half). tsdown bundles
 * the tsc-emitted ESM from lib/types into a single lib/index.js consumed by the
 * shell host. No client closure-factory here — this package runs entirely on
 * the host plane (role runtimes, task queue, scheduler).
 */
import { defineConfig } from 'tsdown'

export default defineConfig(() => [
  {
    name: '@corum/corum-project-core',
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
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-session',
      '@deepseek-ai/dsh-system-prompt',
      '@deepseek-ai/dsh-tools',
    ],
  },
])
