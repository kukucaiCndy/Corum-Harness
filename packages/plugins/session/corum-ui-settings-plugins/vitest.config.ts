/**
 * @corum/corum-ui-settings-plugins test config。
 *
 * 纯函数 + 真实 React DOM 回归（DOM 由仓库已有的 domino 提供，不新增依赖）；
 * 组件走 automatic JSX transform。
 */
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: {
      // 官方 primitives 的产物 import 了 workspace 里没安装的 `simple-icons`
      // （官方包的系统性打包缺陷），而本包的卡片只用到它的一个折叠图标 ⇒
      // 用同形替身，避免为一个视觉符号拉整包依赖。
      '@deepseek-ai/dsh-client-ui-primitives': fileURLToPath(
        new URL('tests/fixtures/primitives.tsx', import.meta.url),
      ),
    },
  },
  test: {
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
    pool: 'forks',
  },
})