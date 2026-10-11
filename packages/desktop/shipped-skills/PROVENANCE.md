# shipped-skills — 随包分发的技能集

本目录随产品分发（打包时由 `packages/desktop/scripts/pack-macos.mjs` staging 到
host 运行时旁的 `<runtime>/shipped-skills/`，与 `shipped-presets/` 同款）。
用户在「设置 → 技能 → 导入内置技能」时，才由 `@corum/corum-skill-manager` 的
`importBuiltinSkills` 把这些技能装进 `<CORUM_HOME>/skills/`。

**应用启动期不写用户 home**：启动期写入会与用户既有技能抢目录、且难以回滚。
导入是显式动作，规则是「已存在一律不覆盖、用户删过的不复活」（见
`packages/plugins/agent/corum-skill-manager/src/shipped-skills.ts`）。

## 收录判定

判定动作：在官方检出 `/Users/kukucai/dsh` 里 `find . -name SKILL.md`，
**能在官方检出里找到同名 SKILL.md 的才算官方技能**。逐条结论：

| 目录 | 判定 | 来源 |
| --- | --- | --- |
| `dsh-archive-agent-notes` | 收录 | `.agents/skills/dsh-archive-agent-notes/` |
| `dsh-ci-test-reliability` | 收录 | `.agents/skills/dsh-ci-test-reliability/` |
| `dsh-code-review` | 收录 | `.agents/skills/dsh-code-review/` |
| `dsh-doc` | 收录 | `.agents/skills/dsh-doc/` |
| `dsh-find-simplifications` | 收录 | `.agents/skills/dsh-find-simplifications/` |
| `dsh-merging-stacked-prs` | 收录 | `.agents/skills/dsh-merging-stacked-prs/` |
| `dsh-pre-push-checks` | 收录 | `.agents/skills/dsh-pre-push-checks/` |
| `dsh-prose-standard` | 收录（内容有本机改造，见下） | `.agents/skills/dsh-prose-standard/` |
| `dsh-translate-docs` | 收录 | `.agents/skills/dsh-translate-docs/` |
| `dsh-trim-cot-leakage` | 收录（内容有本机改造，见下） | `.agents/skills/dsh-trim-cot-leakage/` |
| `record-browser-gif` | 收录 | `.agents/skills/record-browser-gif/` |
| `cordis-plugin-development` | 收录 | `packages/preset/agent-presets/presets/cordis/skills/cordis-plugin-development/` |
| `editing-cordis-compositions` | 收录 | `packages/preset/agent-presets/presets/cordis/skills/editing-cordis-compositions/` |
| `corum-dev-conventions` | **收录**（2026-10-11 改判，见下「corum 自研技能随包」） | 本仓 `skills/corum-dev-conventions/` |
| `corum-official-upgrade` | **收录**（同上） | 本仓 `skills/corum-official-upgrade/` |
| `corum-cdp-verify` | **收录**（同上） | 本机 `~/.corum/skills/corum-cdp-verify/`（**仓库尚无编写源**，见下） |
| `pencil-to-corum-ide` | **收录**（同上） | 本机 `~/.corum/skills/pencil-to-corum-ide/`（**仓库尚无编写源**） |
| `testSkill` | 排除 | 无官方同名内容；SKILL.md 自称「极简测试Skill，用于验证 Agent 是否正确加载」，是本机试验件 |
| `androidSkill` | 排除 | 无官方同名内容；SKILL.md 自称「安卓 Skill 隔离性对照」，是本机试验件 |

## corum 自研技能随包（2026-10-11 用户定调，**推翻** 2026-09-13 的旧裁决）

旧裁决（2026-09-13）：「`corum-cdp-verify` 与 `corum-dev-conventions` **不随包**，
因为它们是本仓开发向技能，产品用户不需要；源就在本仓 `skills/`，开发机按需
用『设置 → 技能 → 导入技能』装入」。

**用户 2026-10-11 明确改判「随包」**，推翻上述裁决。理由（本次审计发现）：
这些技能被**内置预设**「Corum 开发」绑定（`agent.json` 的 `skills` 字段），而该字段
**不在 `SPEC_SYNCED_FIELDS`**（`corum-agent/src/builtin-profiles.ts:44`）——它是
**用户级配置**，内置 spec 不会自动补齐。因此不随包的直接后果是：
**新装机（或换机器）上，「Corum 开发」这个内置档位绑的 4 个技能全都缺失，档位是空壳。**

本批随包 4 个：`corum-dev-conventions`、`corum-official-upgrade`、
`corum-cdp-verify`、`pencil-to-corum-ide`。

**已知缺口（如实记录，未收口）**：后两个技能**本仓没有编写源**，只在开发机
`~/.corum/skills/` 里——也就是说它们随包的这份是**唯一副本**，源已丢失。
`docs/tasks/log.jsonl` 应追一条待办：把这两份的编写源补进本仓 `skills/`
（补完后，与另两个一样受下面的双份漂移守卫保护）。

## 双份技能的一致性守卫（2026-10-11 加）

`corum-dev-conventions` 与 `corum-official-upgrade` 在本仓有**两份实体**：

- `skills/<name>/` —— **编写源**（`AGENTS.md` / `docs/*.md` 引用它；改规范先改这里）
- `packages/desktop/shipped-skills/<name>/` —— **分发副本**（本目录，打包 staging 用）

两份漂移是「同一事实两处、改一处忘另一处 ⇒ 静默失真」那一类（`docs/LESSONS.md` §4.28 同型）。
`./scripts/verify-fork-drift.sh` 的 §18 现在**逐字节**比对这两份（含反向：分发副本不得
多出源里没有的文件），判据用 `cmp`——**不用 `diff`**，因为本机 PATH 上的 `diff` 是
HarmonyOS SDK 的，会**漏报 0 差异**。

同步命令（改完编写源后）：

```bash
cp -R skills/<name>/. packages/desktop/shipped-skills/<name>/
```

## 内容来源与已知偏离

内容从 `packages/desktop/.corum-dev-home/skills/` 复制，并剔除本机产物
（`.versions/`、`skill-versions.json`、`.git/`、`node_modules/`、`.DS_Store`、`*.tsbuildinfo`）。
剔除后全部是文本，无大二进制
（最大文件 `cordis-plugin-development/SKILL.md` ≈ 21KB）。

官方技能中 10 个与官方检出**逐字节一致**（`cmp` 无差异）。两个例外是
`dsh-prose-standard` 与 `dsh-trim-cot-leakage`——它们的 SKILL.md（以及后者
的 `references/recall-batteries.md`）在 2026-09-12 被改造成「corum 本地副本」，
把 dsh 专属的 `vendor/` 排除集、双语配对门禁、Agent Notes 引用换成了本仓的
`node_modules/` + `.dbg/` + `docs/dev-conventions.md §11`。

**这套偏离是已决事项（2026-09-13）**：随包发出去的是 **corum 适配版**，不是官方原文。
理由：那两处改造把 dsh 专属路径（`vendor/` 排除集、Agent Notes 引用）换成了本仓的
`node_modules/` + `.dbg/` + `docs/dev-conventions.md §11`，对 corum 用户才是可执行的指令；
发官方原文反而会给出指向另一套仓库布局的排除路径。
**升级纪律（重要）**：同步官方技能时**不要**用官方原文直接覆盖这两份——先
`cmp`/`diff`（用 `/usr/bin/diff`，本机 PATH 的 diff 不可信）
`/Users/kukucai/dsh/.agents/skills/<name>/` 与本目录同名技能，
把官方新增内容手工合并（否则会静默丢掉 corum 适配，与 `docs/fork-delta.md` 记录的
「整文件覆盖把定制删掉」事故同型）。

**tombstone 的可撤回出口（已决，2026-09-13，保留）**：用户删掉某个内置技能后，
「导入内置技能」永不把它装回来（这正是 tombstone 的目的）；但**显式**用
`skillManager/importFromFile|Text|Directory` 导入同名技能会撤回该名字的 tombstone
（`deleteSkill` 只对「随包同名」技能记账）。理由：否则用户误删内置技能后永久回不来、
按钮永远报「不复活」——死路一条；而显式导入本身就是「我现在就要它」的意图表达。

## 维护

新增/更新随包技能：把技能目录抄进本目录（剔除产物），同步更新
`packages/plugins/agent/corum-skill-manager/scripts/check-shipped-skills.mjs` 的
`EXPECTED` 清单（**必须与 `readdirSync` 字典序一致**，A2 用 `deepEqual` 比对顺序），
然后跑

```
pnpm --filter @corum/corum-skill-manager run build
pnpm --filter @corum/corum-skill-manager run check:shipped-skills
./scripts/verify-fork-drift.sh
```

自检脚本会核验技能名单、frontmatter（按官方 YAML 口径剥引号）与目录名一致性、
产物残留，并用临时目录夹具断言「首次导入 / 改过不覆盖 / 删过不复活」三条策略。
`verify-fork-drift.sh` 的 §18 会额外守住「编写源 ↔ 分发副本」双份一致。
