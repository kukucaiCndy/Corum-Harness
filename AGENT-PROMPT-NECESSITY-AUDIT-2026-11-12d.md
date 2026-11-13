# 系统提示词必要性审计 + MCP 渐进式索引设计（2026-11-12d）

接 c 轮（T1+T2 精简已批准，实施中）。本轮回答用户两个新要求：
① MCP 改为渐进式批量索引 + 查询工具，LLM 按任务逐步获取；② 审计提示词哪些非常必要、哪些可移除，目标整体更短。

## 0. 结论

- **MCP 渐进式索引：官方架构原生支持，无需 fork。** agent-loop 每步对工具面做差量、新增工具以 developer/message 增量声明（`dsh-agent-loop/lib/index.js:1244-1258`，KV-cache 友好）；corum 的 MCP 池（host 单例）已持有全部 server 的工具清单。设计见 §2，**待批准后实施**（新功能，非文案改动）。
- **必要性审计**：T1/T2 之外还有三档空间——条件注入（~1.4KB，按角色/会话类型分流，无语义损失）、可移除候选（ralph ~1.1KB，**与 2026-09-10 用户裁决相反，须重新拍板**）、委派机制段渐进披露（~3.5KB，有行为风险，列为选项）。见 §1。
- 合计远景：普通角色 standard 首轮可从 23.6KB 降到 **~15KB 量级**（T1/T2 -3.1KB + 条件注入 -1.4KB + MCP 索引 -10KB 量级且随 server 数放大）；conductor 同比例。

## 1. 必要性审计（逐段三档）

判据：**必要** = 删除会直接改变模型行为正确性/安全性；**条件** = 只对特定角色/会话类型必要，可分流注入；**候选** = 删除改变能力面，属产品决策。

### 1.1 必要（保留；T1/T2 已压缩其叙述）

| 段 | 理由 |
|---|---|
| persona 前缀 / desktop-surface | 身份与交互面事实（surface 可再压到一句 ~150B，微收益） |
| output-language | 用户硬性要求 |
| @ 路径引用（官方） | 用户常用 @ 路径；官方段不可动 |
| tool-policy | 文件工具纪律 = 改动审查完整性，删了模型回退 bash 写 |
| EFFICIENCY / SANDBOX 核心 | bash 正确性与沙箱升级安全 |
| todo 四条规则 | 清单真实性（用户定调） |
| 官方工具段（read/write/edit/glob/grep/jobs/web/goal） | 工具契约；fork-drift 守卫 |
| 委派路由核心（SHORTEST PATH + 预检 + black-box 契约） | 委派决策必须在调用前知道 |

### 1.2 条件注入（~1.4KB，无语义损失——内容只去它不需要的会话）

| 段 | 现状 | 建议 | 省 |
|---|---|---|---|
| harness-source（壳 -99） | 全局，所有会话 | 只对可能 inspect/extend DSH 的角色（corum-dev 等）注入；普通角色不需要 checkout 位置 | ~330B |
| host-identity 的 CDP/实例细节 | 全局 780B | 拆两半：核心事实（role/home/不可重启宿主）全局；CDP 端口/attach/verify 实例规则只给开发类角色 | ~300B |
| SANDBOX 的 DELEGATED CHILD 段 | root scope，所有会话继承 | 拆段：根会话拿通用升级规则；child  adjudication 细节注册在子会话 scope（子会话仍全量拿到，零损失） | ~750B（根会话） |

实施注：三处都是「注册位置/scope 分流」改动，不改文本语义；host-identity 拆分顺带为 P1 矛盾（verify 重启规则冲突）提供修法落点，但 P1 本身仍另案。

### 1.3 可移除候选（产品决策，须拍板）

| 候选 | 体积 | 冲突/风险 |
|---|---|---|
| **ralph 整套**（官方段 420B + schema ~500B + corum bullet ~200B） | ~1.1KB | ⚠️ 2026-09-10 用户裁决「ralph 一并纳入」——移除是推翻旧裁决。事实：ralph 门控极窄（仅用户显式要求时），standard 里常年闲置。选项：a) 从 standard 卸载、保留专用 preset 按需挂；b) 保留 |
| **委派机制段深度细节渐进披露**（隔离机制/finishing/model-routing 细节 ~3.5KB） | ~3.5KB | 与 MCP 索引同哲学：首轮只留路由+预检+black-box 契约（~3KB），深度细节在首次委派时注入或经查询工具获取。风险：预检/隔离知识必须在**首次 orchestrate 之前**到位，注入时机设计不当会制造新的失败形态（本项目有前科：persona 改动制造卡死）。列为选项，需单独设计+实机验证 |
| REPORT SCOPE bullet | ~150B | 用户重视调用数汇报——**建议保留**，列出仅为完整 |

## 2. MCP 渐进式索引设计（待批准）

### 2.1 机制事实（已核实）

1. **池已持有清单**：`corum-mcp-manager/pool.ts` 是 host 单例，持有各 server 活连接与 `listTools` 结果（proxy.ts:251 现在就在用）。
2. **注册可延迟**：proxy 现在 mount 时把全部工具 `tools.register`（proxy.ts:270，disposers map 已支持动态增删）——改为按需注册是同一 API 的时机变化。
3. **增量声明官方自带**：agent-loop 每步差量工具面，新增工具走 developer/message 增量声明（`dsh-agent-loop:1244-1258`；`dsh-llm:760-806` 消费，deferLoading 语义）——**中途注册的工具自动获得缓存友好的增量声明，无需 fork**。
4. guidance 段（≤4KB/server）与官方 instructions 段（≤32KB）同样可延迟到 load 时注入。

### 2.2 形态

**首轮只注入（每授权 server）**：
- 一段紧凑索引：server 名 + 一句用途 + 工具名清单（每个工具 ≤60 字符摘要，取自描述首句，注册表可覆写）。11 个工具 ≈ 0.8KB。
- 两个共享小工具（schema 合计 ~600B）：
  - `mcp_index({server?, query?})` → 返回匹配工具的**完整描述 + 参数 schema + guidance**（纯查询，不改工具面）；
  - `mcp_load({server, tools?})` → 把选定工具（缺省整 server）注册进本 Agent 工具面 + 注入该 server guidance；返回已加载清单。
- 索引段附带一句使用纪律：「先 index/load 再调用；未加载的工具名不可调用」。

**加载后**：工具 schema 经官方增量声明进入上下文（一次，不每轮重发）；guidance 段自 load 起在。会话内保持。

**冷恢复**：已加载集合记入会话投影（sessionProjections），resume 时 proxy 按投影重注册——否则恢复后工具面与历史声明不一致（设计要点，实施时验证）。

### 2.3 决策点（须拍板）

- **D-A 默认模式**：新 profile 默认 `index`（渐进）还是 `eager`（现状）？建议：默认 index，profile 级 `mcpMode: 'index'|'eager'` 可回退（兼容既有用户与重 MCP 工作流）。
- **D-B 摘要来源**：工具描述首句截断（自动）vs 注册表手写摘要（更准但要维护）。建议：自动首句 + 注册表可覆写。
- **D-C research 子 Agent**：现状 MCP 全 deny。索引可见但 load 拒绝（维持只读语义）？还是允许加载只读 MCP 工具？建议：维持全 deny，索引段也不给 research（省到底）。
- **D-D 自动加载**：模型直接调用未加载工具名时，报错引导（fail-loud，简单）vs 拦截并自动加载后放行（省一轮，但隐式副作用）。建议：fail-loud + 错误文案指路 mcp_load。

### 2.4 收益与成本

- 本会话 2 server：首轮 MCP 成本 ~12KB → **~1.4KB**（索引 0.8 + 两工具 schema 0.6）；加载后的 schema 按需一次进入。
- 10 server 场景：首轮 ~6KB vs 现状 60~100KB，**线性增长被压平**。
- 成本：每 server 首次使用多 1 轮（index/load）；实现面 = proxy 注册时机 + 两个新工具 + 投影恢复 + 测试 + 实机验证（中等规模功能，建议独立一轮实施）。

## 3. 本轮不做 / 待办

- T1+T2 实施：子 Agent 进行中（隔离 worktree），集成后统一构建 + :9333 实机验证。
- §1.2 条件注入、§1.3 候选、§2 MCP 索引：均待批准后各自成轮。
- 上轮遗留：N5（官方 session/create 绕过 conductor 覆盖）、D3（P0 假承诺）、host-identity P1 矛盾。