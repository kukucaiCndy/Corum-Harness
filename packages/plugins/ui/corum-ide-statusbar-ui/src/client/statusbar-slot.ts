/**
 * corum.statusBar 槽的本地 SlotMap 声明合并。
 *
 * 背景：状态栏功能已从壳（@corum/corum-ide-ui）整体移除（见
 * packages/desktop/cordis.ide.patch.yml 的说明），壳的 SlotMap 不再声明
 * `corum.statusBar` 行；但本包与 @corum/corum-ide-test-statusbar-ui 仍滞留
 * 注册该槽。按整改要求只补类型闭合、不改运行时行为，因此在本包内以
 * declare module 重新声明该行（list 型、root 作用域、无 owner 注入面）。
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots' // 让本文件成为模块，declare module 走增强而非替换

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** 状态栏横条槽：壳已移除渲染，声明仅为滞留注册代码保留类型闭合。 */
    'corum.statusBar': { kind: 'list'; scope: 'root' }
  }
}
