# C3a：sidebarMode 演进为 IDE 壳 cordis 服务 —— 完成记录

> 专项：`docs/audit/NEXT-PHASE-DEFERRED.md` §1 C3a。前置「cordis 服务跨 bundle
> 单例」实证见 `.dbg/cordis-singleton-probe.md`（PASS）。本项是该实证的首个落地。

## 改了什么

| 包 | 改动 |
|---|---|
| `corum-ide-ui` | `service.ts`：`ILayout` + `LayoutController` 加 sidebarMode 状态面（`setSidebarMode`/`getSidebarMode`/`onSidebarModeChange`/`sidebarModeSnapshot`），服务实例持有 `#sidebarMode` + 监听者集；`index.tsx` 导出 `SidebarMode`/`SidebarModeSource` 类型 |
| `corum-ide-sidebar-ui` | `index.ts`：`SidebarSkeletonInjected` 加 `hooks.sidebarMode`（uSES 源）+ `setSidebarMode` 动作（桥 `ctx.layout`）；`SidebarSkeleton.tsx` 删本地 `useState` + window 广播，改 `useSidebarMode` 选择器读、`setSidebarMode` 动作写 |
| `corum-ui-conversation` | `apply.ts`：4 处 `setSidebarMode(...)`（openProject/newProject→project、openTask/newTask→task）从 ui-base window 全局改经 `ctx.layout`；类型上用局部能力接口 `SidebarModeCapableLayout` 收窄（见下「类型收窄」） |
| `corum-ui-base` | 删 `sidebar-mode.ts`（`__corumSidebarMode` 死代码）+ `index.ts` 导出 |

## 关键设计决策

1. **挂 `ctx.layout`，不新建服务**：sidebarMode 是壳域状态，`ctx.layout` 是 IDE 壳
   已有 cordis 服务（`LayoutController`），且 shell/sidebar/conversation 都已 inject
   它——零新服务、零额外 inject 声明。服务跨 bundle 单例（实证），故 `#sidebarMode`
   天然全局一致。

2. **类型收窄（conversation 侧）**：conversation 的 `ctx.layout` 类型来自官方基座
   `dsh-client-ui-layout` 的窄 `ILayout`（仅 toggleSidebar/openDetails/closeDetails），
   corum 运行时 `LayoutController` 是其超集。用**局部能力接口** `SidebarModeCapableLayout`
   + `sidebarModeLayout(ctx)` helper 收窄——与 C3b 契约同思路：编译期类型保障、零运行
   时改动、不强耦合 `@corum/corum-ide-ui` 包（conversation 不依赖它）。

3. **顺带修复退化 bug**：空态收敛（commit `fb2003e9`）删掉了 `__corumSidebarMode`
   唯一读端（EmptyStateHero 改双卡同显），此后只剩死写——**侧栏 tab 联动已断**（点
   空态「新建项目/任务」卡侧栏不翻转）。本项经 cordis 服务恢复该联动。

## 验证（CDP 实机，combo=coding）

- ✅ **四包 build + typecheck 全绿**。
- ✅ **tab 双向切换**：点「项目」→ `aria-selected`/`data-mode` = project；点「任务」→ 回 task。
- ✅ **跨 bundle 联动恢复**：点空态「新建项目」卡（conversation bundle 写服务）→
  侧栏 `data-mode` task→project + 项目面板接管（历史项目列表渲染）——sidebar bundle
  经同一服务实例重渲染。
- ✅ **`__corumSidebarMode` window 全局已删**：`typeof window.__corumSidebarMode === 'undefined'`。
- ✅ **控制台零报错**、无白屏（`#root` 有子节点、侧栏正常渲染）。

## 对 C1 的复用价值

本项走通了「cordis 服务作为跨 bundle 单例载体」的完整模式：
**provide（shell）+ inject（consumer）+ uSES 源（`sidebarModeSnapshot`）+ InjectFace
选择器 Hook（`useSidebarMode`）+ 动作面（`setSidebarMode`）**。`slotRegistry` 服务化
（C1 插件自声明槽）可直接套用此模式，无需 ui-base external 化。
