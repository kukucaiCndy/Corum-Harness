# 交接：Pencil 设计技能（pencil-mcp）与当前设计工作

> 写给在新 Agent 对话环境中接手的人。本文档说明 Pencil MCP 技能的位置、已校准的事实、以及当前进行中的设计工作（顶部菜单栏 + 插件中心）的上下文与下一步。

---

## 一、技能位置与组成

Pencil 设计技能在仓库内：

- **技能定义**：`.trae/skills/pencil-mcp/`
  - `pencil-design/`（主技能，按需引用下面两个子模块）
  - `pencil-mcp-api/SKILL.md` — **API 参考（已实测校准）**，本文档重点
  - `pencil-to-miniprogram/`（设计稿转小程序，本次未用）
  - 脚本：`pencil-mcp-api/remove_bg.py`、`crop_pad.py`（图片去背景/裁剪补偿）

另有官方桌面端 Pencil（Pen.app），设计稿在它的画布上编辑，MCP server 驱动。

## 二、Pencil MCP 实测校准结论（2026-08-21，已逐条验证）

`pencil-mcp-api/SKILL.md` 已按本机实测修正，关键点：

1. **实际工具只有 4 个**：`browser / execute / get_app_state / get_guidelines`。
   网上/旧文档的 `batch_design` / `batch_get` / `get_screenshot` / `snapshot_layout` / `get_variables` / `export_nodes` **都不存在**。
2. **读写都走 `execute`**：
   - 读：`Get(id, {depth})` 或 `Get((node,ctx)=>...)`，配 `Print(...)` 输出。
   - 写：`Insert / Copy / Update / Replace / Move / Delete / Generate / FindEmptySpace`。
   - 变量：`GetVariables()`；导出：`Export(...)`（不是 export_nodes）。
3. **execute 失败重试**：用返回的 `editId` + `edits`（find/replace）修补，不重发整段 input。
4. **本项目颜色用 `$token` 引用**（深浅双主题靠变量解析），实测可靠；不要硬编码 hex。旧文档"变量不稳定"不适用本项目。
5. **透明色**写 `#00000000`（`transparent` 会被静默归一化，不报错）。
6. **脚本路径**是 `.trae/skills/...`（旧文档写成 `.codebuddy/...` 已修正）。
7. **schema**：`get_app_state` 三 flag 全填拿完整 schema，但非硬性前置（execute 可独立工作）。
8. **大设计任务**：拆给多个 designer agents 并行，提示词不含布局/尺寸/颜色/变量名（让 agent 自己读文档设计，保证一致）。

详见 SKILL.md 顶部"实测校准"说明与各章"实测注"。

## 三、当前进行中的设计工作

### 3.1 已完成（在 design.pen 画布上）
设计稿：`doc/UXDesign/design.pen`（Pen.app 打开中）。

1. **删除底部状态栏**：⑦ 状态栏节点（浅 ICUAO / 深 wicT3）已删。
2. **顶部窗口标题栏**：两个 L1 主界面（浅 N1HbA / 深 e9dE1）顶部已加「窗口标题栏」（40px、traffic-light-inset 84、右侧 titlebar-actions 含 icon-settings 齿轮）。
3. **新设计稿（待你审阅确认，未改代码）**——5 个新顶层 frame：
   - 顶部菜单栏：浅 `de2wS` / 深 `QcUVk`（文件/编辑/视图/插件/帮助菜单 + 主题切换 + 设置齿轮，含「视图」下拉示例）
   - 插件中心：已安装·深 `gjW1Y`、检索·浅 `kGdy3`、视图管理·浅 `F4hJA`（800px modal，顶部 tab，与设置面板风格统一）

### 3.2 待确认的设计决策（审阅后定）
1. 插件中心三区域用**顶部 tab**（设计选择）还是左侧 nav？
2. 菜单栏菜单项「文件/编辑/视图/插件/帮助」是否符合预期？「插件」点击打开插件中心。
3. 主题切换图标放标题栏右侧（设置齿轮左侧）；布局操作（重置布局）放进了「视图」下拉。

### 3.3 下一步（确认设计稿后）
1. 在 Pen.app 里 **Cmd+S 保存** design.pen（改动目前在画布内存，未落盘时 git 无 diff）。
2. 按定稿改代码：
   - 顶部菜单栏 → 改 `packages/plugins/ui/ide-shell/src/client/AppFrame.tsx` 的 `.titleBar`（当前只有设置齿轮 + Blocks 插件图标）。
   - 插件中心面板样式 → 对齐 `PluginManagerPanel.tsx`（已有一版无稿实现，按设计稿调整视觉/布局）。
3. 提交 design.pen + 代码。

## 四、相关代码现状（供参考）

- 插件中心已实现一版（功能完整，视觉待按设计稿对齐）：
  - Host Remote：`packages/shell/src/host/plugin-manager.ts`（service `pluginManager`：list/setEnabled/install/uninstall/update/search）
  - 面板 UI：`packages/plugins/ui/ide-shell/src/client/PluginManagerPanel.tsx`
  - 标题栏入口：AppFrame.tsx 的 Blocks 图标 → FloatingLayer
- 设计规范：`doc/UXDesign/corum-harness-design-style.md`（液态玻璃 token 全表）

## 五、注意事项

- Pencil 是协作环境：改动可能未落盘，提交前确认 `git status doc/UXDesign/design.pen` 有 diff（无 diff = 没在 Pen.app 保存）。
- design.pen 被 git 跟踪；`.trae/` 目录目前 untracked（是否入库待定，问你）。
- 不要改动 design.pen 里本次新增 5 个页面以外的已有页面（除非明确要求）。
