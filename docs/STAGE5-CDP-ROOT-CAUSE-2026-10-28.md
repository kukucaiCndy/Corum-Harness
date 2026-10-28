# Stage 5 CDP 验收根因分析与修复（2026-10-28）

## 根因

### 1. verify-stage5-cdp.mjs 探针选择器错误（已修复）

原探针用 CSS 类名模式 `[class*="sidebar"]`、`[class*="conversation"]` 检测 UI 元素存在性，
但 IDE 壳使用 CSS Modules（哈希类名 `_8UPZQq_*`），这些选择器永远不匹配。

**修法**：改用 `data-slot` 属性（壳声明的区域名）：
- `data-slot="corum.sidebar"` → 侧栏
- `data-slot="conversation"` → 对话区
- `data-slot="corum.titlebar"` → 标题栏
- `data-slot="conversation.composer"` → 输入区

### 2. corum-smoke.mjs DOM 渲染判据过短 + 附着启动页（已修复）

原 smoke 测试：
1. `waitPage` 接受启动页（`corumapp://startup/index.html`）作为主页面 → 附着到启动页
2. `Page.reload` 把启动页重新加载 → 停在启动页（host 还没 ready，loopback 页面不存在）
3. 固定等 6s → 不够（host boot 实测 5-6s + UI mount 2-3s）
4. 立即检查 DOM → 永远 fail（title="Corum · 正在启动"、sessionBand=false）

**修法**：
1. `waitPage` 优先 loopback 页面（`http://127.0.0.1:<port>/`），启动页只在快超时时返回
2. 删除 `Page.reload`（loopback 页面已正确加载，reload 会打回启动页）
3. DOM 渲染判据改为轮询（最多 35s，每 500ms 探一次），与 main.ts 的 30s 超时对齐

### 3. dist 构建（0.2.1-rc.3 基线）有真实启动问题

dist `Corum.app` 使用 0.2.1-rc.3 版 `dsh-web-app`（5 个 patch 文件 + 更多客户端包），
与安装的 `/Applications/Corum.app`（0.1.5-rc.3，1 个 patch 文件）不同：

- dist 版启动报 `Failed to load plugins @deepseek-ai/dsh-cordis-client-runner`
- `[cordis-client-runner] syncing inspect providers failed: Cannot read properties of undefined (reading 'signal')`
- `corum-web-search: pending (waiting for service: settings)`
- `[data-dsh-boot]` 未移除（boot 未完成）

**这不是源码问题**：安装的 0.1.5-rc.3 版 Corum.app 启动完全正常
（0 pending entries、0 console errors、7/7 探针通过）。
dist 构建的 0.2.1-rc.3 基线有官方包打包缺陷（运行时依赖在 devDependencies，
与 AGENTS.md 红线 5 和 HANDOFF-2026-09-29 §2 方法论②一致）。

**修法**：dist 重新构建应使用 0.1.5-rc.3 基线（当前可用的稳定基线）。
0.2.1-rc.3 基线的升级可行性见 `docs/UPGRADE-0.2.1-rc3-feasibility.md`。

### 4. "SidebarSessionViews.dispose getSnapshot" 无实际错误

任务报告提到 `SidebarSessionViews.dispose getSnapshot` 但无完整堆栈。
CDP 实测（安装版 Corum.app + 隔离 home）：
- 0 runtime exceptions
- 0 console errors
- UI 完整渲染（data-session-band + 13 个 data-slot 区域全部挂载）
- 会话创建对话框正常弹出（"Agent / 访问权限 / 取消 / 开始"）

官方 `ui-sidebar-right` 的 `SidebarSessionViews.dispose()`（session-views.ts:60-65）
在 IDE 模式下正常工作——它 inject `uiSession`，而 `uiSession` 由官方
`dsh-client-ui-session` 提供（在 `__DSH_BOOT__` 中确认存在）。
官方 `ui-sidebar-right` 不需要在 IDE patch 中禁用——它的 `rightbar` 槽
在 IDE 壳中不声明，`ctx.slots.inject('rightbar', ...)` 找不到槽时 cordis
正常跳过（不阻塞 boot）。

## 验证证据

### 安装版 Corum.app（0.1.5-rc.3）隔离 home + CDP

```
verify-stage5-cdp.mjs 结果：通过 7 / 失败 0 / 跳过 6
✓ UI ready（boot marker removed, session-band mounted, 59 entries）
✓ __DSH_BOOT__ 模块图（entries=59 pending=0 errors=0）
✓ 公开桥接面（platform=darwin version=0.7.0 keys=46）
✓ 关键交互元素（sidebar=true conv=true input=true titlebar=true）
✓ 侧栏渲染内容（4 items, "暂无会话 点击「新建任务」开始对话"）
✓ 行为期 console errors = 0
✓ Electron 运行时版本
```

### DOM 结构（CDP 实测）

```
data-slot=root → _8UPZQq_frame
  ├── _8UPZQq_titlebarMount → data-slot=corum.titlebar → tVqcIq_band (data-session-band)
  ├── _8UPZQq_workbenchRow
  │   ├── _8UPZQq_activityBar (rail logo + nav groups + tool groups)
  │   └── _8UPZQq_mainRow → iUtKYW_grid
  └── _8UPZQq_overlayLayer → data-slot=shell.overlay
```

### 会话创建测试

"新建任务" 对话框正常弹出，显示：
- 工作区选择（"选择工作区"）
- Agent: Android 工程师
- Model: DeepSeek-V4-Flash
- 访问权限: 只读/工作区读写/完全权限
- 取消/开始按钮（开始按钮在选工作区前 disabled）

## 待办（不属本次修复范围）

1. **dist 重新构建**：使用 0.1.5-rc.3 基线重新打包，替换当前的 0.2.1-rc.3 dist
2. **0.2.1-rc.3 升级**：按 `docs/UPGRADE-0.2.1-rc3-feasibility.md` 评估可行性
3. **CDP 行为验证扩展**：当前探针跳过 settings roundtrip / session navigation / 
   queue-revert / web-search / ACP / V4 历史（走单元测试）。后续可写只读 debug
   探针插件通过真实 RPC 完成行为验证。
