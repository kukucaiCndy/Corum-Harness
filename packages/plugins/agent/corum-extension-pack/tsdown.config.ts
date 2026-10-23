/**
 * @corum/corum-extension-pack build（host-only **纯函数库**）。
 *
 * 本包**不注册 cordis 服务**、不做 `apply(ctx)`：P1 只定义格式与校验器；
 * P2 增加了目录扫描与安装（仍是纯函数，对磁盘做确定性读写）。
 *
 * 两个 `@corum/*` 依赖（preset-modules 的 `installProfileModule` / `validateMcpEntry` /
 * `unpackModuleArchive`，mcp-manager 的 `saveServer` / `McpServerConfig`）保持 external：
 * host 从真实安装解析，与工作区/闭包里的那份**必须是同一个模块实例**
 * （红线 1 的同源纪律：模块级状态跨 bundle 分裂的代价本仓已付过；
 * 这与 corum-preset-modules 的 external 配置同款）。
 */
import { definePluginBundle } from '@corum/plugin-build'

export default definePluginBundle({
  id: '@corum/corum-extension-pack',
  host: {
    external: ['@corum/corum-preset-modules', '@corum/corum-mcp-manager'],
  },
  client: false,
})
