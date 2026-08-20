/**
 * 区域事件名 —— 单一事实源。
 *
 * 各区域工具组的「关闭区域」按钮发起 `CLOSE_REGION_EVENT`，壳统一隐藏对应
 * 网格叶子（树保留、持久化，可恢复）。事件名在此收敛，避免多文件硬编码
 * 字符串漂移。slot key 由子壳通过 grid.ts 的 registerSlot 自行定义。
 * @module shell-base/client/region-events
 */

/** 区域关闭事件名（CustomEvent，detail = { slot }）。 */
export const CLOSE_REGION_EVENT = 'corum:close-region'

/** 侧栏显隐切换事件名（CustomEvent，无 detail）。 */
export const TOGGLE_SIDEBAR_EVENT = 'corum:toggle-sidebar'
