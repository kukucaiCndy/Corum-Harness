import { defineConfig } from 'tsdown'

/**
 * 本包构建**不注入**平台常量：host 侧 bundle 是平台无关构建（同一份 host 闭包
 * 被三个平台的产物复用），烘入值由 main 进程在 spawn host 时经
 * `CORUM_TARGET_PLATFORM` 环境变量透传（见 src/index.ts 的「两个读通道」）。
 * 编译期 define 注入只发生在 packages/desktop 的 Electron 壳 bundle。
 */
export default defineConfig(() => [
  {
    name: '@corum/corum-platform',
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
    ],
  },
])
