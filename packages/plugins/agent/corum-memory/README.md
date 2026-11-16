# @corum/corum-memory — corum 通用记忆底座

事实级记忆组织插件：为 **Agent 记忆**提供**通用底座**，只承载「组织形式」，
不绑定任何记忆来源。

> 现状边界（2026-11-16 实机复核，见 `docs/MEMORY-BASELINE-2026-11-16.md`）：
> 底座（存储 / 策略 / 13 个 RPC / 设置 UI）已落地并有 131 条单测，但**当前无写入方、
> 无读取方** —— Agent 运行时不沉淀记忆，`corum-agent/compile.ts` 的 `TODO(memory)`
> 仍不组装记忆文本。手动写入只能被设置页 UI 读到。注入 / 抽象（做梦）/ embedding
> 均未实施。

## 核心设计

- **最小单元是「事实」而非消息/文档**：一条带元数据的原子断言
  （`entity` / `relation` / `fact` / `importance` / 时间窗 / `agentId` / 证据链 / 作者）。
  ⚠️ `scope` 与 `projectId` 字段已于 2026-09-22「移除项目记忆」时**整字段删除**，
  归属维度只有 `agentId`（空串 = 未归属）。
- **「失效 ≠ 忘记」（对齐 Graphiti 的时间知识图语义）**：两个正交的「时间」概念——
  - **适用窗口**（`validAt` → `invalidAt`）：事实**断言**何时为真 → 决定 `applicable`；
    到期只表示「不再驱动行为」，**不影响留存**。
  - **存续期**（`retention` → `expiresAt`）：记忆**本身**存多久 → 决定 `retained`；
    到期 = 记忆被遗忘（permanent 永不）。
  - 例：用户要求「10月31日前每天提醒日程」→ 11/1 后断言到期（`applicable`=false，
    不再提醒），但记忆仍在（`retained`=true，取决于存续期），可被 `recall` 召回。
- **存续期（retention）四档**——决定记忆本身存多久（一等落库字段）：
  | retention  | 语义            | TTL        | 衰减半衰期 |
  |------------|-----------------|------------|-----------|
  | temporary  | 临时（1~3 天）  | 2 天       | 半天      |
  | short      | 短期（3 个月）  | 3 个月     | 30 天     |
  | long       | 长期（半年以上）| 1 年       | 半年      |
  | permanent  | 永久            | 永不       | 1 年（微衰）|
- **持久化判定（4 规则）**——非持久化默认按 TTL 衰减，以下情况提升存续期：
  1. 用户明确要求的纪律 → `permanent`（写入方显式声明）；
  2. 可判定永久的事实来源 → `permanent`（同上）；
  3. 用户手动添加（author=`user`）→ `long`；
  4. 多次检索命中到阈值（`readCount` ≥ `readPromoteThreshold`，默认 5，**可配**）
     → `long`（读时升级）。注意：`getFact` / `listFacts` **不累加** readCount，
     只有 `searchFacts` 命中才累加（避免「打开设置页看一遍就升级」的副作用污染）。
- **四杠杆**：
  - **重要性** importance（0-100）：衰减基数；
  - **合并** merge：同 `entity+relation`（且仍 applicable）的 recency-wins，
    标失效不物理删（`supersedes` 溯源）；`entity` 与 `relation` 都为空时永不合并；
  - **衰减** decay：**读时降权**（指数半衰期，存续期定半衰期，访问强化抗衰），无后台任务；
    度量「记忆强度」，**不因断言到期归零**；
  - **驱逐** eviction：存续期耗尽（`expiresAt` 已过 → 遗忘）+ 硬删除（仅合规/用户显式要求）。
- **检索双模式**：`applicable`（默认，只返回当前断言成立的事实，驱动当前行为）/
  `recall`（返回所有**仍被记住**的事实，回忆「发生过什么」）。
- **多策略检索（无 embedding）**：关键词 query 做多字段加权命中
  （`fact`(4) / `entity`(3) / `relation`(2) / `source`(1) / `evidence`(1)），
  排序 = 匹配分 × 记忆强度；无 query 退化为纯记忆强度排序。向量语义检索待
  embedding 引擎就绪后作为第 N 路叠加。
- **持久化**：复用官方 `dsh-storage-domain`（单域 `corum_memory`、单表 `facts`），
  默认路由到全局 SQLite（`$CORUM_HOME/storages`）。

「记什么」由写入方决定，底座只提供能力面：`ctx.memory`（cordis 服务）+ `/api/memory/*`
13 个 RPC 端点，外加「设置 → 记忆」分组（全局设置 / 智能体记忆）做人工管理
（浏览 / 失效标记 / 重要性调整 / 存续期调整 / 硬删除 / 三维记忆空间）。

⚠️ RPC wire 形态（实测）：`POST /api/memory/<name>`，body
`{type:'client-request', rpcId, method:'memory/<name>', payload:{args:{<形参名>:<值>}}}`。
`method` 必须是**全名**，`payload.args` 必须以 `@Remote` 的**形参名**为键
（如 `putFact` 用 `{input:…}`、`listFacts` 用 `{input:…}`、`listFacets` 用 `{filter:…}`、
`getFact` 用 `{id:…}`），直接把业务字段塞进 `args` 会报 `gateway/arguments-invalid`。

## 目录

```
src/
├─ memory-entities.ts      事实 schema（13 字段）与存储域声明 corum_memory/facts
├─ memory-policy.ts        纯函数：TTL / 衰减 / 适用·留存判定 / 合并 / 关键词打分
├─ memory-service.ts       MemoryService（cordis 服务 memory + 13 个 @Remote 端点）
├─ memory-config.ts        settings ns corum-memory-settings：10 键 + 默认值 + resolve
├─ settings-registrar.ts   boot 常驻 settings 行（volatile Config 副本）
├─ index.ts                host apply（inject: ['storageDomain']）
└─ client/
   ├─ index.tsx            注册 2 个 settings.section（memory-settings / memory-agent）
   ├─ MemorySettingsPage.tsx  全局设置页（5 个 GroupCard）
   ├─ MemoryAgentList.tsx    Agent 列表（两步流程第一步）
   ├─ MemorySpace.tsx        三维记忆空间（WebGL 星云 + 五类操作）
   ├─ MemoryLibrary.tsx      平铺库视图（⚠️ 当前无挂载点）
   ├─ starfield.ts           useStarfield WebGL2 渲染器
   ├─ star-points.ts         事实 → 星点坐标
   └─ ui.tsx                 自备 UI 原语
tests/
├─ memory-config.spec.ts    46 例（配置合成 / 策略闸门 / 归属维度）
├─ memory-policy.spec.ts    35 例（TTL / 衰减 / 打分 / 合并）
├─ memory-service.spec.ts   29 例（真装官方存储栈的接口 + 业务集成）
└─ starfield.spec.ts        21 例（星云几何）
```

> 共 131 条单测；测试用 `dsh-storage-json` 后端，生产用 `sqlite`，后端差异无测试覆盖。

## 第三方开源软件与致谢

本插件站在众多开源项目的肩膀上。按其贡献方式如实区分三类：

### 基于 dsh（DeepSeek Harness）fork 版本构建

本插件运行在 **corum Agent OS** 之上——corum 是官方 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
（dsh）的 fork 版本。插件的服务装配（cordis）、领域存储（dsh-storage / dsh-storage-domain）、
RPC 端点（dsh-typert-protocol）与设置面板挂载（dsh-client-ui-*）均复用 **dsh fork 侧**的官方
基线能力，**不列作第三方依赖**；corum 侧的 fork 偏离详见仓库 `docs/fork-delta.md`。

### 直接使用的第三方开源库（运行时/编译期依赖，均 MIT 许可）

| 库 | 仓库 | 用途 |
| --- | --- | --- |
| [zod](https://github.com/colinhacks/zod) | `colinhacks/zod` | 事实记录的落盘 schema 校验 |
| [React](https://github.com/facebook/react) | `facebook/react` | 记忆面板 UI（由桌面壳提供） |

### 设计灵感来源的开源项目（架构思想借鉴，未直接引用其代码）

底座的分层记忆、四杠杆巩固（importance / merge / decay / eviction）、时间窗失效语义，
源于对以下项目的研读与借鉴。**本插件未直接使用它们的代码**，但若无这些先行者的工作，
这套「事实级 + 巩固策略」的组织形式不会这么清晰地成形：

- **[MemGPT / Letta](https://github.com/cpacker/MemGPT)**（`cpacker/MemGPT`）——「把 LLM 当操作系统管理记忆」的分层记忆架构（工作 / recall / archival），启发了本底座的分层思想。
- **[Hindsight](https://github.com/vectorize-io/hindsight)**（`vectorize-io/hindsight`）——「事实级存储 + 实体解析写时做 + 四杠杆 consolidation」的框架，以及「好的巩固让删除变得不必要」的洞见，直接塑造了本底座的合并 / 衰减 / 驱逐策略。
- **[Graphiti](https://github.com/getzep/graphiti)**（`getzep/graphiti`）——时间知识图上 `valid_at` / `invalid_at` / `expired_at` 的失效时间窗语义，启发了本底座用「时间戳失效标记」取代物理删除的设计。

### 致谢

向以上所有项目的作者与维护者致以诚挚感谢——开源世界里「把最难的部分做对、再公开出来」
的慷慨，让后来者得以少走弯路。特别感谢 **MemGPT / Letta 团队**、**Vectorize (Hindsight) 团队**
与 **Zep (Graphiti) 团队**对 Agent 记忆这一难题的扎实工作；也感谢 **colinhacks** 提供的
`zod` 与 **React 团队**长期稳定的 UI 底座。
