/**
 * @corum/corum-agent build: host-only library (no browser half yet). tsdown
 * bundles the tsc-emitted ESM from lib/types into lib/index.js consumed by the
 * shell host. The client half (settings UI + dialog) lands in a later increment.
 *
 * 第二入口 lib/types/contract/index.js → lib/contract/index.js：跨域 RPC 契约
 * 子路径（./contract 导出），纯类型 + 方法名常量，供 client 半消费方引用。
 *
 * 第三入口 lib/types/runtime-state.js → lib/runtime-state.js：卡住自动恢复阈值的
 * **唯一 holder**（./runtime-state 导出）。2026-09-26 项目模式剥离后，闭源仓
 * `@corum/corum-project` 的调度器与开源仓的 task 泳道必须共用同一个生效值，
 * 故这份模块级状态只能有一份 —— 闭源侧 re-export 本入口，不复制。
 *
 * 第四入口 lib/types/lane-support.js → lib/lane-support.js：闭源项目模式插件的
 * **支撑面**（./lane-support 导出：profile 编译/落盘、模型选择安装、事件投影、
 * 内置 PM 播种）。单开一条缝而不是塞进包根导出，理由见该文件头注。
 */
import { definePluginBundle } from '@corum/plugin-build'

export default definePluginBundle({
  id: '@corum/corum-agent',
  host: {
    entries: ['lib/types/index.js', 'lib/types/contract/index.js', 'lib/types/runtime-state.js', 'lib/types/lane-support.js'],
    external: ['@corum/corum-extension-registry', '@corum/corum-mcp-manager', '@deepseek-ai/cordis', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-agent-default-model', '@deepseek-ai/dsh-agent-presets', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-persona', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-typert-protocol', '@deepseek-ai/dsh-home-paths', '@deepseek-ai/dsh-storage-domain', 'zod'],
  },
  client: false,
})
