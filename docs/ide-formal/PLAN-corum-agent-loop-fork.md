# PLAN — fork agent-loop → `@corum/corum-agent-loop`（泳道单实例多会话切换）

> **用途**：把「1 个 Agent 管理多个泳道 session（省实例 + 保隔离）」落地的 fork 方案定稿。
> 状态：**方案已定，未动工**。配合 `DISCUSSION-task-lane-migration.md`、`PLAN-corum-agent-loop-fork.md` 一起读。
> fork 来源：`/Users/kukucai/dsh/packages/core/agent-loop`（TS 源码 1691 行）。
> 最近更新：2026-08-28 · 分支 `feat/ide-s4-restore`

---

## 〇、目标模型（为什么 fork）

- **现状**：泳道 = 一个 `(project, profile, lane)` 一个 rootAgent 实例——本质是「一个 session id 一个 Agent 实例」，跟官方唯一区别只是 session id 前缀（`corum-task-*` vs `session-*`）。**没实现「一个 Agent 管多 session」。**
- **目标**：一个角色一个 Agent 实例，按泳道切换工作上下文。**隔离在 Session 事件流里，不在 Agent 实例里**（官方机制实证：每次发 LLM 的 context 是从 session 事件流现 fold 的，`agent.ts` 头注「Every request is derived from the session log」）。
- **手段**：官方 `ReactLoopAgent.session` 是构造器 `public readonly` 参数属性、无 `switchSession` 接口、且 `ReactLoopAgent` 不从包导出（无法 extends）、构造点在 `AgentLoop.prepare()` 硬编码（无法注入自定义类）——**只能 fork 整个包，加 session 切换能力**。

---

## 一、源码核实的 5 个决定性事实（fork 可行性的地基）

1. `ReactLoopAgent.session` 是构造器 `public readonly` 参数属性（`agent.ts:91`），TS 层 readonly，**无运行时冻结**——fork 改成可变即可。
2. **session 的全部耦合点只有 4 处**（源码很干净）：
   - `this.session`（constructor 赋值）；
   - `this.inbox = new Inbox(session, {...})`（`agent.ts:94`）——Inbox 构造读 `session.events` 回放 `agent/inbox/spliced`，`splice` 会 `this.session.append`（`inbox.ts:186`）——**换 session 必须重建**；
   - `this.runtimeContext = new RuntimeContextProjection(this.ctx, session)`（`agent.ts:103`）——它 `ctx.on('session/event')` 按 `subject !== session` 过滤（`runtime-context.ts:42`）——**换 session 必须重建**；
   - `phase.lastTurn`（constructor 从 `session.events.findLast('turn/start')` 读，`agent.ts:99`）——**换 session 必须重算**。
3. `Agent` 接口契约就是 `readonly session: Session`（`dsh-agent/runtime-types.ts:76`）——子类把字段改可写 + getter **仍满足接口**（readonly 只约束消费侧）。
4. **session 数据映射链不在 agent-loop**：`Session.create/fromRestore`、`ctx.sessions.enter/announce`、`session-persistence` 写 `.zstd`——全在 `dsh-session` / `dsh-session-persistence`。**fork agent-loop 不碰它们**，只要切换时正确调 `enter/announce/flush`。
5. `enter()` 返回的 disposer 就是 detach（卸载）（`session/index.ts:911-946`），`store.delete` + `emitDisposed`——卸载旧泳道 session 的官方机制（驻留策略下第一版不用，留口）。

---

## 二、定位与边界

- **fork 产物**：corum 自己的包 `@corum/corum-agent-loop`，依赖仍指向官方 registry 版本（`^0.1.1-rc.2`），**不依赖 dsh workspace**、**不改官方 `@deepseek-ai/dsh-*` 任何包**。
- **挂载**：cordis patch 把 `- id: agent-loop` 的 `name` 从 `@deepseek-ai/dsh-agent-loop` 换成 `@corum/corum-agent-loop`，**id 不变**——`ctx.agentLoop`、`ctx.agents.setFactory`、declarative `agents:[]` 全部照常解析。
- **核心新增**：`ReactLoopAgent` → `CorumLaneAgent`，新增 `switchSession(target)`。

## 三、包结构（照抄官方，重命名）

```
packages/plugins/agent/corum-agent-loop/
  package.json            # name: @corum/corum-agent-loop；deps workspace:^ → ^0.1.1-rc.2
  src/
    index.ts              # CorumAgentLoop（原 AgentLoop）+ resolveLaneSession 编排
    agent.ts              # CorumLaneAgent（原 ReactLoopAgent + switchSession）
    tool-calls.ts         # 原样
    runtime-context.ts    # 原样
    constants.ts          # 原样
    invariant.ts          # 原样
```

---

## 四、核心改动 1：`agent.ts` 加 `switchSession`

### 4.1 抽 `bindSession`（构造与 switch 共用的 session 绑定逻辑）

```ts
export class CorumLaneAgent implements Agent {
  // session / inbox 从 readonly 参数属性 → 私有可变字段 + 公有 getter（仍满足 Agent 接口）
  private _session!: Session
  get session(): Session { return this._session }
  private _inbox!: Inbox
  get inbox(): Inbox { return this._inbox }

  constructor(loopCtx, id, options, session) {
    this.dispatch = agentEvents(loopCtx, this)
    this.scope = createScope(loopCtx, this)
    this.ctx = this.scope.ctx.extend({ agent: this })
    this.bindSession(session)
  }

  /** 把一个 session 绑定为当前工作上下文（构造与 switch 共用）。 */
  private bindSession(session: Session): void {
    this._session = session
    this._inbox = new Inbox(session, {
      inserted: m => this.dispatch.emit('agent/inbox/inserted', { message: m }),
      discarded: m => this.dispatch.emit('agent/inbox/discarded', { message: m }),
      claimed: (m, turn) => this.dispatch.emit('agent/inbox/claimed', { message: m, turn }),
    })
    const lastTurn = session.events.findLast(e => e.type === 'turn/start')?.data.turn ?? 0
    this.phase = { kind: 'idle', lastTurn }
    this.runtimeContext = new RuntimeContextProjection(this.ctx, session)
    this.requestHeaderLogged = false        // 让目标 session 重新锚定 request/header
    this.requestSurfaceGeneration = undefined
  }
}
```

> `requestHeaderLogged` 重置 `false`：`buildRequest` 才会在新 session 上以 `'initial'/'resume'` 重新落 `request/header`（`agent.ts:505-507`），否则基线错乱。

### 4.2 新增 `switchSession`

```ts
/**
 * 切换当前工作泳道：flush 旧 session，绑定新 session。
 * 省实例（同 Agent 复用封装）+ 保隔离（每泳道独立 Session 事件流）。
 * 红线：仅 idle 可切（running/maintenance 切换会撕裂进行中的 turn）；
 * 调用方（AgentRuntime 调度层）保证切换点在任务边界（complete_task 后）。
 */
async switchSession(target: { session: Session }): Promise<void> {
  if (this.phase.kind !== 'idle') {
    throw new Error(`agent "${this.id}": cannot switch session while ${this.phase.kind}`)
  }
  await this.loopCtx.sessions.flush(this._session)  // 旧泳道落盘（不卸载 Session 对象——驻留）
  this.bindSession(target.session)
  // 不发 agent/session-switched（避免碰官方事件类型）；切换事实由调度层记。
}
```

---

## 五、核心改动 2：`index.ts` 加泳道 session 装载编排

```ts
export class CorumAgentLoop extends Service implements AgentFactory {
  // … 原 create / createAgent / resume / setupAndPublish / prepare 全部保留 …
  // prepare() 里 `new ReactLoopAgent` → `new CorumLaneAgent`（唯一构造点改动）

  /**
   * 解析（或冷恢复）一个泳道 session 供 CorumLaneAgent.switchSession 用。
   * 驻留策略：活泳道直接复用内存 Session；冷泳道经 sessionPersistence 恢复
   * + enter/announce 注册进 store（让 session-persistence 接上写盘）。
   */
  async resolveLaneSession(sessionId: SessionId, meta?: Pick<SessionHeader,'cwd'>): Promise<Session> {
    const live = this.runtime.ctx.sessions.get(sessionId)
    if (live !== undefined) return live
    const persistence = this.runtime.ctx.get('sessionPersistence')
    if (persistence === undefined) {
      return this.runtime.ctx.sessions.create(sessionId, { meta })
    }
    const preparation = await persistence.prepare(sessionId)
    this.runtime.ctx.sessions.enter(preparation.session)
    this.runtime.ctx.sessions.announce(preparation.session)
    return preparation.session
  }
}
```

**驻留 vs 卸载**：第一版**驻留**（冷恢复后留内存，切换零装载；内存代价 = N 个轻量事件流容器，远小于 N 个 Agent 实例）。未来回收：对久未用泳道调 `enter` 返回的 `detach()`，下次 `resolveLaneSession` 再冷恢复。**第一版不回收，注释留口。**

---

## 六、对 session 数据映射的影响范围（结论：无断点）

| 映射环节 | fork 后谁在管 | 是否断 |
|---|---|---|
| `Session.create/fromRestore` 造事件流 | `dsh-session`（官方，不动） | ✅ |
| `enter/announce` 注册 + `session/created` | fork `resolveLaneSession` / 官方 `setupAndPublish` 都照调 | ✅ |
| `session-persistence` 监听写 `.zstd` | 官方插件监听 `session/created`/`session/flush` | ✅（announce 照发，flush 照调） |
| request/header fold / deriveMessages | `dsh-session`（官方） | ✅ |
| 泳道事件流投影 `simplifyEventData` | corum-agent-dev 读 `agent.session.events` | ⚠️ **需适配**（见下） |

**唯一 corum 侧适配点**：switch 后 `agent.session` 指向变了，`getTaskEvents` / `getSessionEventsForType` 现在按 `agent.session.events` 读——要么改成按 sessionId 从 `ctx.sessions.get(id)` 读（而非从 agent 读），要么接受「只能读当前泳道」。这是 corum-agent-dev 的适配点，**不是 fork 的断点**。

### 6.5 对象层复用（2026-08-28 CDP 实机验证：与 fork 正交，早已成立）

**泳道会话在【未 fork】的当前就已经完整活在官方 `ctx.sessions` 对象层**——因为
`ctx.agents.create` 的官方 `AgentLoop.setupAndPublish` 用 `agent.ctx.sessions.enter/announce`
注册的就是 root `SessionStore` 单例（Cordis 服务沿 scope 链共享同一实例）。实测：

- `session.list` RPC 返回泳道（corum-task×18/proj×14/dev×14），header（`cwd`/`agentPreset`）完整；
- `session.models`（模型选择器作用域）、`session.rename` 对泳道均可用；
- 官方对 session-id 零格式约束（`SessionId()` 纯 cast），header 唯一约束是 `cwd` 必须给（泳道已给）。

**含义**：泳道的「对象层 list/open/binding/scope/rename/模型选择器/审批作用域」**不依赖 fork，
早已可用**（这也是 `PLAN-task-lane-ui-adaptation.md` 的事实地基）。fork 只新增「省实例 +
保隔离」能力（泳道多实例 → 单实例切 session），落地后唯一要注意的就是上面「`agent.session`
指向变化 → 投影按 sessionId 读」的适配。**fork 与对象层复用是两件正交的事。**

---

## 七、与现有调度的整合（改动极小）

`AgentRuntime.ensureAgent`（`runtime.ts:697-706`）现在按 `(project,profile,lane)` 起多实例，改成：

```ts
const laneSession = await ctx.agentLoop.resolveLaneSession(laneSessionId, { cwd })
await rt.laneAgent.switchSession({ session: laneSession })  // 一个角色一个实例
rt.agent = rt.laneAgent
```

调度层（队列/泳道池/阻塞循环）**零改动**——早就按「单角色串行」设计（`runtime.ts:11-18` 头注预言的「仅 createAgentForType 内部从多实例换成单实例切会话」）。

---

## 八、实施步骤（可执行顺序）

1. **建包**：`packages/plugins/agent/corum-agent-loop`，照抄官方 5 个 src + package.json（deps 换 registry 版本）。
2. **改名**：`AgentLoop`→`CorumAgentLoop`、`ReactLoopAgent`→`CorumLaneAgent`，export 对齐。
3. **agent.ts 手术**：session 可变 + getter、抽 `bindSession`、加 `switchSession`（§四伪码）。
4. **index.ts 手术**：加 `resolveLaneSession`；`prepare()` 构造点换类。
5. **挂载切换**：cordis patch（dev-agent + ide 两个 overlay 的 host 组合）`agent-loop` 行 `name` 换成 `@corum/corum-agent-loop`。
6. **类型检查 + 构建**：直调 `.bin/tsc` / `CI=true pnpm --filter` build（避开 verify-deps）。
7. **CDP 实机验证**：一个角色连派两个不同 type 任务 → 断言 (a) 同一 agent 实例 (b) 两份独立 session 事件流落盘 (c) 切换后 request/header 在新 session 重新锚定。

**推荐动工节奏**：先做 (1)(2)(5)(6)——「fork 原样替换官方包跑起来」验证能 mount、行为不变；再加 (3)(4) 能力。风险最小。

---

## 九、风险与红线

- **驱动循环 509 行原样保留**——只动 session 绑定那几处，流式/工具配对/cancel 语义一字不改（保真优先）。
- **切换必须 idle**——`switchSession` 硬校验，调度层保证在 `complete_task` 闭环后切。
- **官方同步负担**——fork 后 `dsh-agent-loop` 官方修复要手动比对同步；package.json 注释钉住 fork 自 `/Users/kukucai/dsh` 哪个 commit。
- **不发 `agent/session-switched`**（避免碰官方事件类型），切换事实由调度层记。

---

## 十、未决问题（回到讨论）

- 泳道事件流投影的适配（§六）：RPC 读 `agent.session.events` → 改按 sessionId 读 `ctx.sessions.get(id)`，还是只读当前泳道？
- 驻留 session 的回收策略（第一版不回收，量级上限？）。
- `switchSession` 是否需要在切换前自动 flush + 发射调度可观测信号（当前只 flush 不发事件）。
