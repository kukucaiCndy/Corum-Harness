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

（执行时追加）

## 阶段 2：override 重算

（执行时追加）

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
