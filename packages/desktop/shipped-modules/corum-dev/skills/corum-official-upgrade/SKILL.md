---
name: corum-official-upgrade
description: Use when upgrading this repo (corum Agent OS / kkc-desktop) to a newer official dsh release, or when resyncing the fork packages after such a bump — picking a target version that actually exists on the registry, the per-package upgrade loop (declaration + root override together, install, compile, commit), the fork-resync merge手法 (official base + paste back corum deltas), the fork-counterpart override rules, and the guard/environment traps that have already cost this project time.
---

# corum 官方基座升级（升级技能）

本技能是**升级**这件事的可执行投影。规则的家仍是 `docs/dev-conventions.md`，
逐包台账是 `docs/fork-delta.md`（18 个 fork 包 + §5 runbook），
**本次（0.1.3-alpha.1 → 0.1.5-rc.3）的逐步实录与全部坑**在 `docs/UPGRADE-0.1.5-rc3.md`（活文档，边做边追加）。
两者冲突时以文档为准，并回来修本技能。

## 0. 一句话

**先确认目标版本在 registry 上"整套装齐"，再一个一个升；每个包"包声明 + 根 override"必须同时改，
改完立刻装 + 编译 + 提交；fork 包用"官方为底 + 贴回 corum 增量"，并把增量逐 marker 对齐验证。**

## 1. 升级前必须做的三件事（不做会白干）

1. **确认目标版本完整性**（最容易翻车的一步）：
   官方 `0.1.7-rc.2` 的**源码**标签存在，但 npm 上**缺 5 个包**（`dsh-agent-presets` /
   `dsh-code-runtime` / `dsh-code-runtime-worker-thread` / `dsh-settings-file` /
   `dsh-workflow-worker-thread`）⇒ `overrides` 全量切过去**装不上**。
   **判据**：把 `pnpm-workspace.yaml` 里被钉的每个包名逐个问 registry「有没有该版本」，
   统计覆盖率；**只有 100% 覆盖的版本才能当目标**。实测：`0.1.5-alpha.1→rc.3` 全部覆盖 189/189 ✓，
   `0.1.7-rc.2` 只覆盖 185/190 ✗。
2. **确认基线标签**：官方包**随 npm 只发 `lib/`**（**没有 `src/`**）⇒ 逐字节比对与合并的基线
   **只能取自 dsh 检出的标签**（`git -C /Users/kukucai/dsh archive <tag> <path>`），
   **不能用检出工作区**（HEAD 会前进，实测已到 0.1.7-rc.2）。
3. **停掉所有实例**：改 override 会**重建整个 `node_modules`** ⇒ 必须先停 9333 + 9222
   （`./scripts/corum-instance.sh stop --home=verify` + 打包实例）。

## 2. 每条命令的准确形态（照抄，别凭记忆）

```bash
# 安装：**必须全工作区**，且无 TTY 时必须 CI=true，改过 override 必须 --no-frozen-lockfile
CI=true pnpm install --no-frozen-lockfile

# 校验
pnpm --filter @corum/<pkg> run typecheck     # 单包
pnpm -r typecheck                            # 全仓（这一步不能省）
pnpm -r build                                # ⚠️ build 才会暴露"缺导出"类问题（tsc 发现不了）

# fork 守卫（**必须带基线标签**，否则拿 HEAD 当基线长期假红）
DSH_CHECKOUT=/Users/kukucai/dsh DSH_BASELINE_TAG=dsh-v0.1.5-rc.3 ./scripts/verify-fork-drift.sh
```

**已付学费的四个命令级坑**：

| 坑 | 现象 | 正确做法 |
|---|---|---|
| `pnpm install --filter <pkg>` | 把工作区依赖**裁到子集**（实测 `.pnpm` 里 dsh 包 **246 → 2**），全仓 typecheck 立刻挂 | **永远不带 `--filter`** |
| 无 TTY 跑 install | `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` | `CI=true` |
| 改过 override 跑 install | `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` | `--no-frozen-lockfile` |
| `timeout` 命令 | macOS 无此命令 | 用后台 job 或脚本内轮询 |

## 3. 逐包升级循环（未 fork 包）

**每个包三步，缺一不可**：

1. 改包 `package.json` 里对 `@deepseek-ai/dsh-*` 的版本 → 目标版；
2. **同时**改根 `pnpm-workspace.yaml` overrides 里的**同名条目** → 目标版
   （⚠️ 只改包声明**没用**：override 会把它顶回旧版，实测确认）；
3. `CI=true pnpm install --no-frozen-lockfile` → 单包 typecheck → 全仓 typecheck → 提交。

**升级顺序**：按官方依赖数升序（依赖面小的先做，爆炸半径小）。

### ⚠️ 部分升级期唯一必须记住的规则：`^` 范围会静默带走未升级的包

实测白屏事故：`corum-ide-sidebar-ui` 声明 `^0.1.3-alpha.1`，我只升了**别的**包 ⇒ lockfile 重解析
把它依赖的 `ui-primitives` 带到 0.1.5 ⇒ 新版的 `require("anser")` 进了 bundle，而宿主模块表没有 ⇒
**白屏**（`Failed to load plugins` + `missed the module table`）。

**规则**：只要有包未升级，**被未升包共享的官方依赖就不能单独跳版**。
**修法**：把该官方依赖钉回旧版（`ui-primitives` 锁回 `0.1.3-alpha.1`），等它所有消费者都升完再一起升。

## 4. fork 批次（三方合并）

### 4.0 升级决策流程（**用户口径，2026-09-28 定，优先级高于本技能其余部分**）

对**每个已 fork 的包**，先做**业务逻辑判断**，再决定策略 —— **不默认"合并"**：

1. **搞清楚我们 fork 新增了什么；新版本是否已经 cover** —— 若官方新版已覆盖该能力 ⇒
   **无需再 fork，直接用官方**（删掉我们的增量，改回官方包）。
2. **若我们 fork 是为了自己的新增业务** ⇒ 检查**官方增量是否与我们的业务冲突**。
   有冲突时，进一步判断**官方增量是什么性质**（新增功能 / 重构 / 修 bug / 改名），
   **报告给用户，由用户判断如何处理**（不要自行拍板）。
3. **原则上不做强行合并** —— 以**参考借鉴官方、维护我们 fork 的包**为主。
   （即：我们的包继续存在并演进；官方的新实现作为参考，按需吸收，而不是把两边强行缝在一起。）

> **报告格式**（对每个 fork 包给用户看的）：① 我们的增量清单（按业务目的分组，标文件与行）·
> ② 官方新版是否已覆盖其中哪些（是/否 + 证据）· ③ 官方增量与我们的冲突点（逐个列，标性质）·
> ④ 建议（用官方 / 保 fork / 需要你裁决的具体问题）。
>
> ⚠️ 与下文 4.1「官方为底 + 贴回增量」的关系：4.1 只是**机制**（怎么把代码安全地搬过来），
> **是否该搬由 4.0 决定**。4.0 判定"官方已覆盖" ⇒ 直接采用官方；判定"我们的业务" ⇒ 以维护 fork 为主。

### 4.0.1 **协作方式（用户口径，2026-09-28 定）—— 主会话只做决策与验收**

> 用户原话：「接下来你每次指派两个子 Agent 进行 doublecheck，你负责报告最终的结果让我决策，
> 然后你指派子 Agent 进行升级后你来做 check。…… 升级占用太多上下文，而且每个包关注点不同，
> 最好是单独指派子 Agent，保持主会话注意力始终在任务主线上。子 Agent 只关注当前升级的包。」

**分工（每个包一轮，禁止主会话自己啃包）**：

| 角色 | 谁 | 做什么 | 不做什么 |
|---|---|---|---|
| **探索 ×2** | 两个子 Agent（**独立并行、互不可见**）| 各自对**同一个包**出「业务逻辑判断报告」（§4.0 的四要素）| 不改任何代码 |
| **决策** | **用户** | 依据两份报告的**分歧与共识**裁决策略 | — |
| **升级** | 一个子 Agent | 按裁决只处理**当前这一个包** | 不碰别的包 |
| **验收** | **主会话**（我）| 独立 check：编译 + 守卫 + 逐文件核对增量 + 报告 | 不亲自啃包 |

**为什么两个子 Agent**：doublecheck —— 两份独立报告**相互印证**；**分歧点**才是值钱的地方（往往正是
"该报给用户裁决"的点）。主会话只呈现「共识 / 分歧 / 需裁决」，不替用户拍板。

**⚠️ 两个子 Agent 必须用「不同的模型」**（用户口径 2026-09-28：「子代理可跑不同的模型，这样效果更好」）——
同一模型跑两遍只会得到**相关的错误**（同一盲区），而不同模型的知识面/推理习惯不同 ⇒ 才可能真正互相证伪。

**本机可用路由**（`local` provider）与分工建议：

| 路由 | 适合角色 | 理由 |
|---|---|---|
| `local/glm-5.3` | **分析员 A（探索）** | 长上下文、擅长通读全包与代码考古 |
| `local/kimi-k3-1` | **分析员 B（证伪）** | 换模型家族 ⇒ 盲区不同；可要求它**专找 A 的反例** |
| `local/glm-5.2` | 升级执行 Agent | 指令跟随稳、改代码收敛 |
| `local/glm-5.3-flash` | 机械性汇总/格式整理（省时） | 快、便宜，适合不需要深度判断的活 |
| `local/deepseek-v4.1-flash` | 备用 | — |

派活时用参数显式指定（子 Agent 不会自动换模型）：
`subagent(provider: "local", model: "glm-5.3", …)` 与 `subagent(provider: "local", model: "kimi-k3-1", …)`。

**可选加强**：让 B 在拿到 A 的报告后**专门做证伪**（"请找出 A 结论中的错误"）——
两阶段（先独立、后证伪）比纯并行更容易暴露分歧；代价是慢一轮。

**报告模板（两个分析员用同一模板 ⇒ 主会话才能并排比对）**：

```markdown
## <包名> 升级判断报告（分析员 A/B）
### 1. 我们 fork 了什么（按业务目的分组）
| 业务目的 | 文件 | 行数量级 | 证据（注释/commit）|
### 2. 官方新版是否已覆盖
| 我们的增量 | 官方 0.1.5 是否已有 | 证据（官方文件+行）| 结论 |
### 3. 官方增量与本包的冲突
| 官方改了什么 | 性质（新增功能/重构/修bug/改名/无关）| 与我们的业务冲突？|
### 4. 建议 + 需用户裁决的问题
- 建议：use-official / keep-fork / need-user-decision
- 需裁决：<逐个列，一个都不能含糊>
### 5. 关键命令（可复现）
```
**主会话汇总时只报三样**：① **共识**（两份都同意的结论）· ② **分歧**（两份不一致处 —— 最值钱）·
③ **需你裁决的问题**（合并去重）。**不替用户拍板**。

**⚠️ 派活前必须先读台账对该包的定性**（本场实测教训，2026-09-28）：

**症状**：我给 `corum-agent` 的任务书照抄了通用模板「官方对照包 `@deepseek-ai/dsh-agent` + 逐文件递归比对」✗，
**但台账 §8 开头早就写着**「corum-agent **非对照官方单一包的 fork（无同名官方包）**，以下三处是对**官方机制**
（`dsh-agent-instructions` / `dsh-skill-filesystem` / `dsh-agent-presets`）的**组合修正**」✓。
更糟的是我连**官方路径都写错了**（写 `packages/agent/agent`，真实是 **`packages/core/agent`**）✗。

**后果**：子 Agent 若照做，会在一堆"零同名文件"上得出"这个包整个都是我们的增量"的荒谬结论 ✗；
实际官方该包**只有 8 个文件**，而 corum-agent 是 **46 文件 / 10604 行**的自研包。

**纪律（派每个 fork 包前必做）**：
1. **先读 `docs/fork-delta.md` 对应章节的第一句** —— 台账对每个包都写了定性
   （是"逐文件 fork"还是"**对官方机制的组合修正**"、baseline、风险等级）；
2. **确认官方包的路径与文件数**（用 `git ls-tree` 找 `name` 匹配的 `package.json`，**别凭印象写路径**）；
3. **若"同名交集"很小或为 0** ⇒ 该包**没有"逐文件合并"这回事** ✗ ⇒ 比对目标改成
   「**官方相关包 0.1.x→0.1.y 的 API 面变化**」+「**我们依赖这些 API 的地方是否要跟着改**」。
4. **反过来也成立**：一个包即使名字像 fork，也要先核"同名文件数"再决定用哪种比对方法。

**子 Agent 的任务书必须自包含**（它看不到本会话）——至少给全：
① 包名 + 仓库目录 + 官方对照包名 + 官方检出路径（`/Users/kukucai/dsh`）；
② **基线标签**（`git -C /Users/kukucai/dsh tag` 里选与工作区一致的那个；当前 = `dsh-v0.1.5-rc.3`）；
③ 官方 `src/` **只能**用 `git archive <tag> <path>` 取（官方包只发 `lib/`）；
④ **环境陷阱**：判差异用 `cmp`，**不要用 `diff`**（本机 PATH 上的 `diff` 是 HarmonyOS SDK 的，会静默漏报）；人读用 `/usr/bin/diff`；`sort`/`comm` 统一 `LC_ALL=C`；
⑤ **必须逐文件递归比对整包 `src/`**（含子目录，别只挑"看起来相关"的文件）；
⑥ 产出格式（§4.0 四要素 + 证据命令 + 需要裁决的问题清单）；
⑦ **明确禁止**：不许改代码、不许改 `pnpm-workspace.yaml`、不许 install。

**验收（主会话）的固定动作**（第 3 步已脚本化，一条命令）：

```bash
# ① 逐文件双向核对：官方行零缺失 ∧ 我们的增量全在（**不要靠眼睛**）
./scripts/check-fork-increments.sh <corum 包目录> <官方检出内路径> <标签>
#    ✓ 通过 = 退出码 0 且输出「✅ 官方行零缺失」
#    ✗ 输出「🔴 官方行/文件缺失」= 子 Agent 漏合了官方增量，必须补
./scripts/check-fork-increments.sh --list        # 18 个 fork 包 ↔ 官方路径

# ② 编译（单包 + 全仓，全仓这步不能省）
pnpm --filter @corum/<pkg> run typecheck && pnpm -r typecheck

# ③ 行为面守卫（**必须带基线标签**，否则拿检出 HEAD 当基线会长期假红）
DSH_CHECKOUT=/Users/kukucai/dsh DSH_BASELINE_TAG=<tag> ./scripts/verify-fork-drift.sh
```

之后：更新 `docs/UPGRADE-0.1.5-rc3.md` 与台账 + 提交。

> **该方法已被反向验证**：拿 `corum-api-remotes` **修复前**的状态跑 `check-fork-increments.sh`，
> 精确报出 **11 行官方缺失**（正是当时漏掉的那批）⇒ 脚本确实能拦住"子 Agent 漏合"。

### 4.0.2 **UI 类 fork：不合并，只升依赖**（用户口径，2026-09-28，优先级最高）

> 用户原话：「如果是 UI 我需要指明，我们不能直接合并升级，后续**界面属于单独维护**，**只看依赖包升级**。
> 至于官方更新了什么，我们只需要**了解并决策是否是好的产品设计**，如果是我们就**吸纳并按照我们自己的
> 视觉风格进行设计和融合**，即**借鉴而不是合并**。」

**规则（UI 类 fork 一律照此）**：

1. **界面 = 单独维护** ⇒ UI 包升级**只有一件事**：把 `@deepseek-ai/dsh-*` 依赖升到目标版；
   **官方 `src/client/**` 的代码一概不合并**（不"官方为底 + 贴回"）。
2. **官方 UI 改动 = 产品设计素材**，不是待合并的代码：读懂它 → 判断**是否是好设计** → 若好，
   **按我们自己的视觉风格重新设计并融合**（借鉴），**不照搬代码**。
3. ⇒ UI 包的升级**不需要** `check-fork-increments.sh` 的「官方行零缺失」验收（那条只适用于**逻辑类**）。
   UI 包验收 = `typecheck` + 全仓 `typecheck` +（依赖 API 有变时）适配编译错误 + 实机确认界面未回归。
4. **边界（重要）**：UI fork 里**非视觉面**仍按逻辑面处理 —— `src/index.ts`（node 半 / host 装配）
   与纯类型文件（`css-modules.d.ts` 等）**可以**跟官方对齐；**`src/client/**` 的视觉与交互代码不合并**。

**18 个 fork 的分类（升级方式由此决定）**：

| 类别 | 包 | 升级方式 |
|---|---|---|
| **UI 类（8）** | `corum-ui-conversation` / `corum-ui-chat` / `corum-ui-approval` / `corum-ui-questions` / `corum-ui-model-selection` / `corum-ui-settings-models` / `corum-ui-settings-plugins` / `corum-ui-trajectory` | **只升依赖**；官方 UI 改动进「借鉴清单」（产品设计决策）|
| **逻辑类（10）** | `corum-agent` / `corum-api-remotes` / `corum-credentials-local` / `corum-fs-local` / `corum-goal-round-driver` / `corum-sandbox-local` / `corum-subagent` / `corum-tool-subagent` / `corum-tools` / `corum-session-queue-revert` | 按 §4.0 业务判断 → 借鉴 / 必要时合并 |

> **推论（省掉大量工作）**：剩余 fork 里的 6 个 UI 大包（`ui-chat` 2589 / `ui-settings-models` 2582 /
> `ui-conversation` 4647 / `ui-approval` 516 / `ui-model-selection` 538 / `ui-trajectory` 935 行差异）
> **不再需要逐 hunk 合并** ⇒ 升级动作退化为「改依赖版本 + 编译」✓。
> 「官方 UI 更好」的项进**借鉴清单**，由用户决定是否按我们风格重做（不阻塞升级）。

### 4.1 手法（本场定型）：官方为底 + 贴回 corum 增量

不要"在 corum 文件上补官方改动"（容易漏官方新功能）；要**以官方目标版文件为底**，
再把 corum 增量**逐处贴回**。这样自动获得官方全部新功能，corum 增量也能逐 marker 对齐验证。

**动手顺序**（前两步能省掉大量瞎猜）：

1. **先对齐"函数清单"**，不要先看 diff 片段：
   ```bash
   grep -nE "^(export )?(async )?function |^export const [a-zA-Z]+ = " <官方文件>
   grep -nE "^(export )?(async )?function |^export const [a-zA-Z]+ = " <corum 文件>
   ```
   实测教训：我曾以为 corum 是"就地改写官方那几行"✗，按 `record.key`/`record.env` 做锚点直接失败
   —— 对齐函数清单才发现 corum 是**新增了一个独立函数**（`encryptRecordSecrets`）✓。
2. **看 corum 侧的 `fork（corum）` / `CORUM-PATCH` 标记注释**（作者留下的意图就是增量清单）。
3. 逐处贴回，**贴完立刻逐 marker 计数比对**（`grep -c` 与备份对照），确认一处不漏：
   ```bash
   for pat in <marker1> <marker2>; do
     printf '%-24s %s\n' "$pat" "$(grep -c "$pat" <新文件>)"
   done
   # 与原 corum 备份对照：corumGitWriteRoots=5 existsSync=2 bind-try=2
   ```
4. 用脚本做替换时，**断言写在写盘之前**（`assert count == 1`）——
   失败时文件不会被写坏，可安全重试（本场靠这点省了多次回滚）。
5. **正则要按实际形态写**：本场两次因正则不符失败（多行 vs 单行、括号未转义）。
   先用 `grep -n` 打印**官方原文**，再写锚点。

### 4.2 三类 fork 的判别与升法（4.0 的判定结论落到这里）

| 类型 | 判别 | 升法 | 实例 |
|---|---|---|---|
| **落后型** | 差异只是"官方后来改了/改名了" | 直接采用官方（corum 无增量） | `api-remotes`（14 行，0.1.3 时代的拷贝）|
| **挂点型** | corum 在官方文件里插了少量 hook/调用 | 官方为底 + 贴回挂点 | `credentials-local`（7 处加解密）、`fs-local`（2 处文案）|
| **自研替换型** | 文件名全不同、渲染层整体重写 | **保 corum** + 只跟非渲染层面（`index.ts`/`locales`/`d.ts`）| `ui-questions`（台账已定性"无法逐文件合并"）|

> `ui-questions` 的实测：官方 `PlanReviewPanel.tsx`/`QuestionComposer.tsx`/`contract/slots.ts`/`draft-store.ts`
> 对应 corum 的 `PlanReviewCard.tsx`/`QuestionCard.tsx`/`contract.ts`/`index.tsx` —— **名字全不同**，
> 强行合并会丢掉自研渲染层。**先读 `docs/fork-delta.md` 对应章节**（台账对每个 fork 都有"rebase 风险"定性）。

### 4.3 官方改名/重命名：要跟，而且要跨包全跟

实测两类，**都必须跟随，并检查跨包消费方**：

- **包名重命名**：`@deepseek-ai/node-addon-landlock-run` → `node-addon-system`
  （0.1.5 起）⇒ 改 import + `package.json` + `tsdown.config.ts`（全仓 4 处）。
- **事件名重命名**：`tool/code-dispatch(-start)` → `tool/ptc-dispatch(-start)`
  ⇒ corum 侧 **3 个包 8 个文件**消费该名（`corum-tools` / `ui-chat` / `ui-trajectory`）⇒
  **必须同步改**，否则轨迹视图与工具卡**静默失效**（不报错，只是没数据）。
  **方法**：`grep -rln "<旧名>" packages --include=*.ts` 找全消费方（含注释）。

## 5. fork 顶替名的 override 处置（判据唯一）

**判据 = 这个官方名在本仓还有没有"非 fork 消费者"**：

```bash
grep -rl '"@deepseek-ai/dsh-<名>"' packages --include=package.json | grep -vE '/lib/|/build/|/dist/|node_modules'
```

| 情形 | 处置 | 实例 |
|---|---|---|
| A. 已被 `link:` 顶替 | **不动**（消费者自动用 fork） | `dsh-fs-local`、`dsh-tools` |
| B. 有非 fork 消费者 | **随消费者一起升** | `dsh-api-remotes`（`ui-chat`/`ui-approval`/… 消费）|
| C. **无任何**非 fork 消费者 | **保持旧版不动** | `dsh-sandbox-local`、`dsh-credentials-local` |

- C 的理由：该名在本仓**根本不会被解析**（corum 用自己的 fork 包）⇒ 升它只会把无用的官方包
  拉进打包闭包、增加混版面。实测这两名在仓库内**零**消费者，且 0.1.3 与 0.1.5 **导出符号完全一致**。
- **包对"自身官方对照名"的声明不构成消费者**（例：`ui-questions` 声明 `dsh-client-ui-user-questions`）
  —— 那是升级期解析残留，**不驱动 override 升级**。
- **fork 顶替名的实际分档（实测，2026-09-28）** —— 18 个 fork 包的官方对照名并不都在 override 里：

  | 分档 | 官方名 | 现状 |
  |---|---|---|
  | override 里钉着旧版（合并前**必须保持**）| `dsh-agent`、`dsh-subagent`、`dsh-tool-subagent`、`dsh-sandbox-local`、`dsh-credentials-local`、`dsh-goal-round-driver` | 保持旧版 |
  | override 里是 `link:` 顶替 | `dsh-tools`、`dsh-fs-local` | 不动 |
  | override 里已随消费者升到目标版 | `dsh-api-remotes`、`dsh-client-ui-*`（会话域 6 个）| 随消费者 |
  | **根本不在 override 里**（零消费者、未安装）| `dsh-session-queue-revert` | 无需处置 |

  ⇒ **先查再动**：`grep -nE "'@deepseek-ai/dsh-<名>'" pnpm-workspace.yaml` —— 不在表里的名字不要凭空加进去。

## 6. 验证与验收

### ⚠️⚠️ 第一铁律：`tsc -b` 是**增量**编译，会**藏住**依赖升级造成的破坏点

**实测事故（2026-09-29）**：升级 `node_modules` 里的官方包（**源码没动**）后跑
`pnpm -r typecheck` ⇒ **全绿** ✗；同一棵树用 `pnpm -r typecheck --force` ⇒ **5 个包 / 31 处报错** ✗✗。

**原因**：`tsc -b` 只重编**源码变了**的文件；依赖的 `.d.ts` 变了但它**不认为需要重编** ⇒ 报 0 错 ✗。

**纪律**：
- **每个包升级后**，验收必须包含 **`--force` 的真全量**：
  ```bash
  pnpm --filter @corum/<pkg> run typecheck --force      # 单包真全量
  pnpm -r --no-bail typecheck --force                   # 全仓真全量（--no-bail 一次看全）
  ```
- **`pnpm -r typecheck`（不带 --force）不能作为"依赖升级没破坏代码"的证据** ✗ —— 它只证明"上次编过的东西还编得过"。
- ⚠️ 但 **UI 包（8 个）与逻辑包的 `--force` 结果要分开看**：升级官方 UI 包 API 后，我们 fork 的
  `src/client/**` 用旧 API ⇒ **必然报错** ⇒ 这意味着「**UI 包只升依赖、不改 src**」这条口径
  **在官方 API 有破坏性变更时不成立** ✗ —— 必须**适配 src**（机械适配 ≠ 合并官方 UI 设计）。



- **每个包**：单包 `typecheck` + **全仓 `typecheck`**（每步都跑，别攒着）+ **提交**（粒度 = 一个包一个提交，可独立回滚）。
- **必跑 `pnpm -r build`**：`tsc` 发现不了"缺导出"（`MISSING_EXPORT`）——
  实测 `dsh-client-ui-primitives@0.1.7` 需要 `dsh-util-workspace-path` 的 `pathPartsOf`，
  typecheck 全绿但 **build 直接失败**。
- **fork 守卫必须带基线标签**：`DSH_CHECKOUT=... DSH_BASELINE_TAG=<tag> ./scripts/verify-fork-drift.sh`
  （本场给守卫新增了 `DSH_BASELINE_TAG`；不设则拿检出工作区当基线 ⇒ 长期假红且无法区分
  「我们落后」与「我们改错了」）。**留意"跳过 N 项"** —— 环境变量没给全时，逐字节断言会**静默跳过**，
  那种"绿"不是绿。
- **打包前必须全部升完**：部分升级期同包多版本并存是正常的，但 `pack-macos` 的
  `closure uniform at <版本>` 断言会挡住混版闭包（2026-09-18 那次"两棵树模块实例"血案的成因）。
- **启动实测**：`./scripts/corum-instance.sh start|restart --home=verify` + 探针
  （外壳渲染 / 侧栏会话数 / `domNodes`）+ **查启动日志**（`renderer:error` / `Failed to load plugins` /
  `missed the module table`）。**「编译通过」不等于「能起来」** —— 白屏那次编译全绿。

## 7. 环境陷阱（本机特有，先记住）

| 陷阱 | 现象 | 做法 |
|---|---|---|
| **PATH 上的 `diff` 是 HarmonyOS SDK 的** | 对内容不同的文件**输出 0 行、退出 0** ⇒ 任何用 `diff` 判差异的脚本**静默漏报** | 判差异用 **`cmp -s`**；人读差异用 **`/usr/bin/diff`** |
| `sort`/`comm` 的 locale | 两侧不同 collation 时，同一路径会**同时出现在两个"独有"列表** | 统一 `LC_ALL=C` |
| `wc -l` 于无换行结尾 | 计数偏差 | 必要时用 `grep -c .` |
| 官方包无 `src/` | 仓库内 `packages/core/...` 是**路径错误**而非空结果 | 一律 `git -C /Users/kukucai/dsh archive <tag> <path>` |
| tar 的 `--strip-components` | 层级数猜错会解出**空目录**（本场错 4 次）| 解完先 `find ... -type d -name src` 定位，再对比 |

## 8. 收尾纪律

- 每完成一个包：**更新 `docs/UPGRADE-0.1.5-rc3.md`（活文档，追加本包结论）+ `docs/tasks/log.jsonl` 台账 + 提交**。
- **如实标注没做的事**（本场明确写了"只做版本对齐 + 编译，未跑测试/打包/实机"）。
- 发现自己的判断错误要**写进文档**（本场三处：误把 `credentials-local` 当未 fork 包、
  误按"就地改写"做锚点、误改注释里的官方包名导致守卫判红）—— 这些比成功经验更值钱。
- **守卫要求"逐字节一致"的文件，连文件头注释里的包名都不要改**（实测：注释也是判据的一部分）。
