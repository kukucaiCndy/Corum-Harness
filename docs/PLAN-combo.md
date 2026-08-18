# Combo 设计规范

> corum Agent OS 的核心设计单元：**Combo = 工作流 = Agent 团队**。
> 用户双击 Combo 图标 → 加载完整工作上下文：插件序列 + 界面布局 + Agent 团队 + MCP 工具集 + 独立会话。

---

## 0. 事实背景：dsh 底座支持运行时动态插件加载/卸载

**已核实**（2026-08-18，dsh `0.1.0-rc.7` checkout `/Users/kukucai/dsh`）：dsh 基于 vendored 的 cordis 框架（`@cordisjs/plugin-loader`），从底层完整支持运行时动态插件增删，无需重启宿主。

### 核心 API

| API | 用途 | 证据文件 |
|---|---|---|
| `ctx.loader.create({ name })` | 运行时添加插件 | `vendor/loader/src/config/tree.ts` `EntryTree.create()` |
| `ctx.loader.remove(id)` | 运行时移除插件 | `vendor/loader/src/config/tree.ts` `EntryTree.remove()` |
| `ctx.loader.update(id, { disabled })` | 禁用/启用插件（事务性） | `vendor/loader/src/config/entry.ts` `Entry.update()` |
| `entry.update(id, { config })` | 改插件配置（热重载） | HMR `watchUserPatches` → `entry.update()` |
| `DynamicCordisPackageRunner.load()` | 浏览器侧动态加载 | `packages/extensions/cordis-client-runner/src/client/runtime.ts` |
| `DynamicCordisPackageRunner.retract()` | 浏览器侧动态卸载 | 同上 |

### 已有先例

`directory-picker-auto` 插件在运行时动态创建和移除 loader 条目：

```typescript
// /Users/kukucai/dsh/packages/host/directory-picker-auto/src/index.ts
ids.push(await ctx.loader.create({ name: BACKEND_PACKAGES[backend] }))
// ...卸载时：
await ctx.loader.remove(id)
```

### 事件驱动

`ClientModuleRegistry` 监听 `internal/plugin` 事件做增量扫描——fiber 创建/dispose 时标记 dirty，微任务 flush 调和。**插件增删后客户端 boot 图自动更新，无需重启**。

### 对 Combo 架构的意义

Combo 可以做到**真正的动态插件序列**：每个 Combo 声明自己需要的插件列表，切换 Combo 时通过 `loader.create`/`loader.remove` 动态加载/卸载。不同 Combo 有不同的插件集、Agent 配置、MCP 工具集和独立会话。

---

## 1. 概念

```
Shell（启动器插件）
  ├── Combo 列表（图标网格）
  │   ├── 编码 Combo → 双击 → 卸载启动器 + 加载编码插件序列 + standard Agent + 新会话
  │   ├── 设计 Combo → 双击 → 卸载启动器 + 加载设计插件序列 + designer Agent + 新会话
  │   ├── 调试 Combo → 双击 → 卸载启动器 + 加载调试插件序列 + standard Agent + 新会话
  │   ├── 极简 Combo → 双击 → 卸载启动器 + 加载极简插件序列 + minimal Agent + 新会话
  │   └── 自定义 Combo → 用户自己保存的
  │
  └── Combo 内部 = 工作台（GridView 自由网格 + 已加载的插件区域）
```

**Shell 是一个插件（启动器）**。进入 Combo 时启动器插件卸载，Combo 专属插件加载；退出 Combo 时反向操作。

---

## 2. Combo 数据模型

```typescript
interface Combo {
  /** 唯一 ID（slug）。 */
  id: string

  /** 用户可见名（如「编码」「设计」「调试」）。 */
  name: string

  /** 简短描述（一句话说明此 Combo 做什么）。 */
  description: string

  // ── 核心四要素 ──

  /** 1. Agent 团队：绑定的 agent preset 名称。
   *  决定 Agent 的 tools/skills/MCP 工具集。每个 Combo 创建独立 session。 */
  agentPreset: string               // 'standard' | 'designer' | 'minimal' | 'cordis' | 'frontend' | ...

  /** 2. Plugin 序列：此 Combo 需要加载的插件包名列表。
   *  切换 Combo 时，不在两个 Combo 交集里的插件会被 loader.remove 卸载，
   *  新增的插件会被 loader.create 加载。 */
  plugins: string[]                 // ['@corum/ide-sidebar', '@corum/ide-editor', ...]

  /** 3. 布局：工作台布局（GridView 分割树）。 */
  grid: GridNode                     // 完整布局树（grid.ts 的序列化格式）

  /** 4. ICON 图标：Combo 在启动器里的图标。 */
  icon: ComboIcon

  // ── 可选扩展 ──

  /** 主题覆盖（可选，null = 跟随全局主题）。 */
  theme?: 'light' | 'dark' | null

  /** 底部面板默认高度（0 = 收起）。 */
  bottomPanelHeight?: number

  /** 详情抽屉默认宽度（0 = 关闭）。 */
  detailsWidth?: number

  /** 创建时间 + 最后使用时间（排序用）。 */
  createdAt: number
  lastUsedAt: number

  /** 是否内置（true = 不可删除，只能修改布局）。 */
  builtin: boolean
}

interface ComboIcon {
  type: 'lucide' | 'emoji' | 'image' | 'text'
  value: string
  background?: string | null
}
```

---

## 3. 内置 Combo（首发 5 个）

| ID | 名称 | Agent | 插件序列 | 布局 | 图标 | 描述 |
|---|---|---|---|---|---|---|
| `coding` | 编码 | `standard` | sidebar + conversation + editor + explorer | 四列 280/800/430/210 | lucide `code-2` | 全栈编码 |
| `design` | 设计 | `designer` | sidebar + conversation + explorer | 三列 280/800/210 | lucide `palette` | UI/UX 设计（Pencil MCP） |
| `debug` | 调试 | `standard` | sidebar + conversation + editor + panel | 三列+底部 280/600/430 | lucide `bug` | 调试排障 |
| `minimal` | 极简 | `minimal` | conversation | 单列全宽 | lucide `message-circle` | 纯对话 |
| `frontend` | 前端 | `frontend` | sidebar + conversation + editor + explorer | 四列 280/800/430/210 | lucide `monitor-smartphone` | 前端开发（DevTools + Pencil） |

---

## 4. Combo 切换流程（动态加载/卸载）

```
用户从 Combo A 切换到 Combo B
  │
  ├── 1. 计算插件差异
  │     current = A.plugins
  │     target = B.plugins
  │     toRemove = current - target  // 需卸载
  │     toAdd = target - current    // 需加载
  │     keep = current ∩ target     // 保留
  │
  ├── 2. 卸载差异插件
  │     for plugin in toRemove:
  │       await ctx.loader.remove(plugin)
  │     → fiber dispose → ClientModuleRegistry 增量扫描 → boot 图更新
  │
  ├── 3. 加载差异插件
  │     for plugin in toAdd:
  │       await ctx.loader.create({ name: plugin })
  │     → fiber 创建 → ClientModuleRegistry 增量扫描 → boot 图更新
  │
  ├── 4. 创建新会话（如果 agentPreset 不同）
  │     if B.agentPreset !== A.agentPreset:
  │       session.create(agentPreset: B.agentPreset)
  │     → 新 Agent + 新 MCP 工具集 + 新对话历史
  │
  └── 5. 切换布局
        setGrid(B.grid)
        → GridView 重新渲染，新插件 UI 出现在网格中
```

**启动器 → Combo 的特殊情况**：
- 启动器自身是一个插件（`@corum/ide-shell` 的启动器模式）
- 进入 Combo 时：卸载启动器模式 → 加载 Combo 插件序列 → 创建会话 → 切换布局
- 退出 Combo 时：卸载 Combo 专属插件 → 加载启动器模式

---

## 5. Combo 持久化

### 存储

- **内置 Combo**：代码定义（`packages/plugins/ui/ide-shell/src/client/combos.ts`），不可删除
- **用户 Combo**：localStorage `corum.ide.combos.v1`（用户保存的布局预设）
- **当前 Combo**：localStorage `corum.ide.current-combo`（记住上次用哪个 Combo）

### 序列化

```typescript
// 内置 Combo（代码定义，不含运行时 id/时间戳）
interface ComboDefinition {
  id: string
  name: string
  description: string
  agentPreset: string
  plugins: string[]
  grid: SerializedGridNode
  icon: ComboIcon
  builtin: true
}

// 用户 Combo（localStorage，含运行时元数据）
interface UserCombo extends ComboDefinition {
  builtin: false
  createdAt: number
  lastUsedAt: number
}
```

### 导入/导出

- 导出：Combo → `.combo.json`（原生对话框 `showSaveDialog`）
- 导入：`.combo.json` → localStorage（原生对话框 `showOpenDialog`）

---

## 6. Combo 与插件/Agent/会话的关系

```
Combo（工作流）
  │
  ├── agentPreset → 决定 Agent 团队 + MCP 工具集
  │     └── session.create(agentPreset) → 独立 sessionId → 独立对话历史
  │
  ├── plugins → 决定加载哪些插件
  │     └── loader.create/remove → 动态加载/卸载
  │           └── 每个插件通过 dsh.client 声明有 UI
  │                 └── 插件通过 registerSlot() 注册到槽位注册表
  │
  └── grid → 决定界面布局
        └── leaf.slot → 指向哪个槽位的 UI
```

**Combo 直接管理插件列表**：Combo 的 `plugins` 字段是包名列表（如 `@corum/ide-sidebar`），切换 Combo 时通过 `loader.create`/`remove` 动态加载/卸载。这不同于"所有插件全量加载，只控制可见性"的方案——**插件真正加载/卸载，不是隐藏**。

---

## 7. 实现路径

| 步骤 | 内容 | 依赖 |
|---|---|---|
| **1. Combo 数据模型** ✅ | `combos.ts`：Combo 接口 + 内置 5 个 Combo + 持久化 | grid.ts（已完成） |
| **2. Shell 启动器** ✅ | ComboLauncher 组件（图标网格）+ `?combo=` 路由 | Combo 数据模型 |
| **3. Combo 加载（动态插件）** | 读 combo → loader.create/remove 差异插件 + session.create + setGrid | Combo 数据模型 + bridge |
| **4. Combo 切换器** | 状态栏下拉 + 切换确认 + 插件差异计算 | Combo 加载 |
| **5. Combo 编辑器** | 「保存当前布局为 Combo」+ 编辑名称/图标/agentPreset/plugins | 切换器 |
| **6. 导入/导出** | 原生对话框 → JSON | Combo 编辑器 |
