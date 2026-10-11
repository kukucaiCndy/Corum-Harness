/**
 * @corum/corum-preset-modules 测试配置。
 *
 * 与 corum-mcp-manager / corum-goal-round-driver 同款：测试直接 import `src/*.ts`
 * （Vite 原生转译），`include` 只收 tests 下的 spec，避免把 `src` 当测试扫。
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
  },
})
