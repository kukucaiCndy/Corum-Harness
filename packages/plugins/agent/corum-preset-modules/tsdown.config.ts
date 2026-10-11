/**
 * @corum/corum-preset-modules build（host-only **纯函数库**）。
 *
 * 本包**不注册 cordis 服务**、不做 `apply(ctx)`：它是一组对磁盘做确定性读写的纯函数
 * （导出 / 计划 / 安装 / 前置依赖探测）。RPC 端点由 `@corum/corum-agent` 挂载，
 * 故这里没有第二入口，也不需要任何 cordis/typert 依赖。
 *
 * 两个 `@corum/*` 依赖（skill-manager 的 tombstone 语义、mcp-manager 的 `McpServerConfig`
 * 类型）保持 external：host 从真实安装解析，与工作区/闭包里的那份**必须是同一个模块实例**
 * （红线 1 的同源纪律：模块级状态跨 bundle 分裂的代价本仓已付过）。
 */
import { defineConfig } from 'tsdown'

export default defineConfig(() => [
  {
    name: '@corum/corum-preset-modules',
    entry: ['lib/types/index.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    external: [
      '@corum/corum-mcp-manager',
      '@corum/corum-skill-manager',
    ],
  },
])
