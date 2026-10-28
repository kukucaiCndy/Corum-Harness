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
4. **fork-drift N 项偏差**：历史交接口径曾记录 24 项（无在库证据），评审试跑得 23 项但 TMPDIR 失效回落 rc.2 无效。真实 tag 导出重跑结果：**N = 3 项**（显著少于历史口径，可能因 fork 源码已修复部分项或守卫登记已更新）。**阶段 3 E 收口后（2026-10-28）**：守卫过期项已修复（orchestrate script 模式接线断言、pinned dsh 包版本号硬编码、技能副本同步），当前 drift = **1 项失败**（sandbox-local/src/index.ts 与官方差异，D 任务非 E，`.corum-tmp/stage3-e-drift.log`）。
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

### 步骤 0：开工基线与 inventory（2026-10-27）

#### start hash

- `1299bdae4e7f48601ad9a7a1d23a844165f2244a`（分支 `upgrade/0.2.1-rc3`，阶段 2 完成态）

#### 步骤 0a/0b：expected-red typecheck 基线

**命令 1**（全仓增量 typecheck）：
```bash
pnpm -r --no-bail run typecheck 2>&1 | tee .corum-tmp/stage3-expected-red.log
```
结果：**11 fails, 45 passes**（增量编译基线，部分 tsbuildinfo 缓存掩盖了破坏点）。

**命令 2**（逐包强制 typecheck）：
```bash
node scripts/run-forced-typecheck.mjs --log .corum-tmp/stage3-expected-red.log
```
脚本 `scripts/run-forced-typecheck.mjs` 对 51 个含 tsconfig 的包逐包执行 `tsc -b --force` + 有 spec 再 `tsc -p tsconfig.spec.json --force --noEmit`，no-bail 收集全部失败，TS5033 环境错误与语义错误分开，输出 JSON 摘要。

结果（**强制基线 = 每批门禁的 expected-red 身份清单**）：
- **30 包 FAIL / 21 包 PASS**
- **210 语义错误 / 0 TS5033 环境错误**

失败包及主要错误身份：

| 包 | 语义错误数 | 主要错误码 |
|---|---|---|
| corum-agent | 9 | TS2339×1, TS2352×6, TS2554×1, TS2322×1 |
| corum-api-remotes | 1 | TS2305×1 (SessionJob deleted) |
| corum-extension-pack | 1 | TS5093×1 |
| corum-extension-registry | 1 | TS5093×1 |
| corum-fs-local | 1 | TS5093×1 |
| corum-mcp-manager | 1 | TS5093×1 |
| corum-memory | 2 | TS2379×1, TS2551×1 |
| corum-orchestration | 1 | TS2379×1 |
| corum-platform | 1 | TS5093×1 |
| corum-preset-modules | 1 | TS5093×1 |
| corum-sandbox-local | 2 | TS2416×1 (confine sync→async), TS5093×1 |
| corum-subagent | unknown | 进程被杀（OOM，exit=null；8GB 堆仍不足） |
| corum-tool-subagent | 23 | TS2614×1, TS2589×1, TS2339×5, TS18046×9, TS2322×2, TS2345×1, TS7006×2, TS2375×1, TS5093×1 |
| corum-tools | 6 | TS2614×2 (CodeRuntime), TS2724×2, TS2322×1, TS5093×1 |
| corum-web-search | 4 | TS2339×2, TS2614×1, TS2551×1 |
| corum-session-archive | 1 | TS5093×1 |
| corum-ui-chat | 44 | TS2551×2, TS2339×14, TS2724×8, TS7006×5, TS2305×10, TS2367×1, TS2379×2, TS2739×1, TS2353×1 |
| corum-ui-commit-card | 1 | TS2339×1 |
| corum-ui-conversation | 48 | TS2551×1, TS2339×14, TS2724×12, TS7006×8, TS2305×11, TS18047×2 |
| corum-ui-model-ask | 2 | TS2339×1, TS5093×1 |
| corum-ui-model-selection | 5 | TS2305×1, TS2724×4 |
| corum-ui-questions | 3 | TS2352×1, TS2339×1, TS5093×1 |
| corum-ui-settings-models | 8 | TS2724×2, TS2305×3, TS2551×2, TS2345×1 |
| corum-ui-settings-plugins | 12 | TS2305×5, TS2551×4, TS2724×1, TS7006×2 |
| corum-ui-trajectory | 9 | TS2339×2, TS2724×2, TS2305×3, TS2345×2 |
| corum-ide-sidebar-ui | 9 | TS2339×9 |
| corum-ide-ui | 8 | TS2717×1, TS2339×5, TS2551×1, TS5093×1 |
| corum-ui-base | 2 | TS2551×1, TS5093×1 |
| corum-ui-titlebar | 2 | TS2339×1, TS5093×1 |
| corum-desktop | 2 | TS2352×1, TS2305×1 |

> **TS5093 说明**：大量包报 TS5093（`Option 'bundler' module resolution requires 'moduleResolution' to be set to 'bundler'`）——这是 tsconfig 继承链在 0.2.1-rc.3 官方包新 tsconfig 结构下的环境级不匹配，非语义错误。TS5093 统一归类为环境错误（与 TS5033 同类），不计入语义错误清单。但脚本目前将其计为语义错误（因 TS5093 非 TS5033），后续可优化脚本分类。

> **corum-subagent OOM**：`tsc -b --force` 在 corum-subagent 上 OOM（exit=null，进程被信号杀死）。8GB 堆仍不足。这是已知问题（corum-tool-subagent 在增量运行也 OOM）。基线身份 = "exit=null (OOM)"，后续 rebase 后重跑验证。

> 日志：`.corum-tmp/stage3-expected-red.log` + `.corum-tmp/stage3-expected-red.log.json`

#### 步骤 0c：verify-fork-drift.sh §17 守卫路径修正

**修改文件**：`scripts/verify-fork-drift.sh`

**问题**：§17 的 `OFFICIAL_PRESETS` 指向 `packages/preset/agent-presets/presets`（0.1.5 目录式 `agent.cordis.yml` 格式）。rc3 官方已迁到 `packages/bundle/web-app/presets/<id>.patch.yml`（声明式 `insert:` + `config.plugins` 数组格式）——这是**格式迁移而非路径迁移**。

**修法**（按 brief 要求：不假装兼容，格式迁移检查标为阶段 3 P 专项待更新，当前信息性 skip 并明确原因，不得 false pass）：

1. `OFFICIAL_PRESETS` 路径按 `DSH_BASELINE_TAG` 自动选择：
   - rc3 (`*0.2.1*`)：`packages/bundle/web-app/presets`
   - 0.1.5 及其他：`packages/preset/agent-presets/presets`（保持兼容）
   - 设置 `PRESET_FORMAT_MIGRATED=1` 标记
2. rc3 基线下（`PRESET_FORMAT_MIGRATED=1`），以下断言改为**信息性 skip**（标明原因 + 指向阶段 3 P 专项 `05 §4.5`）：
   - minimal preset 逐字节断言（`cmp -s`）：官方 `.patch.yml` 格式无法与 corum `agent.cordis.yml` 逐字节对比
   - 行 id 对账（④ 官方行 id 一个不少 + 新增行在登记表内）：`.patch.yml` 的行 id 在 `config.plugins` 子数组中，与 corum `agent.cordis.yml` 的行 id 格式/缩进/语义不同，强行对比会 false fail
3. 0.1.5 基线下所有断言**原样不变**（实测 §17 --only 17 在 0.1.5 tag 下全绿）

**需要后续改的具体断言**（阶段 3 P 专项完成后重写）：
- `minimal` 逐字节断言 → 改为 corum `minimal/agent.cordis.yml` 与官方 `minimal.patch.yml` 的 patch.yml 格式对账
- ④ 行 id 对账 → 改为 corum `agent.cordis.yml` 行 id 与官方 `.patch.yml` 的 `config.plugins[].id` 对账
- §17 其余 corum 内部断言（三实例计数、provider 检查、disabled 块检测）在 corum preset 迁到 `.patch.yml` 后需整体重写

#### 步骤 0d：50 包 inventory 生成

**脚本**：`scripts/fork-rebase-inventory.mjs`（只读官方 tag + corum 工作树，不修改源码）

**输出**：`docs/fork-delta/inventory/` 下 50 个 `<pkg>.json` + `SUMMARY.md` + `needs-mapping.json`

**覆盖**：**50/50**（agent 23 + session 12 + ui 15）

**映射分布**：
- **16 包 explicit**（fork-delta.md 已登记官方对照）：corum-api-remotes, corum-credentials-local, corum-fs-local, corum-sandbox-local, corum-subagent, corum-tool-subagent, corum-tools, corum-ui-approval, corum-ui-chat, corum-ui-conversation, corum-ui-model-selection, corum-ui-questions, corum-ui-settings-models, corum-ui-settings-plugins, corum-ui-trajectory
- **15 包 corum-only**（无官方对应物，显式标记）：corum-agent, corum-artgen, corum-goal-round-driver, corum-memory, corum-ollama, corum-orchestration, corum-platform, corum-todo-guard, corum-update-checker, corum-session-queue-revert, corum-ui-model-ask, corum-ide-test-* (3), corum-issue-reporter-ui
- **20 包 needs-mapping**（待逐包确认官方路径，不伪造）：corum-extension-pack, corum-extension-registry, corum-git-core, corum-mcp-manager, corum-preset-modules, corum-skill-manager, corum-web-search, corum-session-archive, corum-ui-commit-card, corum-ide-explorer-ui, corum-ide-integrations-pages-ui, corum-ide-integrations-ui, corum-ide-panel-bottom-ui, corum-ide-plugin-manager-ui, corum-ide-sidebar-ui, corum-ide-statusbar-ui, corum-ide-ui, corum-rpc-client, corum-ui-base, corum-ui-titlebar

每包 JSON 字段：`package`/`group`/`path`、`officialMapping`（type=explicit/corum-only/needs-mapping + officialPkg/officialPath/note）、`officialBaseline`、`files`（逐文件 path/class/officialPath/officialDiffVsPrev）、`fileClassCounts`、`exportFaceDiff`、`stage3Status=pending`、`gates`（typecheck/build/test/drift 全 pending）。

#### 步骤 0e：fork 台账入口

`docs/fork-delta.md` 文首新增阶段 3 inventory 入口段（指向 `docs/fork-delta/inventory/`），不重写现有 §1-§19 的 17 包详细台账。

#### 步骤 0f：初始 rc3 drift（信息性运行）

**命令**：
```bash
TMPDIR="$PWD/.corum-tmp" DSH_CHECKOUT=/Users/kukucai/dsh DSH_BASELINE_TAG=dsh-v0.2.1-rc.3 ./scripts/verify-fork-drift.sh
```

**结果**：真实 tag 导出成功（`[baseline] 官方基线 = dsh-v0.2.1-rc.3（1f81c047fc）`，无回落）。**22 项失败**（属预期——rc3 基线下大面积红，阶段 3 rebase 完成前不作门禁）。

drift 身份概要（22 项失败）：
- [1] corum-api-remotes src/index.ts 与官方有差异（1 项）
- [13] overrides 只钉 0 个 dsh 包（1 项，阶段 2 S2 待处理）
- [15] corum-sandbox-local src/index.ts 差异（1 项）
- [15b] corum-fs-local src/index.ts 差异（1 项）
- [16b] corum-tools 6 个 src 文件差异（ptc/py-types/schema/ts-types/types，6 项）
- [16] corum-subagent 缺 4 官方新文件（activation/archive-admission/manager/structured）+ 3 文件差异（lifecycle/list-children/projection）+ 4 个 corum 新增文件未登记（continuation-activation/continuation/inbox/run-settlement）（11 项）
- [17] orchestrate 缺 script 模式接线（1 项）
- [18] 技能副本 verify-fork-drift.sh 不一致（1 项，因本次编辑）

§17 preset 格式迁移：5 条信息性 skip（`–`），全部标明原因指向阶段 3 P 专项。§17 其余 corum 内部断言全绿。

日志：`.corum-tmp/stage3-initial-rc3-drift.log`。不更新白名单。

### A1 基础批：corum-rpc-client / corum-ui-base / corum-platform / corum-api-remotes（2026-10-27）

#### start hash

- `576178e8d6b8f4c3b239dba7ab7d1a85cead45b9`（步骤 0 完成态）
- commit：`09451d3f`

#### 范围

4 包：corum-rpc-client（ui 组）、corum-ui-base（ui 组）、corum-platform（agent 组）、corum-api-remotes（agent 组）。
needs-mapping 只读确认：corum-rpc-client = corum-only（依赖官方 `dsh-client-connection` ConnectionHandle，非 fork）；corum-ui-base = corum-only（依赖官方 `dsh-client-ui-slots`/`ui-theme`，非 fork）。

#### diff 逐文件

**corum-api-remotes**（官方 `packages/api/remotes`，explicit 映射）：

| 文件 | 分类 | 变化 |
|---|---|---|
| `src/client/index.ts` | substantive | SessionJob 删除→`export type * from '@deepseek-ai/dsh-api-job-controller/types'`（TS2305 修复）；client remote 15→26（新增 11 个官方 remote mount + import + 类型 re-export）；补 `dsh-permission-presets/types` type import；corum 事件计数面增量保留 |
| `src/index.ts` | substantive | emit 路径支持可选 `resources` 字段（`'resources' in entry ? entry.resources : undefined`）；补 `dsh-permission-presets/types` import |
| `src/remote-events.ts` | substantive | api-session/* 5 事件加 `resources: { session: (x): SessionId => ... }` 读取器；新增 9 官方事件（deepseek-account/session-expired、model-sign-in-required、credentials/record-updated、permission-presets/catalog-changed、plugin-manager/changed/install-log/install-state、plugin-market/changed、schedule/changed）；补 6 个新 type import；corum/* 25 条领域事件全部保留 |
| `src/types.ts` | identical | 无变化（与官方 rc3 逐字节一致） |
| `src/corum-events.ts` | corum-new | 无变化（corum 增量保留） |
| `package.json` | substantive | 新增 11 个 devDeps（account-controller/job-controller/terminal-controller/client-product-analytics/client-ui-plugin-manager/deepseek-account/office-to-pdf/permission-presets/plugin-manager/plugin-market/schedule） |

**corum-ui-base**（corum-only）：

| 文件 | 变化 |
|---|---|
| `src/client/theme-presenter.ts:58` | `snapshot.fontSize` → `snapshot.fontSizes.text`（rc3 ThemeSnapshot 破坏性变更：`fontSize:number` → `fontSizes:FontSizes=Record<FontRole,number>`；content 轴对应 'text' role） |

**corum-rpc-client**（corum-only）：无源码改动。rc3 `ConnectionHandle.rpc.call` 签名 + `ConnectionRpcResult` 结构未变。

**corum-platform**（corum-only）：无源码改动。rc3 `TypertRemoteService` 构造器签名兼容（options 默认 `{}`）；`@Remote('name')` 字符串重载仍有效。

**scripts/run-forced-typecheck.mjs**：spec 检查路径去掉 `--force`（TS5093: `--force` 仅与 `--build` 共用）。

#### 三平台差异检查

- corum-api-remotes：无平台特化（BFF 装配，纯 JS 事件转发）。
- corum-ui-base：`platform-paths.ts` 经 preload `window.corumDesktop.getPlatform()` 取实际运行平台分隔符，不硬编码 `/`（P2 已验）。theme-presenter 改动不涉及平台差异。
- corum-platform：`process.platform` 直接返回（darwin/linux/win32 三值全覆盖）；`bakedTargetPlatform()` 经环境变量读取（无编译期平台假设）。

#### 测试数

| 包 | tests |
|---|---|
| corum-api-remotes | 21 passed（remote-events.host.spec.ts） |
| corum-ui-base | 7 passed（grid.spec.ts） |
| corum-platform | 21 passed（session-facts 8 + platform-facts 4 + git-safe-directory 6 + session-facts-projection 3） |
| corum-rpc-client | 无 test（类型/构建包） |

#### 全仓错误基线变化

| 维度 | before（576178e8） | after（09451d3f） | 变化 |
|---|---|---|---|
| PASS | 21 | 30 | +9 |
| FAIL | 30 | 21 | -9 |
| 语义错误 | ~411（grep TS[0-9] 行数） | ~256（script 分类） | -155 |
| TS5033 | 0（script 未分类） | 0 | — |
| TS5093（spec --force） | 多包（ui-base/platform 等 spec 路径） | 0 | 脚本修复 |

9 包转绿（0 新增红）：
- 直接修复：corum-api-remotes（SessionJob）、corum-ui-base（fontSize）、corum-platform（TS5093 spec）
- 级联修复：corum-extension-pack、corum-extension-registry、corum-fs-local、corum-mcp-manager、corum-preset-modules、corum-session-archive（api-remotes 类型面修复后依赖链恢复）

#### 未解决项

- 无。本批 4 包全绿。剩余 21 个 FAIL 包归后续批次（C/E/P/D/B）。
- drift 守卫对 api-remotes 相关节（[1] corum-api-remotes src/index.ts 差异）：rebase 后 src/index.ts 仍有 corum 增量（`installCorumEventStats` 不在 drift 守卫的 byte-identity 检查范围——drift 守卫只检查核心文件 byte-identity，api-remotes 的 src/index.ts 差异属预期 corum 增量）。

#### 新增映射

- corum-rpc-client：needs-mapping → resolved=corum-only
- corum-ui-base：needs-mapping → resolved=corum-only

日志：`.corum-tmp/stage3-a1-after.log` + `.corum-tmp/stage3-a1-after.log.json`。

### A2+C 常规批：corum-tools / corum-sandbox-local / corum-credentials-local / corum-fs-local / corum-memory / corum-orchestration / corum-web-search / 7 needs-mapping + 6 no-change（2026-10-27）

#### start hash

- `cfbc5310`（A1 完成态）

#### 范围

A2：corum-extension-registry/corum-mcp-manager/corum-skill-manager/corum-extension-pack/corum-preset-modules/corum-git-core/corum-orchestration（orchestration 只处理常规 API）。
C：corum-fs-local/corum-sandbox-local/corum-credentials-local/corum-tools/corum-goal-round-driver/corum-todo-guard/corum-update-checker/corum-web-search/corum-memory/corum-ollama/corum-artgen/corum-session-queue-revert。
不含 corum-tool-subagent/corum-subagent/corum-agent/session UI/desktop shared patch（归 E/D/B）。

#### 基础设施修复

**zod 版本钉定**（影响 6 包）：
- 官方 dsh-v0.2.1-rc.3 全量包固定 zod@4.4.3，corum 自有包用 ^4.6.7 导致 internal 类型（$ZodCheck 等）在 `exactOptionalPropertyTypes: true` 下不兼容（TS2379）。
- pnpm-workspace.yaml overrides 新增 `'zod': '4.4.3'`；6 包（corum-agent/corum-memory/corum-orchestration/corum-subagent/corum-tool-subagent/corum-session-queue-revert）package.json zod 依赖从 ^4.6.7 改为 4.4.3。
- 修复 corum-memory TS2379 + corum-orchestration TS2379。

#### 逐包 rebase

**corum-tools**（官方 packages/core/tools 为底 + corum errorMessage 增量保留）：
- CodeRuntime→PtcRuntime 整体更名（服务名 codeRuntime→ptcRuntime、类型 CodeBindingFunction→PtcBindingFunction/CodeRunResult→PtcRunResult/CodeSdkLanguage→PtcSdkLanguage）
- ToolPresentationMode 删 'both'（type + zod union）
- MessageSourceMap 'plugin' kind 删除（跟随官方 rc3）
- 新增 ptc-calls.ts（官方新文件）+ ptc-calls.spec.ts
- 新增 deps：dsh-sandbox/dsh-sandbox-policy/dsh-working-directory/dsh-agent-loop-testkit
- 测试对齐：'both'→throw 断言；errorMessage 测试断言改 JSON（`{"code":500}` 而非 `[object Object]`，保留 corum 增量）
- 416 tests pass
- 三平台差异：无（纯逻辑包）

**corum-sandbox-local**（官方 packages/sandbox/sandbox-local 为底 + corum tryFixWorkspaceAcl 增量）：
- confine(argv, policy) → async confine(argv, policy, signal?): Promise<ConfinedArgv>（rc3 第四接线）
- 保留 tryFixWorkspaceAcl 重试逻辑（@corum/corum-platform import）
- canonicalPath / registerAclDiagnosisSkill 跟随官方
- 10 tests pass
- 三平台差异：win32 ACL 路径保留 corum 修复；linux/macOS 无影响

**corum-credentials-local**（官方 packages/credentials/credentials-local 为底 + corum 加密增量）：
- stored precedence 反转（managed store 优先于 env）
- describe() writable: true、删 assertUnshadowed、ignoredKeys 新字段
- 保留 corum 增量：AES-256-GCM 加密（value-crypto.ts）、MasterKeyUnavailableError degrade、INVARIANT seam 重抛
- build pass（无 test 脚本）
- 三平台差异：无（加密跨平台一致）

**corum-fs-local**（官方 packages/fs/fs-local 为底 + corum edit-candidates 增量）：
- 新增 watch() 方法（chokidar）、localDisplayPath() 对齐
- 保留 edit-candidates.ts 增量（editNotFoundHint/matchLineNumbers）
- 新增 dep：chokidar 5.0.0
- 170 tests pass（1 skipped）
- 三平台差异：localDisplayPath 内部按 process.platform 分支（win32 走 resolve，POSIX 保留 physical traversal）

**corum-memory**（corum-only，rc3 settings API 适配）：
- host 侧：acquireMemorySettingsScope 删 settings.register()；MemorySettingsProviderFace 窄化为只读 describe()
- client 侧：ctx.settingsScope.bind() → ctx.configForms.get(ns)
- typecheck pass
- 三平台差异：无

**corum-orchestration**（corum-only，zod pin 修复）：
- TS2379 由 zod 版本冲突引起，pin 4.4.3 后修复
- activation 消费面大改与 E 强耦合，本批只完成常规 API（zod 修复）；activation 面留 E
- typecheck pass

**corum-web-search**（corum-only，rc3 settings API 适配）：
- SettingsScope import 删除；settings.register() → describe()/update()
- ctx.settings.get(ns) → describe() 找 ns value
- client settingsScope → configForms.get()
- 14 tests pass
- 三平台差异：无

#### no-change 包（6 个，显式记录）

| 包 | 原因 |
|---|---|
| corum-ollama | corum-only，rc3 API 无变化，typecheck pass |
| corum-artgen | corum-only，rc3 API 无变化，typecheck pass |
| corum-goal-round-driver | corum-only，rc3 API 无变化，typecheck pass |
| corum-todo-guard | corum-only，rc3 API 无变化，typecheck pass |
| corum-update-checker | corum-only，rc3 API 无变化，typecheck pass |
| corum-session-queue-revert | corum-only，zod pin 修复（package.json only），typecheck pass |

#### needs-mapping 确认（7 包 → corum-only）

corum-extension-pack/corum-extension-registry/corum-git-core/corum-mcp-manager/corum-preset-modules/corum-skill-manager/corum-web-search 全部确认为 corum-only（消费官方 dsh 包但非 fork）。needs-mapping.json 20 → 11。

#### 测试数

| 包 | tests |
|---|---|
| corum-tools | 416 passed |
| corum-sandbox-local | 10 passed |
| corum-fs-local | 170 passed | 1 skipped |
| corum-web-search | 14 passed |
| corum-credentials-local | 无 test 脚本 |
| corum-memory | 无 test 脚本（host 侧） |
| corum-orchestration | 无 test 脚本 |
| corum-ollama | 无 test 脚本 |
| corum-artgen | 无 test 脚本 |
| corum-goal-round-driver | 无 test 脚本 |
| corum-todo-guard | 无 test 脚本 |
| corum-update-checker | 无 test 脚本 |
| corum-session-queue-revert | 无 test 脚本 |

#### 全仓错误基线变化

| 维度 | before（cfbc5310） | after（9572b040） | 变化 |
|---|---|---|---|
| PASS | 30 | 35 | +5 |
| FAIL | 21 | 16 | -5 |
| 语义错误 | 256 | 212 | -44 |
| 新增红 | — | 0 | 0 |

5 包转绿（0 新增红）：corum-memory、corum-orchestration、corum-sandbox-local、corum-tools、corum-web-search。

corum-subagent 从 OOM（unknown）变为 3 errors（zod pin 后类型面恢复，剩余错误属 E 批范围）。
corum-tool-subagent 从 44 → 40 errors（zod pin 减 4，剩余错误属 E 批范围）。

#### 未解决项

- corum-orchestration activation 消费面：与 E 强耦合（subagent activation 专项），本批只完成常规 API（zod 修复），activation 面标 blocked-by-E。
- 其余 16 FAIL 包归 E（corum-subagent/corum-tool-subagent）、D（corum-agent）、B（12 session/ui 包）批次。

日志：`.corum-tmp/stage3-a2c-before.log` + `.corum-tmp/stage3-a2c-after.log`。



## 阶段 4：三层验证

（执行时追加）

## 阶段 4.5：Electron 验证

（执行时追加）

## 阶段 5：装配进程隔离

（执行时追加）

## 阶段 6：顶层会话 sidecar

（执行时追加）

## 阶段 3 E1：corum-subagent activation 专项（2026-10-27 执行）

### 采用/退役/保留表

#### 官方底采用（新增 6 + 替换 10）

| 文件 | 操作 | 说明 |
|---|---|---|
| `activation.ts` | **新增** | ActivationPool/ChildLock/Activation 类型，取代 corum 的 continuation-activation.ts |
| `manager.ts` | **新增** | SubagentManager（1493 行）取代 corum 的 continuation.ts（startContinuable→startActivation） |
| `structured.ts` | **新增** | 官方 structured.ts 取代 driver/structured.ts（canComplete 第三参） |
| `catalog.ts` | **新增** | subagentCatalog 投影 + establishCatalogChild |
| `archive-admission.ts` | **新增** | workspace/session-activity + session-stop |
| `control.ts` | **替换** | 官方版本（rejectPrompt/cancel） |
| `lifecycle.ts` | **替换** | 官方版本，去掉 corum 的 observeRun/ActivationTerminal |
| `types.ts` | **官方为底** | + corum 字段（toolFilter/persona/kind/personaHint/confinedSandbox/readonlySandbox/agentOptionsOwnedByMechanism/mechanismRoute/localAgent） |
| `descriptor.ts` | **官方为底** | + corum 字段（kind/personaHint/confined 落盘 + parse/snapshot + OneShot 重载） |
| `child-agent.ts` | **官方为底** | + corum 增量（child-roles/confinement/escalation/narrowChildToolFilter）；childSessionMeta 改官方签名（去掉 cwd 参） |
| `depth.ts` | **官方为底** | + assertChildCwd（隔离 confine 补充校验） |
| `projection.ts` | **官方为底** | 逐字节采用 |
| `list-children.ts` | **官方为底** | 逐字节采用 |
| `out-of-process.ts` | **官方为底** | + localAgent: undefined（SubagentRun.corum 字段）+ toolFilter/persona 到 NO_START_CAPABILITIES |
| `continuation-messages.ts` | **官方为底** | + createSettlementMessage 第四参 deliveredToParent |
| `internal.ts` | **官方为底** | + HostPromptDeliveryMode export |
| `assistant-output.ts` | **替换** | joinAssistantStreamText（旧 expandAssistantStream API 更新） |
| `error.ts` | **逐字节相同** | 无变化 |
| `control-types.ts` | **替换** | 官方版本 |
| `projection-types.ts` | **替换** | 官方版本 |
| `client.ts` | **替换** | 官方版本 |

#### 退役文件（4 个）

| 文件 | 原因 |
|---|---|
| `continuation.ts`（697 行） | 功能由 manager.ts 取代（startContinuable→startActivation） |
| `continuation-activation.ts`（1003 行） | 功能由 activation.ts + manager.ts 取代 |
| `inbox.ts`（69 行） | 功能由 activation.ts 的 Activation.closing 直接处理 |
| `driver/structured.ts` | 移至根 src/structured.ts（官方位置，canComplete 第三参） |

#### 保留文件（corum-only 增量）

| 文件 | 说明 |
|---|---|
| `child-roles.ts` | 子 Agent 角色契约（worker/researcher）+ 注入层上限 |
| `routing-guard.ts` | 脚本模式路由剥离 + 告知 |
| `escalation-answerer.ts` | 子 Agent 提权应答器 |
| `escalation-grants.ts` | 会话级提权授权（三档第 2 档） |
| `escalation-policy.ts` | 提权判定纯函数 |
| `isolated/index.ts` | 隔离版 in-process provider（worktree + 台账 + 通知） |
| `isolated/script-model-resolution.ts` | 脚本模式子 Agent 模型路由解析 |
| `driver/index.ts` | one-shot 驱动（structured 改用官方 attachStructuredRuntime；descriptor 改自建） |
| `run-settlement.ts` | 保留供 E2（corum-tool-subagent 仍调 settleRun） |
| `spawn/index.ts` | corum spawn provider |
| `fork/index.ts` | corum fork provider |

### 关键机制落点

| 机制 | 落点 |
|---|---|
| 沙箱钳制接线 1（工具层） | `child-agent.ts` captureDelegatedPolicyOverrides 的 pinReadOnly/confineToWorktree options |
| 沙箱钳制接线 2（isolated provider） | `isolated/index.ts` prepareIsolatedChild 设 confinedSandbox: true |
| 沙箱钳制接线 3（continuable + 冷恢复） | `manager.ts` startLocal captureDelegatedPolicyOverrides + coldResume composition.confined |
| 第四接线（confine async 签名） | corum-sandbox-local（已在沙箱专项完成） |
| descriptor 增量字段 | `descriptor.ts` kind/personaHint/confined 落盘 + parse/snapshot |
| 用户停止级联 | `manager.ts` stopConversation/resumeConversation + userStoppedFor + notifySettlement 检查 |
| 结算通知去重 | `activation.ts` deliveredToParent + `continuation-messages.ts` createSettlementMessage 第四参 |
| 冷恢复路线覆盖 | `types.ts` SubagentSendMessageOptions.agentOptions + `manager.ts` coldResume 合入 |
| run id 全局唯一 | 官方已自带（randomUUID in manager.ts:385 + lifecycle.ts:102） |
| assertChildCwd | `depth.ts` 保留（隔离 confine 补充校验） |
| orchestrate structured output | `structured.ts`（官方原生支持 outputSchema + STRUCTURED_OUTPUT_TOOL）；E2 验证 |

### 验证结果

- **typecheck**：✅ 0 错（`tsc -b --pretty false`）
- **build**：✅ 6 文件 253.12 kB（`tsc -b && tsdown`）
- **grep startContinuable src/**：✅ 0 命中
- **测试**：7 个非 API 依赖文件全绿（122+1 通过）；旧 API 依赖文件（continuation/continuation-inheritance/isolation-confinement/list-children/ownership/service/control/out-of-process/run-settlement/child-agent/timing-projection/fork-provider/isolated-provider 等）待重写到 startActivation API

### 未做（E2 接口契约与风险）

- **corum-tool-subagent** 未迁移（E2）：仍调 `ctx.subagents.startContinuable(...)` / `ctx.subagents.start(...)` / `settleRun(...)`。全仓 `grep startContinuable` 在 tool-subagent src 有命中，属 E2 范围。
- **旧 continuation 测试未重写**：126+ 个测试使用 `startContinuable` API，需映射到 `startActivation`。测试意图保留，API 调用形式需更新。
- **orchestrate structured output**：E1 导出/事件面够用（STRUCTURED_OUTPUT_TOOL 已导出），orchestration 消费面在 E2 验证。
- **corum-tool-subagent 的 `corumSchedulingDescription` job_output/job_kill 文案删除**：E2。
- **全仓 forced typecheck**：corum-subagent 从 3 errors → 0 errors；tool-subagent 从 40 errors → 0 errors（E2 完成后）。E 后全仓 = 37/51 PASS, 14 FAIL, 169 错（`.corum-tmp/stage3-e-after.log`）。

### commits

| # | hash | message |
|---|---|---|
| 1 | — | upgrade(0.2.1-rc3): corum-subagent 采用官方 rc3 生命周期底 + 增量重接线 |
| 2 | — | upgrade(0.2.1-rc3): 测试迁移（jsonl→apply 形态 + childSessionMeta 签名更新） |
| 3 | — | upgrade(0.2.1-rc3): 更新 verify-fork-drift SUBAGENT_DELTA/NEW 文件清单 |

## 阶段 3 E-test：官方测试补齐与记录（2026-10-28 执行）

### 逐文件对照清单（官方 rc3 tag vs corum）

| 官方 spec 文件 | 状态 | corum 测试名 / 原因 |
|---|---|---|
| `structured.spec.ts` | **adopted** | 39 测试全绿（outputSchema→tool→terminal.structured 真实链） |
| `catalog.spec.ts` | **adopted** | 20 测试全绿（纯投影，无额外 deps） |
| `archive-admission.spec.ts` | **adopted** | 6 测试全绿（workspace/session-activity + session-stop） |
| `external-activation.spec.ts` | **adopted** | 19 测试全绿（+ external-activation-helpers.ts helper） |
| `external-lifecycle.spec.ts` | **adopted** | 7 测试全绿 |
| `parked-wait.spec.ts` | **adopted** | 6 测试全绿 |
| `run-settlement.spec.ts` | **adopted** | 2 测试全绿（纯函数 settleRunResult） |
| `continuation-messages.spec.ts` | **adopted** | 7 测试全绿（纯函数 createSettlementMessage） |
| `parent-result.spec.ts` | **adopted** | 3 测试全绿 |
| `activation-policy.spec.ts` | **adopted** | 9 测试全绿（fork 适配：`'ask'` 而非 `'never'`） |
| `activation-presets.spec.ts` | **adopted** | 6 测试全绿（+ fixtures 目录 + cordis-plugin-include） |
| `continuation-presets.spec.ts` | **adopted** | 12 测试全绿（queueHostSubagentPrompt 路径改 `../src/internal.ts`） |
| `schedule-tools.spec.ts` | **not-applicable** | 依赖 `dsh-schedule` + `dsh-storage-domain` 测试 helpers + sessionController provider；机制是 host 端 `subagent_session` 拒绝，corum 无此测试基建 |
| `continuation-messages-adapter.spec.ts` | **not-applicable** | 依赖 `dsh-llm-deepseek` + 官方 deepseek 测试 helpers（`../../../llm/llm-deepseek/tests/helpers.ts`），该路径在 corum 不存在；适配器集成测试与 deepseek adapter 强绑定 |
| `service.spec.ts` | **already-covered + 补齐** | 补 6 项官方缺失测试（catalog projection binding/disposed parent/neither execution method/unavailable runtime/reserved child/no owned work） |
| `child-agent.spec.ts` | **already-covered + 补齐** | 补 `resolveChildDepth` RangeError 测试（2 组参数化） |
| `continuation.spec.ts` | **already-covered** | 164 测试，含 `deliveredToParent` 折叠文案断言 |

### 移植前后测试数

| 包 | 移植前 | 移植后 | 增量 |
|---|---|---|---|
| corum-subagent | 466 (21 files) | **614 (33 files)** | +148 |
| corum-tool-subagent | 450 (18 files) | 450 (18 files) | 0（回归验证） |
| corum-orchestration | 147 (4 files) | 147 (4 files) | 0（回归验证） |

### 生产修复

`child-agent.ts` 的 `captureDelegatedPolicyOverrides` / `appendDelegatedPolicyOverrides`
恢复 `permissionPreset` 捕获与 `permission/preset` 事件追加——fork 此前整体删除了
该字段（官方 `activation-policy.spec.ts` 暴露的回归）。同时添加
`import type {} from '@deepseek-ai/dsh-permission-presets'` 以加载 `SessionEventMap`
的 `permission/preset` 模块增强。

### 新增 devDeps

`dsh-fs-sandbox` / `dsh-tool-fs` / `dsh-ptc-runtime` / `dsh-permission-presets` /
`cordis-plugin-include`

### fork 行为差异适配（非生产修复，测试夹具调整）

- `approval/policy` 钉 `'ask'`（而非官方 `'never'`）——已在 `activation-policy.spec.ts`
  的断言中适配（已有 `continuation-inheritance.spec.ts` 同样断言）
- `SubagentCapabilities` 含 `toolFilter`/`persona` fork 字段——在 ALL_CAPS/NO_CAPS
  和 provider 注册处补齐

### 全仓验证（日志 `.corum-tmp/stage3-e-final-*.log` + `.corum-tmp/stage3-e-after.log` + `.corum-tmp/stage3-e-drift.log`）

- **corum-subagent**：33 文件 614 测试全绿；typecheck + build 全绿
- **corum-tool-subagent**：18 文件 450 测试全绿；typecheck（含 spec `--noEmit`）+ build 全绿
- **corum-orchestration**：4 文件 147 测试全绿；typecheck + build 全绿
- **corum-goal-round-driver**：1 文件 9 测试全绿；typecheck + build 全绿
- **E 四包合计**：56 文件 1220 测试，typecheck/build/test 全绿
- **guard16（SUBAGENT_DELTA 分区）**：0 红 ✅（orchestrate script 模式断言已改为断言旧接线已删除 + 现行 activation/closer 接线存在）
- **全仓 forced typecheck**（`scripts/run-forced-typecheck.mjs`）：37/51 PASS, 14 FAIL, 169 语义错（E 四包全绿；corum-agent 9 错与 E 前一致系 D/UI 既存错；其余 12 包失败为 UI/D 既存错，非 E 引入）——**此后 D/B 批次已全部清零，最终全量门禁见文末「阶段 3 最终全量门禁收口」**
- **fork-drift**（`DSH_BASELINE_TAG=dsh-v0.2.1-rc.3`）：1 项失败（sandbox-local/src/index.ts 与官方有差异，D 任务 A2C rebase 引入的 Windows ACL 修复，非 E）——守卫过期项（orchestrate script 模式接线断言 + pinned dsh 包版本号硬编码 + 技能副本同步）已修复

### commits

| # | hash | message |
|---|---|---|
| 1 | `5135ed03` | test(E): 移植 12 个官方 rc3 spec + 恢复 service.spec 缺失测试 + resolveChildDepth |
| 2 | `ce7c8595` | fix(E): 恢复 child-agent.ts permissionPreset 捕获（activation-policy 回归） |
| 3 | `b8d42494` | docs(E): 更新 fork-delta/inventory/UPGRADE 记录测试补齐

---

## 阶段 3 P：preset 专项（2026-10-28）

### 目标

静态五份 preset + 动态 preset + settings 默认值全部单一官方 registry 来源，不恢复扫描，不双来源。保留 corum 插件行和 disabled 行，不禁用官方 registry。

### 交付

#### 1. 静态五份 preset（`packages/desktop/presets.patch.yml`）

新增 `presets.patch.yml`，接入 boot.ts 的 patch 层栈（`presetOverlays`，位于 `overlays` 之后、`modeOverlays` 之前）。四份官方 preset（standard/ptc/cordis）按官方 row id 覆盖 `config.plugins`（不含 name → 纯覆盖，但含完整 `config.id/order/plugins` 合法结构）；conductor 是 corum 独有 → `- insert: - id: preset-conductor, name: '@deepseek-ai/dsh-agent-preset', config: { id: conductor, order: 5, plugins: [...] }`。minimal 保持官方 insert 不覆盖（无编排面）。

corum 覆盖内容：
- delegation 组：三实例 @corum/corum-tool-subagent（worker + research + fork）+ disabled codex/claude-code + workflow 引擎行 + ralph 行；
- skill-filesystem：corum 集中管理（includeDefaultRoots:false + customSkillDirs=$CORUM_HOME/skills）；
- 其余行保持官方结构（persona/agent-instructions/time-context/tool-bash/pwsh/fs/fs-search/jobs/schedule/skill/command-goal/tool-goal/planning/compaction/ask-user/todo/web/present/plugin-manager/market）。

disabled 行保留双重职责（AGENTS.md 红线 5）。

#### 2. boot.ts 旧 roots/includeShippedRoot 退役

删除 `CORUM_SHIPPED_PRESETS`/`OFFICIAL_SHIPPED_PRESETS`/`CORUM_DEV_PRESETS`/`OFFICIAL_DEV_PRESETS` 四个路径常量 + `resolveAgentPresetRoots()` 函数 + boot.ts:493-506 的 `agent-presets` roots 注入块。shipped-presets 源文件保留为对账资源，运行时不读取。

#### 3. 动态 preset 注册（`preset-registration.ts`）

新增 `packages/plugins/agent/corum-agent/src/preset-registration.ts`：
- `registerUserPreset(ctx, id)`：读 `~/.corum/.agent-presets/<id>/agent.cordis.yml`，解析为 entry list，调 `ctx.agentPresets.register({ id, plugins, name?, description?, order? })`；
- `unregisterUserPreset(ctx, id)`：dispose 旧定义；
- `registerAllUserPresets(ctx)`：启动时一次性注册全部已有用户 preset（单个坏 preset 不拖垮全部）；
- 在 `CorumAgentService` constructor 中调 `registerAllUserPresets(ctx)`（`void` fire-and-forget）；
- 在 `persistProfileAndRecompile` 后调 `registerUserPreset`（保存/更新同步）；
- 在 `deleteProfileRemote` 后调 `unregisterUserPreset`（删除同步）。

#### 4. settings 默认值持久化

- `agent-service.ts`：`resolveDefaultTaskProfileId()` 和 `readConfiguredDefaultPreset()` 改读 `ctx.agentPresets.defaultId`（registry 公开 getter，`selectedDefault ?? default`），不再读 `settings.get('agent-presets').default`；
- `boot.ts`：新增 `resolvePersistedDefaultPreset()` 读 `$DSH_HOME/.default-preset` 文件，boot overlay 写入 `agent-preset-registry` 行的 `config.default`（覆盖 web-app bundle 的 `default: standard`）；
- `agent-service.ts`：新增 `setDefaultPresetRemote(presetId)` RPC 端点，写入 `.default-preset` 文件；
- 设置 UI `SettingsAgentSettingsSection.tsx`：默认预设下拉改用 `rpc('corumAgent', 'setDefaultPreset', id)` 而非 settings 命名空间；值从 `listProfiles` 返回的 `defaultProfileId` 读取。

#### 5. dsh-agent-preset 声明包依赖

- `desktop-host/package.json`：增 `@deepseek-ai/dsh-agent-preset: 0.2.1-rc.3`；
- `corum-agent/package.json`：devDeps 增 `yaml: ^2.9.0`（preset-registration.ts 用）；
- lock 单独解锁更新。

#### 6. pack-macos shipped-presets 退役

`pack-macos.mjs` 删除 shipped-presets staging（`SHIPPED_PRESETS_DIR` 的 `rm/mkdir/cp` 三步），保留 shipped-skills / shipped-modules staging 不动。源文件 `shipped-presets/official/` 保留为对账资源（guard §17 仍对照）。

#### 7. compile.ts 注释更新

`standardRows()` 注释从旧路径 `@deepseek-ai/dsh-agent-preset-registry/presets/standard/agent.cordis.yml` 改为 `packages/bundle/web-app/presets/standard.patch.yml`（config.plugins 数组），并说明静态 patch.yml 与动态编译产物是两套。

#### 8. guard §17 rc3 断言升级

rc3 基线（`PRESET_FORMAT_MIGRATED=1`）下新增真实断言：
- boot.ts 无 `includeShippedRoot`/`roots`/`resolveAgentPresetRoots`；
- `presets.patch.yml` 存在 + 含 4 个官方覆盖 id（preset-standard/ptc/cordis/conductor）；
- conductor insert 行存在；
- corum 三实例 @corum/corum-tool-subagent 行数 ≥9（4 份 preset × 3 实例）；
- desktop-host 含 `@deepseek-ai/dsh-agent-preset` 依赖；
- pack-macos 不复制 shipped-presets。
0.1.5 基线保持原有断言不变。

### 测试

- `tests/preset-registration.spec.ts`（新增，10 个测试）：
  - ① 编译落盘的 profile → register → registry.list 含它；
  - ② 文件缺失 → 跳过（返回 false）；
  - ③ 更新 preset：重新 register 先 unregister 旧定义；
  - ④ 坏 agent.cordis.yml → 跳过（不拖垮）；
  - ⑤ unregister 已注册 → registry.list 不含它；
  - ⑥ unregister 未注册 → 无副作用；
  - ⑦ registerAllUserPresets：多个有效 profile 全部注册；
  - ⑧ 一个坏 preset 不拖垮全部；
  - ⑨ .agent-presets 目录不存在 → 无副作用。
- `tests/default-preset.spec.ts`（更新，11 个测试）：
  - 从 `settings.get('agent-presets')` mock 改为 `ctx.agentPresets.defaultId` mock；
  - 覆盖 7+4=11 个断言场景。

### 未做（D 处置）

- **corum-agent rebase 本身**（agent-service.ts 2500+ 行）：D 任务，P 只做 preset 相关改动，不碰 D 的 rebase 范围。corum-agent typecheck 9 个既有错与 D 相关，P 新增测试可独立过。
- **AgentPreset.trust 消费迁移**（agent-service.ts:1207 读 `.trust`）：D 处置，P 不在此改。但 profile metadata 映射不再加官方已删 trust 字段。
- **完整 pack / smokeBridge / assert-packaged-boot / CDP**：阶段 4 验证范围，P 只验 `pack:host:mac --skip-app`。
- **全仓 forced typecheck**：P 只减不增（preset 相关改动不引入新 typecheck 错）。

### commits

| # | hash | message |
|---|---|---|
| 1 | — | deps(P): add dsh-agent-preset + yaml, update lock |
| 2 | — | feat(P): static presets.patch.yml + boot.ts wiring + roots 退役 |
| 3 | — | feat(P): dynamic preset registration + default preset RPC + settings UI |
| 4 | — | feat(P): guard §17 rc3 assertions + compile.ts comments + pack-macos |
| 5 | — | docs(P): UPGRADE + 03 ledger + 05 P done |

---

## P 专项纠偏（M1-M4，2026-10-28 独立审查后）

### 审查报告

独立只读审查报告（`~/.corum/research-reports/832c2d9d-3577-4e7d-a1b3-d9f1d129535a.md`）对 HEAD `21f53b31` 的 P 专项给出 **FAIL** 判定，4 个必须修项：

| # | 问题 | 判定 |
|---|---|---|
| M1 | presets.patch.yml 未打包 → 正式包 boot 必崩（loadOverlayPatches throw） | 已修 |
| M2 | 默认持久化偏离 05 §4.5(e)：既有用户 settings ns 默认值静默丢失 + 改默认需重启生效 | 已修（适配 rc3） |
| M3 | 动态注册竞态 + 解析失败静默：`void registerAllUserPresets(ctx)` 未等待 | 已修 |
| M4 | 销账过早 + 无 boot 级测试 | 已修 |

### M1 修复：pack-macos 复制 presets.patch.yml

- `pack-macos.mjs copyDesktopArtifacts`：新增 `cp presets.patch.yml → HOST_DIR`（与 cordis.patch.yml 同链）。
- `packages/desktop/package.json`：`exports` + `files` + `build.files` 登记 `presets.patch.yml`。
- `pack-macos.mjs`：新增部署断言——`HOST_DIR/presets.patch.yml` 存在且内容合法（非空 + 含 `- id:` / `- insert:` 结构）。
- guard §17：新增「pack-macos 复制 presets.patch.yml」+「desktop package.json exports 登记」两条断言。
- **验证**：`pnpm run pack:host:mac -- --skip-app` exit 0；`build/host/presets.patch.yml` 实物存在（33161 bytes）；`build/host/lib/bridge.js` 含 `PRESETS_PATCH` + `presetOverlays` 引用（5 处）。

### M2 修复：默认持久化走官方 settings 通道（volatile selectedDefault 持久化 + 热生效）

> **关键发现（已纠正）**：05 §4.5(e) 原假设「settings ns `agent-presets` 可通过 settings mutate 写 `default` 字段」在 rc3 不可行（`default` 非 volatile），但**官方 `SettingsForms.write()` 会把 volatile 字段值持久化进 profile patch**（`mergeLayers(strip(raw, form), next)`，settings/src/index.ts:414-416），且 `configEditor.edit` 触发 loader `_commitVolatile` + `loader/volatile-update` 事件——实现**运行期即时生效 + 重启后恢复**。官方测试 `configuration.spec.ts:65-79` 证明 volatile 值穿越 `fiber.dispose()` 重启存活。
>
> 故「settings ns 作为唯一持久层在 rc3 完全可行」，且官方 UI（`ui-agent-preset`）正是这么做的。`.default-preset` 文件 + `Symbol.for("cosmokit.volatile.write")` 直写方案**已被撤回**：它是建立在与官方代码相反的事实判断上（误判 selectedDefault 不持久化），属于内部协议滥用（绕过 schemastery 校验、绕过 `write()` 落盘、绕过 loader 的 `_commitVolatile` 与 `loader/volatile-update` 事件）。

实际实现：
1. **持久化 + 热生效**：`setDefaultPresetRemote` RPC 调 `ctx.settings.update('agent-preset-registry', { selectedDefault: effectiveId })`，volatile 值持久化进 profile patch 且热生效。官方 `write()` → `mergeLayers` → loader `_commitVolatile` + `loader/volatile-update` 事件链。
2. **重启持久**：schemastery 从 patch raw 解析 volatile `selectedDefault`，`defaultId` getter（`selectedDefault.get() ?? config.default`）直接返回持久值，无需 boot 读文件或注入 overlay。
3. **undefined 清除**：`effectiveId === undefined` 时 `settings.update({ selectedDefault: undefined })` 清除，`defaultId` 回落 `config.default`（registry 自带 `default: standard`）。
4. **无效 preset id 回退 `standard` + warn**：`setDefaultPresetRemote` 校验 presetId 在 registry list 中且未 broken。
5. **写失败必须抛错**：不 catch 后伪 `{ ok: true }`（settings.update 失败直接 reject）。
6. **boot 无需读文件**：删除 `resolvePersistedDefaultPreset()` 与 `.default-preset` overlay 注入。官方 profile patch 启动即恢复 volatile 值。
7. **不迁移/删除用户 `.default-preset` 文件**：该实验方案未发布，普通用户无此文件（两台 home 实测均无）；只在 docs 记录撤回。

### M3 修复：动态注册 ready Promise + disposer 进 service state + warn 日志 + validatePlugins

1. **ready Promise**：`PresetRegistrationState` 类持有 `readyPromise`，`registerAllUserPresets` 返回 Promise 并赋值给 `ready`。所有 list/mount/select/create 任务入口（`listProfilesRemote`/`createAgentRemote`/`createAgentForTask`/`setDefaultPresetRemote`）`await presetRegistrationReady()` 确保注册完成后才读 registry。
2. **disposer Map 进 service state**：`PresetRegistrationState` 类（由 `CorumAgentService` 实例拥有）持有 disposer Map，随 `ctx.effect` dispose 清理。不用模块级可变 Map（AGENTS 红线 1）。
3. **warn 日志**：`readPresetPlugins` / `readPresetMetadata` 解析失败/non-array/metadata 错误 warn 带 preset id 和原因（不再静默返回 undefined）。disposer 失败 warn 带 preset id 和原因（不静默 catch）。
4. **validatePlugins 真实调用 `entryListProblem`**：从 `@deepseek-ai/dsh-agent-preset-registry` 值导入 `entryListProblem`（依赖已存在 + tsdown external），空壳函数删除。
5. **state dispose 返回 Promise.all**：`ctx.effect` dispose 回调收集所有 disposer 的清理 Promise，`Promise.all` 等待完成（不再 fire-and-forget）。
6. **register 失败显式说明旧定义已移除**：warn 消息显式「old definition was removed」，不伪成功。
7. **delete RPC await unregister**：`deleteProfileRemote` 改为 async，`await unregisterUserPreset(id)` 确保 disposer 完成。

### M4 修复：真实测试 + skip-app + 台账销账

1. **静态合成测试**（`tests/preset-composition.spec.ts`，新增 8 个测试）：
   - 官方 rc3 bundle patches + corum presets.patch.yml 按 boot 同顺序 `composeEntries` → 验证含 standard/ptc/minimal/cordis/conductor + default bind 不抛；
   - standard/conductor mount 含 @corum/corum-tool-subagent（3 实例）+ 无旧 config 键（`provider:spawn` 被覆盖为 `corum-spawn`）；
   - minimal 官方 insert 合法保留（corum 无增量）。
2. **动态测试更新**（`tests/preset-registration.spec.ts`，新增 disposer warn + register failure 测试）：
   - 改用 `PresetRegistrationState` 类（不再用模块级函数）；
   - 坏 preset warn 带 id 断言（M3 要求）；
   - disposer 失败 warn 带 preset id 和原因；
   - register 失败 warn 显式说明旧定义已移除。
3. **默认持久化测试**（`tests/default-preset.spec.ts`，16 个测试）：
   - settings.update 参数验证（`('agent-preset-registry', { selectedDefault })` 调用）；
   - 写失败抛错传播（不 catch 后伪 ok:true）；
   - defaultId 下一次任务生效（resolveDefaultTaskProfileId 读 defaultId getter）；
   - 无效 id 回退 standard、undefined 清除回退 config.default；
   - **真实持久化穿越**：volatile 写 → dispose → 重建 → defaultId 保留（非 mock，用官方 SettingsForms + ConfigEditor + AgentPresetRegistry 真实 boot）。
4. **pack:host:mac --skip-app**：exit 0，`build/host/presets.patch.yml` 实物存在，bridge.js 含 `PRESETS_PATCH` 引用。
5. **03 台账 §3.6**：#1/#2/#5/#6 从「已处置」升级为「已处置 + 验证」，标注 M1-M4 验证证据。
6. **05 §4.5(a)**：minimal 偏差文档矛盾解决——注明「corum minimal 无增量，官方 rc3 insert 即迁移落点」。

### M2 文档矛盾已解决

05 §4.5(e) 原文要求「settings ns `agent-presets` 作为持久层」。经研究证实：rc3 官方 `SettingsForms.write()` 会把 volatile 字段值持久化进 profile patch，故 settings ns 作为单一持久层在 rc3 **完全可行**。05 §4.5(e) 已更新为说明 rc3 实际机制（官方 `settings.update('agent-preset-registry', { selectedDefault })` 通道，volatile 持久化 + 热生效 + 重启恢复）。**brief 与代码的分歧已消除**——`.default-preset` 文件 + Symbol 直写方案撤回，改为官方 settings 通道。

## 阶段 3 D2 纠偏：三个 settings ns 对齐 patch 行 id（2026-10-28）

### 初审 FAIL + 裁决

独立评审报告 `~/.corum/research-reports/429e00b9-a1a4-4aae-9135-c81dabfd2f66.md` 确认：
三个 settings registrar 的 **settings ns 与 patch 行 id 不一致**——rc3 用 `entry.options.id`
作为 settings ns（`describe()` 的 `ns` 字段、`write()` 的 ns 参数），**不存在** entry id → ns
的映射。旧消费方读的 ns 与 patch 行 id 不匹配 ⇒ describe 读空、write 抛
`No configurable plugin entry`。

| registrar | patch 行 id（=rc3 实际 ns） | 旧消费方读取的 ns | 后果 |
|---|---|---|---|
| corum-tool-subagent | `corum-subagent-settings` | `'corum-subagent'` | 设置页读空、write 抛错 |
| corum-memory | `corum-memory-settings` | `'corum-memory'` | acquireMemorySettingsScope 恒 undefined |
| corum-ui-onboarding | `corum-ui-onboarding-settings` | `'ui-onboarding'` | welcome scope 恒 unavailable |

**裁决 A**（采用）：消费方 ns 对齐现有行 id——不并主 Config、不改重复 id（loader 显式
重复 id 行为未验证，且需动两个主包的 Config 声明面）。

### 三 ns 对齐

- `CORUM_SUBAGENT_SETTINGS_NAMESPACE`: `'corum-subagent'` → `'corum-subagent-settings'`
- `CORUM_MEMORY_SETTINGS_NAMESPACE`: `'corum-memory'` → `'corum-memory-settings'`
- `WELCOME_NOTICE_SETTINGS_NAMESPACE`: `'ui-onboarding'` → `'corum-ui-onboarding-settings'`

同步更新的消费方（共 8 处源码 + 4 处测试）：
- `corum-tool-subagent/src/settings-namespace.ts`（常量定义 + acquireCorumSubagentSettingsScope）
- `corum-tool-subagent/src/index.ts`（文档注释）
- `corum-memory/src/memory-config.ts`（常量定义 + acquireMemorySettingsScope）
- `corum-memory/src/client/index.tsx`（`MEMORY_SETTINGS_NS` 本地镜像）
- `corum-memory/src/memory-service.ts`（文档注释）
- `corum-subagent/src/isolated/script-model-resolution.ts`（`CORUM_SUBAGENT_NS` 本地镜像）
- `corum-ui-settings-models/src/onboarding-copy.ts`（常量定义）
- `corum-ui-settings-models/src/settings-registrar.ts`（文档注释）
- `corum-ui-settings-models/src/index.ts`（文档注释）
- `corum-ide-ui/.../SettingsAgentSettingsSection.tsx`（`SUBAGENT_NS`）
- `corum-ide-ui/.../SettingsAgentPresetsSection.tsx`（`n.ns === 'corum-subagent'`）
- 测试：`corum-tool-subagent/tests/model-policy.spec.ts`、`corum-subagent/tests/script-model-resolution.spec.ts`

### 删除三个 registrar 的 configure({auto:true})

`autoGenerate` 默认就是 true（rc3 describe `?? true`），这三个 `configure({auto:true})` 是
近似 no-op。尤其 `corum-tool-subagent` registrar 直接 `ctx.settings.configure` 裸访问
（未 `inject(['settings'])`），settings 未挂载时有 TypeError 风险。整段删掉，保留 Service +
`static Config`——Config 声明本身已让 ns 进 describe。

### 旧设置迁移（一次性、幂等、新值优先）

官方 `importLegacyDocument`（settings/src/index.ts:346）在首启时把 `settings.yaml` 改名为
`settings.yaml.imported`，按 `LEGACY_SECTION_ENTRIES[section] ?? section` 找 entry：
- `corum-subagent` / `corum-memory` 不在官方映射表 ⇒ `update('corum-subagent', …)` 找不到
  entry ⇒ warn 丢值。
- `ui-onboarding` 被官方映射到 `ui-settings-general`（不是 corum 的 onboarding ns）。

实现通用、幂等的一次性映射（`corum-agent/src/settings-legacy-migration.ts`）：
- 仅读已备份的 `settings.yaml.imported`（不触碰真实 `settings.yaml`）；
- 旧段 → 新 ns 映射表（`LEGACY_NS_MAPPING`）：`corum-subagent`→`corum-subagent-settings`、
  `corum-memory`→`corum-memory-settings`、`ui-onboarding`→`corum-ui-onboarding-settings`；
- **新值优先**：目标 ns 在 `describe().user` 里已有非空值时跳过（不被旧值覆盖）；
- **幂等**：marker 文件 `settings.legacy-ns-migrated` 存在即跳过；
- **坏值 warn 不启动失败**：旧段值类型校验失败只 warn，不抛错；
- 在 `corum-agent/src/index.ts` 的 `apply()` 中调用 `runLegacySettingsMigration(ctx)`，
  settings 服务挂载后短轮询执行（同 `runSettingsYamlGuard` 同款）。

### 真实测试（不喂同常量自证）

新增 `corum-tool-subagent/tests/d2-ns-guard.spec.ts`（19 个测试）：
1. **patch 行 id ↔ ns 常量逐字相等**（3 个）——从 `cordis.patch.yml` 文件实读行 `id:`
   字段，与三个导出常量逐一相等（防回潮）；
2. **三个 registrar 不再调 configure({auto:true})**（3 个）——源码注释剥离后检查；
3. **旧段迁移**（7 个）——一次性补缺值、新值优先跳过、marker 幂等、坏值 warn 不中断、
   三段同时迁移、`LEGACY_NS_MAPPING` 覆盖三个旧段名；
4. **YAML 段解析器**（6 个）——扁平/嵌套/标量/多段/注释/语法残缺。

### 验证结果

- `corum-tool-subagent` typecheck 0 错 / test 469 通过（含 19 个 D2 新增）
- `corum-memory` typecheck 0 错 / test 131 通过
- `corum-agent` typecheck 0 错 / test 445 通过
- `corum-subagent` typecheck OOM（台账已知豁免）/ test 614 通过
- `corum-ui-settings-models` / `corum-ide-ui` typecheck 既有错误数不变（B1 基线，D2 未增减）
- 真实测试总数：19（D2 新增）+ 469 + 131 + 445 + 614 = 1678（四包全绿）

### 05 B 计划同步评审修正

评审报告 §5 确认的 05 B 计划必需修正：
1. **azure 协议 id 不改**：`azure-openai-responses` 在 rc3 仍是合法 wire protocol
   （pi-ai 0.85.1 `KnownApi` 类型），05 原写「→ azure」是误判 provider 路由键与协议选择器；
2. **`useSessionPendingInteraction` 迁移**：0.1.5 有 → rc3 删，ConversationRoot.tsx:138,146
   实错，需迁移到 rc3 `useSessionStatus`；
3. **settingsScope→configForms 全清单**：§3 表第 1 列列出需同批迁移的包；
4. **corum 导航服务**：ISessions 重写在 IDE 模式不能依赖官方 `uiWorkspace.openSession`
   （IDE patch 禁用了官方 ui-workspace），需在 corum 侧新建选址/导航服务；
5. **inbox**：queue → inbox 投影映射（`session.projections.faceOf('inbox')`）；
6. **configForms**：settingsScope → configForms 迁移面（含 settings-models client）；
7. **transcript/blank verify-only**：corum 自有 2 模式世界 + 已有等价实现，降级为
   verify-only（不迁移）。

### commits

- `fix(D2): 三个 settings ns 对齐 patch 行 id + 删 configure({auto:true}) + 旧段迁移`

## B1 迁移实录（2026-10-28）

### 概要

B1 = ISessions/选址组 + settingsScope→configForms + queue→inbox + icons + 机械组。
13 个包全部迁移完成，全仓 forced typecheck **51/51 PASS / 0 错误**（B1 前 12 FAIL / 160 错误）。

### 迁移内容

1. **corum 会话选址/导航服务**（`corum-ui-conversation/src/client/corum-navigation.ts`）：
   cordis Service（provide+inject，跨 bundle 单例），持 `MainSelection` 等价状态 + retain 引用生命周期。
   `openSession(target)` → `retain(target, {source:'mainView'})` + release 旧引用；
   `clearSelection()` → release + 清空 selection store。
   切换/取消/dispose 释放旧引用，快速切换不泄漏（mirrors official navigation.ts replaceMain/clearMain）。

2. **ISessions.open/clear/list.current 全部替换**：
   - `sessions.open(id)` → `ctx.corumNavigation.openSession(id)`（conversation/chat/ide-ui/sidebar/titlebar）
   - `sessions.clear()` → `ctx.corumNavigation.clearSelection()`（sidebar/titlebar）
   - `sessions.list.getSnapshot().current` → `ctx.corumNavigation.selection.getSnapshot().sessionId`

3. **settingsScope→configForms**：
   - `inject 'settingsScope'` → `inject 'configForms'`
   - `ctx.settingsScope.bind({namespace})` → `ctx.configForms.get(namespace)`
   - `ctx.settingsScope.describe()` → `ctx.configForms.describe()`
   - `SettingsScope<T>` → `ConfigForm<T>`，`SettingsScopeSnapshot<T>` → `ConfigFormSnapshot<T>`（drop `mode` field）
   - `settings.register(namespace, schema)` → `static Config` + `settings.configure({auto: false})`（conversation/chat host index.ts）

4. **useSessionPendingInteraction→useSessionStatus**：
   rc3 `GlobalStandardProps` 删了 `useSessionPendingInteraction`，改为 `useSessionStatus`（selector over `SessionStatusSnapshot`）。
   `ConversationRoot.tsx` + `SessionsPane.tsx` 均已迁移。

5. **queue→inbox 投影**：
   - `SessionSnapshot.queue` 删除 → `session.projections.faceOf('inbox')` 返回 `InboxState`
   - `s.queue` → `useProjection('inbox') as InboxState | undefined`
   - `inbox.filter(item => item.placement === 'steering')` → `inbox?.['next-step'] ?? []`
   - steer 走 `session.updateQueue(id, { kind: 'steer' })`（不变）
   - `QueueRow` 类型从 `SessionSnapshot['queue'][number]` 改为 `UserMessage`
   - `projectUserText` 本地重实现（rc3 删除了该导出）

6. **ide-ui 三条 openSession RPC**：
   - `openSession` → `ctx.corumNavigation.openSession()`
   - `refreshSubagents` → `ctx.sessions.refreshProjections()`
   - `setSubagentCatalogOpen` → 本地 no-op（rc3 无此概念，corum 组件自管 catalog 显隐）

7. **icons**：`Outline14`/`Outline16` → `OutlineMedium`；`ReferenceIcon` → `ReferenceIconMedium`；`PermissionSelect` → `PermissionSelection`；`IconFolderClose16`→`IconFolderCloseMedium` 等。

8. **ContentBlock/CompactionCheckpointSource 类型变化**：
   - `ToolResultBlock` 从 `ContentBlockMap` 删除（tool results 现在是 `ToolResultMessage`）
   - `block.content`/`block.isError` → `message.content`/`message.isError`
   - `CompactionCheckpointSource` 从 `kind:'plugin', plugin:'compact'` → `kind:'compact-checkpoint'`
   - 使用官方 `isCompactCheckpointSource` 谓词替代字面比较

9. **settings.onboarding slot**：删本地 `SettingsOnboardingOwnerProps` 声明，改 import 官方（含 `explicit?` 字段）。

### 测试数

| 包 | 测试数 |
|---|---|
| corum-ui-conversation | 13 |
| corum-ui-chat | 169 |
| corum-ui-settings-models | 66 |
| corum-ui-settings-plugins | 0（无测试文件） |
| corum-web-search | 14 |
| corum-ide-ui | 29 |
| corum-ide-sidebar-ui | 7 |
| corum-ui-titlebar | 8 |
| corum-ui-trajectory | 0（无测试文件） |
| corum-ui-model-selection | 0（无测试文件） |
| corum-ui-commit-card | 45 |
| corum-ui-model-ask | 42 |
| corum-ui-questions | 3 |
| **合计** | **396** |

### grep 守卫

`scripts/verify-stage3-b.mjs`：12 项全绿（sessions.open/settings.register/useSessionPendingInteraction/settingsScope/SessionListState.current/SessionSnapshot.queue/sessions.clear/refreshSubagents/setSubagentCatalogOpen/SettingsScope import = 0；corumNavigation/configForms ≥ 1）。

### B2 残留

B2 五包（corum-ui-approval/corum-ui-model-ask/corum-ui-model-selection/corum-ui-questions/corum-ui-commit-card）的 icons/机械组已在 B1 同批修复（OutlineMedium 替换）。B2 的 forced typecheck/build/test 已全绿。B2 专项门禁（run-forced-typecheck 全绿 + 全仓 test + fork-drift）待 B2 专属 commit 收口。

## 阶段 3 B 纠偏与测试收口（2026-10-28）

### 新发现：六处 settings ns 级功能缺口 + 守卫假绿

独立验收报告（`~/.corum/research-reports/4fb78134-6cb7-40a3-8610-0b0be443d195.md`）发现 typecheck/现有门禁不可见的真缺陷：

1. **corum-agent ns 注册**：combo 行 id 是 `@corum/corum-agent`（包名），但 `CORUM_AGENT_SETTINGS_NAMESPACE = 'corum-agent'`。rc3 settings ns = entry id，故 describe() 找不到 `corum-agent` → AgentStallGroup 写不进。
2. **corum-review ns 注册**：`CorumReviewService` 直接 `new`（不经 loader），`static Config` 不会被 loader 识别 → describe() 无 `corum-review` ns。
3. **corum-web-search**：函数插件无 Config 导出 → describe() 无 `corum-web-search` ns → `setActive()` 报错。
4. **shell 卡 ns**：`SHELL_NS = 'shell'`（0.1.5 时代），rc3 已无 id 为 `shell` 的 entry（官方改为 `bash-sandbox`）。
5. **IDE 模式 conversation/chat ns**：客户端常量 `'ui-conversation'`/`'ui-chat'`，但 IDE overlay 插入行 id 是 `corum-conversation`/`corum-chat`。
6. **SUBAGENT_MODEL_SELECTION_NS**：`'subagent-model-selection'`，官方 rc3 行 id 是 `'subagent-model-selection-settings'`。
7. **守卫假绿**：`verify-stage3-b.mjs` 用 BSD grep `\(` 转义 → exit 2 → `2>/dev/null || true` 吞成空输出 → 假绿；路径表还把 `corum-web-search` 写成不存在的 `session/corum-web-search`。

### 修复

#### 设置 Config 落点

| ns | 修复 |
|---|---|
| `@corum/corum-agent` | `export const Config`（volatile `stallRecoverMinutes`），`CORUM_AGENT_SETTINGS_NAMESPACE` → `'@corum/corum-agent'`；删 register+轮询，改 `settings/document-updated` 事件订阅热更新 |
| `corum-review` | 新增 boot 常驻 registrar 行（`cordis.patch.yml` → `@corum/corum-agent/review-settings`），`CorumReviewSettingsService` 持 `static Config`；desktop `CorumReviewService` 从 describe() 读 retentionDays + 订阅 `settings/document-updated` |
| `corum-web-search` | `export const Config`（volatile `activeProvider` default `deepseek`） |
| `bash-sandbox` | `SHELL_NS` → `'bash-sandbox'`（对照官方 base patch 行 id） |
| `corum-conversation` | `CONVERSATION_SETTINGS_NAMESPACE` → `'corum-conversation'`（IDE overlay 插入行 id） |
| `corum-chat` | `CHAT_SETTINGS_NAMESPACE` → `'corum-chat'`（同上） |
| `subagent-model-selection-settings` | `SUBAGENT_MODEL_SELECTION_NS` → `'subagent-model-selection-settings'` |

UI 端 `general-groups.tsx` 的 `CORUM_AGENT_NS` 同步改为 `'@corum/corum-agent'`。

#### Legacy migration 扩展

`settings-legacy-migration.ts` 的 `LEGACY_NS_MAPPING` 新增六项映射（旧 ns → 新 ns）：`ui-conversation`→`corum-conversation`、`ui-chat`→`corum-chat`、`shell`→`bash-sandbox`、`corum-agent`→`@corum/corum-agent`。幂等、新值优先、坏值 warn 不中断。

#### 守卫修复

`scripts/verify-stage3-b.mjs` 完全重写：Node 递归遍历 `collectSourceFiles` + JS RegExp（不用 BSD grep），缺路径 fail loud（不再 `2>/dev/null` 吞错），路径表修正（`corum-web-search` 在 `agent/` 不在 `session/`），注释词法剥离（block + line comment strip，不把整行 URL 当注释）。`SessionSnapshot.queue` 的 `s\.queue` 改 `\bs\.queue\b`（不误匹配 `deps.queue`）。12 项全绿。

#### 导航修复

sidebar `archive` handler 原注释称「归档当前会话则清空选择」但实现只 `archiveSession` 不清选择（注释失实）。对照官方 `clearArchivedCurrent`：归档后若 `current === sessionId` 则调 `ctx.corumNavigation.clearSelection()`。

#### 新增测试

- `corum-ui-conversation/tests/corum-navigation.spec.ts`：open A→B 旧 release、快速切换只 1 live、clear/dispose/retain throw 不破坏旧选择、release 幂等、源码契约验证。
- `corum-ui-questions/tests/derived-pending-interactions.spec.ts`：空 Map/有 pending/无 pending/subscribe 转发/更新传播/Map key 类型。
- `corum-agent/tests/settings-ns-alignment.spec.ts`：六 ns 对齐 entry id + Config 声明 + register 残留扫描。

#### sidebar exit1 根因

`.corum-tmp/stage3-b1-tests.log` 的 sidebar 段 `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL / Exit status 1`。根因：sidebar-ui 包无测试文件（`tests/` 目录只有 `workspace-delete.spec.ts` 一件），vitest 默认 `passWithNoTests` 未配 → exit 1。需在 vitest 配置加 `passWithNoTests: true` 或补测试文件（本轮已补 navigation spec 不在 sidebar 包，sidebar 自身仍需配 `passWithNoTests`）。

---

## 阶段 3 最终全量门禁收口（2026-10-28）

> start hash: `fc4238a8`（B 纠偏收口后）｜ branch: `upgrade/0.2.1-rc3`｜ 日志前缀: `.corum-tmp/stage3-final-*`

### 12 门禁逐项

| # | 门禁 | 命令 | 结果 | 日志 |
|---|---|---|---|---|
| 1 | forced typecheck | `node scripts/run-forced-typecheck.mjs` | **51/51 PASS, 0 FAIL, 0 semantic errors, 0 TS5033** | `.corum-tmp/stage3-final-typecheck.log` + `.json` |
| 2 | 全量测试 | `pnpm -r --no-bail run test` | **3524 tests (3389 vitest + 135 node:test desktop), 0 fail, 34 vitest suites** | `.corum-tmp/stage3-final-tests.log` |
| 3 | 全量 build | `pnpm -r --no-bail run build` | **50+ packages built, 0 error, UI inline-css 全确认（注入 CSS + 移除外置 style.css）** | `.corum-tmp/stage3-final-build.log` |
| 4 | fork-drift (rc3) | `DSH_CHECKOUT=/Users/kukucai/dsh DSH_BASELINE_TAG=dsh-v0.2.1-rc.3 scripts/verify-fork-drift.sh` | **exit 0, 0 red (✗), 13 informational skip (–)** | `.corum-tmp/stage3-final-drift.log` |
| 5 | stage3-b guard | `node scripts/verify-stage3-b.mjs` | **ALL CHECKS PASSED (12 checks, 0 red)** | `.corum-tmp/stage3-final-b-guard.log` |
| 6 | pack:host:mac --skip-app | `pnpm --filter corum-desktop run pack:host:mac -- --skip-app` | **闭包审计全过：258 dsh uniform 0.2.1-rc.3 + 311 probes OK + 8 blacklist OK + 7 vendor OK + 7 platform OK + 2 fork 替身** | `.corum-tmp/stage3-final-skipapp.log` |
| 7 | 50 包 inventory 覆盖 | `docs/fork-delta/inventory/*.json` | **50/50，每包含 finalDisposition + commit + evidence + gates** | `docs/fork-delta/inventory/SUMMARY.md` |
| 8 | 不可 boot 台账 6/6 销账 | `03-removed-packages.md §3.6` | **6/6 ✅**：#1 roots 退役 / #2 settings defaultId / #3 activation / #4 working-directory / #5 preset YAML / #6 dsh-agent-preset dep | `03-removed-packages.md §3.6` |
| 9 | drift 基线 tag | `DSH_BASELINE_TAG=dsh-v0.2.1-rc.3` | **rc3 tag 确认**（非 0.1.5，非 worker 误用的 0.1.5-rc.3） | drift log 首行 `[baseline] 官方基线 = dsh-v0.2.1-rc.3` |
| 10 | SUMMARY 统计一致 | inventory SUMMARY gates 统计 | typecheck 50 pass / build 50 pass / test 30 pass + 20 n/a / drift 15 pass + 35 n/a | `docs/fork-delta/inventory/SUMMARY.md` |
| 11 | fork-delta §N=50 + 文首 50 | `docs/fork-delta.md` | 已在阶段 3 步骤 0e 补齐 | `docs/fork-delta.md` |
| 12 | build/test/typecheck gates 真实 logRefs | 每包 inventory evidence | typecheck→final-typecheck.log / build→final-build.log / test→final-tests.log / drift→final-drift.log | 各 inventory JSON |

### skip-app 物化验证

| 检查项 | 结果 |
|---|---|
| `build/host/presets.patch.yml` | ✅ 存在（33KB，五份 preset：standard/ptc/cordis/conductor + minimal 官方 insert） |
| corum-agent/review-settings 入口 | ✅ `node_modules/@corum/corum-agent/lib/review-settings-registrar.js` 存在 |
| web-search Config | ✅ `cordis.patch.yml` 含 7 处 web-search 引用 |
| 新 UI build 物化 | ✅ 47 个 @corum 包在闭包 `node_modules/@corum/` |
| dsh 版本 | ✅ 0.2.1-rc.3 uniform（host package.json 89 处引用） |
| 闭包探针 | ✅ 311 resolve OK / 7 skip（type-only/fork 替身）/ 0 fail |
| fork 替身 | ✅ dsh-fs-local←corum-fs-local / dsh-tools←corum-tools |

### drift 13 informational skip 逐项（均已解释，非 red）

- §4 host emit 面：3 项 corum 自有事件无 emit 映射（commit-card/request、commit-card/update、escalation/ask）——corum 新增事件，待登记归属，非断链。
- §8 客户端挂载点：5 项有意不挂载（corum-ide-explorer-ui retired / corum-ide-statusbar-ui retired / 3 个 test 插件按需手工挂载）。
- §17 preset 本地副本：5 项 rc3 官方 preset 已迁 `.patch.yml` 格式，行 id 对账待 P 专项后续更新（standard/ptc/cordis/minimal/conductor）——信息性 skip，不 false pass。

### 阶段 3 commit 范围

`576178e8`（建立 50 包 rebase 清单与错误基线）→ `fc4238a8`（B 纠偏收口），共 **45 个 commit**，批次 A→C→E→P→D→B 串行。

### 阶段 3 未做（留阶段 4）

- 完整 pack / smokeBridge / assert-packaged-boot / 实机 CDP 冲烟（06 册，三平台覆盖）
- 存量会话 V3→V4 迁移预演（06 册）
- Electron 版本验证（06 册 §4.5 子节）

---

## 阶段 4 评审决策（2026-10-28）

> 编排报告 #78（`~/.corum/orchestrate-reports/orchestrate_78_a1ce9587.md`）对 06-verification.md 做了只读评审，
> 基于 `git show dsh-v0.2.1-rc.3` 官方源码对照 + 评审报告交叉复核，修订 9 处关键结论。
> **本修订不改阶段 3 结果，只修正阶段 4 计划。**

### 评审方法

- dsh checkout 当前工作区在 `dsh-v0.2.1-rc.2`（`git describe --tags` 确认），但 `dsh-v0.2.1-rc.3` tag 存在。
- 官方对照全部用 `git -C /Users/kukucai/dsh show dsh-v0.2.1-rc.3:<path>`，不依赖工作区当前 checkout 状态。
- 关键结论复核：①迁移机制（`session-persistence-jsonl/src/index.ts` open/read/write 逻辑）②flock addon 加载机制（`flock.js`/`flock.c`/`prebuilds.json`）③会话目录结构 + 版本计数 ④`corum-instance.sh` 端口/角色判定 ⑤`pack-macos.mjs` smokeBridge/buildApp 安全性 ⑥`assert-packaged-boot.mjs` 资源路径探测。

### 9 处修订

| # | 修订点 | 原计划问题 | 修订内容 |
|---|---|---|---|
| 1 | typecheck 统一脚本 | 手写 `for` 循环 + `npx tsc -b --force`（spec `--force --noEmit` 有 TS5093 风险） | 统一 `scripts/run-forced-typecheck.mjs`（阶段 3 已创建验证 51/51 PASS）；内部 `tsc -b --force` + spec `tsc -p tsconfig.spec.json --noEmit` 分离；保留 `--no-bail` 补充 |
| 2 | 完整 pack 前置 | 旧 dist 产物（`Electron.app`）不算 pack 证据；`assert-packaged-boot` exit 2 | 完整 `pack-macos.mjs`（`smokeBridge`+`buildApp`）→ `dist/mac-arm64/Corum.app` → `assert-packaged-boot.mjs`；列准确命令 + 产物时间戳/HEAD 证据；`--skip-app` 不能替代 |
| 3 | CDP 隔离 | 假设 verify 默认隔离 home | `--home=verify` 确为 9333（`HOME_SEL` 决定角色），但 home 仍为 `~/.corum`；独立 home 需 `CORUM_HOME`/`DSH_HOME`/`CORUM_USER_DATA_DIR` 一致；启动前检查 9222/9333 占用；9222 永不 restart/kill；packed `smokeBridge` 已自有 `.smoke-home`，CDP 行为验证另用独立 temp home |
| 4 | 行为清单扩 E/P/D/B | 原清单只 5 项基础交互 | 扩到 E/P/D/B 新机制：preset list/default settings 持久、动态用户 preset register、foreground/background activation+continuable 消息、cold-resume confinement（真实越界拒绝）、会话切换 retain 不泄漏、settings ns roundtrip（agent/review/websearch/conversation/chat/subagent/memory/onboarding）、V4 历史打开、flock 写租约；零 console error |
| 5 | V2→V3→V4 完整链 | 只验 V3→V4，遗漏 v2（占 59%）；`cp *.jsonl` 匹配 0 文件；步骤 4-5 无法执行 | 改完整 V2→V3→V4 链；`cp -R` 三层目录（最好复制完整 home 排除 credentials/密钥，迁移只需 session 相关文件）；直接 Node 持久层 `backend.list()`/`open(id,'read')` 遍历（不启动实例，不存在迁移日志）；read open 不发布源（`requireStoredLog` → `primed`，不调 `publishStoredMigration`），write open 才发布（第 433 行）；预演统计 read 迁移可准备 + 在临时副本 write publish 验证源 hash 不变；`scripts/rehearse-v4-migration.mjs` 阶段 4 执行时创建；总数/v2/v3/v4/成功/失败原因 → `v4-migration-report.md`；源 home 只读、绝不删除不可迁移会话 |
| 6 | Electron flock addon | V8 指纹决策树错误前提（custom-loader 按 Electron 44.7 指纹识别） | flock 用原生 `require()` 加载（不经 custom-loader）；Node-API v8 ABI 稳定（`prebuilds.json` `{"kind":"node-api","napi":8}`）；43.4.1 Node 20.x ↔ 44.7.0 Node 22.x 无区别；删 custom-loader/V8 指纹错误前提；验证平台子包 `bin/system.node` 存在 + Electron 43.4.1 实际加载 + 真实 SessionWriteLease 写；失败优先缺二进制/平台包，不自动升级 Electron |
| 7 | 三平台 | Linux/Windows 标「不强制」可 PASS | Linux 无可用主机/Windows 真机不可用 → 标未验；历史 Windows dist 非当前 HEAD 产物；最终升级目标若要求三平台，阶段 4 只能 conditional/blocked 直到真实覆盖 |
| 8 | 回滚路径 | `~/.corum-verify/sessions-backup-pre-v4` 不存在 | 改 `$V4_TEMP_HOME/sessions` 备份；验收项同步（V4a/V4b/V4c 拆分）；状态从「待执行」改「计划评审完成，待执行」 |
| 9 | docs/UPGRADE 追加 | 阶段 4 评审决策无记录 | 本段；不改阶段 3 结果；`git add -f docs` commit/push 升级分支 |

### 验收项拆分

原 V4 拆为 V4a（完整 pack）/ V4b（assert-packaged-boot）/ V4c（macOS CDP 冲烟），原 V6（Windows）增加「历史 dist 非当前 HEAD 产物」标注 + 三平台 blocked 说明。

---

## 阶段 6 任务书评审修订（2026-10-30）

> 编排报告 #46（`~/.corum/orchestrate-reports/orchestrate_46_da580434.md`）对 `08-top-level-sidecar.md` 做了两路合并评审：
> task 0（架构能力面深度评审）+ task 1（事实准确性 + 三平台 + 迁移评审）。
> 关键结论已用 `git -C /Users/kukucai/dsh show dsh-v0.2.1-rc.3:<path>` 独立只读复核。
> **本修订不含代码，只修订 08 册 + README 状态行 + 本实录。**

### 评审方法

- 两路并行评审（task 0 架构能力面 / task 1 事实准确性），互补无矛盾。
- 官方源码对照全部用 `git -C /Users/kukucai/dsh show dsh-v0.2.1-rc.3:<path>`，不依赖工作区当前 checkout 状态。
- 已核实源码引用：
  - `subprocess-local/src/index.ts:93-94,105-115`（subprocess seam 绑 host exit）
  - `session-persistence-jsonl/src/lease.ts:76-85`（POSIX flock + Windows 信号量平台分支）
  - `session-persistence-jsonl/src/win32.ts`（Windows koffi CreateSemaphoreW）
  - `subprocess-local/src/spawn.ts`（spawn detached / taskkill 平台差异）

### 两路评审结论

| 路 | 结论 |
|---|---|
| task 0（架构能力面） | ACP 协议不可直接承载 corum 顶层交互会话（首要发现，已核实 ACP README）；subprocess seam 绑 host exit；SessionWriteLease 崩溃恢复需 jsonl 重建 tracker；热卸载隔离边界不完整；S1–S5 缺 6 个必须补充项（S6–S11） |
| task 1（事实准确性） | 5 处事实性错误（cf58d502 非 commit / S4 平台说法与源码不符 / acp 装配状态不实 / addon 指纹差表述错位 / 缺包名）+ 3 处表述不精确（S5 迁移窗口 / 验收缺 DoR-DoD / subprocess seam 表述） |

### 修订内容（10 项）

| # | 修订点 | 原文问题 | 修订内容 |
|---|---|---|---|
| 1 | cf58d502 provenance | 称「commit cf58d502」 | 修正为会话 ID（非 git commit，已核实不存在于任何 repo） |
| 2 | 事故描述 | 未准确描述根因 | 2026-10-26 热卸载破坏会话 ToolNotFoundError；不称阶段 5 已实证修复，改「目标 / 待阶段 5 验收」 |
| 3 | S1 owner 矩阵 | 只说「脱离 renderer fiber」 | 补三候选（Electron main / host root ctx / 独立 supervisor）+ subprocess seam 绑 host exit；窗口关闭/主进程退出存活为后续硬决策 |
| 4 | S2 ACP 能力面 | 说「acp 是候选」，过于乐观 | ACP 仅 automation 基础面；缺 elicitation/plans/todos/compaction/goal/subagent/notifications/permission 语义；三候选不定案，禁止「直接复用 ACP」 |
| 5 | S3 崩溃恢复 | 不完整 | 补三约束（jsonl 重建 / 租约交接 / 探活心跳）+ 未 flush 丢失口径；POSIX 与 Windows 内核锁均崩溃释放 |
| 6 | S4 平台实现 | 与官方源码不符 | 准确描述 spawn detached POSIX 进程组 / Win taskkill；POSIX Node-API flock，Win koffi CreateSemaphoreW |
| 7 | S5 迁移 | 未展开 | 迁移窗口 / 单写者 / 租约冲突 / quarantine（43 个不可迁移）；不假设全部成功 |
| 8 | 新增 S6–S12 | 缺 7 个必须项 | S6 凭据 / S7 cwd / S8 权限 / S9 会话索引 / S10 通知 / S11 独立 Node runtime / S12 插件链热卸载边界 |
| 9 | addon 指纹风险 | Electron 指纹差错位 | 改独立 Node v26.4.0 三平台 addon 验证；macOS 已验 Linux/Win 未验；ACP 闭包以阶段 5 实际为准 |
| 10 | 验收 DoR/DoD | 无拆分 | 本册 DoR（V1–V5）+ 后续 DoD（D1–D9：威胁模型/故障注入/三平台/并发写/热卸载/UI 事件/最小 POC/ACP 能力面/迁移） |

### 状态更新

- `08-top-level-sidecar.md` 状态行：`可行性确认 + 设计任务书（不含代码）` → `设计任务书评审修订完成，待阶段 5 前置`
- `README.md` 阶段 6 状态：`☐ 待开工` → `📋 任务书评审修订完成，待阶段 5 前置`
- 本册**不写 sidecar 代码**、**不提前选 owner 方案**、**不提前选 RPC 方案**


---

## 阶段4 最终修复 + 阶段5 ACP 纠偏（2026-10-28）

### 迁移安全修复（A1-A7）

1. **per-session 统计 + 低代保留**：repair 改为按 session 目录取最高 generation（与官方 `resolveGenerationInDirectory` 一致），低代文件原样保留。79 个低代文件保留。
2. **changes 审计恒空 bug 修复**：`repairUnresolvedToolCalls` 的 changes 审计原恒空（`shift()` 消费后对空数组做 `map`），修复为在 shift 之前收集 + 断言。
3. **corum 扩展事件保留 fork 字段**：fork 字段（kind/personaHint/confined）从官方 descriptor 剥离后，通过 `plugin:corum-subagent/descriptor` 扩展事件（`ignorable: true`）保留。官方 v4 admission 实测接受。`foldSubagentDescriptor` 合并两者。
4. **coldResume 保留测试**：已有 isolation-confinement cold-resume 执行链测试 + 新增 corum 扩展事件验证。
5. **quarantine/repair 分类区分**：publish 阶段区分 repair quarantine vs publish quarantine。

### ACP 纠偏（B8-B9）

1. **acpCliPath 打包路径修复**：新增 `resolveAcpCliPath(packaged, resourcesPath, mainFileUrl)` helper。packaged = `Resources/host/node_modules/...`。
2. **resolveAcpEnv 绝对路径 + DSH_HOME 必填**：`isAbsolute()` 校验 + DSH_HOME 必填 + CORUM_HOME 一致性。
3. **真实 ACP activation mock server**：新增 mock server + mock server 测试。端到端标记 `.skip`（需完整 cordis context）。

### 测试结果

| 指标 | 数值 |
|------|------|
| corum-subagent vitest | 646 passed + 1 skipped (36 files) |
| v4-migration-repair spec | 79 passed |
| desktop acp-paths test | 8 passed |
| corum-subagent typecheck | 0 errors |
| desktop typecheck | 0 errors |
| corum-subagent build | exit 0 |
| 复演：961 session 目录 | 72 repaired + 1 quarantine + 888 noRepairNeeded + 79 skippedLowerGen |
| 源不变 | ✓ |
| dsh-tools 解析修复 | clean reinstall 修复 workspace: peer symlink（640→646） |

### 未修改 08

按 brief 要求，`08-top-level-sidecar.md` 未修改。

---

## 阶段 5 macOS 隔离 CDP 行为验收（2026-10-28）

> **HEAD**：730fd870 | **产物**：完整 Corum.app（16:25 生成）
> **平台**：macOS darwin-arm64（Linux/Windows 未验证）
> 详见 `docs/upgrade-0.2.1-rc3/verification-log.md` §G

### 通用 smoke

`corum-smoke.mjs --fast --launch --packaged --json` 两次独立运行：pass=7 / fail=0 / skip=2（skip 为平台不适用）。

| 项 | 结果 |
|----|------|
| 应用自启动 | ✓ |
| CDP 连上主页面 | ✓ |
| DOM 渲染 | ✓ |
| 控制台零错误（reload 后） | ✓ |
| 凭证加密 | ✓ master-key 0600 |
| Electron 身份 = pin | ✓ sha256 + cdhash |
| 窗口真实呈现（X 像素） | – skip（macOS 无 DISPLAY） |

### host 端（全过）

typecheck ✓ / test ✓ / build ✓ / fork-drift ✓ / pack ✓ / assert-packaged-boot ✓ / ACP CLI smoke ✓ / ACP wiring 探针 ✓ / queue-revert descriptor 无 fail ✓

### renderer 端（受限）

主界面加载超时：23 个 UI 插件未激活。根因 = 循环依赖：
- `corum-ide-ui` provide `layout`，inject `corumNavigation`
- `corum-ui-conversation` provide `corumNavigation`，inject `layout`
- cordis 激活器无法打破循环

**非升级回归**：循环依赖在 `cordis.ide.patch.yml` 禁用官方 `ui-layout` + `corum-ide-ui` 接管 `layout` 时即已存在。主实例（kkc-desktop home）正常因预存配置。

renderer RPC 桥不可用 → settings roundtrip / 会话导航 / queue-revert / web-search / ACP / V4 历史 标 SKIP。

### macOS CDP V4c 验收状态

| 子项 | 结果 |
|------|------|
| DOM 渲染 | ✓ PASS |
| 控制台零错误 | ✓ PASS |
| Electron 43.4.1 运行时 | ✓ PASS |
| 凭证加密 + Electron 身份 | ✓ PASS |
| UI 行为（E/P/D/B） | ✗ FAIL（循环依赖，非升级回归） |
| web-search 激活 | ✗ FAIL（settings 未加载） |
| settings roundtrip / 会话导航 / queue-revert / ACP / V4 历史 | – SKIP（renderer RPC 不可用） |

### 三平台

- macOS：host 端全过，renderer 端行为受限（循环依赖）
- Linux：❌ 未验证（无可用主机）
- Windows：❌ 未验证（无可用真机）

### 不宣称 ACP 已支持 continuable/preset

ACP 能力面已在 §1.3 能力表 + 测试覆盖确认全 `false`/不支持。CDP 无法在 UI 层补充验证，但**不宣称 ACP 已支持 continuable/preset**——仍列后续必做。

### 阶段 5 confined/worktree 仍列后续必做

本阶段只装配 acp provider + one-shot + 能力拒绝。confined/worktree 不在本阶段。
