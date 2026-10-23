/**
 * @corum/corum-extension-pack build（host-only **纯函数库**）。
 *
 * 本包**不注册 cordis 服务**、不做 `apply(ctx)`：P1 只定义格式与校验器，
 * 不做磁盘扫描/目录遍历/安装逻辑（那是 P2 的职责）。故没有第二入口，
 * 也不需要任何 cordis/typert 依赖。`host.external` 为空数组：P1 不依赖
 * 任何 `@corum/*` 运行时包（红线 2：不随意 externalize `@corum/*`，
 * 但这里压根没有 `@corum/*` 依赖，自然为空）。
 */
import { definePluginBundle } from '@corum/plugin-build'

export default definePluginBundle({
  id: '@corum/corum-extension-pack',
  host: {
    external: [],
  },
  client: false,
})
