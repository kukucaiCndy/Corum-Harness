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
 *
 * 2026-11-13：TurnTriggerCard 的识别逻辑下沉到 conversation 后，chat 组件测试经
 * `@corum/corum-ui-conversation/client` 拉到的是**构建产物** lib/client.js——它带 dsh
 * 客户端加载器包装（顶层 `window.__ModuleLoader__.load`），node 测试环境无 window 即炸。
 * 别名指向 conversation 的**源码入口**（与其自身测试同口径）：Vite 转换源码，顶层无
 * window 引用，CSS 模块走转换链。生产构建不受影响（仍走包导出面的 lib 产物）。
 */
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@corum/corum-ui-conversation/client': resolve(import.meta.dirname, '../corum-ui-conversation/src/client/index.ts'),
    },
  },
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
