/**
 * 桌面覆盖层的**单一定义点**（rc3 修复：profileContext.overlays 丢失）。
 *
 * 为什么必须抽出来：官方 `readProfilePatches()`（`@deepseek-ai/dsh-app-boot`）用
 * `profileContext.overlays` 重算 profile 的完整 patch 列表，`dsh-config-editor` 的
 * `edit()`（设置中心/配置编辑器的写盘路径）与 `dsh-hmr` 的 `reconcileProfile()`
 * 都走它 → `recompose()`。desktop 的传输/模式/preset/combo 覆盖层如果只出现在
 * `boot()` 的入参里、而 profileContext.overlays 为空，那么**任何一次热重组都会把
 * 这些行还原成基座默认**：
 *   · webserver 从 `port: 0`（套接字 ephemeral）回落到基座 `3080`（本机常被占）；
 *   · 官方 plugin-manager / credentials 行重新激活 → `service "…" has been registered`；
 *   · IDE 壳行的 `disabled: true` 丢失 → 官方三栏壳与 corum 壳同时挂载。
 * 这不是「缓存了旧配置」，而是 recompose 的输入**确实不完整**（读的是 profileContext）。
 *
 * ## 分层规则（与冷启动 boot() 的层栈逐一对应）
 *
 * | 层 | 进入 profileContext.overlays？ | 理由 |
 * |----|-------------------------------|------|
 * | bundle / profile / home patches | 否（官方 `readProfilePatches` 自己读） | 重复会插入两遍 |
 * | desktop overlay（`cordis.patch.yml`） | **是** | 启动固定层 |
 * | preset overlay（`presets.patch.yml`） | **是** | 启动固定层 |
 * | mode overlay（IDE 模式 `cordis.ide.patch.yml`） | **是** | 启动固定层 |
 * | combo patches / combo rows | **是** | combo 在进程启动时定死 |
 * | telemetry patch | 否 | 官方 `readProfilePatches` 按 `telemetryDisabledEnv` 现算，重复会冲突 |
 * | extensionPackPatches（扩展包 insert 行） | 否 | 各走 `extensionManager` 热应用通道（append 语义、不去重） |
 * | disabledPatches（插件中心启停清单） | 否 | 各走 `CorumExtensionManager` 的现读通道（`getDisabledPatches`） |
 *
 * 关键纪律：**绝不为了「避免重复」而 filter 掉 `disabled: true` 的行**。
 * `disabled` 行同时承担「停用」与「抑制官方包、让 fork 独占 cordis service 名」两件事
 * （AGENTS.md 红线 5，`docs/LESSONS.md` §1.17）：过滤掉会让官方
 * `plugin-manager`/`credentials` 重新激活，热重组当场报 service 重复注册。
 *
 * @module corum-desktop/host/desktop-overlays
 */

import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'

/** combo 覆盖规则的两部分：`patches` 是覆盖行，`rows` 是插件 insert 行。 */
export interface ComboOverlayPatches {
  /** combo 的覆盖规则（`CORUM_COMBO_PATCHES` 里的 patch 文件）。 */
  readonly patches: readonly PatchOptions[]
  /** combo 的插件 insert 行（`CORUM_COMBO_PLUGINS`）。 */
  readonly rows: readonly PatchOptions[]
}

/**
 * 组成桌面层栈的全部输入。顺序即层栈顺序（后面的层覆盖前面的层），
 * 与 `boot()` 传给官方 `boot()` 的 patch 列表逐项一致。
 */
export interface DesktopOverlayLayers {
  /** 桌面传输覆盖层（`cordis.patch.yml`）。 */
  readonly overlays: readonly PatchOptions[]
  /** corum 预设覆盖层（`presets.patch.yml`）。 */
  readonly presetOverlays: readonly PatchOptions[]
  /** IDE 模式覆盖层（`cordis.ide.patch.yml`）；minimal 模式为空。 */
  readonly modeOverlays: readonly PatchOptions[]
  /** combo 覆盖规则（进程启动时由环境变量定死）。 */
  readonly comboOverlays: ComboOverlayPatches
  /** 扩展包插件 insert 行（运行期可变，走 extensionManager 热应用）。 */
  readonly extensionPackPatches: readonly PatchOptions[]
  /** 插件中心禁用清单（运行期可变，走 extensionManager 现读）。 */
  readonly disabledPatches: readonly PatchOptions[]
  /** telemetry opt-out patch（由 `resolveTelemetryPatch` 生成，可能为 undefined）。 */
  readonly telemetryPatch?: PatchOptions | undefined
}

/** `composeDesktopOverlays` 的两个产物。 */
export interface ComposedDesktopOverlays {
  /**
   * 启动固定层：只含「进程启动时定死」的覆盖层，按层栈顺序。
   * 这份就是 `profileContext.overlays`（官方 `readProfilePatches` 会把它接在
   * bundle → profile patch → home patch 之后，并自己补 telemetry patch）。
   */
  readonly fixedOverlays: PatchOptions[]
  /**
   * 冷启动传给 `boot()` 的完整覆盖层：固定层 + 扩展包 insert 行 + 插件中心禁用行
   * + telemetry patch。比固定层多出的三类**都不进** `profileContext.overlays`。
   */
  readonly bootOverlays: PatchOptions[]
}

/**
 * 按层栈顺序组合桌面覆盖层，产出「profileContext 用的固定层」与「boot 用的完整层」。
 *
 * 纯函数：不读环境变量、不读文件，同一输入恒得同一输出（两次返回的是新数组，
 * 但行对象是同一引用 —— 调用方交给 `boot()` 前自行 `structuredClone`）。
 *
 * ⚠️ 传进来的各层**必须已经去掉 `insert` 行**：行定义（insert）走运行期 bundle
 * （`runtime-bundle.ts`，位置在 profile patch 之前），否则设置中心的写盘守卫必然
 * 误拒（见该模块头注释的两条 composeEntries 事实）。`boot.ts` 用
 * {@link pickOverrideRows} 从解析结果里滤出覆盖行后再调本函数。
 * @param layers - 各层覆盖行（顺序即层栈顺序）。
 * @returns 固定层与完整层两份列表。
 */
export function composeDesktopOverlays(layers: DesktopOverlayLayers): ComposedDesktopOverlays {
  // 固定层：启动时定死、且 profileContext 必须能重放的部分。
  const fixedOverlays: PatchOptions[] = [
    ...layers.overlays,
    ...layers.presetOverlays,
    ...layers.modeOverlays,
    ...layers.comboOverlays.patches,
    ...layers.comboOverlays.rows,
  ]
  // 冷启动层栈：固定层之后再叠运行期可变的扩展包行、插件中心禁用行、telemetry。
  const bootOverlays: PatchOptions[] = [
    ...fixedOverlays,
    ...layers.extensionPackPatches,
    ...layers.disabledPatches,
  ]
  if (layers.telemetryPatch !== undefined) bootOverlays.push(layers.telemetryPatch)
  return { fixedOverlays, bootOverlays }
}

/**
 * 从一份解析后的 patch 列表里滤出**覆盖行**（不含 `insert`）。
 *
 * 为什么必须筛：`insert` 是 append 语义、不按 id 去重（官方
 * `@deepseek-ai/cordis-plugin-include` 的 applyEntryPatches），而行定义只能出现在
 * 运行期 bundle 那一层——同一个 insert 块既进 bundle 又进 overlay 会插出两行同 id，
 * loader 直接报错。覆盖行（`disabled: true` / `config`）留在 overlay 层，位置与
 * 历史行为一致。
 * @param rows - 解析后的 patch 行。
 * @returns 覆盖行（保持原顺序）。
 */
export function pickOverrideRows(rows: readonly PatchOptions[]): PatchOptions[] {
  return rows.filter(row => row.insert === undefined)
}

/**
 * 收齐一份 patch 列表里的 insert 行数（诊断/断言用：bundle 里应恰好出现这些行）。
 * @param rows - 解析后的 patch 行。
 * @returns insert 行总数。
 */
export function countInsertRows(rows: readonly PatchOptions[]): number {
  return rows.reduce((total, row) => total + (row.insert?.length ?? 0), 0)
}
