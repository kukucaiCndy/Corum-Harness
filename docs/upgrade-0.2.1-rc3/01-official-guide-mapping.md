# 阶段 -1：官方升级指南映射

> 状态：已完成（2026-10-27） | 前置：无（一切的前置） | 预估工程量：约 0.5-1 人日
> （43 篇英文正文实测约 952 行 / 75KB，阅读约 0.5h；主要工作量是逐篇 grep/映射分析）

## 1. 目标与范围

**目标**：通读 dsh 官方 `dsh-v0.2.1-rc.3` tag 下 `docs/upgrade-guide/` 的全部升级指南
（7 个版本目录，共 **43 篇**），逐篇评估对 corum fork 仓的影响，产出「指南 → corum 影响映射表」。
该映射表是后续阶段 1-6 执行的输入——避免靠考古 commit 摸索迁移面，直接用官方现成迁移文档。

**数量说明**：官方共 43 篇 guide（7 目录分布 2/6/22/10/1/1/1）。全树 129 文件 = 每篇 guide.md +
guide.zh.md + guide.i18n.yaml。本阶段只读英文 `guide.md`（43 个），不读 zh.md / yaml。

**范围**：
- 只读 `/Users/kukucai/dsh` 仓（严禁 checkout / 写）。
- 只产出映射表文档，不改任何源码。
- 映射表每条影响必须归入阶段 1-6 之一或显式标注「corum 不受影响」。

**不做的事**：
- 不执行任何代码修改（那是阶段 1+ 的事）。
- 不做 commit 探源（可行性文档 + 评审报告已完成此项）。
- 不验证 npm 包可解析性（那是阶段 2 的事）。

## 2. 前置条件（准入门禁）

| # | 条件 | 验证方式 | 状态 |
|---|---|---|---|
| 1 | 可行性文档已通读 | `docs/UPGRADE-0.2.1-rc3-feasibility.md` 在 HEAD | ✅ |
| 2 | 六份评审报告已可访问 | 原三份 `~/.corum/research-reports/{885858d9,5c35a73b,06867ebb}-*.md` 可读（后续阶段基础证据）；新增三份 `{e9de057a,abf2af7e,958879cc}-*.md` 可读（阶段 -1 专用） | ✅ |
| 3 | dsh 仓 tag `dsh-v0.2.1-rc.3` 存在 | `git -C /Users/kukucai/dsh tag -l 'dsh-v0.2.1-rc.3'` | ✅ |

> 无代码前置——本阶段纯文档工作。

## 3. 输入与依赖

| 输入 | 来源 | 用途 |
|---|---|---|
| 官方升级指南 | `dsh-v0.2.1-rc.3:docs/upgrade-guide/` | 逐篇通读（只读 guide.md） |
| 可行性文档 §六阶段 -1 | `docs/UPGRADE-0.2.1-rc3-feasibility.md` | 已列必读清单 |
| 评审报告 06867ebb §E2-c | `~/.corum/research-reports/06867ebb-*.md` | 确认 7 目录 43 篇 |
| corum fork 包清单 | `packages/plugins/{agent,session,ui}/` 下 50 个包 | 评估影响面 |
| corum 组合文件 | `packages/desktop/cordis.patch.yml` + `profile/corum/cordis.patch.yml` | 判断是否受影响 |
| corum override 表 | `pnpm-workspace.yaml:43-306`（217 条） | 判断包依赖面 |

## 4. 执行步骤（命令级，逐步可执行，每步带验证命令）

### 步骤 1：列出官方升级指南全清单

```bash
# 列出 dsh-v0.2.1-rc.3 tag 下 docs/upgrade-guide/ 的全部文件
git -C /Users/kukucai/dsh ls-tree -r --name-only dsh-v0.2.1-rc.3 docs/upgrade-guide/
```

**验证**：输出应包含 7 个版本目录，每个目录下有若干 `guide.md`。预期分布：

| 版本目录 | 篇数 | 说明 |
|---|---|---|
| `v0.1.7-rc.2/` | 2 | 0.1.5→0.1.7 过渡 |
| `v0.2.0-rc.2/` | 6 | 含 `remove-runtime-invariants`（已引用于可行性文档 §三·1） |
| `v0.2.1-alpha.1/` | 22 | 最多，含 subagent/session-title 等 corum 直接相关篇 |
| `v0.2.1-alpha.2/` | 10 | |
| `v0.2.1-alpha.3/` | 1 | |
| `v0.2.1-alpha.4/` | 1 | |
| `v0.2.1-rc.2/` | 1 | |

> 来源：评审报告 06867ebb §E2-c（`git ls-tree` 实测）。全树 129 文件 = 43 篇 × 3（guide.md + guide.zh.md + guide.i18n.yaml）。

### 步骤 2：逐篇读取指南内容

对步骤 1 输出的每个 `guide.md`，用 `git show` 读取（**只读英文 guide.md，不读 guide.zh.md / guide.i18n.yaml**）：

```bash
# 示例：读 subagent-activations 指南
git -C /Users/kukucai/dsh show dsh-v0.2.1-rc.3:docs/upgrade-guide/v0.2.1-alpha.1/subagent-activations/guide.md

# 批量读全部 guide.md（只读英文，输出到临时文件便于逐篇分析）
git -C /Users/kukucai/dsh ls-tree -r --name-only dsh-v0.2.1-rc.3 docs/upgrade-guide/ \
  | grep '/guide\.md$' \
  | while IFS= read -r f; do
      echo "===== $f ====="
      git -C /Users/kukucai/dsh show "dsh-v0.2.1-rc.3:$f"
    done > /tmp/upgrade-guides-all.txt
```

**验证**：
```bash
# 确认只读了英文 guide.md（应为 43 篇，不是 129 文件）
grep -c '/guide\.md$' <(git -C /Users/kukucai/dsh ls-tree -r --name-only dsh-v0.2.1-rc.3 docs/upgrade-guide/)

# 确认总行数（43 篇英文正文实测约 952 行 / 75KB，加分隔符后约 1000 行）
wc -l /tmp/upgrade-guides-all.txt
# 应约 1000 行，而非数千行（只读了 guide.md，不含 zh.md / yaml）
```

> **注意**：`/tmp/upgrade-guides-all.txt` 重启即清，**不可作为跨阶段唯一依据**——跨阶段回查请用 `git -C /Users/kukucai/dsh show dsh-v0.2.1-rc.3:<path>` 直接读取。

### 步骤 3：逐篇分析对 corum 的影响

对每篇指南，回答以下 **6** 个问题，填入映射表（见步骤 4 模板）：

1. **涉及哪些官方包**？指南标题/正文中提到的 `@deepseek-ai/dsh-*` 包名。
2. **corum 是否有引用点**？在 corum 仓 grep 对应包名，确认是否有 fork 包依赖、import、组合挂载。
3. **影响的 fork 包**？corum 的 50 个 fork 包中哪些与此指南相关。
4. **所需动作**？改 dep / 改 import / 改组合 / 改测试 / 无需改动。
5. **归入哪个阶段**？阶段 1（被删包）/ 2（override）/ 3（fork rebase）/ 4（验证）/ 5（进程隔离）/ 6（sidecar）/ 标注「corum 不受影响」。
6. **是否只改服务名/事件名/RPC 面/配置 schema 而不改包名**？若是，则必须 grep corum 的 `inject('...')` / `ctx.get('...')` 调用点、两份 `cordis.patch.yml`、`scripts/verify-fork-drift.sh` 的事件 allowlist——**不得只 grep 包名**（包名没变不代表无影响：服务名/RPC 面变了会断 inject）。

**已知必读清单**（可行性文档 §六 + 评审报告 06867ebb §E2-c 确认与 corum 直接相关，共 **13 篇**）：

| 指南篇名 | 所在版本目录 | 为何必读 |
|---|---|---|
| `subagent-activations` | `v0.2.1-alpha.1/` | 直击 corum-subagent 的 activation 生命周期（官方 `3d852a1cea` 合并驱动） |
| `subagent-preset-composition` | `v0.2.1-alpha.1/` | 直击 corum-subagent rebase（preset 声明迁移） |
| `jsonl-persistence-plugin` | `v0.2.1-alpha.1/` | SessionWriteLease / persistence 形态变化 |
| `working-directory` | `v0.2.1-alpha.1/` | 会话工作目录语义（`session/working-directory` 新包）；corum 有 `{{cwd}}` 提示变量残留 |
| `session-title-provider-strategy` | `v0.2.1-alpha.1/` | session-title-llm provider API 迁移（可行性文档 §三 dsh-session-title 行） |
| `session-title-adapters` | `v0.2.1-alpha.1/` | session-title adapter 变化（与上一篇配对） |
| `plugin-engines-dsh` | `v0.2.1-alpha.3/` | 兼容性检查优先读 engines.dsh；拒绝记录 peers 改名 requirements（与 HMR 无关） |
| `from-default-profile-replaces-target` | `v0.2.1-alpha.2/` | profile 组合语义变化（corum 不受影响 + 备忘） |
| `new-session-blank-reuse` | `v0.2.1-rc.2/` | 新建会话语义（阶段 4 行为观察） |
| `remove-runtime-invariants` | `v0.2.0-rc.2/` | invariants 删除（可行性文档 §三·1 方案 A 已定） |
| `experimental-package-composition` | `v0.2.1-alpha.1/` | 实验性包组合（新组合语义关联红线 5） |
| `web-listener-trust-config` | `v0.2.1-alpha.1/` | webRuntime→webStartup、trustedHosts 配置迁移；命中 corum `packages/desktop/cordis.patch.yml:36-41` trustedHosts:[] 和 `src/host/boot.ts:524-528` 四行链 |
| `plugin-install-over-installed` | `v0.2.1-alpha.2/` | HMR 下 installBundle 对已安装包报 already-installed，需先 removeBundle；命中 corum-extension-pack install-local/uninstall、corum-ide-plugin-manager-ui、corum-rpc-client |

> 其余 **30** 篇也须逐篇过一遍，但上述 13 篇是高优先级。

### 步骤 4：产出「指南 → corum 影响映射表」

将步骤 3 的分析结果填入以下映射表模板（追加到本册附录 A，见 §8 产出物）：

```markdown
## 附录 A：指南 → corum 影响映射表

| # | 指南篇名 | 版本目录 | 涉及官方包 | corum 引用点 | 影响的 fork 包 | 所需动作 | 归入阶段 | 横切标签 |
|---|---|---|---|---|---|---|---|---|
| 1 | subagent-activations | v0.2.1-alpha.1 | dsh-subagent | corum-subagent activation 生命周期 | corum-subagent | ... | 1+3+4 | ... |
| ... | ... | ... | ... | ... | ... | ... | ... | ... |
| N | <篇名> | <目录> | <包名> | <引用点或无> | <fork 包名或无> | <动作或"corum 不受影响"> | <阶段或N/A> | <build/ci/docs/空> |
```

> 映射表可加可选「横切标签」列（build/ci/docs），用于标注跨阶段横切关注点，**不扩阶段号**。

### 步骤 5：交叉校验映射表完整性

```bash
# 确认指南篇目总数（只数 guide.md）
git -C /Users/kukucai/dsh ls-tree -r --name-only dsh-v0.2.1-rc.3 docs/upgrade-guide/ \
  | grep -c '/guide\.md$'
# 输出应为 43
```

**验证**：
- 映射表有效条目数 ≥ 43（每篇至少一行）。
- 每行的「归入阶段」列要么是 1/2/3/4/5/6 之一（可组合），要么标注「corum 不受影响」。
- 高优先级 13 篇全部有详细分析（非空行）。

## 5. 验收标准（退出门禁，可判定）

| # | 标准 | 判定方式 | 状态 |
|---|---|---|---|
| 1 | 映射表覆盖全部指南篇目 | 有效映射条目 = 43（步骤 5 的 `grep -c '/guide\.md$'` 输出） | ✅ |
| 2 | 每条影响都落到阶段 1-6 之一或标注「corum 不受影响」 | 逐行检查「归入阶段」列 | ✅ |
| 3 | 13 篇高优先级指南有详细分析 | 每篇至少记录涉及包 + 引用点 + 动作 + 阶段 | ✅ |
| 4 | 映射表已追加到本册附录 | 本文件附录 A 存在且非空 | ✅ |
| 5 | 未改任何源码 | `git diff --stat HEAD` 只含 01 册（本阶段执行时）；`git status --porcelain` 非 `docs/` 路径为空 | ✅（指挥者核验：commit 2637685c 仅修改01册，无源码改动） |

> **门禁 5 机械判定**：`git status --porcelain` 中非 `docs/` 路径必须为空，且 `git diff --stat HEAD` 只含 01 册文件（本阶段执行时）。本阶段执行只允许修改 01 自身。**不得要求不存在的实录文件**——实录暂记本册附录 B（见 §9），阶段 0 建骨架时转录。

## 6. 风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| 指南正文未明确包名，需交叉考古 commit | 中 | 以可行性文档 §三 + 评审报告 885858d9 为权威引用点清单，指南只补充迁移手法 |
| corum 引用点遗漏（grep 漏报） | 中 | 评审报告 885858d9 已逐文件逐行核对 50 个 fork 包的 package.json + tsdown.config.ts + src/，以报告为准 |
| 指南描述的 API 变化与 corum 实际用法不匹配 | 低 | 逐篇读指南时同步 grep corum 仓确认实际用法 |
| 某篇指南涉及 corum 未装配的包 | 低 | 标注「corum 不受影响」即可，不影响后续阶段 |
| 只 grep 包名漏掉服务名/RPC 面/事件名变更 | 中 | 步骤 3 第 6 问强制 grep `inject('...')`/`ctx.get('...')`/两份 patch/事件 allowlist |

## 7. 回滚方案

**本阶段无回滚需求**——纯文档工作，不改源码。若映射表质量不达标，重做步骤 3-4 即可。

## 8. 产出物与下游接口

| 产出物 | 位置 | 下游消费者 |
|---|---|---|
| 指南 → corum 影响映射表 | 本册附录 A（执行时填入） | 阶段 1-6 各册的「输入与依赖」 |
| 全部指南文本（临时） | `/tmp/upgrade-guides-all.txt`（不入库，重启即清） | 阶段 1-3 执行时按需回查（跨阶段回查用 `git show` 直接读取） |
| 实录暂记 | 本册附录 B（执行时填入） | 阶段 0 步骤 6 建实录骨架时转录 |

**下游接口契约**：
- 映射表中每条「归入阶段 = X」的记录，对应阶段 X 手册的「输入与依赖」§3 应引用该指南篇名。
- 阶段 1 手册（`03-removed-packages.md`）应从映射表筛选所有「归入阶段 = 1」的条目作为输入。
- 阶段 3 手册（`05-fork-rebase.md`）应从映射表筛选所有「归入阶段 = 3」的条目作为输入。

## 9. 实录要求（执行时暂记本册附录 B，阶段 0 转录）

执行本阶段时，暂记内容写入**本册附录 B**（见下方模板）。**阶段 0 步骤 6 建 `docs/UPGRADE-0.2.1-rc3.md` 骨架时，将附录 B 内容转录到实录文件**。

> **约束**：本阶段执行只允许修改 01 自身——不创建 `docs/UPGRADE-0.2.1-rc3.md`（那是阶段 0 的事）。

暂记内容：

1. **步骤 1 的命令输出**：`git ls-tree` 的完整文件列表（43 篇 guide.md 的路径）。
2. **步骤 2 的批量读命令**与总行数（预期约 1000 行）。
3. **步骤 3 的逐篇分析摘要**：每篇一句话结论（涉及什么 / corum 是否受影响 / 归入哪个阶段）。
4. **步骤 5 的交叉校验结果**：`grep -c '/guide\.md$'` 输出 43，映射表条目数。
5. **偏差记录**：若发现可行性文档或评审报告有遗漏的指南篇目或影响，在此记录。
6. **时间**：本阶段实际耗时。

---

## 附录 A：指南 → corum 影响映射表

> 以下 43 条覆盖 `git ls-tree -r --name-only dsh-v0.2.1-rc.3 docs/upgrade-guide/ | grep '/guide\.md$'` 全部篇目，编号 1-43。

| # | 指南篇名 | 版本目录 | 涉及官方包 | corum 引用点 | 影响的 fork 包 | 所需动作 | 归入阶段 | 横切标签 |
|---|---|---|---|---|---|---|---|---|
| 1 | subagent-activations | v0.2.1-alpha.1 | dsh-tool-subagent, dsh-subagent-in-process-driver | `corum-tool-subagent/src/index.ts:153-163`（backgroundMode/enableRunInBackground 配置）、`:241-242`（zod schema 含 backgroundMode）、`:1251`（工具描述引用 job_output/job_kill）、`:1293`（run_in_background 路径走 ctx.subagents.start()）；`corum-subagent/src/index.ts:284` startContinuable；`corum-subagent/src/driver/index.ts:11`（fork 官方 dsh-subagent-in-process-driver 的 startInProcessRun）；`corum-agent/src/compile.ts:259,265,271`（preset 行含 backgroundMode: 'continuable'/'one-shot'）；`desktop-host/package.json:114` dep + `pnpm-workspace.yaml:220` override（dsh-subagent-in-process-driver） | corum-tool-subagent, corum-subagent | 删 backgroundMode/enableRunInBackground 配置及 zod schema；start/startContinuable→startActivation + caller delivery；删 run_in_background 工具参数，结果改读 subagentId + completion notice；删 dsh-subagent-in-process-driver dep/override/import，corum-subagent/src/driver/ 改用 prepareContinuable()；compile.ts preset 行的 backgroundMode 字段删除；SubagentRun.id 全局唯一 | 1+3+4 | — |
| 2 | subagent-preset-composition | v0.2.1-alpha.1 | dsh-tool-subagent | `corum-tool-subagent/src/index.ts:169-178`（persona?/toolFilter? 配置字段）、`:257`（toolFilter zod schema）、`:1568-1569`（toolFilter 校验逻辑）；`corum-agent/src/compile.ts:259,265,271`（preset 行未设 persona/toolFilter 但含 backgroundMode）；`corum-subagent/src/child-agent.ts:28` type import dsh-agent-presets | corum-tool-subagent, corum-subagent | 删 persona/toolFilter 配置字段及 zod schema；spawn 改走 agentPreset；fork 继承父 preset；compile.ts preset 行需清理（背景模式已删但 persona/toolFilter 未用） | 1+3 | — |
| 3 | jsonl-persistence-plugin | v0.2.1-alpha.1 | dsh-session-persistence-jsonl | `corum-subagent/tests/isolation-confinement.spec.ts:32` default import JsonlSessionPersistence、`:62` ctx.plugin(JsonlSessionPersistence, config)；`corum-subagent/tests/continuation.spec.ts:11,84,484,3058` 同款 default import + ctx.plugin；`corum-subagent/tests/ownership.spec.ts:45,67` 同款；`pnpm-workspace.yaml:188` override；`desktop-host/package.json` 无直接 dep（经 dsh-subagent 间接）；`corum-ide-ui/plugin-meta.ts:49` + `corum-ide-plugin-manager-ui/plugin-meta.ts:44` 元数据 | corum-subagent（测试文件） | default import 改 namespace import（`import * as JsonlSessionPersistence`）；ctx.plugin() 调用方式不变（指南确认）；SessionPersistence 类型从 dsh-session-persistence 取；阶段 3 rebase 时关注 + 阶段 4 addon 验证 | 3+4 | — |
| 4 | working-directory | v0.2.1-alpha.1 | session/working-directory, tool-working-directory, dsh-subagent-acp, dsh-subagent-dsh-sdk | `packages/desktop/cordis.patch.yml:234` system-prompt persona 含 `Your working directory is {{cwd}}`；`corum-subagent/src/child-agent.ts:149,154`（cwd 字段 + effectiveCwd 逻辑）；`corum-subagent/src/out-of-process.ts:5`（working-directory resolution 注释）；`corum-subagent/package.json` 描述提及 cwd 透传为 fork 动机 | corum-subagent, corum-tools | 删 `{{cwd}}` 提示变量（cordis.patch.yml:234）；删 dsh-subagent-acp/dsh-sdk 的 config.cwd；start request cwd 已被官方支持（corum 增量 childSessionMeta.cwd 透传需裁决保留/删除）；presentationMeta 嵌套 PTC 归阶段 4 验证 | 1+3+4 | — |
| 5 | session-title-provider-strategy | v0.2.1-alpha.1 | dsh-session-title-llm | `desktop-host/package.json:105` dep（dsh-session-title-llm 0.1.5-rc.3）；`pnpm-workspace.yaml:199` override；`corum-agent/src/agent-service.ts:67` type import dsh-session-title/types；`corum-agent/package.json:55` dep + `:99` devDep（dsh-session-title）；`corum-ide-ui/plugin-meta.ts:48` + `corum-ide-plugin-manager-ui/plugin-meta.ts:43`（dsh-session-title-first-prompt-llm 元数据） | corum-agent | 阶段 1 迁移 provider API（registerSessionTitleLlmProvider → ctx.sessionTitle.register + executeSessionTitleLlm）；改 dep/override 版本；UI 元数据 dsh-session-title-first-prompt-llm 需核实是否改名 | 1 | — |
| 6 | session-title-adapters | v0.2.1-alpha.1 | dsh-session-title-llm | 同 #5 | 同 #5 | 阶段 1 配对迁移（llm/stream middleware → registerAdapter；reasoning.efforts 从小到大排序） | 1 | — |
| 7 | plugin-engines-dsh | v0.2.1-alpha.3 | engines.dsh / peerDependencies→requirements | 未发现 corum fork 包有 engines.dsh 字段（grep 零命中）；corum 46 个 fork 包有 peerDependencies（均 `@deepseek-ai/dsh` workspace:~ 等）；corum-ide-plugin-manager-ui 无 IncompatiblePlugin/PluginCompatibility 读取代码（grep 零命中） | — | 兼容性检查优先读 engines.dsh；corum 0 个 engines.dsh ⇒ 走 peer 回退；peers→requirements 改名不影响 corum（无读取代码）；包声明预期无需改 | corum 不受影响（已检索 engines.dsh/IncompatiblePlugin/PluginCompatibility） | — |
| 8 | from-default-profile-replaces-target | v0.2.1-alpha.2 | dsh-base / profile 组合 | `profile/corum/cordis.patch.yml`（空数组 `[]`，无 dsh-base 行引用）；corum 不走 `dsh --from-default-profile` CLI（desktop host 直接 boot profile） | — | corum 不受影响 + 备忘（CLI 重建会删目标目录；corum 不走该 CLI，profile patch 手维护） | corum 不受影响 | — |
| 9 | new-session-blank-reuse | v0.2.1-rc.2 | session 控制器 | `corum-ide-sidebar-ui/src/client/index.ts:180` startSession 自有 RPC（不直接走 uiWorkspace.startSession）；corum 新建任务走 corum-ide-sidebar-ui 自有 startSession binding | — | 阶段 4 行为观察（rc.2 恢复 blank reuse 语义；corum 自有 startSession binding 需验证是否跟随官方语义） | 4 | — |
| 10 | remove-runtime-invariants | v0.2.0-rc.2 | dsh-invariants | `corum-goal-round-driver/package.json:28` dep + `:10` ./invariant export + `src/invariant.ts:6,16` import InvariantFailure/InvariantInstaller + inject ['invariants'] + `:86` ctx.invariants.register()；`corum-tool-subagent/package.json:34` dep + `:12` ./invariant + `src/invariant.ts:18` 同款；`corum-subagent/src/invariant.ts:84` inject ['subagents']（注：corum-subagent invariant 不 inject invariants 服务）；`corum-tools/src/invariant.ts:120` inject ['sessions']；`desktop-host/package.json:86` dep dsh-invariants；`pnpm-workspace.yaml:155` override | corum-goal-round-driver, corum-tool-subagent, corum-subagent, corum-tools | 方案 A 跟随删除（可行性文档 §三·1）：删 4 fork 包的 invariant.ts + ./invariant export + dsh-invariants dep + external + desktop-host dep + pnpm override；invariant 逻辑迁移到 emitter 自身或删除 | 1 | — |
| 11 | experimental-package-composition | v0.2.1-alpha.1 | 实验性包组合（hooks/webhooks/tools/skills/badge） | `packages/desktop/cordis.patch.yml` 的 disabled+insert 四组：credentials（`:161` disabled + `:262` insert corum-credentials）、api-remotes（`:194` disabled + `:273` insert corum-api-remotes）、subagent（`:205` disabled + `:331` insert corum-subagent）、sandbox（`:217` disabled + `:354` insert corum-sandbox）、goal-round-driver（`:226` disabled + `:336` insert corum-goal-round-driver） | — | 阶段 3：新组合语义「只 enable 被删行的 patch 不插入插件」需重验四组 disabled+insert 模式（关联红线 5：不得 filter disabled 行——disabled 行有双重职责）；corum 的 disabled+insert 纪律正确（先 disabled 官方行再 insert fork），但需确认官方 base bundle 是否移除了 dormant rows | 3 | — |
| 12 | web-listener-trust-config | v0.2.1-alpha.1 | webRuntime→webStartup、trustedHosts | `packages/desktop/cordis.patch.yml:36-41` web-runtime 行 config 含 `trustedHosts: []`；`packages/desktop/src/host/boot.ts:524-530` 注释链「web-startup → webserver → web-runtime → connection」+ `:528` trustedHosts | — | webRuntime→webStartup 配置迁移：inject [webRuntime] → inject [webStartup]；ctx.webRuntime.trustedHosts → ctx.webStartup.trustedHosts；cordis.patch.yml:36-41 的 trustedHosts:[] 需迁移到 web-startup 行；boot.ts:524-530 注释链需更新；corum host 0.0.0.0 检查（已 pin 127.0.0.1） | 1+3 | — |
| 13 | plugin-install-over-installed | v0.2.1-alpha.2 | installBundle/removeBundle | `corum-ide-integrations-ui/src/client/PluginsPage.tsx:675,681`（removeBundle RPC 调用）；`packages/desktop/src/host/plugin-manager.ts:283-288`（removeBundle @Remote 实现）；`corum-extension-pack/src/install-local.ts:20`（pluginManager.install(spec) 注释）；`corum-extension-pack/src/uninstall.ts:59,311-315`（uninstallPlugin 回调）；corum-rpc-client（RPC 面）；corum-ide-plugin-manager-ui（UI 面） | corum-extension-pack, corum-ide-plugin-manager-ui, corum-rpc-client | HMR 下 installBundle 对已安装包报 already-installed，需先 removeBundle；corum 的 install-local/uninstall 需核实是否走 installBundle RPC（还是自有 install-local 路径）；PluginsPage 已有 removeBundle 调用（`:681`）；阶段 3 rebase + 阶段 4 验证 | 3+4 | — |
| 14 | schedule-optional-bundle | v0.1.7-rc.2 | dsh-web-app, dsh-experimental-schedule-bundle | 未发现 corum 引用（grep dsh-experimental-schedule-bundle 零命中；cordis.patch.yml 无 schedule/time-context/ui-schedule 行） | — | corum 不受影响（已检索 dsh-experimental-schedule-bundle/schedule/time-context/ui-schedule 包名/服务面） | corum 不受影响 | — |
| 15 | transcript-view-legacy-normal | v0.1.7-rc.2 | ui-chat.transcriptView | `corum-ide-ui/src/client/settings/sections/SettingsAdvancedSection.tsx:44,76-81`（transcriptView 字段读取，default 'compact'）；corum-ui-chat fork 包（未直接 grep transcriptView 但 fork dsh-client-ui-chat） | corum-ui-chat | 阶段 4 行为观察：legacy 'normal' 值改显示 'detailed'；corum 默认 'compact' 不受影响；corum-ui-chat fork 需 rebase 官方改动（如有） | 3+4 | — |
| 16 | account-sign-in-errors | v0.2.0-rc.2 | dsh-deepseek-account | 未发现 corum 引用（grep SignInErrorCode/no-response/account getState/startSignIn/watch 零命中 corum fork 源码）；corum 无 deepseek-account fork 包 | — | corum 不受影响（已检索 SignInErrorCode/no-response/account getState/startSignIn/watch 包名/服务面） | corum 不受影响 | — |
| 17 | bundled-python-tests | v0.2.0-rc.2 | NumPy/pandas 测试目录 | 未发现 corum 引用（corum 不含 Python runtime 测试目录；grep numpy.*/pandas.*tests 零命中） | — | corum 不受影响（已检索 numpy.*.tests/pandas.tests 包名/服务面） | corum 不受影响 | — |
| 18 | primary-runtime-python-aliases | v0.2.0-rc.2 | DH_PRIMARY_RUNTIME | 未发现 corum 引用（grep DSH_PRIMARY_RUNTIME/python3.12/dependencies/python/bin 零命中 corum 源码） | — | corum 不受影响（已检索 DSH_PRIMARY_RUNTIME/dependencies/python/bin 包名/服务面） | corum 不受影响 | — |
| 19 | schedule-bundle-retired | v0.2.0-rc.2 | dsh-experimental-schedule-bundle, dsh-web-app | 未发现 corum 引用（同 #14，grep 零命中） | — | corum 不受影响（已检索 dsh-experimental-schedule-bundle/schedule/ui-schedule/time-context 包名/服务面） | corum 不受影响 | — |
| 20 | subpath-plugin-display-manifest | v0.2.0-rc.2 | subpath plugins | 未发现 corum fork 包导出 subpath package.json（corum fork 包有 ./invariant、./spawn、./fork 等 subpath 但不导出 package.json）；corum-ide-plugin-manager-ui 无 subpath manifest 读取代码 | — | corum 不受影响（已检索 subpath/package.json/icon export + verify-package-meta 包名/服务面） | corum 不受影响 | — |
| 21 | deepseek-model-discovery | v0.2.1-alpha.1 | deepseek-official route | `corum-ide-ui/src/client/settings/sections/SettingsAgentPresetsSection.tsx:794` deepseek-official provider id；`corum-ui-base/src/client/web-search-credential.ts:27` DEEPSEEK_API_KEY ref；corum 无 deepseek-official route fork 包 | — | corum 不受影响（corum 无 deepseek-official route fork；DEEPSEEK_API_KEY 用于 web-search 而非 model discovery；已检索包名/服务面） | corum 不受影响 | — |
| 22 | desktop-test-auth-popup | v0.2.1-alpha.1 | desktop test auth | 未发现 corum 引用（grep allowTestAuthPopupWindow/updates.*allowTestAuth/desktop/settings.json 零命中 corum 源码） | — | corum 不受影响（已检索 allowTestAuthPopupWindow/desktop/settings.json 包名/服务面） | corum 不受影响 | — |
| 23 | instruction-home-override | v0.2.1-alpha.1 | dsh-agent-instructions, dsh-home-paths | `packages/desktop/src/host/boot.ts:39` import resolveDshHome from dsh-home-paths + `:280,392,395` 调用；`corum-agent/src/compile.ts:177,324,653` agent-instructions 行引用 + `:653` ctx.get('fs') 读 AGENTS.md；`corum-ide-ui/plugin-meta.ts:68` + `corum-ide-plugin-manager-ui/plugin-meta.ts:63` dsh-agent-instructions 元数据；cordis.patch.yml 无 dshHome 字段（grep 零命中） | — | dshHome 字段已从 agent-instructions 移除（corum cordis.patch.yml 无 dshHome 字段）；resolveDshHome 已在 boot.ts 使用（正确）；阶段 4 验证 AGENTS.md 加载路径 | 4 | — |
| 24 | job-id-identity | v0.2.1-alpha.1 | job registry, JobId, JobExecutionId | `corum-tool-subagent/src/index.ts:1251,1354`（工具描述引用 job_output/job_kill 但已改为 subagent 模式）；`corum-orchestration/src/execution-discipline.ts:37`（注释引用 job_output/job_kill）；corum 无 JobExecutionId import（grep 零命中） | — | JobId 格式变化（`<kind>-<uuid16>` 替代 `<kind>-N`）是运行时行为，corum 不构造 JobId；阶段 4 验证 job_output/job_kill 仍可用；工具描述需清理 job_output/job_kill 引用（随 #1 subagent-activations 一起做） | 4 | — |
| 25 | mock-messages-events | v0.2.1-alpha.1 | dsh-llm-mock-server | 未发现 corum 引用（grep dsh-llm-mock-server/mock-messages 零命中 corum fork 源码） | — | corum 不受影响（已检索 dsh-llm-mock-server/mock-messages 包名/服务面） | corum 不受影响 | — |
| 26 | native-subagent-bundle-tools | v0.2.1-alpha.1 | dsh-subagent-claude-code, dsh-subagent-codex | `corum-agent/src/compile.ts:262-271` tool-subagent-codex/claude-code preset 行（disabled:true, backgroundMode:'one-shot', maxDepth:'provider-managed'）；`pnpm-workspace.yaml:731-732` 包含 dsh-subagent-claude-code/codex；`packages/desktop/shipped-presets/official/ptc/agent.cordis.yml:243,252` + `standard/agent.cordis.yml:236` preset 行 | corum-tool-subagent, corum-subagent | bundle 现在注册 Host global tool（tool-subagent-claude-code/codex）；corum preset 行已 disabled（compile.ts:264,270）但含 backgroundMode（随 #1 删除）；BundleInfo.official/availability 新字段需核实 corum-ide-plugin-manager-ui 是否读取（grep 零命中）；阶段 3 rebase + 阶段 4 验证 | 3+4 | — |
| 27 | new-session-generations | v0.2.1-alpha.1 | session 控制器 | 同 #9（corum-ide-sidebar-ui/src/client/index.ts:180 startSession 自有 RPC） | — | 阶段 4 行为观察（alpha.1 创建 fresh Agent；rc.2 恢复 blank reuse——见 #9） | 4 | — |
| 28 | plugin-option-placement | v0.2.1-alpha.1 | dsh plugin CLI | 未发现 corum 引用（corum 不走 `dsh plugin` CLI；desktop host 直接 boot profile） | — | corum 不受影响（已检索 dsh plugin/--profile/add 包名/服务面） | corum 不受影响 | — |
| 29 | python-optional-resources | v0.2.1-alpha.1 | Python runtime wheels | 未发现 corum 引用（grep download_office/download_primary_runtime/DSH_RESOURCE_CACHE 零命中 corum 源码） | — | corum 不受影响（已检索 download_office/download_primary_runtime/DSH_RESOURCE_CACHE 包名/服务面） | corum 不受影响 | — |
| 30 | python-ptc-sandbox | v0.2.1-alpha.1 | dsh-experimental-ptc-runtime-python, dsh-sandbox-local, dsh-sandbox-policy | `corum-subagent/tests/isolation-confinement.spec.ts:30` import SandboxPolicyService from dsh-sandbox-policy（测试文件）；corum-sandbox-local fork 包（服务名 sandbox 不变）；cordis.patch.yml `:217` disabled 官方 sandbox + `:354` insert corum-sandbox | corum-sandbox-local | Python PTC 需要 sandbox/sandboxPolicy（corum 走 Node runtime 不受直接影响）；corum-sandbox-local fork 需阶段 3 rebase（sandbox 服务面无变化）；阶段 4 验证 sandbox 服务仍可用 | 3+4 | — |
| 31 | ssh-helper-launch | v0.2.1-alpha.1 | dsh-ssh, dsh-ptc-runtime-node | 未发现 corum 引用（grep dsh-ssh/dsh-ptc-runtime-node/nodeExecutable/bootstrapPath/bootstrapHash/ptcLaunch 零命中 corum 源码 + deps + overrides） | — | corum 不受影响（已检索 dsh-ssh/dsh-ptc-runtime-node/nodeExecutable/bootstrapPath/ptcLaunch 包名/服务面） | corum 不受影响 | — |
| 32 | team-direct-inbox | v0.2.1-alpha.1 | dsh-experimental-agent-team | 未发现 corum 引用（grep dsh-experimental-agent-team/maxPendingMessagesPerMember/team/message/queued/delivered 零命中 corum 源码 + deps + overrides） | — | corum 不受影响（已检索 dsh-experimental-agent-team/maxPendingMessages/team/message 包名/服务面） | corum 不受影响 | — |
| 33 | terminal-command-labels | v0.2.1-alpha.1 | dsh-client-ui-primitives, TerminalBlockLabels | `corum-ide-ui/package.json:42,58` dep dsh-client-ui-primitives；`corum-ide-sidebar-ui/package.json:42` 同款；`corum-ui-base/tsdown.config.ts:15` external dsh-client-ui-primitives；grep TerminalBlockLabels/commandLine 零命中 corum 源码 | corum-ide-ui, corum-ui-base | TerminalBlockLabels 新增 commandLine formatter；corum 未直接使用 TerminalBlockLabels（grep 零命中），但 dep dsh-client-ui-primitives 需阶段 2 升版；阶段 4 验证终端 UI 不受影响 | 2+4 | — |
| 34 | tool-presentation-mode | v0.2.1-alpha.1 | dsh-tools, dsh-agent-tool-presentation | `corum-tools/src/index.ts:810` zod schema `mode: z.union(['native', 'ptc', 'both'])`（含 'both'）；`corum-tools/src/py-types.ts:10` 注释 `mode: 'both'`；cordis.patch.yml 无 mode: both 行（grep 零命中）；DSH_TOOLS_MODE 环境变量 grep 零命中 | corum-tools | 删 'both' 值：corum-tools/src/index.ts:810 zod union 移除 'both'；py-types.ts 注释更新；阶段 3 rebase | 3 | — |
| 35 | deepseek-account-identity-watch | v0.2.1-alpha.2 | dsh-deepseek-account | 未发现 corum 引用（grep deepseekAccount.watch/getPlatformSession 零命中 corum fork 源码）；corum 无 deepseek-account fork 包 | — | corum 不受影响（已检索 deepseekAccount.watch/getPlatformSession 包名/服务面） | corum 不受影响 | — |
| 36 | deepseek-account-model-catalog | v0.2.1-alpha.2 | dsh-deepseek-account | 未发现 corum 引用（corum 无 deepseek-account route fork；grep models field/llm-deepseek-account/modelOverrides 零命中 corum 源码） | — | corum 不受影响（已检索 llm-deepseek-account/models/modelOverrides 包名/服务面） | corum 不受影响 | — |
| 37 | desktop-font-size-shortcuts | v0.2.1-alpha.2 | Desktop font shortcuts | 未发现 corum 引用（grep font size shortcut/Cmd.*=/Cmd.*- 零命中 corum 源码）；corum 无自定义快捷键覆盖此组合 | — | corum 不受影响（已检索 font-size shortcut/Cmd.+=/Cmd.- 包名/服务面） | corum 不受影响 | — |
| 38 | operator-connect | v0.2.1-alpha.2 | Connection, non-page clients | 未发现 corum 引用（corum desktop host 直接 boot profile，不走 `--from-default-profile` CLI + 不走 non-page Connection）；grep interactions: 'none'/$stream/$on/$events 零命中 corum 源码 | — | corum 不受影响（已检索 interactions/none/$stream/$on/connect 包名/服务面） | corum 不受影响 | — |
| 39 | pi-ai-azure-provider | v0.2.1-alpha.2 | dsh-llm-pi-ai, azure provider route | `corum-ui-settings-models/src/client/ConfigureWizard.tsx:467`（`azure-openai-responses` provider id 在 wizard 下拉）；`corum-ide-ui/src/client/settings/sections/SettingsAgentPresetsSection.tsx:795` + `SettingsAgentSettingsSection.tsx:131`（`pi-ai` 供应商 id）；`corum-ide-ui/plugin-meta.ts:44` + `corum-ide-plugin-manager-ui/plugin-meta.ts:39`（dsh-llm-pi-ai 元数据） | corum-ui-settings-models | azure provider route 从 `azure-openai-responses` 改名 `azure`；ConfigureWizard.tsx:467 的 `azure-openai-responses` id 需改 `azure`；阶段 3 rebase + 阶段 4 验证 | 3+4 | — |
| 40 | pi-ai-model-discovery | v0.2.1-alpha.2 | dsh-llm-pi-ai | 同 #39（corum 无 pi-ai route fork 包；corum-ui-settings-models 有 pi-ai 供应商 UI） | — | 阶段 4 行为观察（无 credential 时空 catalog；corum UI 需验证不崩溃）；corum 无 pi-ai route fork | 4 | — |
| 41 | sdk-minimal-image-compaction | v0.2.1-alpha.2 | sdk-minimal, read_image, compaction | 未发现 corum 引用（grep sdk-minimal/read_image/compaction 零命中 corum fork 源码 + deps + overrides）；corum-ide-ui/plugin-meta.ts:97,111 + corum-ide-plugin-manager-ui:92,106 有 dsh-compaction-basic/tool-result-pruner 元数据 | — | corum 不受影响（corum 不走 sdk-minimal profile；compaction 元数据仅供参考；已检索 sdk-minimal/read_image/compaction-basic 包名/服务面） | corum 不受影响 | — |
| 42 | stored-credentials-precedence | v0.2.1-alpha.2 | credentials store, .credentials.yaml | `corum-credentials-local/src/index.ts:2,7`（.credentials.yaml 文件后端）；`corum-credentials-local/src/value-crypto.ts:5,175`（加密落盘）；`cordis.patch.yml:161` disabled 官方 credentials + `:262` insert corum-credentials；corum-credentials-local 是 fork 包 | corum-credentials-local | 阶段 3 rebase：stored credentials 现在优先于环境变量；headless profile 禁用 credential store；corum-credentials-local fork 需核实是否受 precedence 变化影响（corum fork 的加密层在 durable 边界，precedence 逻辑在官方 dsh-authorization）；阶段 4 验证 | 3+4 | — |
| 43 | account-notification-fields | v0.2.1-alpha.4 | dsh-deepseek-account, AccountBonusNotification | 未发现 corum 引用（grep getUnnotifiedBonuses/AccountBonusNotification 零命中 corum fork 源码）；corum 无 deepseek-account fork 包 | — | corum 不受影响（已检索 getUnnotifiedBonuses/AccountBonusNotification/account/getUnnotifiedBonuses 包名/服务面） | corum 不受影响 | — |

> **填表纪律**：
> - 「corum 引用点」列必须给出具体文件:行号（从评审报告 885858d9 取或 grep 确认），不能只写「有」。
> - 「归入阶段」列不能留空——要么写阶段号，要么写「corum 不受影响」。
> - 无影响的篇目均写「corum 不受影响（已检索包名/服务面）」并注明检索范围。

---

## 附录 B：阶段 -1 实录暂记

> 阶段 0 步骤 6 建 `docs/UPGRADE-0.2.1-rc3.md` 骨架时，将本附录内容转录到实录文件。

```
## 阶段 -1：官方升级指南映射（实录）

### 步骤 1 输出
- 命令：git -C /Users/kukucai/dsh ls-tree -r --name-only dsh-v0.2.1-rc.3 docs/upgrade-guide/
- guide.md 总数：43
- 全树文件总数：129 = 43×3（guide.md + guide.zh.md + guide.i18n.yaml）

43 篇 guide.md 路径清单：
1.  docs/upgrade-guide/v0.1.7-rc.2/schedule-optional-bundle/guide.md
2.  docs/upgrade-guide/v0.1.7-rc.2/transcript-view-legacy-normal/guide.md
3.  docs/upgrade-guide/v0.2.0-rc.2/account-sign-in-errors/guide.md
4.  docs/upgrade-guide/v0.2.0-rc.2/bundled-python-tests/guide.md
5.  docs/upgrade-guide/v0.2.0-rc.2/primary-runtime-python-aliases/guide.md
6.  docs/upgrade-guide/v0.2.0-rc.2/remove-runtime-invariants/guide.md
7.  docs/upgrade-guide/v0.2.0-rc.2/schedule-bundle-retired/guide.md
8.  docs/upgrade-guide/v0.2.0-rc.2/subpath-plugin-display-manifest/guide.md
9.  docs/upgrade-guide/v0.2.1-alpha.1/deepseek-model-discovery/guide.md
10. docs/upgrade-guide/v0.2.1-alpha.1/desktop-test-auth-popup/guide.md
11. docs/upgrade-guide/v0.2.1-alpha.1/experimental-package-composition/guide.md
12. docs/upgrade-guide/v0.2.1-alpha.1/instruction-home-override/guide.md
13. docs/upgrade-guide/v0.2.1-alpha.1/job-id-identity/guide.md
14. docs/upgrade-guide/v0.2.1-alpha.1/jsonl-persistence-plugin/guide.md
15. docs/upgrade-guide/v0.2.1-alpha.1/mock-messages-events/guide.md
16. docs/upgrade-guide/v0.2.1-alpha.1/native-subagent-bundle-tools/guide.md
17. docs/upgrade-guide/v0.2.1-alpha.1/new-session-generations/guide.md
18. docs/upgrade-guide/v0.2.1-alpha.1/plugin-option-placement/guide.md
19. docs/upgrade-guide/v0.2.1-alpha.1/python-optional-resources/guide.md
20. docs/upgrade-guide/v0.2.1-alpha.1/python-ptc-sandbox/guide.md
21. docs/upgrade-guide/v0.2.1-alpha.1/session-title-adapters/guide.md
22. docs/upgrade-guide/v0.2.1-alpha.1/session-title-provider-strategy/guide.md
23. docs/upgrade-guide/v0.2.1-alpha.1/ssh-helper-launch/guide.md
24. docs/upgrade-guide/v0.2.1-alpha.1/subagent-activations/guide.md
25. docs/upgrade-guide/v0.2.1-alpha.1/subagent-preset-composition/guide.md
26. docs/upgrade-guide/v0.2.1-alpha.1/team-direct-inbox/guide.md
27. docs/upgrade-guide/v0.2.1-alpha.1/terminal-command-labels/guide.md
28. docs/upgrade-guide/v0.2.1-alpha.1/tool-presentation-mode/guide.md
29. docs/upgrade-guide/v0.2.1-alpha.1/web-listener-trust-config/guide.md
30. docs/upgrade-guide/v0.2.1-alpha.1/working-directory/guide.md
31. docs/upgrade-guide/v0.2.1-alpha.2/deepseek-account-identity-watch/guide.md
32. docs/upgrade-guide/v0.2.1-alpha.2/deepseek-account-model-catalog/guide.md
33. docs/upgrade-guide/v0.2.1-alpha.2/desktop-font-size-shortcuts/guide.md
34. docs/upgrade-guide/v0.2.1-alpha.2/from-default-profile-replaces-target/guide.md
35. docs/upgrade-guide/v0.2.1-alpha.2/operator-connect/guide.md
36. docs/upgrade-guide/v0.2.1-alpha.2/pi-ai-azure-provider/guide.md
37. docs/upgrade-guide/v0.2.1-alpha.2/pi-ai-model-discovery/guide.md
38. docs/upgrade-guide/v0.2.1-alpha.2/plugin-install-over-installed/guide.md
39. docs/upgrade-guide/v0.2.1-alpha.2/sdk-minimal-image-compaction/guide.md
40. docs/upgrade-guide/v0.2.1-alpha.2/stored-credentials-precedence/guide.md
41. docs/upgrade-guide/v0.2.1-alpha.3/plugin-engines-dsh/guide.md
42. docs/upgrade-guide/v0.2.1-alpha.4/account-notification-fields/guide.md
43. docs/upgrade-guide/v0.2.1-rc.2/new-session-blank-reuse/guide.md

### 步骤 2 输出
- 批量读命令：git -C /Users/kukucai/dsh ls-tree -r --name-only dsh-v0.2.1-rc.3 docs/upgrade-guide/ | grep '/guide\.md$' | while IFS= read -r f; do echo "===== $f ====="; git -C /Users/kukucai/dsh show "dsh-v0.2.1-rc.3:$f"; done > /tmp/upgrade-guides-all.txt
- /tmp/upgrade-guides-all.txt 总行数：995（含 43 个 ===== 分隔行 + 43 篇英文正文）

### 步骤 3 逐篇分析摘要
1.  schedule-optional-bundle — Schedule 移入 optional bundle；corum 无 schedule 行引用，不受影响。
2.  transcript-view-legacy-normal — legacy 'normal' 改显示 'detailed'；corum 默认 'compact'，fork ui-chat 需 rebase，归阶段 3+4。
3.  account-sign-in-errors — SignInErrorCode 新增 no-response；corum 无 deepseek-account fork，不受影响。
4.  bundled-python-tests — NumPy/pandas 测试目录移除；corum 不含 Python 测试目录，不受影响。
5.  primary-runtime-python-aliases — Python interpreter 别名校验；corum 无 DSH_PRIMARY_RUNTIME 引用，不受影响。
6.  remove-runtime-invariants — dsh-invariants 包及 ./invariant subpath 删除；corum 4 fork 包有 invariant.ts + dep + override，归阶段 1。
7.  schedule-bundle-retired — schedule-bundle 删除；corum 无引用，不受影响。
8.  subpath-plugin-display-manifest — subpath 不再读 package.json；corum 不导出 subpath package.json，不受影响。
9.  deepseek-model-discovery — 无 credential 时空 catalog；corum 无 deepseek-official route fork，不受影响。
10. desktop-test-auth-popup — test auth 默认禁用；corum 无引用，不受影响。
11. experimental-package-composition — hooks/webhooks/tools/skills 改显式安装；corum disabled+insert 四组需重验，归阶段 3。
12. instruction-home-override — dshHome 字段删除；corum cordis.patch.yml 无 dshHome，resolveDshHome 已用，归阶段 4。
13. job-id-identity — JobId 改 UUID 格式；corum 不构造 JobId，工具描述需清理 job_output 引用，归阶段 4。
14. jsonl-persistence-plugin — 改 namespace import；corum 测试用 default import 会断，归阶段 3+4。
15. mock-messages-events — mock server 发命名 SSE 事件；corum 无引用，不受影响。
16. native-subagent-bundle-tools — claude-code/codex bundle 注册 global tool；corum preset 行有 backgroundMode 需删，归阶段 3+4。
17. new-session-generations — New Session 创建 fresh Agent；corum 自有 startSession RPC，归阶段 4。
18. plugin-option-placement — dsh plugin CLI 选项位置；corum 不走该 CLI，不受影响。
19. python-optional-resources — Python wheels 需显式下载；corum 无引用，不受影响。
20. python-ptc-sandbox — Python PTC 需 sandbox；corum 走 Node runtime，sandbox fork 需 rebase，归阶段 3+4。
21. session-title-adapters — title route 需 registerAdapter；corum-agent 有 session-title dep + type import，归阶段 1。
22. session-title-provider-strategy — provider API 迁移；corum-agent 有 dep + type import，归阶段 1。
23. ssh-helper-launch — SSH/PTC launch 配置迁移；corum 无 SSH 引用，不受影响。
24. subagent-activations — backgroundMode/run_in_background 删除 + startActivation；corum-tool-subagent/corum-subagent 直击，归阶段 1+3+4。
25. subagent-preset-composition — persona/toolFilter 拒绝 + agentPreset；corum-tool-subagent 有 persona/toolFilter 字段，归阶段 1+3。
26. team-direct-inbox — team 消息直发 inbox；corum 无 agent-team 引用，不受影响。
27. terminal-command-labels — TerminalBlockLabels 新增 commandLine；corum 有 dep 但不直接使用，归阶段 2+4。
28. tool-presentation-mode — mode: 'both' 拒绝；corum-tools zod schema 含 'both'，归阶段 3。
29. web-listener-trust-config — webRuntime→webStartup + trustedHosts 迁移；corum cordis.patch.yml + boot.ts 直击，归阶段 1+3。
30. working-directory — {{cwd}} 删除 + config.cwd 删除 + presentationMeta PTC；corum cordis.patch.yml:234 有 {{cwd}}，归阶段 1+3+4。
31. deepseek-account-identity-watch — watch 需 opt-in identity；corum 无引用，不受影响。
32. deepseek-account-model-catalog — account models 来自 listing；corum 无引用，不受影响。
33. desktop-font-size-shortcuts — 桌面字号快捷键保留组合；corum 无自定义快捷键冲突，不受影响。
34. from-default-profile-replaces-target — --from-default-profile 替换目标；corum 不走该 CLI，不受影响。
35. operator-connect — non-page clients 默认 interactions: none；corum 不走 non-page Connection，不受影响。
36. pi-ai-azure-provider — azure route 改名；corum ConfigureWizard 有 azure-openai-responses id，归阶段 3+4。
37. pi-ai-model-discovery — 无 credential 时空 catalog；corum 无 pi-ai route fork，归阶段 4。
38. plugin-install-over-installed — HMR 下 installBundle 报 already-installed；corum extension-pack/PluginsPage 有 install/remove 路径，归阶段 3+4。
39. sdk-minimal-image-compaction — sdk-minimal 加 read_image + compaction；corum 不走 sdk-minimal，不受影响。
40. stored-credentials-precedence — stored credentials 优先于环境变量；corum-credentials-local fork 需 rebase，归阶段 3+4。
41. plugin-engines-dsh — 兼容性读 engines.dsh + peers→requirements；corum 0 个 engines.dsh + 无读取代码，不受影响。
42. account-notification-fields — AccountBonusNotification 字段变化；corum 无引用，不受影响。
43. new-session-blank-reuse — rc.2 恢复 blank reuse；corum 自有 startSession RPC，归阶段 4。

### 步骤 5 交叉校验
- grep -c '/guide\.md$' 输出：43
- 映射表有效条目数：43
- 43 vs 43 交叉校验：附录 A 编号 1-43 全部覆盖，无遗漏无重复；逐一对照官方 ls-tree 输出的 43 篇 path → 全部命中。

### 偏差记录

1. **预填 #3 jsonl-persistence-plugin 偏差**：预填「SessionWriteLease 形态（0.1.5 已含，0.2.1 预编译 Node-API flock）」仅描述运行时形态，未指出测试文件的 default import 会断。实测 corum-subagent 有 5 个测试文件使用 `import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'`（default import），0.2.1 删除了 default export，这些测试将编译失败。已在附录 A #3 纠正为「default import 改 namespace import」。

2. **预填 #7 plugin-engines-dsh 偏差**：预填标注「corum 不受影响（待核查 plugin-manager-ui peers 读取）」。实测 grep IncompatiblePlugin/PluginCompatibility/peers 在 corum-ide-plugin-manager-ui 源码零命中，确认不受影响。已在附录 A #7 纠正为「corum 不受影响（已检索 engines.dsh/IncompatiblePlugin/PluginCompatibility）」。

3. **预填 #11 experimental-package-composition 偏差**：预填引用行号 `cordis.patch.yml:199/207/224/236` 不精确。实测 disabled 官方行实际在 `:161`（credentials）、`:194`（api-remotes）、`:205`（subagent）、`:217`（sandbox）、`:226`（goal-round-driver），insert fork 行在 `:262`/`:273`/`:331`/`:354`/`:336`。已在附录 A #11 纠正行号。

4. **预填 #4 working-directory 偏差**：预填提到「corum-tools presentationMeta 嵌套 PTC」但未给出具体引用。实测 `corum-tools/src/schema.ts:497,556,579` 和 `presentation.ts:276,315` 有 presentationMeta。已在附录 A #4 补充引用。

5. **预填 #12 web-listener-trust-config 偏差**：预填引用 `src/host/boot.ts:524-528` 四行链。实测注释在 `boot.ts:524-530`，trustedHosts 在 `:528`，行号范围已修正为 `:524-530`。

6. **新发现：dsh-subagent-in-process-driver 被删**（#1 subagent-activations）：指南明确「The published `@deepseek-ai/dsh-subagent-in-process-driver` package is removed」。corum 同时 dep 它（desktop-host:114 + pnpm-workspace:220）并 fork 它（corum-subagent/src/driver/ 整目录）。预填未提及 dep/override 删除。已在附录 A #1 补充。

7. **新发现：compile.ts preset 行含 backgroundMode**（#1/#2/#16）：corum-agent/src/compile.ts:259,265,271 的 tool-subagent-fork/codex/claude-code preset 行都含 `backgroundMode: 'continuable'/'one-shot'`，需随 subagent-activations 删除。预填未提及。已在附录 A #1/#26 补充。

### 时间
- 2026-10-27 完成全部 43 篇通读 + 逐篇 grep 分析 + 附录 A/B 填写 + HMR 实证 + 自查提交。实际耗时约 3 小时。
```

---

## 开放问题：0.2.1 HMR 形态——已实证并裁决

> **状态：已实证（2026-10-27）。** 结论：`dsh-hmr` 是 `cordis-plugin-hmr` 的官方继任包（不是简单改名，职责扩展），corum 的 `desktop-host` dep + `pnpm-workspace` override **应替换为 `dsh-hmr`**。

### 实证证据

**1. dsh-hmr 与 cordis-plugin-hmr 是替代关系，非并列。**

- 官方 `packages/bundle/base/cordis.patch.yml:28-32`（rc.3）：HMR 行 name = `@deepseek-ai/dsh-hmr`，id = `hmr`，服务键 `ctx.hmr`。
- 官方 `packages/boot/hmr/package.json`：name = `@deepseek-ai/dsh-hmr`，version = `0.2.1-rc.3`，peerDependencies 含 `@deepseek-ai/cordis-plugin-timer/loader/include`（与 cordis-plugin-hmr 对齐）。
- 官方 `packages/boot/hmr/README.md`「Use this package」段明确写道：
  > "Existing configurations replace the module name `@deepseek-ai/cordis-plugin-hmr` with `@deepseek-ai/dsh-hmr`. The `hmr` service key, `baseDir`, `config`, `getLinked()`, `getOuterStack()`, `hmr/change` and `hmr/reload` remain available. **The vendored package remains available; DSH profiles use this package.**"
- 官方 `vendor/hmr/package.json`：name = `@deepseek-ai/cordis-plugin-hmr`，version = `1.0.20`（vendored 旧包仍存在但官方 profile 不用）。
- 官方 `apps/cli/README.md`："`dsh-hmr`, when enabled in YAML, watches the profile manifest and both profile and home patch files, then recomposes all layers through one serialized reload." —— 职责从纯模块热替换扩展到 profile manifest + patch watcher 的协调队列。

**结论**：`dsh-hmr` 是 `cordis-plugin-hmr` 的官方继任包。`hmr` 服务键、`baseDir`/`config`/`getLinked()`/`getOuterStack()`/`hmr/change`/`hmr/reload` 全部保留。cordis-plugin-hmr 作为 vendored 旧包仍存在但官方 profile 不引用。

**2. corum 三份 cordis.patch.yml 没有 hmr 行——hmr 行来自官方 base bundle。**

- `packages/desktop/cordis.patch.yml`：grep `hmr` 零命中（corum 不覆盖 hmr 行，官方 base bundle 的 hmr 行原样穿透）。
- `profile/corum/cordis.patch.yml`：空数组 `[]`。
- `cordis.patch.yml`（根）：grep `hmr` 零命中。

**结论**：corum 不通过 cordis.patch.yml 控制 HMR；HMR 行由官方 base bundle 提供，corum 覆盖 webserver/web-runtime/trustedHosts 等行但不碰 hmr 行。升级后官方 base bundle 的 hmr 行 name 改为 `@deepseek-ai/dsh-hmr`，corum 的 patch 无需改。

**3. corum 的 dep/override 引用的是旧包名 cordis-plugin-hmr。**

- `packages/desktop/desktop-host/package.json:53`：dep `@deepseek-ai/cordis-plugin-hmr ^1.0.16`
- `pnpm-workspace.yaml:292`：override `@deepseek-ai/cordis-plugin-hmr 1.0.17`
- `corum-ide-ui/src/client/settings/plugin-meta.ts:39` + `corum-ide-plugin-manager-ui/src/client/plugin-meta.ts:34`：plugin-meta 中 `@deepseek-ai/cordis-plugin-hmr` 元数据

**结论**：corum 的 dep/override 指向旧包名 `cordis-plugin-hmr`，但官方 base bundle 的 hmr 行已改用 `dsh-hmr`。升级后 pnpm 需要解析 `dsh-hmr`（官方 base bundle 行 name），但 corum 的 dep/override 只给了 `cordis-plugin-hmr`——**如果不替换，HMR 行将无法解析 `dsh-hmr` 包**（override 没有覆盖它）。

### 配置 schema 是否影响 corum

- HMR 的 config 字段（`base`/`root`/`ignored`/`debounce`）无变化，服务键 `ctx.hmr` 不变。
- corum 不通过 inject/ctx.get 引用 `hmr` 服务（grep `ctx.get('hmr'` / `inject.*hmr` 在 corum fork 源码零命中）。
- corum 的 `boot.ts` 不引用 HMR 配置（grep 零命中）。

**结论**：配置 schema 不影响 corum；corum 不消费 `ctx.hmr` 服务。唯一影响是包名替换导致的 dep/override 解析问题。

### 裁决：阶段 1/2 动作

**阶段 1（被删包/改名包）**：
- `desktop-host/package.json:53`：dep `@deepseek-ai/cordis-plugin-hmr ^1.0.16` → `@deepseek-ai/dsh-hmr`（跟随官方 base bundle 行 name）。
- `corum-ide-ui/src/client/settings/plugin-meta.ts:39` + `corum-ide-plugin-manager-ui/src/client/plugin-meta.ts:34`：plugin-meta 中 `@deepseek-ai/cordis-plugin-hmr` → `@deepseek-ai/dsh-hmr`（元数据 zhName/zhDesc 保留）。

**阶段 2（override）**：
- `pnpm-workspace.yaml:292`：override `@deepseek-ai/cordis-plugin-hmr 1.0.17` → `@deepseek-ai/dsh-hmr` <rc.3 版本>（跟随官方 tag 版本）。

**无需改动**：
- 三份 `cordis.patch.yml`：无 hmr 行，官方 base bundle 的 hmr 行原样穿透，name 改 `dsh-hmr` 后 corum 无需改 patch。
- corum fork 源码：不消费 `ctx.hmr` 服务，不 import dsh-hmr/cordis-plugin-hmr（grep 零命中 fork src）。

**03 册 §4.6 前置解除**：本节已完成实证，03 册可据此执行阶段 1/2 的 HMR 相关动作。
