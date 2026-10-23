/**
 * @corum/corum-extension-pack build（host-only **纯函数库**）。
 *
 * 本包**不注册 cordis 服务**、不做 `apply(ctx)`：P1 只定义格式与校验器；
 * P2 增加了目录扫描与安装（仍是纯函数，对磁盘做确定性读写）；
 * P3a 增加了插件 insert 行持久层（entries.json 读写 + boot 折行辅助）。
 *
 * 两个 `@corum/*` 依赖（preset-modules 的 `installProfileModule` / `validateMcpEntry` /
 * `unpackModuleArchive`，mcp-manager 的 `saveServer` / `McpServerConfig`）保持 external：
 * host 从真实安装解析，与工作区/闭包里的那份**必须是同一个模块实例**
 * （红线 1 的同源纪律：模块级状态跨 bundle 分裂的代价本仓已付过；
 * 这与 corum-preset-modules 的 external 配置同款）。
 *
 * `@deepseek-ai/cordis-plugin-include` 与 `@deepseek-ai/cordis-plugin-loader`
 * 是纯类型依赖（P3a 只 import PatchOptions/EntryOptions 类型做类型标注，运行时不
 * 引用其导出值），external 让 tsdown 不打进 bundle、由 host 从真实安装解析
 * （与 desktop 的同类型源，避免类型分裂）。
 */
import { definePluginBundle } from '@corum/plugin-build'

export default definePluginBundle({
  id: '@corum/corum-extension-pack',
  host: {
    // `@deepseek-ai/cordis-plugin-include` 与 `@deepseek-ai/cordis-plugin-loader`
    // 是纯类型依赖（只 import PatchOptions/EntryOptions 类型），external 让 tsdown
    // 不打进 bundle、由 host 从真实安装解析。
    external: ['@corum/corum-preset-modules', '@corum/corum-mcp-manager', '@deepseek-ai/cordis-plugin-include', '@deepseek-ai/cordis-plugin-loader'],
  },
  client: false,
})
