# 子 Agent E 报告：架构耦合与业务内聚度（已收）

整体比直觉健康：27 包**零循环依赖**（runtime 与含 type 两口径均无环），分层单向（desktop→ui-base/rpc-client→feature），rpc-client(Ca=7)/ui-base(Ca=6) 是干净 Ce=0 基础包。三大结构风险：ide-ui 上帝壳、会话域 2 万行 fork、双 AgentRuntime。

## 对四个已知疑点的独立核实（修正前判）
1. chat→conversation 33 处 import：28 处 type-only 合法；真问题是 conversation 被放进 chat 的 **dependencies**（应 devDependencies）+ index.ts:46-49 type re-export 把对方类型变成自己公开面。**非运行时红线**（与主 Agent 实证一致）。
2. ide-ui EXCLUDE 清单：**24 条**硬编码（index.tsx:370-396），插件可见性由壳反推而非自声明。
3. 双 AgentRuntime：agent-dev/runtime.ts(1222) vs project-core/runtime.ts(203) 同名类；project-core **零挂载零引用**，待爆哑弹。
4. 双槽模型：运行时 GridSlot=string 注册表（ui-base/grid.ts:20,60）vs 编译期 SlotMap（ide-ui/index.tsx:78-122 共 21 槽），三处人肉对齐无编译保障。

## Ca/Ce/I（runtime 口径；含 type 另列）
- rpc-client 7/0/0、ui-base 6/0/0（最稳定核心）
- ide-ui 2/2/0.50（含 type Ca=10 扇入冠军，改动影响面最大）
- agent-ui-dev 0/4/1.00（runtime 扇出最高最不独立）
- 无循环依赖。

## 新发现（主 Agent 未覆盖）
- H6 ide-* 插件 import ide-ui 的 sidebar.module.css 跨包 CSS 耦合（ProjectPane/SidebarSkeleton/SessionsPane）——类名哈希在 ide-ui 构建时生成，构建产物级耦合。
- H9/M1 `__corumSidebarMode` window 挂点根因：corum-ui-base 未走 dsh.client.external → 每 bundle 一份 sidebar-mode；**连带 slotRegistry 按 bundle 每包一份**（ide-ui 注册的槽在别的 bundle 不可见，这正是扫描必须在 ide-ui 内做的原因）。
- H5/M4 skill/team-ui-dev 双重身份（既是 cordis 插件又是被 agent-ui-dev 内联的组件库）。
- H11 conversation fork 直接 RPC 调 corumAgent/corumProject（无类型保障的跨域硬耦合，但是当前唯一正确跨域通路，缺 typed contract）。
- 越层判定：conversation（feature）经 setSidebarMode 直写 IDE 壳 sidebar 模式（越权写）。
- desktop/build/host/cordis.patch.yml 旧 IPC 方案构建残留（与现行 loopback 矛盾）。
- M5 会话域 fork 缺统一差异台账 + 升级 runbook。

## 整改分档（已并入 ARCHITECTURE-REMEDIATION-TODO.md）
立即 5（I1 依赖降级/I2 裸事件收编/I3 死代码/I4 build 残留/I5 AppFrame 轮询改 ResizeObserver）
中期 5（M1 ui-base external 化/M2 网格槽自声明/M3 agent RPC 契约包/M4 skill/team 拆双重身份/M5 fork 台账）
长期 3（L1 双槽归一/L2 agent 域归并/L3 会话域壳状态写权回收）

## 值得肯定
cordis.patch.yml 纪律教科书级；rpc-client/ui-base 干净基础包（组件不见 ctx）；settings 壳同形替换策略正确；事件常量集中+注释记竞态诚实；combo=独立 host 进程隔离模型 + COMBO_ENV_BLOCKLIST 安全钳制。
