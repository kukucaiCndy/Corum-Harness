/**
 * @corum/corum-agent-dev build: host-only library (no browser half yet). tsdown
 * bundles the tsc-emitted ESM from lib/types into lib/index.js consumed by the
 * shell host. The client half (settings UI + dialog) lands in a later increment.
 *
 * 第二入口 lib/types/contract/index.js → lib/contract/index.js：跨域 RPC 契约
 * 子路径（./contract 导出），纯类型 + 方法名常量，供 client 半消费方引用。
 */
import { defineConfig } from 'tsdown'

export default defineConfig(() => [
  {
    name: '@corum/corum-agent-dev',
    entry: ['lib/types/index.js', 'lib/types/contract/index.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    external: [
      '@corum/corum-mcp-manager-dev',
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-agent',
      '@deepseek-ai/dsh-agent-default-model',
      '@deepseek-ai/dsh-agent-presets',
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-persona',
      '@deepseek-ai/dsh-session',
      '@deepseek-ai/dsh-system-prompt',
      '@deepseek-ai/dsh-tools',
      '@deepseek-ai/dsh-typert-protocol',
      '@deepseek-ai/dsh-home-paths',
      '@deepseek-ai/dsh-storage-domain',
      'zod',
    ],
  },
])
