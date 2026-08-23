import { defineConfig } from 'tsdown'

export default defineConfig(() => [
  {
    name: '@corum/corum-mcp-manager-dev',
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
      '@modelcontextprotocol/sdk',
    ],
  },
])
