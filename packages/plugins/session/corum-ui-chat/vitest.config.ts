/**
 * @corum/corum-ui-chat test config.
 *
 * Minimal vitest config for the review-source unit tests. No decorator syntax
 * in the tested source, so no special pre-transform is needed (unlike
 * @corum/corum-subagent).
 *
 * 2026-10-29：加入组件渲染测试（`turn-tail-list.spec.tsx`）后，官方
 * `@deepseek-ai/dsh-client-ui-primitives` 会被作为**外部依赖**直接交给 Node 加载，
 * 而它的 lib 里有 `*.module.css` 导入 ⇒ Node 报 `Unknown file extension ".css"`。
 * 把该包 inline 进 Vite 处理链后，CSS 模块走 Vite 的转换（测试不关心样式）。
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
    pool: 'forks',
    server: {
      deps: {
        inline: ['@deepseek-ai/dsh-client-ui-primitives'],
      },
    },
  },
})
