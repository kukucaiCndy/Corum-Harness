# 标准模式与指挥模式系统提示词审查（续）：身份段泄漏与完整装配图

审查日期：2026-11-12（同日续审，接 [AGENT-STARTUP-PROMPT-REVIEW-2026-11-12.md](AGENT-STARTUP-PROMPT-REVIEW-2026-11-12.md)，上一轮已提交为 `679b467d`）
范围：与上一轮相同——`standard`、`conductor` 基准 preset 的首轮 system prompt；不含行业角色 persona、PM、子 Agent、运行中追加指令。
实证环境：打包态 Corum.app（host 构建时间 `202611112345`，channel `local`，基座 `0.2.1-rc.3`）；仓库 HEAD `679b467d`，工作树干净。

## 结论（先回答用户报障）

**`You are an AI agent powered by DeepSeek Harness.` 来自官方基座 `@deepseek-ai/dsh-system-prompt` 构造时注册的全局段 `harness:identity`，开关 `includeHarnessIdentity` 默认 `true`，corum 全仓（源码 + 打包产物）从未关闭它。** 它不是 persona、不是 preset 行、不是 corum 注入——是 SystemPrompt 服务自带的第 0 段，排序 `-1000`，先于一切内容。上一轮审查只追了 persona 行与 corum root scope 注册，没有读 SystemPrompt 构造函数自身的注册，因此漏掉了它（以及同源的另外三处，见 N2–N4）。

本轮共 4 个新发现（N1–N4），上一轮 3 个发现（P0/P1×2/P2）复核**全部未变**。全部为源码 + 打包产物 + 本会话运行时三方对证；standard/conductor 两 preset 的逐字运行时快照仍未取得（见 §6）。

## 1. 新发现

### N1（P1，用户本次报障主体）：官方 `harness:identity` 段从未被关闭

- 来源：`node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js:228-232`（打包产物同版本同行为）：

  ```js
  if (config.includeHarnessIdentity ?? true) this.section({
      name: "harness:identity",
      order: this.getSectionOrder("HARNESS_IDENTITY"),   // = -1000，全 prompt 最前
      text: "You are an AI agent powered by DeepSeek Harness."
  });
  ```

- Config schema 只有 `includeHarnessIdentity / includeRuntimeContext / personaPrefix / personaSuffix / toolOrder` 五个字段。
- corum 侧 `grep includeHarnessIdentity|harness:identity` 于 `packages/`（含全部 yml patch）与打包产物 `@corum/*` lib：**0 命中**。`cordis.patch.yml` 的 `system-prompt` 行（:277）没有设这个开关。
- 影响面：**除 minimal 外所有模式**（standard / conductor / ptc / cordis / 全部 corum 自建角色）。minimal 因 persona `complete: true` 触发「只渲染 complete 段」（`dsh-system-prompt/lib/index.js:381-405`），是唯一不含此段的形态。
- 运行时实证：本审查会话（corum-dev 角色，standard 基座，打包态主实例）的首轮 system prompt 第一句即该文案。全局段栈对 standard/conductor 完全相同（host 组合层），persona 差异不影响本发现。
- 与 2026-11-11 裁决的关系：`packages/desktop/src/index.ts:47-51` 注释记录了用户当日报障「一会说 DeepSeek Harness、一会又是 CodeBuddy」，裁决为「基座 = DeepSeek Harness，载具 = Corum」——那次修的是桌面壳自己的旧名字字面量，**没有裁决官方身份段的去留**。本次用户口径（「目前居然还会有」）表明该段的存在出乎预期，去留需用户拍板（§5 D1）。

### N2（P2）：`cordis.patch.yml` 的 `config.persona` 是死配置

- `packages/desktop/cordis.patch.yml:277-280`（打包产物同款）：

  ```yaml
  - id: system-prompt
    config:
      persona: >-
        You are a coding agent powered by the {{model}} model.
  ```

- 实测（node 直接调 `SystemPrompt.Config` 解析 `{persona:'X', includeHarnessIdentity:false, personaPrefix:'P'}`）：schemastery **保留**未知键 `persona`，但构造函数**从不读它**——部署级 persona 前缀实际是默认空串 `""`。注释「── desktop persona ──」名不副实。
- 真实身份来源是各 preset 的 `dsh-persona` 行（`presets.patch.yml:33-36` standard / :194-197 conductor，prefix 同为 coding-agent 模板），它 shadow 的是 `deployment:persona-prefix`（order 0），与 `harness:identity` 是**两个不同的段**，互不覆盖。
- 定性：基座升级漂移（旧版字段名残留）。无行为危害，但误导后续审查——上一轮文档 §1 把 persona 当成首段，部分原因即在此。

### N3（P1）：官方 `app:web-surface` 与 corum `app:desktop-surface` 互相矛盾，且向产品注入 DSH 开发工作流指引

- corum 桌面壳注册（`packages/desktop/src/index.ts:57-61`，order -98）：
  「You are interacting with the user through the Corum desktop application. The application is a native window; **there is no browser tab and no URL to reload**.」
- 官方 `@deepseek-ai/dsh-harness-dev-context`（由 `dsh-web-app/cordis.patch.yml:211-212` 的 insert 行挂载，行 id `harness-dev-context`）注册 `app:web-surface`（order 10100）：
  「You are interacting with the user through the **DeepSeek Harness Web GUI whose URL the runtime context names** … verify this existing URL after a page refresh … `pnpm run dev:web` … apps/web Vite entry … `window.__DSH_BOOT__` …」
  以及 runtime context（order 210）：`Current DeepSeek Harness Web GUI URL: "http://127.0.0.1:<port>"`。
- 两段**同时**出现在本会话首轮 prompt（运行时实证）。「没有 URL 可刷新」与「刷新这个 URL 验证」直接冲突；`dev:web` / `apps/web` / `__DSH_BOOT__` 是 DSH 源码开发工作流，对打包桌面产品是错误指引。
- corum 侧无任何代码消费该插件的投影（`harnessDevLegacyPrompt`）或 `getAdvertisedUrl`（全仓 grep 0 命中）⇒ 禁用无依赖牵连。
- 修法方向：在 `cordis.patch.yml` 以 `id: harness-dev-context` + `disabled: true` 压制（与 sandbox / goal-round-driver 同款手法；注意红线——disabled 行不得被任何调用方 filter）。该手法对 base bundle insert 行已验证，对 web-app bundle patch 行的压制**实施时需实机验证一次**。

### N4（P2）：harness-source 三重注入、两个不同路径

同一事实（基座 checkout 位置）被注入三次：

| 注册者 | 段/上下文名 | order | 内容 |
|---|---|---|---|
| corum 桌面壳 `index.ts:52-56` | `harness-source` | -99 | 旧式整段：「The DeepSeek Harness implementation checkout is at **/Applications/Corum.app/Contents/**. …」 |
| 官方 harness-dev-context | `harness:source` 段 | 10000 | 新式无路径指引：「The runtime context names the … checkout …」 |
| 官方 harness-dev-context | `harness:source` context | 200 | 「Current DeepSeek Harness implementation checkout: **/Applications/Corum.app/Contents/Resources/host/**」 |

- 两个路径不同（壳从自身位置算 `../../..`，官方包从包位置算 `../../../..`），模型收到两份「事实」。
- 额外耦合：corum 壳的旧式整段恰好命中官方包的 LEGACY_SOURCE 前后缀模式（`dsh-harness-dev-context/lib/index.js` LEGACY_SOURCE），会被其 `harnessDevLegacyPrompt` 投影当作「会话已承认的旧段」逐字保留——corum 文案与官方冻结文本形成隐式契约，官方改冻结文本即断裂。
- N3 禁用后官方两处消失；corum 壳的 -99 段是否保留/改新式，随 D2 一并裁决。

## 2. 完整装配图（standard，打包态 0.2.1-rc.3，按 order 排序）

首轮 system prompt = 下列**非空段**按 order 排序、`\n\n` 连接（`renderPrompt`，严格 `{{var}}` 插值）；另加 runtime context 快照与工具 schema。AGENTS.md 与 skills catalog 走 system-reminder 注入（上一轮 §1 已述，不变）。

| order | 段名 | 注册者 | 备注 |
|---|---|---|---|
| -1000 | `harness:identity` | 官方 SystemPrompt 构造 | **N1**；默认开，从未关 |
| -99 | `harness-source` | corum 桌面壳 | **N4** 旧式整段 |
| -98 | `app:desktop-surface` | corum 桌面壳 | 「原生窗口、无 URL」 |
| 0 | `deployment:persona-prefix` | preset `dsh-persona` 行 shadow 全局 | standard = coding-agent 模板；全局默认空（**N2**） |
| 5 | `corum:host-identity` | corum-agent root scope（agent-service.ts:801） | 上一轮 P1 冲突仍在 |
| 6 | `corum:output-language` | corum-agent root scope（:831） | 上一轮 P2 仍在 |
| 500 | plan-mode 段 | dsh-plan-mode | 仅 plan 模式激活时非空 |
| 900 | file-reference | dsh-file-reference-local | |
| 950 | `corum:tool-policy` | corum-agent root scope（:751） | conductor 置空 |
| 1000 | `tool:bash` | dsh-tool-bash | win32 换 `tool:pwsh`(1010) |
| 1001 | `corum:execution-discipline` | corum-agent root scope（:765） | |
| 1002 | `corum:todo-discipline` | corum-agent root scope（:785） | |
| 1100/1200/1300 | `tool:read`/`tool:write`/`tool:edit` | dsh-tool-fs | conductor 置空 write/edit |
| 1400/1500 | `tool:glob`/`tool:grep` | dsh-tool-fs-search | |
| 1600 | `tool:jobs` | dsh-tool-jobs | |
| 2000/2100 | `tool:web-search`/`tool:web-fetch` | dsh-tool-web | |
| 2400 | `tool:goal` | dsh-tool-goal | |
| 2700 | `tool:ralph` | dsh-tool-ralph | standard 挂载 |
| 2800 档 | corum 编排机制段 | corum-tool-subagent | 三实例（subagent/research/fork） |
| 3100 | MCP_SERVERS | dsh-mcp-client | 按 profile 授权 |
| 5000 | TOOLS_SDK | SDK 工具 | |
| 9000 | deliverable-file-references | dsh-client-ui-deliverables | present 工具配套 |
| 10000 | `harness:source` | 官方 harness-dev-context | **N3/N4** |
| 10100 | `app:web-surface` | 官方 harness-dev-context | **N3** 与 -98 矛盾 |
| 10200 | `deployment:persona-suffix` | preset `dsh-persona` suffix | standard 为空 |

Runtime context（order）：working-directory(100)、sandbox-policy(110)、approval-policy(115)、subagent-delegation(120)、`harness:source`(200，**N4**)、`app:web-surface`(210，**N3**)。

**conductor = 上表 + agent scope 四个运行时改变**（conductor-runtime.ts:93-151，复核与上一轮 §3 一致）：
1. `corum:conductor`（order 1）= CONDUCTOR_PERSONA（conductor.ts:96，全文未变）；
2. `corum:tool-policy` 置空；
3. `tool:write`/`tool:edit` 置空 + `tools.restrict` deny `write/edit/str_replace_editor/pwsh(win32)`；
4. `tools.guard(conductorMainReadonlyGuard())`。
**conductor 不触及任何身份/表面段**——N1–N4 对指挥模式同样成立。

## 3. 上一轮发现复核（全部未变）

- **P0（指挥模式「Every write is refused」为假）**：persona 原文未变（conductor.ts:102）；门禁仍是 `detectBashWrite` 启发式（permission-policy.ts:185 → confinement.ts:395，自述「宁可漏判也不误伤」），`pnpm run build` / `make` / 自定义脚本仍不在列举形态。**增量**：issue #194 给 guard 加了写工具名兜底（permission-policy.ts:160-178，与注册时机无关），堵了「restrict 收敛成空集」的洞，但 bash 启发式缺口与 MCP 缺口（下条）不变。
- **P1（host-identity verify 重启规则冲突）**：host-identity.ts:59（`you may restart it freely`）与 :70（`Never restart or kill the instance hosting this session`）原样并存。
- **P1（MCP 写工具绕过「No write tools」）**：guard 对非 bash、非四个写工具名一律 `return undefined`（permission-policy.ts:179），MCP 副作用工具不设防，未变。
- **P2（output-language「latest message」无机器判据）**：output-language.ts:113 原样，未变。

## 4. 对上一轮文档的更正

上一轮 §1 把「基础 persona」列为首轮第 1 项。实际首轮最前是 `harness:identity`（-1000），随后是 corum 壳的 `harness-source`（-99）与 `app:desktop-surface`（-98），persona 前缀排第 4（order 0）。上一轮 §1 的「共同进入内容」清单应补入本文 §2 表中 N1–N4 四行。其余结论（组装关系、conductor 四改变、P0/P1/P2）经复核维持。

## 5. 待用户拍板的产品决策

- **D1（N1）**：官方身份段去留。选项：
  a) `cordis.patch.yml` 的 `system-prompt` 行 config 改为 `includeHarnessIdentity: false`（顺带清掉 N2 死键）——官方身份句消失，身份由 preset persona + 桌面壳表面段承担；
  b) 关闭后另注册 corum 品牌身份段（需定文案）；
  c) 保留（若 2026-11-11「基座 = DeepSeek Harness」裁决意图包含此句，则本文 N1 改记为「有意保留」）。
- **D2（N3/N4）**：是否在桌面组合禁用 `harness-dev-context` 行（消除 web-surface 矛盾 + 开发指引 + 重复 source）；corum 壳 -99 旧式段是否同步改为新式无路径文案。
- **D3（P0，上一轮遗留）**：指挥模式承诺降级为「已知写形态会被拒绝」，或上文件系统层不可覆盖只读边界。与本次新发现独立，仍待裁决。

以上均为 host 组合/插件改动 ⇒ 实施后需重打包 + 重启 + 实机三层验证（打包态主实例由用户决定重启时机）。

## 6. 证据清单与未验证项

**已实测**：
- 官方段注册与开关默认值：打包产物 `dsh-system-prompt/lib/index.js:214-243`（逐字读取）；
- `persona` 死键：node 直调 `SystemPrompt.Config` 解析，未知键保留但构造函数无消费（§1 N2）；
- corum 从未处理开关/投影/URL：`packages/` 与打包 `@corum/*` 全量 grep 0 命中；
- 全量注册点枚举：打包产物 `@deepseek-ai/*` 29 处 section + 8 处 context、`@corum/*` 11 处 section（§2 表即由此建成）；
- 运行时实证：本审查会话（打包态主实例、corum-dev 角色）首轮 prompt 同时含 N1 身份句、-99/-98 两段、10000/10100 两段与两条 runtime context——全局段栈与 §2 表逐一对应。

**未取得（如实标注）**：
- standard / conductor 两基准 preset 的**逐字**首轮快照：`cdp_list_targets` 返回空（无运行中 verify 实例），本轮未新起实例。上一轮 §5 的失败原因（`~/.corum-rc3/.../launcher.mjs` 缺失）本轮未复测。全局段栈结论不受影响（host 组合层与 preset 无关，且有本会话实证）；persona 行文本取自打包产物 `presets.patch.yml:33-36/:194-197` 逐字读取。
- N3 修法（disabled 行压制 web-app bundle patch 行）的实机有效性：实施时验证。

**方法论事故（本轮已纠正）**：本 shell PATH 仅 `/usr/bin:/bin:/usr/sbin:/sbin`，`rg` 与 `node` 均不在 PATH——前几轮 `rg … 2>/dev/null` 静默空结果险些造成「全仓不存在该文案」的误判。纠正：系统 `grep` + 绝对路径 node（`/opt/homebrew/bin/node`）。教训另记 `docs/LESSONS.md`。

## 7. 实施记录（同日续：用户已裁决 D1/D2，D3 本轮不动）

### 7.1 改动（唯一源码改动点：`packages/desktop/cordis.patch.yml`）

1. `system-prompt` 行 config 由死键 `persona` 替换为 `includeHarnessIdentity: false`（N1+N2 一并收口；patch 替换目标行整个 config，死键随之清除）。
2. 新增 `- id: harness-dev-context / disabled: true` 覆盖行（N3+N4），压制 `dsh-web-app` bundle patch 的 insert 行。层序依据：`boot.ts:626` `composeEntries([bundlePatches, profile, home, overlayRows, …])`——overlay 在 bundle 之后，与 `sandbox`/`goal-round-driver` 同款手法；disabled 行未被任何调用方 filter（红线 5）。

### 7.2 实机验证（:9333 验证实例，home=`~/.corum-rc3`，dev 态，未触碰主实例）

- 实例：`corum-instance.sh start --home=verify --allow-sandboxed`（沙箱内断言模式；`env -u CORUM_HOME -u DSH_HOME` 防主 home 劫持；PATH 补 `/opt/homebrew/bin`）。
- 场景：standard 走官方 `session/create`（无运行时覆盖需求）；**conductor 必须走 `corumAgent/createTaskAgent`**（ConductorRuntime.apply 只在 corum 泳道流程注册，见 N5）。各发一条最小 prompt，首轮组装后从会话日志（`session.v4.jsonl.zstd` 的 `system/message` / `request/context` 事件）提取逐字 prompt。
- 断言：**37/37 PASS**（`docs/analysis/prompt-review-2026-11-12b/extract-and-assert.mjs`，报告 `assertion-report.json`，逐字 prompt `standard/conductor-first-turn-prompt.txt`）。覆盖：N1 身份句消失 / N3 web-surface 与 dev:web 指引与 URL context 消失 / N4 checkout 只注入一次 / 应有段全在（桌面表面段、壳 harness-source、host-identity、输出语言、执行纪律）/ standard persona 与 write/edit 段在 / conductor 人格段在且紧跟基础身份、tool-policy 与 tool:write/tool:edit 段已清空 / 两回合正常收口。
- console 错误：验证窗口内 renderer `console.error` 收集为 **[]**；宿主日志 3 条 error 均与本改动无关（1 条 macOS sandbox 噪音 + 2 条 dev home 缺 `corum-test-suite-*-dev` 扩展包的既有环境问题）。截图：`docs/analysis/prompt-review-2026-11-12b/shots/verify-9333-after-fix.png`。
- 守卫：`node --test packages/desktop/tests/desktop-overlays.test.mjs` **10/10 pass**（含「固定层 disabled 行不被过滤」「config 覆盖行一条不丢」）。未跑 fork-drift（本次未改 fork 包/事件声明）；`assert:boot` 随重打包执行（见 7.4）。

### 7.3 新观察 N5（P2，本轮不修，登记待办）

官方 `session/create` + `agentPreset:'conductor'` 建出的会话**拿不到 ConductorRuntime 覆盖**（无人格段、无工具裁剪、无只读门禁）——实测复现（会话 `session-916ab73e`）。corum IDE UI 的建会话入口只有 `corumAgent/createTaskAgent` / `selectTaskAgentProfile` / `forkTaskAgent`（`corum-ide-sidebar-ui/src/client/index.ts:197`），用户路径不经过官方 create；但 host 的官方 RPC 面仍然暴露该入口。定性：指挥模式的保证**绑定创建路径**，属纵深防御缺口而非用户可达缺陷。另：本轮断言脚本曾有一处 `indexOf(-1)` 假阳性（已修）——负向断言必须带存在性前提。

### 7.4 生效条件与交付产物

改动在 host 组合层 ⇒ **打包态主实例需重打包 + 重启才生效**（重启时机由用户定）。dev/verify 态重启即生效（本轮已验）。

重打包已完成（提交 `5b11ddeb`，pack.mjs darwin 四步全绿；前两次失败已诊断：pnpm 无 TTY → `CI=true`；文件沙箱拦 hdiutil APFS 创建 → 沙箱外重跑，见 LESSONS §4.60）：

- **DMG**：`packages/desktop/dist/Corum-0.8.0-arm64-local-202611121431.dmg`（584M）
  SHA-256 `0ee6a1642f38d6be800bce8d24bcbc9cfaf0a40ee7c65e30b83cf1210804bd43`
- **zip**：`Corum-0.8.0-arm64-mac-local-202611121431.zip`（573M）
  SHA-256 `7d02f82e2d052b9b22174c2bfd2d5dd009bd3d73169169de90cebff85c20ce1f`
- **`pnpm assert:boot` 通过**：产物自带 Node 跑产物 host 桥，ready 发出。
- 产物内 `build/host/cordis.patch.yml` 逐字核对：两处改动均在。
- 如实标注：local 通道**未签名**（本机自用，非发布资产）；electron-pin 二进制身份校验跳过（electron 包缺 `path.txt`，版本声明/override/lockfile 三者一致）。