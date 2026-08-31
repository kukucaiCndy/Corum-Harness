# corum 开发规范

> 面向 corum Agent OS（kkc-desktop 仓库）的客户端/插件开发约定。每条都源自
> **真实踩过的坑或审计发现**，标注了实证依据。新增插件/改跨包状态前必读。
>
> 本期核心：**跨 bundle 共享状态一律走 cordis 服务，禁用 window 全局**——依据
> C3a 专项（`.dbg/cordis-singleton-probe.md` + `.dbg/C3a-sidebar-mode-service.md`）。

---

## 1. 跨 bundle 共享状态：一律 cordis 服务，禁 window 全局（本规范核心）

### 反模式（禁止）

把「多个插件都要读写的运行时状态」挂到 **window 全局** 或 **模块级变量**：

```ts
// ❌ 禁：window 全局共享可变状态
const w = window as unknown as { __corumFoo?: { mode: string } }
w.__corumFoo ??= { mode: 'task' }
export function setFoo(m: string) { w.__corumFoo!.mode = m }

// ❌ 禁：模块级单例（被各 bundle 各自内联后互不通）
let currentMode = 'task'
export const getMode = () => currentMode
```

**为什么禁**：dsh 的 client 打包机制会把 `@corum/*` 源码**各自内联**进每个消费
bundle（tsdown `noExternal`）——同一个库在每个 bundle 里是**独立的模块实例**，
模块级/window 挂点看似「全局」，实则按 bundle 拆分、互不可见。`__corumSidebarMode`
就是活例：侧栏 set 的是侧栏实例、会话区 get 的是会话实例，改成 cordis 服务前联动
直接断裂（且无人察觉——退化成死写）。

### 正例（必须）

共享状态做成 **IDE 壳（或提供方插件）的 cordis 服务**，经 `ctx.reflect.provide`
注册，消费方 `inject` 后读。**cordis 服务实例的唯一性由 root context 的
`reflect.store` 保证（按服务名 keyed，不经各 bundle 模块实例）——跨 bundle 天然单例
（已实证 PASS），无需 ui-base external 化。**

```ts
// ✅ 提供方（如 corum-ide-ui shell 的 LayoutController）
class LayoutController {
  #sidebarMode: SidebarMode = 'task'
  #listeners = new Set<() => void>()
  setSidebarMode(m: SidebarMode) { /* 幂等 + 广播 */ }
  getSidebarMode(): SidebarMode { return this.#sidebarMode }
  sidebarModeSnapshot() {   // uSES 源：组件选择器 Hook 用
    return { getSnapshot: () => this.getSidebarMode(),
             subscribe: (fn) => this.onSidebarModeChange(fn) }
  }
}
// shell apply 里：ctx.reflect.provide('layout', layout)
```

```ts
// ✅ 消费方（sidebar / conversation）：inject 已有服务即可，无需新声明
const mode = useSidebarMode(s => s)          // 组件经 InjectFace 选择器读
ctx.layout.setSidebarMode('project')          // apply 里写
```

### 决策树（要不要 / 怎么共享）

```
状态要被 ≥2 个独立 bundle 读写？
├─ 否 → 组件 useState / 包内 store，别上服务
└─ 是 → cordis 服务
        ├─ 该状态属于某已有服务域（布局/主题/会话…）？→ 挂到那个服务（如 ctx.layout），
        │   别新建服务——sidebarMode 挂 ctx.layout 就是这个考量：shell/sidebar/
        │   conversation 都已 inject，零新服务零额外 inject。
        └─ 无归属 → 新建独立服务，但先想清楚谁 provide、谁 inject
```

### 例外（允许的 window 挂点）

只有两类 window 挂点合法，且都不是「共享可变业务状态」：
- **一次性桥/服务对象**：desktop 壳注入的 `window.corumDesktop`（IPC 桥）、
  `__corumNotify`（通知函数）——写一次、只读，无跨 bundle 写竞争。
- **框架级只读 manifest**：`__DSH_BOOT__`（client 侧唯一读法，`parseBootManifest`
  是 loader 内部不暴露，插件只能裸读——C1 子项已实证，别再提「改 parseBootManifest」）。

判断红线：**「会被多个 bundle 写的状态」绝不上 window；「写一次只读」可以。**

---

## 2. cordis 服务使用规范

1. **provide 一次，位置固定**：服务实例在提供方插件的 `apply` 里 `new` 出来、
   `ctx.reflect.provide(name, instance)` 注册。同一服务名全组合只允许一个 provide 点
   （cordis 会 throw 重复注册）。
2. **消费方用 inject 声明，不用 `ctx.get` 裸取**：`inject: [...]` 声明依赖，cordis
   保证激活时就绪；`ctx.get(name)` 只在「可选依赖」场景用（且配降级），别拿它绕开
   inject 等依赖——fork 的 `ctx.remote` 坑（apply.ts 注释）就是裸取未装配服务的下场。
3. **跨 bundle 类型面不一致 → 局部能力接口收窄**：消费方 inject 的服务类型可能
   来自**官方基座窄接口**（如 conversation 看到的 `ctx.layout: ILayout` 只有 3 方法），
   而 corum 运行时是其超集。**别强耦合实现包**，用局部能力接口 + helper 收窄（C3b
   契约同思路）：
   ```ts
   interface SidebarModeCapableLayout { setSidebarMode(m: SidebarMode): void }
   const layout = ctx.layout as unknown as SidebarModeCapableLayout
   ```
   编译期有保障、零运行时改动、依赖不膨胀。
4. **组件订阅服务状态 → uSES 源 + InjectFace**：服务暴露
   `{ getSnapshot, subscribe }` 源，经 slots inject 面下发，组件侧以
   `useXxx(selector)` 选择器 Hook 消费（与 `useProjectOccupied` 同模式）。
   `getSnapshot` 返回引用在值不变时必须稳定。

---

## 3. 打包 / 模块表纪律（B1-pre 踩坑沉淀）

1. **别想当然给 `@corum/*` 做 external 化**：dsh 模块表只有 8 个硬编码 seed
   （react/cordis/store/ui-slots/ui-primitives 等），自定义共享模块走 `dsh.client`
   插件路径**实机白屏**（round 36 实证，回退即恢复）。共享需求优先用 §1 的 cordis
   服务绕开；external 化（B1-pre）仅在官方模块表机制明朗后重启。
2. **client bundle 进 boot 图必须有 apply**：纯库当共享模块也要补
   `export function apply(): void {}` + `export const inject: string[] = []`，否则
   cordis `create()` 抛 `invalid plugin`、整个 web boot 失败（loud）。
3. **实机回归必须在「可渲染基线」上做**：动 ui-base/壳核心（GridView/grid/slot）
   时，先确认壳处于能渲染的状态再 external/重构，否则无法把「我的改动」与「别人
   的半成品」在运行时隔离归因（round 36 教训）。
4. **新插件要让 desktop 能解析**：加进 `packages/desktop/package.json` deps +
   `pnpm install` 链接，否则 loader `Cannot find package`（本仓库 probe 插件踩过）。

---

## 4. fork 包纪律（会话域 6 个 fork）

1. **偏离官方要登记**：fork 包的实质修改写 `// fork（corum）：原因` 注释，并记入
   `docs/fork-delta.md` 台账——官方升级按 §5 runbook 执行，不靠考古。
2. **官方形状尽量保留**：能不动的就不动（如 inject 面、官方 ILayout 语义）；
   已知「官方不可行」的点（裸读 `__DSH_BOOT__`、禁用的 uiWorkspace）按既定降级，
   别重提审计已关闭的误判项（见 `NEXT-PHASE-DEFERRED.md` §4）。

---

## 5. 实机验证纪律（CDP）

1. **编译通过 ≠ 完成**：跨包状态/壳/调度类改动，必须 CDP 实机验证「UI 渲染 +
   行为 + 控制台零报错」三层（见 `corum-cdp-verify` skill）。
2. **真实点击用 MCP click/Input 域**：React controlled 组件别用 `el.value=` /
   裸 `dispatchEvent` 糊弄——MCP `click`/`fill` 或 CDP `Input.dispatchMouseEvent`
   才触发完整事件链。
3. **改 host 插件必重启应用**：renderer 改动 HMR 热更，host（corum-agent-dev 等）
   改动要 `./scripts/cdp.sh stop && start` 才生效。

---

## 附：本规范条目 ↔ 实证依据速查

| 条目 | 依据 |
|---|---|
| §1 禁 window 全局共享状态 | C3a 专项：`__corumSidebarMode` 按 bundle 拆分成死写、联动断裂 |
| §1 cordis 服务跨 bundle 单例 | `.dbg/cordis-singleton-probe.md`（实机 `===` PASS） |
| §1 例外（corumDesktop/__DSH_BOOT__） | C1 子项实证（`NEXT-PHASE-DEFERRED.md` §4） |
| §2.3 能力接口收窄 | C3b 契约 + C3a conversation `SidebarModeCapableLayout` |
| §2.2 禁裸取未装配服务 | conversation `ctx.remote` 坑（apply.ts 注释） |
| §3.1 external 化白屏 | B1-pre round 36（`.dbg/B1-boot-graph-findings.md`） |
| §3.2 纯库需 no-op apply | cordis `resolve()` 有效性检查 + 官方无纯 client 先例 |
