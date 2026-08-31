# corum Agent OS — 开发规范（每对话自动注入）

> 本文件由 dsh agent-instructions 自动注入每个新对话（项目根 `AGENTS.md`，
> 机制：`packages/context/agent-instructions`，从 cwd 向上找 `.git` 定位本根）。
> 只列**红线 + 入口**；完整规范见 `docs/dev-conventions.md`（改跨包状态/新插件前必读全文）。

## 红线（必须先知道）

1. **跨 bundle 共享状态：一律 cordis 服务，禁 window 全局 / 模块级单例。**
   dsh 把 `@corum/*` 源码各自内联进每个 bundle，模块级/window 挂点按 bundle 拆分、
   互不可见（`__corumSidebarMode` 退化成死写、联动断裂的活例）。cordis 服务实例
   唯一性由 root context `reflect.store` 保证——**跨 bundle 天然单例**（已实证
   `.dbg/cordis-singleton-probe.md`），共享状态做成 cordis 服务（provide + inject）
   即可，无需 external 化。
   - 例外（合法 window 挂点，都是「写一次只读」非共享可变状态）：`window.corumDesktop`
     （IPC 桥）、`__corumNotify`、`__DSH_BOOT__`（client 侧唯一读法）。
2. **别想当然给 `@corum/*` 做 external 化**：dsh 模块表只有 8 个硬编码 seed，
   自定义共享模块走 `dsh.client` 插件路径实机白屏（round 36 实证）。共享需求用
   上一条的 cordis 服务绕开。
3. **跨 bundle 类型面不一致 → 局部能力接口收窄**：消费方 inject 的服务类型可能
   是官方基座窄接口（corum 运行时是其超集），别强耦合实现包，用能力接口 + helper
   收窄（C3b/C3a 同思路）。
4. **消费 cordis 服务用 inject 声明，别 `ctx.get` 裸取**未装配服务（`ctx.remote` 坑）。
5. **改 host 插件必重启应用**；renderer 改动才 HMR 热更。跨包状态/壳/调度类改动
   必须 CDP 实机三层验证（UI 渲染 + 行为 + 控制台零报错），编译通过 ≠ 完成。

## 关键文档（按需读）

- `docs/dev-conventions.md` — **完整开发规范**（决策树、代码正反例、依据速查）。
- `docs/audit/NEXT-PHASE-DEFERRED.md` — 架构暂缓/关闭项交接（C3a 已完成、C1 前置已通）。
- `docs/fork-delta.md` — 会话域 6 个 fork 包差异台账 + 官方升级 runbook（fork 包改动必读）。
- `docs/plugin-template.md` — 新插件包模板与新增步骤。
- `.dbg/cordis-singleton-probe.md`、`.dbg/C3a-sidebar-mode-service.md` — cordis 服务
  跨 bundle 单例实证 + C3a 落地（C1 复用同模式：provide + inject + uSES 源 + InjectFace）。

## 仓库速览

- 插件在 `packages/plugins/<group>/<name>`（ui/session/agent 分组），desktop 壳在
  `packages/desktop`。新插件要加进 `packages/desktop/package.json` deps + `pnpm install` 链接。
- 构建：`pnpm --filter <name> run build`（ui-base 等被依赖包先 build）。typecheck 同包名。
- 实机验证/CDP：见 `corum-cdp-verify` skill（`./scripts/cdp.sh start|status|stop`）。
