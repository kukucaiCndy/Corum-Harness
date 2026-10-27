# dsh 基座 0.1.5-rc.3 → 0.2.1-rc.3 升级实录

> 本文件记录升级全程的逐步执行实况。每个阶段执行时追加内容。
> 执行文档索引：docs/upgrade-0.2.1-rc3/README.md
> 可行性评估：docs/UPGRADE-0.2.1-rc3-feasibility.md

## 基线快照（阶段 0 记录）

| 维度 | 当前基线值 | 记录时间 |
|---|---|---|
| dsh 基座 | 0.1.5-rc.3 | 2026-10-27 09:05 |
| desktop app | 0.7.0（从安装产物 Info.plist 读） | 2026-10-27 09:05 |
| 基座版本 | 0.1.5-rc.3（dsh-v0.1.5-rc.3） | 2026-10-27 09:05 |
| cordis | 4.0.2（从 dsh tag `dsh-v0.1.5-rc.3:vendor/cordis/package.json` 读） | 2026-10-27 09:05 |
| Electron | 43.4.1（从 `packages/desktop/package.json` 读） | 2026-10-27 09:05 |
| node | v26.4.0（homebrew `/opt/homebrew/bin/node --version`） | 2026-10-27 09:05 |
| pnpm | 11.7.0（`package.json` `packageManager` 字段） | 2026-10-27 09:05 |
| override 总数 | 217 = 216 @deepseek-ai/* + 1 electron（`pnpm-workspace.yaml` overrides 段） | 2026-10-27 09:05 |
| minimumReleaseAgeExclude | 433 = 249 @0.1.3-alpha.1 + 184 @0.1.1-rc.2 | 2026-10-27 09:05 |
| fork 包 | 50 = 23 agent + 12 session + 15 ui | 2026-10-27 09:05 |
| 官方包总数 | 278（packages 274 + apps 4，口径 `git ls-tree` package.json 计数） | 2026-10-27 09:05 |
| git HEAD | 2c205dcc240293eb3688eac8b86fd377fa33d9ac | 2026-10-27 08:57 |
| git branch | main | 2026-10-27 08:57 |
| 未推送提交数 | 16（评审时 15，执行时动态确认 16） | 2026-10-27 08:57 |
| 主实例形态 | 主实例 :9222 **未运行**（dev PID 78023 已死、packaged PID 93801 已死，脚本 status 报「未运行」）；PID 文件残留 coding.pid + pack-9222.pid | 2026-10-27 09:04 |
| verify 实例形态 | **存活**：PID 36360（node）、mode=dev、role=verify、port=9333、home=~/.corum（**与主实例共写 home**） | 2026-10-27 09:04 |

### 基线快照汇总表

| 维度 | 当前基线值 | 目标值 |
|---|---|---|
| dsh 基座 | 0.1.5-rc.3 | 0.2.1-rc.3 |
| desktop app | 0.7.0（从安装产物读） | 待定 |
| 基座版本 | 0.1.5-rc.3 | 0.2.1-rc.3 |
| cordis | 4.0.2（从 dsh tag 读） | 4.0.5 |
| Electron | 43.4.1 | 43.4.1（待阶段 4.5 决定是否升 44.7.0） |
| node | v26.4.0（homebrew） | — |
| pnpm | 11.7.0（packageManager） | — |
| override 总数 | 217 条（216 @deepseek-ai/* + 1 electron） | 约 250-300 条 |
| minimumReleaseAgeExclude | 433 条（249 @0.1.3-alpha.1 + 184 @0.1.1-rc.2） | 待清理 |
| fork 包 | 50 个（23+12+15） | 50 个（rebase 后不变） |
| 官方包总数 | 278（packages 274 + apps 4） | 362（packages 352 + apps 10） |
| git HEAD | 2c205dcc | — |
| git branch | main | — |
| 未推送提交数 | 16（动态确认） | — |
| 主实例形态 | 未运行（PID 文件残留）；verify 实例存活 PID 36360/port 9333 | — |

## fork-drift 基线（阶段 0 记录）

- 守卫退出码：**1**（非 0，属预期——不要求 exit code 必须为 0）
- 真实 tag 导出：**成功，无回落**（日志 `[baseline] 官方基线 = dsh-v0.1.5-rc.3（a4c74a91e0）`，无「无法导出」或「回落到检出工作区」字样）
- 失败项数：**N = 3**
- 运行环境：`TMPDIR="$PWD/.corum-tmp" DSH_CHECKOUT=/Users/kukucai/dsh DSH_BASELINE_TAG=dsh-v0.1.5-rc.3 ./scripts/verify-fork-drift.sh`
- 完整输出存档：`.corum-tmp/stage0-fork-drift-baseline.log`（临时证据，未入库）

### 3 项失败清单

1. **[15] corum-sandbox-local `src/index.ts` 与官方有差异**：
   - `✗ src/index.ts 与官方有差异——增量必须只在 profiles.ts / git-write-roots.ts（否则每次升级三方合并面扩大）`
   - 其余子项全部 ✓（profiles.ts 三个平台 builder、git-write-roots.ts、desktop patch、package.json、deploy 清单、pack-macos 断言）

2. **[17] orchestrate 缺 script 模式接线**：
   - `✗ orchestrate 缺 script 模式接线（引擎/隔离 provider 选择）`
   - 但 `✓ orchestrate script 模式：isolate:'off' 绕过口已清除`（部分通过）
   - 其余 orchestration 子项全部 ✓

3. **[18] corum-cdp-verify 技能副本与仓库不一致**：
   - `✗ 技能副本 scripts/ui-verify.mjs 与仓库不一致 —— 同步：cp scripts/ui-verify.mjs "/Users/kukucai/.corum/skills/corum-cdp-verify/scripts/"`
   - `✓ 技能自带 SKILL.md`

> **判定标准**：真实 tag 导出成功（无回落警告）✓；N=3 项失败已归档到实录 ✓。后续升级不得新增失败项——阶段 4 的 fork-drift 验证对照本阶段记录的基线 N=3，只许收敛不许扩大。

## 回滚最低集合

- [x] home 一致备份（$BACKUP_ROOT/home/，排除 engines/sd-models + bin/*.part，kv.sqlite 经 sqlite3 .backup 在线一致）
- [x] 主 user-data（$BACKUP_ROOT/user-data/）
- [x] Corum.app（$BACKUP_ROOT/Corum.app/，版本 0.7.0）
- [x] git 基线 commit（2c205dcc，含 pnpm-lock.yaml）
- [x] dsh-v0.1.5-rc.3 tag（dsh 仓本地已有）
- [x] 备份 manifest（$BACKUP_ROOT/manifest.md）

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

## 阶段 0：前置准备（实录）

### 步骤 1：完整备份

- 备份开始时间：2026-10-27 09:00:17
- 备份根目录：`/Users/kukucai/corum-upgrade-backups/pre-0.2.1-rc3-20261027-090017`
- 源路径与排除项：
  - home：`~/.corum/`（rsync `--exclude='engines/sd-models/' --exclude='bin/*.part'`）
  - user-data：`~/Library/Application Support/corum-desktop-ud-minimal-9222/`
  - Corum.app：`/Applications/Corum.app`（版本 0.7.0）
- 备份结束时间：2026-10-27 09:03:03
- 耗时：约 3 分钟
- 磁盘占用：
  - home：730M
  - user-data：336M
  - Corum.app：1.7G
  - 合计：约 2.77 GB
- manifest 路径：`$BACKUP_ROOT/manifest.md`
- git HEAD：2c205dcc240293eb3688eac8b86fd377fa33d9ac
- git branch：main

**验证结果**：
- a) 目录级完整性：sessions/profiles/skills/extension-packs/.agent-presets/storages 全部存在且非空（无 MISSING 输出）✓
- b) 稳定文件 SHA256 一致（5 对 hash 全部匹配，只显示 hash 不显示内容）✓
  - .credentials.yaml: src=bak ✓
  - .master-key: src=bak ✓
  - settings.yaml: src=bak ✓
  - mcp-servers.json: src=bak ✓
  - sessions.json: src=bak ✓
- c) 备份目录大小：home 730M（预期约 600 MB，合理）✓
- d) Corum.app Info.plist 版本 = 0.7.0 ✓
- e) manifest 存在 ✓
- f) 会话 cf58d502 相关文件存在于备份：`$BACKUP_ROOT/home/sessions/--Users-kukucai-work-corum-dev-preset--/cf58d502-c658-48e2-9eb6-36afc562b468/`（含 session.v3.jsonl.zstd + session.lock）✓
- g) 稳定目录二次 rsync dry-run 无差异输出 ✓

### 步骤 2：SQLite 在线一致性备份

- 命令：`sqlite3 "$SOURCE_DB" ".backup '$BACKUP_DB'"`
- SOURCE_DB：`/Users/kukucai/.corum/storages/kv.sqlite`
- BACKUP_DB：`$BACKUP_ROOT/home/storages/kv.sqlite`
- WAL/SHM 删除：备份侧 `kv.sqlite-wal` 和 `kv.sqlite-shm` 已删除（rsync 复制来的 + sqlite3 .backup 可能产生的均已清理）✓
- integrity_check：**ok** ✓
- user-data 热副本 caveat：Electron user-data 无法用 sqlite3 .backup 统一处理（含 IndexedDB/LevelDB 等多种格式），仅作为 rsync 热副本；恢复时如需一致 user-data，须先停实例后重备（本阶段不停实例）。

### 步骤 3：工作区 commit + push

- 执行前 git HEAD：2c205dcc240293eb3688eac8b86fd377fa33d9ac
- 执行前未推送提交数：16（动态确认 `git log --oneline origin/main..HEAD | wc -l`）
- 工作区状态：已提交本阶段文档（commit `ba46d008`，3 files changed, 352 insertions(+), 18 deletions(-)）
- push 结果：直推 origin/main 被 GitHub 分支保护拒绝（`GH006: Protected branch update failed for refs/heads/main. Changes must be made through a pull request.`），改经 PR #155 推送。本地 HEAD=`ab9df571`，origin/main=`6647d914`，18 笔未推送（全部 docs 提交）。**本 PR（#155）合并即完成阶段0 远程回滚点**——合并后本地与远程同步，工作区干净，未推送提交数归零。

### 步骤 4：fork-drift 真实基线

- 运行命令：`TMPDIR="$PWD/.corum-tmp" DSH_CHECKOUT=/Users/kukucai/dsh DSH_BASELINE_TAG=dsh-v0.1.5-rc.3 ./scripts/verify-fork-drift.sh`
- TMPDIR 设置：`$PWD/.corum-tmp`（防止 mktemp 在 `/var/folders` 被沙箱拒绝导致回落到工作区）
- 真实 tag 导出：**成功，无回落**（日志开头 `[baseline] 官方基线 = dsh-v0.1.5-rc.3（a4c74a91e0）`，无「无法导出」或「回落到检出工作区」字样）✓
- 退出码：**1**（非 0，属预期——不要求 exit code 必须为 0）
- 失败项数：**N = 3**
- 完整输出存档：`.corum-tmp/stage0-fork-drift-baseline.log`（临时证据，未入库）

**3 项失败清单**：
1. [15] corum-sandbox-local `src/index.ts` 与官方有差异（增量必须只在 profiles.ts / git-write-roots.ts）
2. [17] orchestrate 缺 script 模式接线（引擎/隔离 provider 选择）
3. [18] corum-cdp-verify 技能副本 `scripts/ui-verify.mjs` 与仓库不一致

### 步骤 5：确认 dsh 仓 tag dsh-v0.2.1-rc.3 存在

- `git -C /Users/kukucai/dsh tag -l 'dsh-v0.2.1-rc.3'` 输出：`dsh-v0.2.1-rc.3` ✓
- `git -C /Users/kukucai/dsh rev-parse dsh-v0.2.1-rc.3` 输出：`1f81c047fc48fa190a683e469daa699857e9afe8` ✓
- `git -C /Users/kukucai/dsh rev-parse HEAD` 输出：`687f282e8625c6b8d11ff58211a90524be2e4317`（当前 dsh HEAD，不必等于 rc.3，只需 tag 存在即可用 git show）

### 步骤 6：基线快照

（已记入上方「基线快照」小节）

### 步骤 8：实例状态确认

- **主实例 :9222**：**未运行**。脚本 `scripts/corum-instance.sh status` 报「未运行（home=/Users/kukucai/.corum mode=dev port=9222）」。PID 文件残留：
  - `coding.pid`：`{"pid":78023,"combo":"coding","home":"/Users/kukucai/.corum","debugPort":9222,"startedAt":1792943254,"mode":"dev","tag":"background"}` — PID 78023 **已死**（ps 查无此进程）
  - `pack-9222.pid`：`{"pid":93801,"combo":"coding","home":"/Users/kukucai/.corum","debugPort":9222,"startedAt":1792684787,"kind":"packaged"}` — PID 93801 **已死**（ps 查无此进程）
- **verify 实例 :9333**：**存活**。PID 36360（node 进程，ps 确认存活）、mode=dev、role=verify、port=9333、home=`/Users/kukucai/.corum`（**与主实例共写 home——风险说明见下**）。
- **verify 共写 home 风险**：verify `--home=verify` 实际 home 仍为 `~/.corum`（非隔离）；备份期间 verify 在跑会影响一致性。本阶段备份已完成，verify 实例在备份期间持续运行。后续阶段需独立临时 home，不依赖 verify 隔离。
- **禁止启停纪律**：本阶段未执行 start/stop/restart/update 任何实例操作。主实例已自行停止（非本阶段操作所致），未重启。

### 偏差记录

1. **未推送提交数偏差**：评审时（02 册快照）记录 15 笔，执行时动态确认实际为 **16 笔**。评审后新增了 1 笔提交（`2c205dcc docs: 强化阶段0备份一致性与真实基线门禁`）。已按动态值记录。
2. **主实例形态偏差**：02 册预期「dev/packaged、home、port」隐含实例在跑。执行时实测主实例 **未运行**（PID 已死、脚本报「未运行」）。这不影响备份完整性（热副本 + sqlite3 .backup 覆盖了 kv.sqlite 一致性），但记录为偏差：主实例在备份期间不在跑，实际上降低了备份期间 home 活动写入风险。
3. **minimumReleaseAgeExclude 行号偏差**：02 册命令 `sed -n '308,$p'` 但实际 `minimumReleaseAgeExclude:` 在第 307 行（entries 从 308 开始）。修正为 `sed -n '308,$p'` 计数 433，与预期一致。
4. **fork-drift N 项偏差**：历史交接口径曾记录 24 项（无在库证据），评审试跑得 23 项但 TMPDIR 失效回落 rc.2 无效。真实 tag 导出重跑结果：**N = 3 项**（显著少于历史口径，可能因 fork 源码已修复部分项或守卫登记已更新）。
5. **push 阻塞偏差**：用户已授权 `git push origin main`，但 GitHub 仓库 `kukucaiCndy/Corum-Harness` 的 `main` 分支受分支保护规则保护（`GH006: Protected branch update failed`），拒绝直接推送。已改经 PR #155 推送——**本 PR 合并即完成阶段0 远程回滚点**，阶段0 push 门禁随 PR 合并完成（不再是阻塞）。

### 时间

- 开始：2026-10-27 08:57:39
- 备份完成：2026-10-27 09:03:03
- fork-drift 完成：2026-10-27 09:06（约 1 分钟）
- 全阶段完成：2026-10-27 09:15（含实录撰写）
- 实际耗时：约 18 分钟（备份 3 分钟 + SQLite + 验证 + fork-drift + 快照 + 实录）

## 阶段 1：被删/更名包处理

> 总原则：阶段 1 不改 `pnpm-workspace.yaml`；`build/host` 和 `dist` 是生成物，不手改进 commit（阶段 2 重新 deploy/pack 消除）。
> 分支：`upgrade/0.2.1-rc3`（从 main `bacd04ab` 创建）。不 push（本阶段统一完成后处理）。

### 阶段 1 · 处置对象 ①：dsh-invariants 方案 A（跟随官方删除）

- 执行时间：2026-10-27 10:10
- 执行者：delegated worker（main tree，isolation: main）
- commit hash：`fb4cb9fe`
- 分支：`upgrade/0.2.1-rc3`

#### 修改清单（22 个文件，净删 726 行）

| # | 文件 | 操作 |
|---|---|---|
| 1 | `corum-goal-round-driver/src/invariant.ts` | 删除（87 行） |
| 2 | `corum-tool-subagent/src/invariant.ts` | 删除（60 行） |
| 3 | `corum-subagent/src/invariant.ts` | 删除（92 行） |
| 4 | `corum-tools/src/invariant.ts` | 删除（128 行） |
| 5-8 | 4 包 `package.json` | 删 `dsh-invariants` dep（含 corum-tools 的 peerDep+devDep）+ `./invariant` exports 子路径 |
| 9-12 | 4 包 `tsdown.config.ts` | 删 external `@deepseek-ai/dsh-invariants` + entries invariant 入口 + 头注释同步（tool-subagent/subagent） |
| 13 | `corum-subagent/tests/invariant.spec.ts` | 整删（96 行） |
| 14 | `corum-tools/tests/invariant.spec.ts` | 整删（239 行） |
| 15 | `corum-subagent/tests/continuation.spec.ts` | 删 2 处 import（InvariantRegistry/SubagentInvariant）+ 2 处 ctx.plugin 挂载行 |
| 16 | `corum-tools/tests/README.md` | 同步删 invariant.spec.ts 引用 + sha256 对比清单从 10→9 模块 |
| 17 | `packages/desktop/desktop-host/package.json` | 删 `@deepseek-ai/dsh-invariants` dep（唯一跟踪源） |
| 18 | `packages/desktop/cordis.patch.yml` | 删 `:401` invariant 注释 |
| 19 | `scripts/verify-fork-drift.sh` | [16b] 循环清单删 invariant.ts（9→8 模块）+ [16] `SUBAGENT_DELTA_FILES` 删 invariant.ts + `:1174` 注释 + **case 豁免 invariant.ts**（官方遍历发现 fork 缺该文件时的豁免，类似 catalog.ts） |
| 20 | `docs/upgrade-0.2.1-rc3/03-removed-packages.md` | 修正步骤 ①-5 矛盾：只删 desktop-host dep，build/host 生成物和 pnpm-workspace override 全部留阶段 2 |
| 21 | `corum-tools/vitest.config.ts` | 删 `@deepseek-ai/dsh-tools/invariant` alias 项 + 头注释 spec 说明符计数 4→3（独立验收尾项补充） |
| 22 | `corum-tools/tsconfig.spec.json` | 删 `@deepseek-ai/dsh-tools/invariant` paths 行（独立验收尾项补充） |

#### build/typecheck/test 精确数字（旧 0.1.5-rc.3 基线）

| 包 | build | typecheck | test |
|---|---|---|---|
| `corum-goal-round-driver` | ✅ 1 文件 18.23 kB | ✅ 0 错 | ✅ 1 文件 9 测试通过 |
| `corum-tool-subagent` | ✅ 3 文件 188.56 kB | ✅ 0 错（含 spec） | ✅ 18 文件 434 测试通过 |
| `corum-subagent` | ✅ 6 文件 251.78 kB | ✅ 0 错 | ✅ 21 文件 469 测试通过（含 continuation.spec.ts 126 测试，"cold-resumes after the initial provider unregisters" 存活用例通过） |
| `corum-tools` | ✅ 3 文件 152.16 kB | ✅ 0 错（含 spec） | ✅ 10 文件 370 测试通过 |
| **合计** | 4 包全绿 | 0 错 | **1282 测试通过，0 失败** |

> 测试数下降 14+13=27 属预期（两个 invariant.spec.ts 整删，分别 4+10=14 和 11=13 项，含 continuation.spec.ts 不变但少 2 行 invariant 挂载不影响用例数）。

#### drift 逐项身份（真实 tag `dsh-v0.1.5-rc.3`，无回落）

```
[baseline] 官方基线 = dsh-v0.1.5-rc.3（a4c74a91e0）
```

drift 失败 **2 项**（阶段 0 已归档的 3 项中 ui-verify 已同步技能副本消除，剩余 2 项身份比对）：

| # | 失败项 | 身份 | 阶段 0 |
|---|---|---|---|
| 1 | `src/index.ts 与官方有差异——增量必须只在 profiles.ts / git-write-roots.ts` | sandbox-local index.ts 未登记差异 | ✅ 阶段 0 可接受 |
| 2 | `orchestrate 缺 script 模式接线（引擎/隔离 provider 选择）` | orchestrate script 接线 | ✅ 阶段 0 可接受 |

> 阶段 0 基线原为 3 项（sandbox-local / orchestrate / ui-verify）。本次 ui-verify 的 2 条技能副本不一致因同步 `verify-fork-drift.sh` + `ui-verify.mjs` 到 `~/.corum/skills/corum-cdp-verify/scripts/` 而消除（非新增、非消失——同步动作本身消除了它）。故本次 N=2 < 阶段 0 的 3，逐项身份确认无新增漂移。

`[16b]` 和 `[16]` 两节**零新增 ✗**（特别确认无 "fork #9 缺官方文件 src/invariant.ts"、无 corum-tools invariant 相关项）。

日志保存：`.corum-tmp/stage1-invariants-fork-drift.log`。

#### 偏差记录

1. **03 册步骤 ①-5 矛盾修正**：最新总原则已裁决「阶段 1 不改 pnpm-workspace.yaml；build/host 生成物不手改」，但 §4.1 步骤 ①-5 仍写删三处（desktop-host/build/host/pnpm-workspace）。已修正为只删跟踪源 `desktop-host/package.json` 的 dsh-invariants dep；build/host 和 pnpm-workspace override 及 minimumReleaseAgeExclude 历史行全部留阶段 2。该 docs 修正并入对象 ① commit（不单独先提交到 main）。
2. **verify-fork-drift.sh case 豁免 invariant.ts**：03 册步骤 ①-7 只指示改 [16b] 循环清单 + [16] `SUBAGENT_DELTA_FILES` + `:1174` 注释，但未提及 [16] 的官方文件遍历循环（`:1184`）会发现 fork 缺 `invariant.ts` 并报 `fail "fork #9 缺官方文件 src/invariant.ts"`。实跑 drift 时确实报此错。修法：在 case 豁免列表（与 catalog.ts 同型）添加 `invariant.ts` continue 分支，附 2026-10-27 注释说明删除原因。
3. **技能副本同步**：修改 `verify-fork-drift.sh` 后，`~/.corum/skills/corum-cdp-verify/scripts/verify-fork-drift.sh` 副本与仓库不一致（[18] 节报 ✗）。同步 `cp scripts/verify-fork-drift.sh ~/.corum/skills/corum-cdp-verify/scripts/`（及 `ui-verify.mjs`）消除。
4. **lib 残留清理**：4 包 `lib/invariant.js` + `lib/types/invariant.{js,d.ts,js.map}` + `build/host/node_modules/@corum` 下 invariant 残留全部先 rm 再 build（`clean:false` 下不先 rm 会导致死代码复活）。
5. **pnpm-lock 临时更新后恢复**：`pnpm install --no-frozen-lockfile` 临时更新 lockfile 使 node_modules 与删 dep 后的 package.json 一致（CI=true 触发 frozen-lockfile 失败）。build/test 验证后 `git checkout -- pnpm-lock.yaml` 恢复，commit 不含 lock。

#### 遗留问题

- `build/host/package.json:114` 和 `dist/win-unpacked/.../host/package.json:113` 仍含 `dsh-invariants` dep（生成物，`.gitignore` 忽略，不在 commit）。阶段 2 重新 deploy/pack 消除。
- `pnpm-workspace.yaml` 的 override 行 `:155` 及 `:397`/`:587` 历史 ignore 段仍含 `dsh-invariants`。阶段 2 清理。
- 阶段 1 整体仍进行中（对象 ① 完成，②~⑧+附 待执行）。

### 阶段 1 · 处置对象 ②：dsh-code-runtime → dsh-ptc-runtime 更名

- 执行时间：2026-10-27 11:15
- 执行者：delegated worker（main tree，isolation: main）
- commit hash：`eb0e5a13`
- 分支：`upgrade/0.2.1-rc3`
- 改动文件数：9

#### 修改清单

| # | 文件 | 操作 |
|---|---|---|
| 1 | `corum-tools/src/index.ts:17` | import `dsh-code-runtime` → `dsh-ptc-runtime` |
| 2 | `corum-tools/src/index.ts:41` | 注释 `dsh-code-runtime` → `dsh-ptc-runtime` |
| 3 | `corum-tools/src/index.ts:1038` | 报错文案 `dsh-code-runtime-worker-thread` → `dsh-ptc-runtime-node` |
| 4 | `corum-tools/src/py-types.ts:5` | JSDoc `dsh-code-runtime#CodeRuntime.language` → `dsh-ptc-runtime#PtcRuntime.language` |
| 5 | `corum-tools/src/ptc.ts:12` | import 改名 |
| 6 | `corum-tools/tests/ptc.spec.ts:7-8` | import 改名 |
| 7 | `corum-tools/package.json` | peerDep+devDep 改 `dsh-ptc-runtime` ^0.2.1-rc.3 |
| 8 | `corum-tools/tsdown.config.ts` | external 改名 |
| 9 | `corum-ide-ui` + `corum-ide-plugin-manager-ui` plugin-meta | 键名改 `dsh-ptc-runtime-node` |
| 10 | `desktop-host/package.json:75` | dep 改 `dsh-ptc-runtime` = 0.2.1-rc.3 |

#### 验证结果
- 静态 grep `dsh-code-runtime`：✅ 零命中（排除 lib/dist/build/node_modules）
- **偏差**：步骤 ②-5 要求 build 三包，但 `CodeRuntime` → `PtcRuntime` 等类型名重命名（+ `dsh-sandbox` 等结构性变更）属阶段 3 fork-rebase，阶段 1 仅做包名重定向。中间态不可编译属预期。
- lib 产物（`py-types.d.ts`/`ptc.d.ts` 中残留旧名）被 `.gitignore` 忽略，阶段 3 rebase 后重 build 自动更新。

### 阶段 1 · 处置对象 ③：dsh-subagent-in-process-driver 删除

- 执行时间：2026-10-27 11:25
- 执行者：delegated worker（main tree，isolation: main）
- commit hash：`0ad06261`
- 改动文件数：3

#### 修改清单

| # | 文件 | 操作 |
|---|---|---|
| 1 | `corum-subagent/src/driver/index.ts:11` | JSDoc `@module` 改指 `@deepseek-ai/dsh-subagent` |
| 2 | `corum-subagent/src/driver/structured.ts:10` | JSDoc `@module` 改指 `@deepseek-ai/dsh-subagent/structured` |
| 3 | `desktop-host/package.json:113` | 删 `dsh-subagent-in-process-driver` dep |

#### 验证结果
- 静态 grep `dsh-subagent-in-process-driver`：✅ 零命中（排除 lib/dist/build/node_modules；独立验收发现 `corum-subagent/package.json:4` description 历史叙述文字曾残留旧名，已在尾项修正中清除 → 现为真零）
- 无实质 driver 合并到 spawn-in-process（避免错误做法）

### 阶段 1 · 处置对象 ④：dsh-agent-presets → registry 类型重定向

- 执行时间：2026-10-27 11:35
- 执行者：delegated worker（main tree，isolation: main）
- commit hash：`065bc609`
- 改动文件数：14

#### 修改清单

| # | 文件 | 操作 |
|---|---|---|
| 1 | `corum-agent/src/agent-service.ts:49` | type import → `dsh-agent-preset-registry` |
| 2 | `corum-agent/src/agent-service.ts:378` | 注释 → `dsh-agent-preset-registry` |
| 3 | `corum-agent/src/preset-reload.ts:37` | type import → `dsh-agent-preset-registry` |
| 4 | `corum-agent/src/compile.ts:75,81` | 注释 → `dsh-agent-preset-registry` |
| 5 | `corum-agent/tsdown.config.ts:24` | external → `dsh-agent-preset-registry`（保留 external，不 inline） |
| 6 | `corum-agent/package.json:44,88` | peerDep+devDep → `dsh-agent-preset-registry` ^0.2.1-rc.3 |
| 7 | `corum-subagent/src/child-agent.ts:28` | type import → `dsh-agent-preset-registry` |
| 8 | `corum-subagent/tsdown.config.ts:13` | external → `dsh-agent-preset-registry`（保留） |
| 9 | `corum-subagent/package.json:40` | dep → `dsh-agent-preset-registry` ^0.2.1-rc.3 |
| 10 | `corum-api-remotes/src/index.ts:26` | type import → `dsh-agent-preset-registry/types` |
| 11 | `corum-api-remotes/src/client/index.ts:4,23,52` | 值导入+type export → registry/remote + registry/types |
| 12 | `corum-api-remotes/package.json:44` | dep → `dsh-agent-preset-registry` ^0.2.1-rc.3 |
| 13 | `desktop-host/package.json:60` | dep → `dsh-agent-preset-registry` = 0.2.1-rc.3 |
| 14 | `corum-ide-ui` + `corum-ide-plugin-manager-ui` plugin-meta | 键名 → `dsh-agent-preset-registry`（退出 grep 门禁需改） |

#### 验证结果
- 静态 grep `dsh-agent-presets`：✅ 零命中（排除 lib/dist/build/node_modules）
- preset YAML/settings/动态发现迁移全部留阶段 3（§3.6 台账 #1/#2/#5/#6）

### 阶段 1 · 处置对象 ⑤：dsh-session-title 版本跟随（无 provider 重写）

- 执行时间：2026-10-27 11:40
- 执行者：delegated worker（main tree，isolation: main）
- commit hash：`6098b23b`
- 改动文件数：2

#### 修改清单

| # | 文件 | 操作 |
|---|---|---|
| 1 | `corum-agent/package.json:55,99` | dep+devDep `dsh-session-title` ^0.1.5-rc.3 → ^0.2.1-rc.3 |
| 2 | `desktop-host/package.json:104` | `dsh-session-title-llm` 0.1.5-rc.3 → 0.2.1-rc.3 |

#### 验证结果
- 静态 grep `registerSessionTitleLlmProvider`/`generateSessionTitleWithLlm`：✅ 零命中（corum 无自定义 provider）
- `import type {}` 保留（包未删，类型路径不变）

### 阶段 1 · 处置对象 ⑥：HMR dep + plugin-meta 替换

- 执行时间：2026-10-27 11:45
- 执行者：delegated worker（main tree，isolation: main）
- commit hash：`c8d18b26`
- 改动文件数：3

#### 修改清单

| # | 文件 | 操作 |
|---|---|---|
| 1 | `desktop-host/package.json:53` | `cordis-plugin-hmr` ^1.0.16 → `dsh-hmr` 0.2.1-rc.3 |
| 2 | `corum-ide-ui/src/client/settings/plugin-meta.ts:39` | 键名 → `dsh-hmr` |
| 3 | `corum-ide-plugin-manager-ui/src/client/plugin-meta.ts:34` | 键名 → `dsh-hmr` |

#### 验证结果
- 静态 grep `cordis-plugin-hmr`：✅ 零命中（排除 lib/dist/build/node_modules）
- `dsh-client-hmr` 不动（0.2.1 仍存在）；组合无 hmr 行（来自官方 base bundle，corum 不覆写）
- vendor override 全部留阶段 2

### 阶段 1 · 处置对象 ⑦：trustedHosts 死配置清除

- 执行时间：2026-10-27 11:50
- 执行者：delegated worker（main tree，isolation: main）
- commit hash：`47871d51`
- 改动文件数：2

#### 修改清单

| # | 文件 | 操作 |
|---|---|---|
| 1 | `cordis.patch.yml:40` | web-runtime 行删 `trustedHosts: []`，保留 openBrowser/printUrl/surfaceContext |
| 2 | `boot.ts:524-532` | 更新注释：trustedHosts 已从 web-runtime 移到 ctx.webStartup.trustedHosts |

#### 验证结果
- `grep -A5 'id: web-runtime' | grep 'trustedHosts'`：✅ 零命中
- `openBrowser/printUrl/surfaceContext`：✅ 3 行命中
- corum pin `127.0.0.1` 不触发通配 host 拒载；fork 源码零处消费 `ctx.webRuntime`

### 阶段 1 · 处置对象 ⑧：{{cwd}} 全量清除

- 执行时间：2026-10-27 12:00
- 执行者：delegated worker（main tree，isolation: main）
- commit hash：`ed99e7a4`
- 改动文件数：12

#### 修改清单

| # | 文件 | 操作 |
|---|---|---|
| 1 | `corum-agent/src/compile.ts:333-338,380,383,488-490` | BASE_MODE_PERSONA 删 `Your working directory is {{cwd}}.` 句 + composePersonaPrefix segments 删 cwd + 注释同步 |
| 2 | `corum-subagent/src/child-roles.ts:87-108,116` | SELF_FACTS 删 `, in the working directory {{cwd}}` + 注释大量同步 |
| 3 | `corum-subagent/src/types.ts:224` | 注释删 `{{cwd}}` 引用 |
| 4 | `corum-subagent/src/isolated/index.ts:12` | 注释删 `{{cwd}}` |
| 5 | `corum-agent/src/output-language.ts:28-30` | 注释删 `{{cwd}}` 引用 |
| 6 | `corum-agent/src/agent-service.ts:692` | 注释删 `{{cwd}}` 引用 |
| 7 | `cordis.patch.yml:198,233` | 注释删 `{{cwd}}` + system-prompt persona 删 cwd 句 |
| 8-11 | `shipped-presets/official/{standard,ptc,cordis,conductor}/agent.cordis.yml` | persona suffix 行删 cwd + 注释同步 |
| 12 | `corum-subagent/tests/child-role-facts.spec.ts` | 断言从 model+cwd 改为只 model（4 处） |

#### 验证结果
- 静态 grep `{{cwd}}`：✅ 零命中（排除 lib/dist/build/node_modules；独立验收发现 `corum-subagent/package.json:4` description 历史叙述文字曾残留 `{{cwd}}`，已在尾项修正中清除 → 现为真零）
- 不替换硬编码路径；新 user context 机制留阶段 3（§3.6 台账 #4）

### 阶段 1 · 处置对象（附）：官方 preset 行 backgroundMode 死键删除

- 执行时间：2026-10-27 12:10
- 执行者：delegated worker（main tree，isolation: main）
- commit hash：`33dc7b19`
- 改动文件数：5

#### 修改清单

| # | 文件 | 操作 |
|---|---|---|
| 1 | `corum-agent/src/compile.ts:259,265,271` | 官方 dsh-tool-subagent disabled 行删 `backgroundMode`，保留整行+`disabled:true` |
| 2-5 | `shipped-presets/official/{standard,ptc,cordis,conductor}/agent.cordis.yml` | tool-subagent-codex/claude-code disabled 行删 `backgroundMode` |

#### 验证结果
- `grep 'backgroundMode' compile.ts`：✅ 仅 `:100` corum 自有键命中
- `shipped-presets` backgroundMode：✅ 仅 corum 自有行（`@corum/corum-tool-subagent`）保留
- **偏差**：`shipped-presets/official/cordis/skills/editing-cordis-compositions/SKILL.md` 含 `backgroundMode: one-shot` 示例文本，属技能文档非 preset 行，未改（不在 §4.9 范围内）。**（注：SKILL.md:92 的 `dsh-workflow-worker-thread` 旧包名已在阶段 2 加固 commit `97da7216` 中改为 `dsh-workflow`，见 S4.6。）**

### 阶段 1 · 依赖解析验证

- 执行时间：2026-10-27 12:15
- 命令：`CI=true pnpm install --no-frozen-lockfile`
- 结果：**解析成功**，0 `ERR_PNPM` error
- 警告：`[WARN] Issues with peer dependencies found`（混合依赖树预期——旧 0.1.5 override 钉版与新 0.2.1 peer 交叉）
- `pnpm peers check`：No peer dependency issues found
- lockfile 变更：+5 packages -2 packages（新增 `dsh-ptc-runtime`/`dsh-agent-preset-registry`/`dsh-hmr`@0.2.1-rc.3，删 `dsh-code-runtime`/`dsh-subagent-in-process-driver`@0.1.5-rc.3）
- **lockfile 恢复**：`git checkout -- pnpm-lock.yaml`，commit 不含 lock ✅
- **pnpm-workspace.yaml 未改** ✅

### 阶段 1 · 静态门禁 §5 矩阵

| # | 门禁项 | 结果 |
|---|---|---|
| 5.1 | ① 单独可绿（旧 0.1.5 基线） | ✅ 见对象 ① 实录（4 包 build/test 1282 通过 + drift N=2） |
| 5.2 | 静态断链矩阵全清 | ✅ 全部零命中（独立验收后发现并修正了 corum-tools 测试基建残留的 invariant alias/paths + corum-subagent description 旧叙述，现为真零） |
| 5.3 | 全仓 grep 旧包名零命中 | ✅ ①~⑥ 全零（仅 pnpm-workspace.yaml 历史 ignore 段残留，阶段 2 清理；独立验收并修正后 description/测试基建旧名亦清零） |
| 5.4 | 一次 install 解析成功 | ✅ 0 ERR_PNPM error |
| 5.5 | lockfile 恢复 | ✅ commit 不含 lock |
| 5.6 | 已知不可 boot 项台账显式标注 | ✅ 6 项「阶段 3 处置」（§3.6） |
| 附 | invariant.ts 文件不存在 | ✅ 零命中 |
| 附 | lib/invariant* 残留 | ✅ 零命中 |
| 附 | compile.ts backgroundMode 仅 :100 | ✅ |

### 阶段 1 · git diff --check + 工作树状态

- `git diff --check`：✅ 无空格错误
- `git status --short`：✅ 空输出（所有源码均 commit）
- `pnpm-workspace.yaml`：✅ 未改（HEAD~9 diff 为空）
- `pnpm-lock.yaml`：✅ 未改（HEAD~9 diff 为空）

### 阶段 1 · 提交总览（9 个 commit，对象 ①~⑧+附）

| # | commit hash | message |
|---|---|---|
| ① | `fb4cb9fe` | upgrade(0.2.1-rc3): 删除 dsh-invariants（方案 A 跟随官方） |
| ② | `eb0e5a13` | upgrade(0.2.1-rc3): dsh-code-runtime → dsh-ptc-runtime 更名 |
| ③ | `0ad06261` | upgrade(0.2.1-rc3): 删除 dsh-subagent-in-process-driver 依赖 |
| ④ | `065bc609` | upgrade(0.2.1-rc3): dsh-agent-presets → registry 类型重定向 |
| ⑤ | `6098b23b` | upgrade(0.2.1-rc3): dsh-session-title 版本跟随（无 provider 重写） |
| ⑥ | `c8d18b26` | upgrade(0.2.1-rc3): HMR dep + plugin-meta 替换为 dsh-hmr |
| ⑦ | `47871d51` | upgrade(0.2.1-rc3): 删除 web-runtime 行 trustedHosts 死配置 |
| ⑧ | `ed99e7a4` | upgrade(0.2.1-rc3): 清除 {{cwd}} 未解析变量引用 |
| 附 | `33dc7b19` | upgrade(0.2.1-rc3): 删官方 preset 行 backgroundMode 死键（留行留 disabled） |

### 阶段 1 · 已知不可 boot 项台账（§3.6，6 项阶段 3 处置）

> 阶段 1 结束的树是**装得上、起不来**的——以下各项必须在阶段 3 处置。

1. preset 目录扫描（`~/.agent-presets/<id>/agent.cordis.yml` 运行期发现+挂载）→ 阶段 3
2. settings `agent-presets` 默认 preset 失效 → 阶段 3
3. corum 自有 activation/backgroundMode/persona/toolFilter 机制 → 阶段 3
4. `{{cwd}}` 清除后的新 user context 机制 → 阶段 3（如需）
5. corum 完整 preset YAML 声明（standard/ptc/cordis/conductor/minimal）→ 阶段 3
6. dsh-agent-preset 声明包 → 阶段 3（如需）

### 阶段 1 · 偏差汇总

1. **对象 ② 类型重命名未做**：`CodeRuntime` → `PtcRuntime`、`CodeRunResult` → `PtcRunResult`、`CodeBindingFunction` → `PtcBindingFunction` 等类型名重命名 + `dsh-sandbox` 结构性变更属阶段 3 fork-rebase。03 册 §4.2 步骤 ②-5 要求 build 三包，但中间态不可编译属预期（spec 原文「中间态不能编译属预期」）。
2. **对象 ④ plugin-meta 未在步骤中列出但改了**：03 册 §4.4 步骤未列 `corum-ide-ui`/`corum-ide-plugin-manager-ui` 的 plugin-meta `dsh-agent-presets` 键，但退出门禁 §5.3 要求 `dsh-agent-presets` 全仓零命中，故一并改为 `dsh-agent-preset-registry`。
3. **对象 ⑧ SKILL.md 未改**：`shipped-presets/official/cordis/skills/editing-cordis-compositions/SKILL.md` 含 `backgroundMode: one-shot` 示例文本，属技能文档非 preset 行，不在 §4.9 范围内。**（阶段 2 独立验收加固已处理：SKILL.md:92 的 `dsh-workflow-worker-thread` 示例改为 `dsh-workflow`，见 S4.6。）**

### 阶段 1 · 独立验收 + 尾项修正

- **独立验收报告**：`~/.corum/research-reports/5d77ffc9-c403-4870-a93d-7173dc7dab12.md`
- 验收结论：**PASS（带 3 项需修正的低危遗留 + 2 处实录措辞不实）**
- 验收范围：`bacd04ab..c519b890`，11 个 commit、49 文件；全部基于 git diff + 现场静态 grep + 官方 tag 只读对账，未重跑 install/test。
- 独立验收发现并修正的 3 项尾项（本次尾项 commit）：
  1. **corum-tools 测试基建残留 invariant alias/paths**：`vitest.config.ts:68-69` 保留已删 `@deepseek-ai/dsh-tools/invariant` alias + `tsconfig.spec.json:13` 保留对应 paths。已删除（alias 项 + paths 行），头注释 spec 说明符计数同步 4→3。无运行时影响（invariant.spec.ts 已删故无 import 触达），但消除阶段 2/3 死配置陷阱。
  2. **corum-subagent/package.json description 旧叙述**：仍含 `dsh-subagent-in-process-driver` 和 `{{cwd}}`（历史叙述文字，零运行时影响）。已改写为实际功能描述：named-provider registry + start/startContinuable/sendMessage API + 子 Agent 角色契约（worker/researcher）+ childSessionMeta 透传。
  3. **实录措辞修正**：对象 ③/⑧ 验证结果原写「零命中」，但独立验收发现 description 文字曾残留旧名/`{{cwd}}`，属措辞过宽。已在对象 ③/⑧ 验证结果和 §5.2/5.3 门禁矩阵收窄措辞、注明修正后现为真零。
- **修正后状态**：跟踪源（排除 lib/dist/build/node_modules/docs/pnpm-workspace/lock）全仓 grep `dsh-subagent-in-process-driver`/`{{cwd}}`/`dsh-invariants`/`dsh-code-runtime`/`cordis-plugin-hmr` 均为真零命中；`dsh-agent-presets` 在 dep/import/external/config/plugin-meta 层面零命中，仅 `shipped-presets/official/*/agent.cordis.yml` 各保留 1 行描述性注释（叙述旧包行为，非实际引用，阶段 3 preset rebase 一并更新）。
- 03 册状态：**完成**（阶段 1 断链 + 配置硬错误清零成立，装得上起不来属预期，§3.6 六项待阶段 3 处置）。

## 阶段 2：override 重算

> 状态：**S0-S2 完成，S3/S4 待执行**｜ 04 册状态同步更新。
> 起点 HEAD：`3538e691`（阶段 1 尾项 commit）。

### S0 回补（独立 commit `dbc3ed37`）

阶段 1 漏网的 2 个被删包回补：

- **desktop-host/package.json** 删 `@deepseek-ai/dsh-settings-file: 0.1.5-rc.3` + `@deepseek-ai/dsh-workflow-worker-thread: 0.1.5-rc.3`；
- **desktop/package.json** 删 `@deepseek-ai/dsh-settings-file: ^0.1.5-rc.3`；
- **corum-agent/src/compile.ts:292** 引擎 provider 行 `name` 从 `@deepseek-ai/dsh-workflow-worker-thread` 改挂 `@deepseek-ai/dsh-workflow`（**行保留不删**——orchestrate script 模式依赖 `runtimeCtx.get('workflowEngine')`，删行则指挥模式派发即报错）；注释更新解释 rc3 删包并改挂原因；
- **compile-subagent.spec.ts** 测试断言同步：`name: "@deepseek-ai/dsh-workflow"`；注释中的错误消息文字也同步更新；
- **两处 plugin-meta.ts**（corum-ide-ui + corum-ide-plugin-manager-ui）删 `dsh-settings-file` + `dsh-workflow-worker-thread` 展示条目（仅插件中心 inventory 元数据，无运行时依赖）；
- **4 shipped presets**（ptc/standard/cordis/conductor 的 agent.cordis.yml）workflow-worker-thread 行 `name` 改挂 `@deepseek-ai/dsh-workflow`；
- **corum-tool-subagent/src/index.ts** 两处注释更新旧包名为历史叙述（「旧包名 dsh-workflow-worker-thread，rc3 已并入 @deepseek-ai/dsh-workflow」），避免静态误判。

**验证**：
- `grep -rn 'dsh-settings-file' packages/ --include='*.ts' --include='*.json'` 零命中（pnpm-workspace.yaml override 行 S1 处理）；
- `grep -rn 'dsh-workflow-worker-thread' packages/ --include='*.ts' --include='*.json'` 仅命中注释行（历史叙述），无实际引用；
- compile.ts:292 `name` 已改为 `@deepseek-ai/dsh-workflow`，provider 行保留。

### S1 依赖统一与 override 正向生成（commit `e26fc8fc`）

#### S1.1 正向清单生成

用 Node 脚本 `scripts/generate-rc3-overrides.mjs`（已提交）从官方 tag `dsh-v0.2.1-rc.3` 的全量 package.json 读取 name/version/private：

- **383** 个 package.json 扫描；
- **356** 个公开 `@deepseek-ai/*` 包加入 override（排除 `cordis-plugin-hmr`、`cordis-plugin-logger-console`）；
- **8** 个 private 包排除：`dsh-benchmarks`、`dsh-desktop`、`dsh-desktop-host`、`dsh-plugin-market-generator`、`dsh-root`、`dsh-ssh-helper-runtime`、`node-addon-system-workspace`、`website`。

**版本异常审查**（不盲信「所有公开包 version = 0.2.1-rc.3」）：
- **vendor 包 7 个**：cordis 4.0.5、cordis-plugin-group 1.0.5、cordis-plugin-include 1.0.10、cordis-plugin-loader 1.0.6、cordis-plugin-timer 1.1.7、cosmokit 1.8.6、schemastery 3.18.5 —— 用各自真实版本（独立版本线，与 S2.2 vendor 表对齐）；
- **native addon 5 个**：node-addon-system / darwin-arm64 / darwin-x64 / linux-arm64 / linux-x64 均为 0.1.2 —— 用真实版本（独立版本线，非 dsh 应用包）；
- **dsh-hmr**：0.2.1-rc.3 ✓（官方继任包，走目标版本）；
- 其余 341 个 dsh 应用包 version 均等于 0.2.1-rc.3 ✓。

#### S1.2-S1.3 manifest 机械升版

- **desktop-host/package.json**：全部 `@deepseek-ai/*` 依赖统一精确 `0.2.1-rc.3`（84 条 0.1.5-rc.3 → 0.2.1-rc.3）；S0 已删包未复活；
- **desktop/package.json**：全部 `@deepseek-ai/*` 依赖统一 `^0.2.1-rc.3`（60 条）；
- **50 fork 包 package.json**：全部 `@deepseek-ai/*` deps/dev/peer/optional 统一 `^0.2.1-rc.3`（663 处 0.1.5/^0.1.5 → ^0.2.1-rc.3）；
- **SDK 包 + example 包**：同步升级（corum-plugin-sdk、corum-plugin-ui-contract、region-replacement-plugin）；
- 未改 `@corum/*` workspace:* 或其他第三方依赖。

#### S1.4-S1.5 fork override + electron 保留不动

```
'@deepseek-ai/dsh-fs-local': 'link:packages/plugins/agent/corum-fs-local'
'@deepseek-ai/dsh-tools': 'workspace:@corum/corum-tools@*'
'electron': '43.4.1'
```

两条 fork override 原样保留（含完整注释），electron 43.4.1 不动。

#### override 重写结果

pnpm-workspace.yaml overrides 段全量重算，**357 条**：
- 341 个 dsh 应用包 `0.2.1-rc.3`；
- 5 个 native addon `0.1.2`；
- 7 个 vendor 包（cordis 4.0.5 / group 1.0.5 / include 1.0.10 / loader 1.0.6 / timer 1.1.7 / cosmokit 1.8.6 / schemastery 3.18.5）；
- 1 个 dsh-hmr `0.2.1-rc.3`（vendor 段）；
- 2 个 fork override（dsh-fs-local link: / dsh-tools workspace:）；
- 1 个 electron `43.4.1`。

YAML 合法性验证通过（js-yaml parse），overrides keys = 357。

### S2 豁免+vendor+external 决策（同 commit `e26fc8fc`）

#### S2.1 minimumReleaseAgeExclude 433 条整段删除

- 433 条（249 @0.1.3-alpha.1 + 184 @0.1.1-rc.2）**整段删除**；
- `minimumReleaseAge: 0` 保持不动（当前 0 分钟冷却，exclude 段是死配置）；
- 官方 rc3 的 22 条非 dsh 豁免对照决策：
  - libreoffice-kit 6 条（corum 不装配 → 不加）；
  - pi-ai 2 条（corum 无 pi-ai route fork → 不加）；
  - node-addon-* 11 条（corum 装配 node-addon-system → 若启用冷却需补齐，当前不加）；
  - claude-agent-sdk 6 条（若 corum 装配则保留，当前不加）；
  - electron@44.7.0 1 条（corum 钉 43.4.1 → 不加）；
- 删除位置补注释记录决策口径。

**验证**：`grep -cE "0\.1\.3-alpha\.1|0\.1\.1-rc\.2" pnpm-workspace.yaml` = 0。

#### S2.2 vendor 钉版重算

| vendor 包 | 0.1.5-rc.3 版本 | 0.2.1-rc.3 版本 | 处置 |
|---|---|---|---|
| cordis | 4.0.2 | 4.0.5 | ✓ 已改 |
| cordis-plugin-loader | 1.0.3 | 1.0.6 | ✓ 已改 |
| cordis-plugin-hmr | 1.0.17 | — | ✓ override 删除（dsh-hmr 继任） |
| dsh-hmr | — | 0.2.1-rc.3 | ✓ 新增 override |
| cordis-plugin-include | 1.0.7 | 1.0.10 | ✓ 已改 |
| cordis-plugin-group | 1.0.2 | 1.0.5 | ✓ 已改 |
| cordis-plugin-timer | 1.1.4 | 1.1.7 | ✓ 已改 |
| schemastery | 3.18.2 | 3.18.5 | ✓ 已改 |
| cosmokit | 已浮 1.8.5 | 1.8.6 | ✓ 已钉（消除漂移） |

electron 43.4.1 不动。

#### S2.3 CLIENT_EXTERNALS_BASE 决策

**决策：保持内联不动**（当前 6 词：react、react/jsx-runtime、react-dom、react-dom/client、@deepseek-ai/cordis、@deepseek-ai/dsh-client-ui-slots）。

理由：
- 官方 rc3 seed.ts 从 9→11 词（新增 zod + @tanstack/react-virtual）；
- corum 已在 import 这两个模块（zod 6 处、react-virtual 1 处），目前**内联进 bundle**，不报 Module not found；
- 是否加 external 必须基于「是否需要跨 bundle 共享同一实例」（如 zod schema 共享），非盲加；
- 当前未证明需要跨 bundle 单例共享，故保持内联；
- 官方 seed 新增不代表必须 external —— 若后续跨 bundle schema/实例共享需求再专项评审。

### S2 静态验证

- `node scripts/verify-electron-pin.mjs` exit 0（electron 43.4.1 三重一致；二进制身份校验跳过，因未打包）；
- `git diff --check` 无问题（无空白错误）；
- pnpm-workspace.yaml YAML parse 通过（js-yaml，357 override keys）；
- 全部 55 个 changed package.json JSON parse 通过；
- `grep -c "0.1.5-rc.3" pnpm-workspace.yaml` = 0；
- `grep -cE "dsh-settings-file|dsh-workflow-worker-thread" pnpm-workspace.yaml` = 0（override 段内）；
- `grep -c "cordis-plugin-hmr" pnpm-workspace.yaml` = 1（仅注释，无 override 条目）；
- fork 两条 + electron 原样保留（grep 确认 link:/workspace:/43.4.1）。

### 未执行项（S3/S4 待下一任务）

> **2026-10-27 追加：S3/S4 已执行完成，见下方「阶段 2 S3-S4 实录」。**

**本阶段未做**：lock 重生成、install、deploy、实机验证、全仓 typecheck/test/fork-drift。

---

## 阶段 2 S3-S4 实录（2026-10-27 执行）

### S3 lock 重生成

**环境**：pnpm@11.7.0（packageManager 字段），node v26.4.0（`/opt/homebrew/bin/node`），registry = `https://registry.npmmirror.com`。

**registry 抽查**（S3.5）：
- `pnpm view @deepseek-ai/dsh-hmr@0.2.1-rc.3 version` → `0.2.1-rc.3` ✓
- `pnpm view @deepseek-ai/dsh-ptc-runtime@0.2.1-rc.3 version` → `0.2.1-rc.3` ✓
- `pnpm view @deepseek-ai/dsh-agent-preset-registry@0.2.1-rc.3 version` → `0.2.1-rc.3` ✓

**重生成**（S3.2-S3.3）：
1. 备份旧 lock 至 `.corum-tmp/pnpm-lock-prev-S3.yaml`（git 保护下）。
2. `rm pnpm-lock.yaml && CI=true pnpm install --no-frozen-lockfile`（完整日志 `.corum-tmp/stage2-install.log`）。
   - 退出码 0 ✓
   - 零 `ERR_PNPM` ✓
   - peer dependency：`pnpm peers check` → `No peer dependency issues found` ✓
   - 唯一 WARN：`1 deprecated subdependencies found: node-domexception@1.0.0`（无影响）。
3. lock 内容：`0.2.1-rc.3` 出现 3626 次，`0.1.5-rc.3` dsh 包出现 0 次 ✓。
   - `libreoffice-kit@0.1.5` 为 `dsh-office-to-pdf@0.2.1-rc.3` 的传递依赖（官方 rc3 声明，非 corum 装配，非 override 目标）。

**幂等校验**（S3.4）：
1. 第一遍 install 后 `shasum pnpm-lock.yaml` = `7bc457b939f3d1406eb2d2b5f48f551e6d3d110d`。
2. 第二遍 `pnpm install`（无 --no-frozen）后 hash 不变 ✓。
3. `diff .corum-tmp/lock-copy-1.yaml pnpm-lock.yaml` 为空 ✓。

**vendor 物化**（A5）：
| vendor 包 | 0.2.1-rc.3 版本 | 物化确认 |
|---|---|---|
| cordis | 4.0.5 | desktop-host/node_modules ✓ |
| cordis-plugin-loader | 1.0.6 | ✓ |
| cordis-plugin-include | 1.0.10 | ✓ |
| cordis-plugin-timer | 1.1.7 | ✓ |
| schemastery | 3.18.5 | ✓ |
| cosmokit | 1.8.6 | ✓ |
| dsh-hmr | 0.2.1-rc.3 | ✓ |

**解析面实况**（A6）：
- `desktop-host/node_modules/@deepseek-ai/dsh-session-title-llm` → `0.2.1-rc.3`（活案例验证：manifest 0.2.1 ↔ override 0.2.1 ↔ 物化 0.2.1-rc.3 三者一致 ✓）。
- `.pnpm` store 中残留 220 个 `dsh-*@0.1.5-rc.3` 条目（content-addressable store 不自动清理），但**均未实例化**（`.modules.yaml` 零引用、顶层 `node_modules` 无软链）。
- `pnpm store prune` 清理了 4495 个包/6.5GB 但保留这些（pnpm 仍认为它们被引用）——不影响闭包，topUp 函数已加版本过滤（见 S4）。

**electron pin**（A9）：`node scripts/verify-electron-pin.mjs` exit 0，版本声明/workspace override/lockfile 三者一致 ✓（二进制身份校验跳过，因未打包）。

**lock commit**：`936ced5c` `upgrade(0.2.1-rc3): 重生成 rc3 锁文件`。此后 frozen。

### S4 skip-app 部署 + 闭包审计

**--skip-app 模式实现**（S4.1）：
- `pack-macos.mjs` 新增 `--skip-app` flag（`const SKIP_APP = process.argv.includes('--skip-app')`）。
- `main()` 流程：`assertVcRedistStaged → assertUiPluginStylesInlined → deployHost → assertUniformDshVersions → assertClosureBlacklist → assertUniformVendorVersions → copyDesktopArtifacts → materializeSymlinks → resolveClosureProbes` → 写 build-channel → **if SKIP_APP: return**（跳过 smokeBridge + buildApp）。
- 默认（无 flag）行为完全不变。
- usage/help 同步标注。

**补强断言**（S4.2-S4.3）：

1. **assertClosureBlacklist**：8 个被删/旧包闭包内不得出现：
   - dsh-agent-presets / dsh-code-runtime / dsh-code-runtime-worker-thread / dsh-invariants / dsh-subagent-in-process-driver / cordis-plugin-hmr / dsh-settings-file / dsh-workflow-worker-thread。
   - 结果：8 个均未出现 ✓。

2. **assertUniformVendorVersions**：cordis/schemastery/cosmokit 各自唯一版本且符合 override：
   - cordis@4.0.5（唯一）✓ / schemastery@3.18.5（唯一）✓ / cosmokit@1.8.6（唯一）✓
   - cordis-plugin-* 也断言唯一：group@1.0.5 / include@1.0.10 / loader@1.0.6 / timer@1.1.7 ✓。

3. **resolveClosureProbes**：闭包顶层 @deepseek-ai/@corum 可运行包 require.resolve：
   - 311 包 resolve 成功 ✓
   - 7 个跳过（类型-only / subpath-only exports / fork 替身）
   - 跳过名单：fork 替身（dsh-fs-local → corum-fs-local / dsh-tools → corum-tools）+ subpath-only（dsh-web-frontend / libreoffice-kit-darwin-arm64 / node-addon-system / corum-rpc-client）+ 无入口包。

4. **topUpOfficialPackagesFromWorkspace 过滤**：
   - .pnpm store 残留 0.1.5-rc.3 的 dsh-* 包（stale 条目）→ topUp 加 `isBlacklisted` 过滤 + 版本过滤（dsh-* 只收 0.2.1-rc.3），避免 stale 条目进闭包。
   - 从 +24（含 8 个黑名单）降为 +15（干净）。

**解析探针设计**（S4.3）：
- 用 `createRequire(import.meta.url)` + `require.resolve(pkgName, { paths: [HOST_DIR] })`。
- 跳过类型-only（无 main/exports/module）。
- 跳过 subpath-only exports（有 exports 但无根 `.` 键）。
- 跳过 fork 替身（manifest.name 不以 @deepseek-ai/ 开头）。
- 模块初始化副作用不执行，只 resolve。

**node-pty 验证**（S4.4）：
- `node_modules/.pnpm/node-pty@1.2.0-beta.15/node_modules/node-pty/prebuilds/` 六平台齐全：darwin-arm64 / darwin-x64 / linux-arm64 / linux-x64 / win32-arm64 / win32-x64 ✓。
- `packages/desktop/package.json` 精确钉 `node-pty: 1.2.0-beta.15` ✓。
- `onlyBuiltDependencies` 仍含 node-pty ✓。
- 不移植官方 patch（已评审决定：corum 在宿主 Electron 跑 pty，不用嵌入式 runtime）。

**部署运行**（S4.5）：
- 全仓 `pnpm -r run build` 因 `corum-api-remotes` API 语义错（`SessionJob` export 缺失）+ `corum-ide-ui` API 语义错（`ISessions` 属性变化）而停止——属阶段 3 fork-rebase 范畴，非依赖解析错误。
- bridge.js 与 UI 插件 lib/client.js 均已预构建（10-26），`assertUiPluginStylesInlined` 全绿。
- `pnpm --filter corum-desktop run pack:host:mac -- --skip-app` 退出码 0 ✓（完整日志 `.corum-tmp/stage2-skipapp-5.log`）。

**闭包审计结果**（A1-A10）：

| # | 验收项 | 结果 |
|---|---|---|
| A1 | override 自洽 | rc3=342 条 / 0.1.5=0 / 黑名单=0 ✓ |
| A2 | pnpm install 可解析 | exit 0 / ERR_PNPM=0 ✓ |
| A3 | lock 落位 | rc3=3626 / 0.1.5-rc.3 dsh=0 / 幂等 hash 一致 ✓ |
| A4 | frozen 一致性 | deploy 副本 `pnpm install --frozen-lockfile` 成功 ✓ |
| A5 | vendor 物化 | cordis 4.0.5 / loader 1.0.6 / include 1.0.10 / timer 1.1.7 / schemastery 3.18.5 / cosmokit 1.8.6 / dsh-hmr 0.2.1-rc.3 ✓ |
| A6 | 解析面实况 | dsh-session-title-llm=0.2.1-rc.3 / .pnpm stale 不实例化 ✓ |
| A7 | 部署管线断言 | dsh uniform(258) + blacklist(0) + vendor uniqueness + platform(7) + topUp(0 missing) ✓ |
| A8 | 解析探针 | 311 resolve 成功 / 7 跳过 ✓ |
| A9 | electron 锁 | verify-electron-pin exit 0 / 43.4.1 ✓ |
| A10 | minimumReleaseAgeExclude | 0 残留 ✓ |

**build/host 闭包版本分布**：
- 258 个 @deepseek-ai dsh 包 @ 0.2.1-rc.3 ✓
- 2 个 fork 替身 @ 0.7.0（corum-fs-local / corum-tools）✓
- 2 个 libreoffice-kit @ 0.1.5（dsh-office-to-pdf 传递依赖，非 dsh 基座）✓
- vendor: cordis 4.0.5 / cosmokit 1.8.6 / schemastery 3.18.5 / loader 1.0.6 / include 1.0.10 / group 1.0.5 / timer 1.1.7 ✓
- node-pty 1.2.0-beta.15 ✓
- cordis-plugin-hmr **不在**闭包 ✓（被 dsh-hmr 继任）

**未做 B 项**（阶段 3/4）：
- B1 smokeBridge ready（阶段 4）
- B2 全仓 typecheck --force（阶段 3，corum-api-remotes/corum-ide-ui API 语义错待修）
- B3 全仓 test（阶段 3）
- B4 fork-drift（阶段 3）
- B5 assert-packaged-boot.mjs（阶段 4，需完整 app）
- B6 CDP 冲烟（阶段 4）

**commits**：
- `936ced5c` — `upgrade(0.2.1-rc3): 重生成 rc3 锁文件`
- `3c5db12e` — `upgrade(0.2.1-rc3): 增加安全部署闭包审计`
- `97da7216` — `upgrade(0.2.1-rc3): 加固部署闭包缺失断言`

**生成物 build/dist 不提交**（.gitignore 排除 `build/`）。

### S4.6 独立验收加固（commit `97da7216`）

独立只读验收（`~/.corum/research-reports/35d425b4-…md`）PASS 后，按报告 §2/§5 指出的两个加固点落实：

**topUpOfficialPackagesFromWorkspace 版本过滤加固**：

1. **版本过滤不再静默 continue**：被跳过的非 rc3 `dsh-*` 包记账到 `versionFiltered` 数组，循环后 `console.warn` 列出全部跳过的包名+版本（实测 226 个 stale 条目）。
2. **删除冗余嵌套 if**：旧 `if (shortName.startsWith('dsh-') || …) { if (shortName.startsWith('dsh-') && …) continue }` 外层已含 `dsh-` 判断、内层重复——改为扁平三路分支（rc3 收 / 非 rc3 记账 / vendor 旧版记账）。
3. **两阶段 fail-loud 策略**（最不易误报）：
   - 收集阶段：rc3 版本的 `dsh-*` 包收进 `wanted`；非 rc3 记账到 `versionFiltered`（不立即 throw，因 store 可能有同包多版本共存）。
   - 判定阶段：对 `desktop-host/package.json` 声明的每个 `@deepseek-ai/dsh-*` 目标包（88 个，从 manifest 动态读取、不硬编码），若 store 中没有任何 rc3 条目但有旧版本 → 立即 `throw`。旧残留与正确版本共存时只 warn。
   - 目标包集合从 manifest 动态读取，不硬编码排除表（避免 lockfile packages 段全集误报 dev-only/testkit/非本平台变体）。
4. **新增交叉断言 ④**：断言 desktop-host 声明的全部 `@deepseek-ai/dsh-*` 目标包都在闭包 `have` 集中。与 ③（topUp wanted 来源）互补——若某目标包在 store 里根本没有物化目录（lockfile 未含但 manifest 声明了），③ 不包含它 → ③ 全绿但闭包真缺。④ 直接读 manifest 声明集断言。fork 顶替包目录名仍在 have 集中，不误报。

**SKILL.md:92 旧包名清理（尾项已处理）**：

阶段 1 偏差 §3「对象 ⑧ SKILL.md 未改」遗留的 `dsh-workflow-worker-thread` 示例（`shipped-presets/official/cordis/skills/editing-cordis-compositions/SKILL.md:92`），改为 `dsh-workflow`（rc3 已删 worker-thread 包，引擎并入 `dsh-workflow`）。保留 corum 其他增量内容不变。`grep -rn 'dsh-workflow-worker-thread' shipped-presets/` 零命中。

**重跑验证**：`pnpm --filter corum-desktop run pack:host:mac -- --skip-app` exit 0，全部断言通过（258 dsh uniform / blacklist 0 / vendor uniqueness / 311 resolve probes / 7 platform / 226 stale 条目 warn 记账 / 交叉断言 ④ 隐式通过）。

> 独立验收报告加固实录已追加至 `~/.corum/research-reports/35d425b4-…md`。

## 阶段 3：fork 包 rebase

（执行时追加）

## 阶段 4：三层验证

（执行时追加）

## 阶段 4.5：Electron 验证

（执行时追加）

## 阶段 5：装配进程隔离

（执行时追加）

## 阶段 6：顶层会话 sidecar

（执行时追加）
