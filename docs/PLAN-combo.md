# Combo 设计规范（v2 · 启动器定位）

> **Combo = 一个基于 dsh 底座开发的独立 Agent 应用**（如 IDE、自媒体工作台、办公工作台）。
> 壳（Electron 第一进程）是一个桌面式启动器：展示所有已配置 combo，点击即进入对应应用。
> 每个 combo 启动时注入自己的环境变量 / 工作目录 / 覆盖规则，spawn 一个**独立**的 dsh host
> 进程——combo 之间进程级隔离，不共享会话 / 设置 / Agent / 插件。

---

## 1. 架构（2026-08-19 修正后）

```
cli.ts（净化环境：纯壳不携带 DSH_HOME 及 dsh 运行态环境）
  └─▶ Electron main（纯壳 = combo 管理页 corumapp://combo/index.html）
        │  · 读取所有 combo（内置 + 用户，~/.corum-shell/combos.json）
        │  · 点击 combo → 注入 env / cwd / 覆盖规则 → spawn 独立 host 子进程
        └─▶ host 子进程（boot.ts 按 combo 环境构建 composition）
              └─▶ 窗口切换到 corumapp://app/index.html?combo=<id>
```

**关键决策**：combo 不做「进程内动态插件切换」。官方多 client 机制是「多窗口监看同一
host」（同一业务场景），与「不同 combo 解决不同业务」冲突，因此**不共享 host，完全独立**。

## 2. Combo 数据模型（壳层）

实现：`packages/shell/src/electron/combos.ts`（数据落盘 `~/.corum-shell/combos.json`）。

```typescript
interface Combo {
  id: string            // 唯一 ID（slug）
  name: string          // 用户可见名
  description: string   // 一句话描述
  agentPreset: string   // 绑定的 agent preset（决定 Agent 团队 + MCP 工具集）
  plugins: string[]     // 需要加载的插件包名（以 CORUM_COMBO_PLUGINS 注入，boot 时定死）
  env: Record<string, string>   // 注入给 host 子进程的环境变量（如 CORUM_DESKTOP_MODE=ide）
  cwd: string           // 注入给 host 子进程的工作目录（空 = 继承壳）
  patches: string[]     // 额外覆盖规则（patch 文件绝对路径，boot 时作为最高层叠加）
  icon: ComboIcon       // lucide / emoji / image / text
  theme?: 'light' | 'dark' | null
  createdAt: number
  lastUsedAt: number
  builtin: boolean      // 内置不可删
}
```

启动注入的机制（boot.ts 消费）：

- `CORUM_DESKTOP_MODE`：`ide` 叠加 `cordis.ide.patch.yml`（IDE 壳）；缺省为 `minimal`（官方三栏）
- `CORUM_COMBO_PLUGINS`：逗号分隔插件包名 → 作为 insert 行加入 composition
- `CORUM_COMBO_PATCHES`：逗号分隔 patch 文件绝对路径 → 作为最高 patch 层叠加

## 3. 内置 Combo（当前 1 个）

| ID | 名称 | Agent | 插件序列（S0 测试占位） | 描述 |
|---|---|---|---|---|
| `coding` | 编码 | `standard` | ide-test-sidebar + ide-test-conversation | 全栈编码（IDE 模式） |

> 当前只保留 IDE（coding）一个内置 combo。combo 是独立 Agent 应用的启动入口，后续
> 新应用（自媒体/办公等）通过用户自定义 combo 或新增内置项扩展。`agentPreset` 仅记录
> 默认 Agent——combo 未来可能管理多个 Agent，该字段不限定数量，启动器页也不展示它。

## 4. 启动流程

```
用户点击 combo 卡片
  ├── 1. 壳按 combo 构造 env（净化后的壳环境 + combo.env + 插件集/覆盖规则注入）
  ├── 2. kill 旧 host（如有）→ spawn 新 host 子进程（注入 env + cwd）
  ├── 3. host bootDesktop() 按环境构建 composition（profile + 桌面 overlay + mode overlay + combo 规则）
  ├── 4. 协议集更新 graph → 窗口 loadURL corumapp://app/index.html?combo=<id>
  └── 5. 渲染端加载 dsh client（独立会话/设置/Agent）
```

快捷方式：`--combo=<id>` 跳过 combo 页直接进入指定 combo；`--smoke` 以无
combo 的 web profile 验证传输链路。默认（无参数）停在壳的 combo 启动器页。

## 5. 隔离边界

- **进程级隔离**：每个 combo 一个 host 子进程，composition / DSH_HOME / 插件集 / Agent 全独立
- **不共享**：会话、设置、工作区、Agent roster
- **官方多 client（多 tab）机制不使用**：每个 host 只服务自己的 client

## 6. 相关文件

- 壳层模型/持久化：`packages/shell/src/electron/combos.ts`
- combo 管理页：`packages/shell/src/electron/combo-page.ts`
- 启动编排：`packages/shell/src/electron/main.ts`（`launchCombo`/`spawnHost`）
- combo 覆盖规则：`packages/shell/src/host/boot.ts`（`resolveComboOverlays`）
- 环境净化：`packages/shell/src/electron/cli.ts`
- 工作台布局（combo 内）：`packages/plugins/ui/ide-shell/src/client/`（GridView，布局归 localStorage）
