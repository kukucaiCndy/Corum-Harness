import { defineConfig } from 'tsdown'

export default defineConfig(() => [
  {
    name: '@corum/corum-git-core',
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
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-scope',
      '@deepseek-ai/dsh-typert-protocol',
      '@corum/corum-api-remotes',
    ],
  },
])
