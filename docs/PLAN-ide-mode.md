# PLAN：双模式外壳（极简 / IDE）

> 状态：方案定稿（待评审）。本文在 `PLAN-ide-shell.md`（分层）+ `doc/UXDesign/*`（设计稿）+ `interaction-design.md`（交互规格）之上，回答一个此前未定的事项：
> **不推翻现有 UI，而是保留「极简模式」为默认，新增「IDE 模式」采用矩道 Corum Harness 液态玻璃设计。**
> 配套阅读：`HANDOFF.md`（现状）、`PLAN-code-editor.md`（Monaco）、`doc/UXDesign/HANDOFF-design.md`（设计读取指引）。

---

## 1. 目标

| 模式 | 定义 | 组成 |
|---|---|---|
| **极简模式（默认）** | 现状不变：官方三列聊天壳（`ui-layout` 三栏 + 官方主题） | 现有 `web` 组合，零改动 |
| **IDE 模式（新增）** | 六区 IDE 壳 + 液态玻璃主题 + 常驻 Monaco 编辑器 + 会话行菜单 | 新增 IDE 组合覆盖层 |

一句话：**模式是「组合层」的一个维度，不是第二套 profile、也不是第二套内核。** 铁律不变：不改 `/Users/kukucai/dsh`，不碰 `dsh-client-runtime`，slot 接管不 monkey-patch。

---

## 2. 核心决策

1. **模式 = 组合覆盖层，不是第二个 profile。** 复用现有单一 `web` profile 与整套 boot/heal 链路，在 `bootDesktop()` 里按模式条件性地多叠一层 patch（IDE overlay）。
2. **模式持久化 + 启动标志 + 运行时切换，三者一套机制。** 优先级：`CORUM_DESKTOP_MODE` 环境变量（`--ide` 启动标志用）> `$CORUM_HOME/mode.json`（持久化）> `minimal`。运行时切换 = 写 mode 文件 → `restartHost()` 重组 + 页面 reload 重跑客户端图；会话历史落盘在 `$CORUM_HOME/sessions/`，切换不丢上下文。
3. **IDE 外壳 = fork `ui-layout`，重新声明同名 child slot。** IDE overlay 禁用官方 `ui-layout`/`ui-workspace` 行，插入 `@corum/corum-layout`，它进 `root` 槽并**重新声明同名** `sidebar`/`conversation`/`details`/`shell.overlay`——官方 `ui-sidebar`、`ui-conversation`、`ui-workspace`（fork 版）一行不改，零改动挂载。
4. **液态玻璃主题 = `@corum/corum-theme`，只挂 IDE 模式。** 两条腿：(a) `ctx.theme.overrideTokens('corum-glass', {...})` 把设计语义 token 映射进官方 `--dsw-alias-*`（深/浅双值），让所有官方组件自动换肤；(b) 注入样式表定义 `--glass-*`/`--brand-*`/`--glow-*` 变量 + `.glass-card` + 环境光斑背景 + 字体。模式（minimal/IDE）与主题（light/dark/system）正交：IDE 内再叠官方三态主题。
5. **编辑器 = Monaco 常驻右侧 `corum.editor` 槽。** 从 `conversation.view` 临时 tab 迁出（它本就是 Phase 1 验证位）。shell client 用 `ctx.slots.inject('corum.editor', …)` 注册——该槽只被 `corum-layout`（IDE）声明，故极简模式自然无编辑器入口、无跨包 value import、无模式服务依赖。
6. **会话管理动词收进列表行菜单（IDE 模式）。** fork `ui-workspace` → `@corum/corum-workspace`，在 `Rows.tsx` 的 `sessionMenuItems` 追加「保存日志 / 删除」。保存/删除/导入的宿主能力（`CorumSessionArchive` + 原生桥）已现成，直接复用。

---

## 3. 模式机制（关键新基建）

### 3.1 模式来源

```
resolveDesktopMode(): 'minimal' | 'ide'
  = CORUM_DESKTOP_MODE（环境，--ide 标志）  ??  $CORUM_HOME/mode.json（持久化）  ??  'minimal'
```

- 位置：`packages/shell/src/host/boot.ts`（宿主组合时读）+ `packages/shell/src/electron/*`（主进程读/写同一文件）。
- 模式文件：`$CORUM_HOME/mode.json`，内容 `{"mode":"ide"}`，原子写（复用 `atomic-write` 或 `writeFileSync` + rename）。

### 3.2 组合分叉（`bootDesktop()`）

在 `composeEntries` 之前、telemetry 之后，按模式追加 patch 层：

```ts
if (resolveDesktopMode() === 'ide') {
  composedOverlays.push(...loadOverlayPatches(NAME, IDE_PATCH)) // cordis.ide.patch.yml
}
```

`packages/shell/cordis.ide.patch.yml`（新增，随 shell 打包）内容：

```yaml
- id: ui-layout
  disabled: true
- id: ui-workspace
  disabled: true
# session-archive 的 header 保存/删除两键在 IDE 下移入行菜单（见 §3.4 拆分）
- id: session-archive-minimal
  disabled: true

- insert:
    - id: corum-layout
      name: '@corum/corum-layout'
    - id: corum-theme
      name: '@corum/corum-theme'
    - id: corum-workspace
      name: '@corum/corum-workspace'
    - id: corum-panels
      name: '@corum/corum-panels'
```

> 依赖闭环：4 个 `@corum/*` client 包作为 shell 的 `workspace:*` dependencies（同现有 3 个 fork），经 `healProfilesModuleFallbackRegistry` realpath heal 进 profile；打包态进 `desktop-host` 的 `workspace:*` 闭包（`pack-macos.mjs` 已按此模式跑通）。

### 3.3 运行时切换

- **IPC 增两路**：`corum:get-mode`（`sendSync`，preload 顶层读一次并 `exposeInMainWorld` 为同步值 `window.corumDesktop.getMode()`）/ `corum:set-mode`（写 mode 文件）。
- **切换动作**（一处「界面模式：极简 / IDE」入口，放设置或侧栏 footer）：`setMode(next)` → `restartHost()`（宿主按新模式重组）→ `location.reload()`（渲染端重跑 `__DSH_BOOT__` 客户端图，preload 重跑拿新 mode）。
- **启动标志**：`node lib/cli.js --ide` → 设 `CORUM_DESKTOP_MODE=ide`（该次启动覆盖持久化值，并写回为持久化选择）。

### 3.4 会话存档的 mode 作用域（拆分，消除「入口唯一性」冲突）

现状 `@corum/session-archive` 同时注册：header「保存」、header「删除」、设置「导入」。设计（`interaction-design.md` §5）要求 IDE 下保存/删除只在行菜单。

- **拆**：header 两键抽到兄弟包 `@corum/session-archive-minimal`（只挂极简模式），`session-archive` 保留「原生桥 + controller + 设置导入行」（双模式共享）。
- 结果：极简 = header 按钮 + 设置导入；IDE = 行菜单（`corum-workspace`）+ 设置导入。
- 降级方案（v1 可接受，记入技术债）：不拆，IDE 下 header 与行菜单并存，后续 polish。

---

## 4. 包清单

| 包 | 类型 | 作用域 | 说明 |
|---|---|---|---|
| `@corum/corum-layout` | fork `ui-layout` | IDE | `CorumAppFrame` 六区外壳进 `root`；重声明 4 个同名 slot + 新增 `corum.activity`/`corum.tabStrip`/`corum.editor`/`corum.panel`/`corum.statusBar`；同形扩展 `ctx.layout`；渲染 ambient 光斑层 |
| `@corum/corum-theme` | 新增（替代 `corum-ui-theme` 空壳） | IDE | 液态玻璃 token：`overrideTokens` 映射 `--dsw-alias-*` + 注入 `--glass-*`/`--brand-*`/`--glow-*` CSS + 字体/圆角/`.glass-card` |
| `@corum/corum-workspace` | fork `ui-workspace` | IDE | `Rows.tsx` 行菜单追加保存/删除；`delete` 后 `sessions.refresh()`+`workspaces.refresh()`；删当前会话 `sessions.clear()` |
| `@corum/corum-panels` | 新增 | IDE | 活动栏 5 项 + 底部面板（终端/待办/队列）+ 状态栏（连接/项目/模型/运行态），注册进 `corum.*` 槽 |
| `@corum/session-archive-minimal` | 拆自 session-archive | 极简 | header 保存/删除两键 |
| `@corum/session-archive` | 现有（减员） | 双模式 | 原生桥 + controller + 设置导入行（不变） |
| `corum-shell` | 现有（改 editor 注册位） | 双模式 | Monaco 组件留在 shell；client 注册点从 `conversation.view` 改为 `corum.editor`（slot 门控，无模式服务） |
| `corum-ui-theme`（占位） | 清理 | — | 删除或留空；其职责由 `corum-theme` 承担 |

> fork 纪律沿用 `HANDOFF.md` §fork 要点：最小必要改动 + `// CORUM-PATCH:` 围块 + `diff -ru` 同步官方升级。`ui-conversation` 不 fork。

---

## 5. 分层实施（自下而上，每层独立可交付、可回滚）

### P0 · 模式基建（先于一切 UI）
- `boot.ts` 增 `resolveDesktopMode()` + `cordis.ide.patch.yml` + IDE overlay 分叉。
- Electron main/preload/ipc 增 `corum:get-mode`/`corum:set-mode` + mode 文件读写 + `--ide` 标志。
- 会话存档拆出 `session-archive-minimal`。
- **验收**：`--ide` 启动后 `graph.entries` 含 IDE overlay 的 disable/insert 行；不传标志时 graph 与现状逐行一致；`setMode`+`restartHost`+reload 后模式翻转、会话历史保留。

### P1 · 外壳 fork（`@corum/corum-layout`）
- fork `ui-layout` → `CorumAppFrame`：活动栏(56px) + 主侧栏 + 编辑器区(flex) + 次侧栏 + 底部面板 + 状态栏(28px)。
- 几何让位沿官方 `columns.ts` 思路扩展（活动栏固定、主侧栏不让位、先缩次侧栏再缩编辑器、底部/状态栏固定高）。
- 重声明 4 个同名 slot + 新增 5 个 `corum.*` 槽；提供同形 `ctx.layout`（`toggleSidebar/openDetails/closeDetails` 保留 + `togglePanel/toggleActivity` 等新增）。
- **验收**：IDE 六区渲染；官方会话/项目/详情在对应区正常；`toggleSidebar/openDetails` 不报错；拖拽让位正常。

### P2 · 主题兑现（`@corum/corum-theme`）
- `overrideTokens` 映射（见 §6）+ 注入玻璃 CSS 变量/字体/圆角/`.glass-card` + ambient 光斑背景（深/浅两套）。
- Monaco 主题联动（深 `vs-dark` 蒸汽波、浅 `vs`）。
- 资产接线：品牌横幅 / hero / logo / 背景图（见 §7）。
- **验收**：IDE 下深浅两主题切换只换 token；玻璃卡片透光；`prefers-reduced-motion` 降级；极简模式观感零变化。

### P3 · 编辑器常驻 + 会话行菜单
- `@corum/corum-workspace`：行菜单追加保存/删除（复用原生桥），删除后列表实时刷新。
- shell client：编辑器注册点迁到 `corum.editor`（多文件 tab + dirty 态，Monaco 组件已具备单文件，扩展即可）。
- **验收**：IDE 下无 `conversation.view` 编辑器 tab；右侧编辑器列常驻；行菜单 5 动词齐全；删除当前会话不留僵尸选中；极简模式 header 按钮仍存。

### P4 · 活动栏 / 底部面板 / 状态栏（`@corum/corum-panels`）
- 活动栏：Explorer / 编辑器 / 终端 / 待办 / 队列 / 设置，激活态指示条动效。
- 底部面板：终端（复用 `dsh-terminal`）；待办/队列 v1 放占位（官方内容为 session 级 dock，全局上提需后续专项，诚实标注）。
- 状态栏：连接态（`connection-controller` 已有）+ 当前模型 + 当前项目 + 会话运行态（会话级统计仍在对话区状态条，不进状态栏）。
- **验收**：六区各自可用；活动栏切换显隐正常；连接状态点三态正确。

### P5 · 动效 + 打磨
- 按 `motion-spec.md` 落地：基础缓动 `cubic-bezier(0.22,1,0.36,1)`、弹窗 spring(1,300,26)、列表交错 30ms、流式光标 530ms、工具点 pulse、`prefers-reduced-motion` 全量降级。
- 会话 tab 栏（打开过的会话集合 UI 态 + localStorage 持久化）若 P3 未含，归此。
- **验收**：关键动效逐项核对 `motion-spec.md`；无障碍降级生效。

---

## 6. 主题 token 映射（浅 / 深）

> 完整表见 `corum-harness-design-style.md`；实现以 token 为单一事实源，禁止写死 hex。`--dsw-alias-*` 经 `ctx.theme.overrideTokens` 覆盖；`--glass-*` 等为新 CSS 变量注入样式表。

| 设计 token | 目标变量 | 浅色 | 深色 |
|---|---|---|---|
| `bg-base` | `--dsw-alias-bg-base` | `#E9E9F2` | `#0D0817` |
| `bg-deep` | 新 `--bg-deep` | `#DDDCE8` | `#0A0612` |
| `glass-1` | `--dsw-alias-bg-layer-1` | `#FFFFFFE6` | `#1D112BD9` |
| `glass-2` | `--dsw-alias-bg-layer-2` | `#FFFFFFCC` | `#2A1840D9` |
| `glass-3` | `--dsw-alias-bg-layer-3` / `bg-overlay` | `#FFFFFFB3` | `#372050CC` |
| `glass-border` | `--dsw-alias-border-l1` | `#FFFFFF` | `#B98CFF2E` |
| `glass-border-active` | 新 `--glass-border-active` | `#5B21F5` | `#01CDFE` |
| `label-primary` | `--dsw-alias-label-primary` | `#0E0E1C` | `#F3ECFF` |
| `label-secondary` | `--dsw-alias-label-secondary` | `#5C5C77` | `#B3A6D9` |
| `label-tertiary` | `--dsw-alias-label-tertiary` | `#8B8BA3` | `#7E719E` |
| `label-dimmed` | `--dsw-alias-label-dimmed` | `#B9B9C9` | `#55486F` |
| `brand-primary` | `--dsw-alias-brand-primary` | `#5B21F5` | `#01CDFE` |
| `brand-accent` | 新 `--brand-accent` | `#F5276C` | `#FF71CE` |
| `brand-text` | `--dsw-alias-brand-text` | `#5B21F5` | `#4DE3FF` |
| `label-on-brand` | 新 `--label-on-brand` | `#FFFFFF` | `#0A0612` |
| `state-error` | `--dsw-alias-state-error-primary` | `#E0245E` | `#FF5C8A` |
| `state-success` | `--dsw-alias-state-success-primary` | `#0BA57C` | `#3EE6B0` |
| `state-warn` | `--dsw-alias-state-warn-primary` | `#E07A00` | `#FFB45C` |
| `state-idle` | 新 `--state-idle` | `#9AA0B5` | `#6E6392` |
| `state-running` | 新 `--state-running` | `#5B21F5` | `#01CDFE` |
| `glow-1/2/3` | 新 `--glow-1/2/3` | 见 style §背景层 | 见 style §背景层 |
| hover/active | `--dsw-alias-interactive-bg-hover` / `-active` | glass 半透明 | glass 半透明 |
| 侧栏填充 | `--dsw-specific-sidebar-fill` | `glass-1` | `glass-1` |
| 主按钮 | `--dsw-alias-button-primary-fill` | `brand-primary` | `brand-primary` |

CSS 变量切换机制：沿官方 `body[data-ds-dark-theme]`（`ui-layout` ThemePresenter 已切换），不另立 `data-theme`，避免双属性漂移。

---

## 7. 资产与打包

| 资产 | 用途 | 落点 |
|---|---|---|
| `brand_logo_{dark,light}_crop.png` | 侧栏品牌横幅 | dist staging `build/dist/assets/corum/`，`corumapp://app/assets/corum/...` |
| `big_brand_{dark,light}_crop.png` | 空态 hero | 同上 |
| 蒸汽波鲸鱼背景图（从 `generated-*.png` 选定深/浅各 1） | ambient 背景 | 同上，`object-fit:cover` + 60% `bg-base` 蒙版 |
| `logo.png` | 应用图标（可选） | electron-builder `mac.icon` |

- 打包：`pack-macos.mjs` 复制资产到 `build/dist/assets/corum/`；dev 态锚定 shell 自身 staging（同 Monaco worker 模式）。
- CG 视频背景（`vaporwave-{dark,light}.webm`）设计方后续提供，留 `ambient` 挂载层 + 交叉淡入淡出 600ms 接口。

---

## 8. 风险与回滚

1. **最大风险是 P1 外壳重写**（全局观感 + 几何让位 + 子 slot 契约）。缓解：fork 只做几何，`sidebar/conversation/details/shell.overlay` 同名重声明，官方下游零改动；先 P0 验证 fork+overlay 链路，再动 P1。
2. **模式切换丢态**。缓解：会话历史已落盘；切换只 `restartHost`+reload，不碰 `$CORUM_HOME/sessions/`；`before-quit` flush 已有。
3. **IDE 包进入 profile 闭包**。缓解：4 个 client 包走 `workspace:*` + realpath heal；打包态进 `desktop-host`；改完 name/目录立即 `CI=true pnpm install --no-frozen-lockfile` 并查旧 scope symlink（HANDOFF §教训 6）。
4. **每层可回滚**：P0 是唯一改到共享 boot 链路的层，用 `CORUM_DESKTOP_MODE`/mode 文件即时切回 `minimal`；其余层是纯新增包，disable 对应 insert 行即回退。
5. **`ui-conversation` 不 fork**，会话 body 全复用；待办/队列上提为 P4 已知缺口，不阻塞主路径。

---

## 9. 建议第一步

**先做 P0（模式基建）**：它是独立、低风险、且立刻验证「模式分叉 + IDE overlay + fork 接线」整条链路的一块，与 `PLAN-ide-shell.md` §9 的结论一致。P0 通过后，P1 外壳重写单独开一轮详细设计（几何求解、活动栏、子 slot 契约）再动工。

## 10. 与既有文档的关系

- `PLAN-ide-shell.md` 的 P0–P4 映射到本文 P1–P5；本文新增 P0（模式基建）并把「整体替换」改为「双模式共存」。
- `PLAN-code-editor.md` 的「编辑器迁到常驻右侧」在本文 P3 落地，且不再需要「是否拆独立插件」的悬而未决：Monaco 留 shell，注册点走 `corum.editor` slot 门控。
- `interaction-design.md` 是 IDE 模式的交互事实源；`HANDOFF-design.md` + `design-style.md` + `motion-spec.md` 是视觉/动效事实源。
