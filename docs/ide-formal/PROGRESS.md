# IDE 正式 combo 功能对接进度记录

> 目的：正式版本切到 IDE combo（仓库内 combo id = `coding`，`CORUM_DESKTOP_MODE=ide`）后，
> 按「从上到下、从交互界面元素适配开始」的节奏推进正式功能对接。
> 本文是跨 Agent / 跨 context 的交接锚点：每次推进都要更新「当前状态 / 已完成 / 进行中 / 下一步 / 风险」。
> 创建时间：2026-08-25 · 基线提交：`1319d6a2`

---

## 0. 协作规则（本轮起生效）

1. **按用户节奏推进**：不一次性铺开实现；每一步先明确当前交互元素/界面区域，再做适配，验证后记录。
2. **从上到下**：优先交互界面可见元素（壳/区域/槽位/面板/按钮/对话区/文件树/底部面板），再往下接 host 能力与数据。
3. **子 Agent 优先**：凡可并行调查、读码、验证、整理清单的工作，尽量交给子 Agent/独立任务执行；当前会话保留协调、决策与进度记录。
4. **进度即代码**：每完成一个小步就更新本文；重要节点提交 git，便于 context 受限时快速恢复。
5. **正式 combo 注意**：IDE combo 走 `packages/desktop/cordis.ide.patch.yml` overlay；不要改官方内核，仍只写插件 + overlay。

## 1. 当前基线

- 分支：`feat/ide-s4-restore`
- 最新提交：`1319d6a2`（agent-dev 数据层/泳道标签/dev-agent 维护脚本已提交）
- 未提交文件：`doc/UXDesign/design.pen`（与本任务无关，保持未纳入）
- 可用工具：
  - `scripts/dev-agent.sh`：dev-agent combo 一键维护（清残留 + 直编 .bin + PID 记录 + 启动）
  - `~/.agents/skills/corum-cdp-verify`：CDP 实机验证技能
- 待补工具：IDE/coding combo 的同类一键维护脚本（后续第一步可补）

## 2. 正式目标（IDE combo）

- 启动形态：`packages/desktop/scripts/dev.sh --combo=coding`（或后续补 `scripts/dev-ide.sh`）
- UI 承载：`@corum/corum-ide-ui` 壳 + `corum-ide-*` 功能插件
- 对接原则：用户能看到的元素先适配真实能力；每接一个元素，明确其数据来源（RPC/事件/共享实体/会话）与降级态。

## 3. 进度日志

### 2026-08-25 · 起步
- 状态：IDE/coding 维护脚本已补齐；正式 combo 已启动并验证可进入界面。
- 已完成：
  - agent-dev 侧地基提交（`1319d6a2`），可作为 IDE 正式功能的数据/调度后盾。
  - 新增 `scripts/dev-ide.sh`；`scripts/combo.sh coding` 改走该脚本。
  - 移除 IDE/coding 对 S0 布局调试插件的注入（`corum-ide-test-sidebar-ui` /
    `corum-ide-test-conversation-ui`），解决 `conversation` 槽重复注册启动报错。
  - CDP 验证：`corumapp://app/index.html?combo=coding` 打开，`bootCount=41`，
    无 conversation 冲突，正式 `corum-ide-sidebar-ui` / `corum-ide-conversation-ui` 在 boot entries。
- 当前运行：IDE/coding 实例保留运行（PID 记录见 `.corum-dev-home/run/coding.pid`）。
- 下一步候选（等用户点名节奏）：
  1. 盘点 IDE combo 当前可见 UI 元素与槽位占用（壳/侧栏/资源管理器/对话区/底部面板/状态区）。
  2. 选定第一个交互元素做真实能力适配（建议从对话区或文件树开始）。

## 4. 风险 / 注意

- `doc/UXDesign/design.pen` 有无关改动，提交时继续排除，避免污染正式功能提交。
- 多 host 残留仍是红线：IDE 调试脚本落地前，重启仍按 `corum-cdp-verify` 技能清残留。
- LanePool 泳道占用投影仍是进程内存态；IDE 若要展示运行中状态，重启后需以事件日志/数据层为准重建。
