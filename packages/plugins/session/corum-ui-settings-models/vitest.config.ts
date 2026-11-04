/**
 * @corum/corum-ui-settings-models test config。
 *
 * 纯函数与真实 React DOM 回归；组件使用 automatic JSX transform。
 */
import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  resolve: {
    // 测试消费真实组件源码，避免加载仅供浏览器 module loader 的打包产物。
    alias: { '@corum/corum-ui-base/client': fileURLToPath(new URL('../../ui/corum-ui-base/src/client/ConfirmDialog.tsx', import.meta.url)) },
  },
  test: {
    include: ['tests/**/*.spec.ts'],
    pool: 'forks',
  },
})
