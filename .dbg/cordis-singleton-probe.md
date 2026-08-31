# cordis 服务跨 bundle 单例性 —— 实机实证结论（PASS）

> 定位：本文档是 `docs/audit/NEXT-PHASE-DEFERRED.md` §5 第 1 条「优先验证 cordis
> 服务是否天然跨 bundle 单例」的实证记录。结论是 **C3a / C1 的前置墙已被推翻**——
> 不需要 ui-base external 化（B1-pre），cordis 服务即可作为跨 bundle 单例载体。

## 命题

C3a（sidebarMode 演进为 cordis 服务）与 C1（插件自声明槽）的共同前置：
**两个独立打包的 client bundle，经 cordis inject/get 消费同名服务时，是否拿到
同一个 JS 对象实例（`===` 成立）？**

交接文档的担忧：ui-base 未 external 化 → 各 bundle 各自内联 → 模块级单例互不通
（sidebar-mode.ts 每 bundle 一份）。若 cordis 服务也按 bundle 拆分，则服务化无用。

## 实证设计

三个消费点，覆盖两种「跨」维度（探针代码已移除，本记录留存结论）：

| 消费点 | 位置 | bundle | fiber | 验证维度 |
|---|---|---|---|---|
| `__probeProvided` | `corum-ide-probe-cordis` apply | 探针 bundle | root fiber | 提供方引用（基准） |
| `__probeInjected` | 同插件 `ctx.inject(['corumProbe'])` | 探针 bundle | 子 fiber | **跨 fiber** 单例 |
| `__probeCrossBundle` | `corum-ide-sidebar-ui` apply（`ctx.get('corumProbe', false)` 轮询） | **sidebar bundle** | 独立 fiber | **跨 bundle** 单例（核心） |

- 提供方实例：`{ marker: 'probe-<random>', providedAt }`，随机 marker 供肉眼核对身份。
- 判定：`window.__probeProvided === window.__probeCrossBundle`（跨 bundle）与
  `=== window.__probeInjected`（跨 fiber）。

## 实机结果（CDP，combo=coding，应用实跑）

```json
{
  "allPresent": true,
  "marker": "probe-4j5p69xh",
  "sameBundle_crossFiber": true,
  "crossBundle_singleton": true,
  "crossBundle_marker": "probe-4j5p69xh"
}
```

- **跨 bundle 单例：PASS** —— `corum-ide-probe-cordis`（提供方）与
  `corum-ide-sidebar-ui`（独立 bundle 消费方）拿到**同一 JS 实例**（marker 一致 +
  `===` 全等）。
- **跨 fiber 单例：PASS** —— 提供方 root fiber 与 `ctx.inject` 子 fiber 同一实例。
- 实机健康：`#root` 1 子节点、侧栏渲染、无白屏、无 `missed the module table`。

## 机制解释（为什么 cordis 服务天然单例，与 bundle 内联无关）

关键在**两套状态的分层**：

1. **bundle 模块实例**：每个 client bundle 是独立闭包，模块级 `let`/单例按 bundle
   各自一份——这是 ui-base sidebar-mode.ts 拆分的根因，**与 cordis 无关**。
2. **cordis 服务注册表**：在 window 唯一的 cordis 运行时（`Context.root.reflect.store`）
   内，**按服务名 keyed 全局一份**。`ctx.reflect.provide(name, value)` 把实例存进
   root store（`cordis/src/reflect.ts:277` `provide()` → `this.store[key] = impl`）；
   任何 bundle 的 fiber `ctx.name` / `ctx.get(name)` 都经同一个 root store 解析
   （`reflect.ts:136` Proxy get trap → `_getImpl` → `impl.value`）。

**结论**：服务实例的唯一性由 **cordis root context 的 store** 保证，不经过各 bundle
的模块实例。只要 bundle 共享同一个 cordis 运行时（desktop 壳只有一个），服务就天然
跨 bundle 单例。isolate 仅在同名服务需多份时才用（`ctx.isolate(name, label)`），
corum 组合未用 isolate（全仓 grep 0 命中）。

## 对暂缓项的解锁

- **C3a（sidebarMode 服务化）**：✅ 可直接做，**无需 B1-pre**。把 sidebarMode 做成
  ide-shell 的 cordis 服务（`ctx.layout` 同族，`ctx.reflect.provide`），conversation
  经 inject 消费、SidebarSkeleton 经 inject 订阅。window 全局 `__corumSidebarMode`
  与 ui-base `sidebar-mode.ts` 可删。**附加发现**：`__corumSidebarMode` 当前已无活跃
  读端（空态收敛 commit `fb2003e9` 删掉唯一读者），只剩 2 个死写端（SidebarSkeleton
  广播 + conversation apply 4 处）——侧栏 tab 联动功能实际已退化，服务化可一并恢复。
- **C1（插件自声明槽）**：✅ 前置打通。`slotRegistry` 可按 C3a 同思路改为 cordis
  服务（而非依赖 ui-base external 化），插件在自己 apply 里 `registerSlot` 自声明，
  壳经 cordis 服务读到跨 bundle 一致的注册表。

## 复现方式（探针已移除）

探针插件 `packages/plugins/ui/corum-ide-probe-cordis`（零 UI，provide + 双消费点）
与 sidebar-ui 的临时消费段已按「验证后即移除」清理。如需复现：重建该探针包 +
patch 挂 `ide-probe-cordis` + sidebar-ui 加 `ctx.get('corumProbe', false)` 轮询段，
CDP 跑 `.dbg/tmp/corum-probe-crossbundle.js` 比对三方 `===`。
