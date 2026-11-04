import { definePluginBundle } from '@corum/plugin-build'

export default definePluginBundle({
  id: '@corum/corum-cdp-router',
  host: {
    /**
     * `ws` 必须打进来（第三方宿主不一定装了它）；官方基座与 cordis 一律外置，
     * 否则会出现两份 cordis / 两份 typert 的实例分裂（AGENTS 红线）。
     */
    external: ['@deepseek-ai/cordis', '@deepseek-ai/dsh-typert-protocol', '@deepseek-ai/dsh-tools'],
  },
  /**
   * client 半：设置 ›「扩展」里的 **CDP 目标状态面板（只读）**。
   *
   * 入口显式写 `.tsx`：plugin-build 的缺省是 `src/client/index.ts`（无 x），
   * 而本面板是 React 组件，文件是 `.tsx` —— 不写就报
   * `UNRESOLVED_ENTRY: Cannot resolve entry module src/client/index.ts`。
   */
  client: {
    entry: 'src/client/index.tsx',
  },
})
