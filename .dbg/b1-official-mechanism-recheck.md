# B1-pre 重启条件核查（dsh 0.1.2-alpha.2 源码复核）——维持「放弃」，并补两条官方硬约束

> 定位：本记录是 `docs/audit/NEXT-PHASE-DEFERRED.md` §0「B1-pre：ui-base external 化」
> 的重启条件核查。调研对象：`/Users/kukucai/dsh` checkout（master@0a53fb55be，
> version 0.1.2-alpha.2）。结论：**机制墙依旧 + 新增规范墙，B1-pre 维持关闭**；
> 若未来仍要重启，需满足下文 §4 的四个条件。

## 1. 机制勘察复核（三份入口文档结论源码级全部成立）

| 既有结论（`.dbg/b1-boot-graph-findings.md` 等） | dsh 源码实证位置 |
|---|---|
| boot 图 entry 需 `dsh.client`(platform:'web') + `./client` 指产物 bundle | `packages/client/modules/src/index.ts` `parseDshClient`(L201)/`clientExportOf`(L224)/`resolveMeta`(L738) |
| 单例语义是模块系统核心（materialize 一次全 require 共享） | `packages/client/modules/src/client/system.ts` `materialize`(L173) memoize 进 `loadCache`；`manifest.ts` 头注 L9-16 lazy CJS 模型 |
| `<id>/client` 与裸包名归一同一条 graph row | `manifest.ts` `stripClientSuffix`(L156)，require/import/host 拓扑三处共用 |
| external 拓扑排序（动态行先于消费者） | host `orderByModuleGraph`(index.ts L438)；browser `arriveGraphRow`(system.ts L144) |
| 纯库必须 no-op apply 才能被 cordis 激活 | `vendor/cordis/src/registry.ts` L318-319（无 apply throw `invalid plugin`） |
| seed 只有 8 个硬编码基线模块 | `packages/client/web/src/platform.ts` L8-13 `PLATFORM_MODULES`；`seed.ts` `getStaticModules()` L23-37；`PRELOADED_CLIENT_EXTERNALS = []` 至今为空 |

## 2. round 36 白屏的新归因线索（试做时缺失的配置）

boot 时序（`packages/client/web/src/boot.ts` L127-131）对全部 entry `Promise.all(loader.create)` 并发创建，**模块 arrival 是 import 时惰性驱动的**；browser 侧 `arriveGraphRow` 先按 `row.inject` arrival 被 inject 包的 factory（2026-08-24 commit `5549b9add5`「preload injected module factories」起）。

**官方唯一的外部共享模块先例的配对纪律**：`dsh-api-session-controller`/`dsh-api-workspace-controller` 声明 `external:['@deepseek-ai/dsh-api-gateway/client']` **同时** `inject:['@deepseek-ai/dsh-api-gateway']`（packages/api/*/package.json）；基础设施行 ui-theme 则 `immediately:true`。

**试做（路径乙）对照**：6 个消费包 `dsh.client.inject` 均未含 ui-base，ui-base 又是 `immediately:false`——inject 配对 + 预载两道先序保障都缺失。此外 dev 实机 HMR 活跃时，被共享包经 `client-hmr` reload（invalidate → 重建 exports）会**重建 exports 对象身份**，而各消费 bundle 内已缓存的 CJS exports 快照不级联刷新（cascade 只沿 fiber inject 服务边，不走模块 external 边）——「壳拿新、插件拿旧」的静默身份分裂与「无报错、不挂载」表征吻合，且只在自定义共享模块形态下出现。

## 3. 重启条件核查结果

| 重启条件 | 0.1.2-alpha.2 现状 | 判定 |
|---|---|---|
| 开放的 seed 注入点 | `apps/web/src/main.ts` 仅 `new AppWebEntry(el).run()`；`getStaticModules()` 硬编码 8 词，`satisfies Record<PlatformModule,unknown>` 编译期 pin 死；无注册 API、无壳侧配置面 | ❌ |
| 模块表注册 API | host `ctx.clientModules` 服务面仅 graph/clientPath/artifactBaseline/rebuilt/onRebuilt/onGraphChanged（面向 HMR），无「注册共享模块」入口 | ❌ |
| 文档化共享模块机制 | **出现了，但方向相反**：`packages/client/AGENTS.md` §Shared modules（L73-97）明文「`dsh.client.external` 不是 feature 插件的依赖机制，只有 infrastructure/transport/generated assembly 可加非基线请求」；`docs/subsystems/web-client.zh.md` L88「功能包不能只为绕过规则而加 external」；`scripts/verify-client-packages.ts` 自动修复/拒绝冗余或违规声明 | ⚠️ 有文档，但把 ui-base 形态列为**反模式** |

git 佐证：`seed.ts` 自 2026-08-23 无实质变更；`PRELOADED_CLIENT_EXTERNALS` 空数组至今（官方自己未用过预留口）；master 无任何针对「自定义共享单例模块」的提交。

## 4. 若未来仍要重启的四个前置条件（缺一不可）

1. 出现「必须模块级（非 cordis 服务）跨 bundle 共享可变单例」的真实需求——cordis 服务路径（C3a/C1）不能覆盖的场景。
2. 官方开放 seed 注入点，或文档化该形态（当前文档方向相反）。
3. 若走 dsh.client 路径：消费包**同时** `inject` + `external` 被共享包（api-gateway 配对纪律），被共享包评估 `immediately:true`；声明需先通过 `scripts/verify-client-packages.ts` 等价校验（否则被官方门禁判违规）。
4. dev 实机回归必须覆盖 **HMR bundle swap** 场景（改一次被共享包源码触发 rebuilt），验证各消费 bundle 无 exports 身份分裂——round 36 未覆盖的静默点。

## 5. 官方推荐的正解 = corum 已走的路

官方规则原文：「共享运行时值需要一个职责收窄、没有功能生命周期的静态 owner」（web-client.zh.md L88）+「跨包行为使用注入的 Cordis service」——corum 的 C3a（`ctx.layout`）/C1（`ctx.slotRegistry`）与官方 `dsh-client-store`/`ui-primitives` 静态 owner 模式同构，且 cordis 服务跨 bundle 天然单例已实证（`.dbg/cordis-singleton-probe.md`）。**ui-base 剩余内联复制只有 bundle 体积成本，无正确性问题。**
