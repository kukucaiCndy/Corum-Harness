# 阶段 0：前置准备

> 状态：已完成 | 前置：阶段 -1（官方升级指南映射） | 预估工程量：约 0.5 人日（备份 + 守卫 + 快照记录）
>
> **执行完成时间**：2026-10-27 09:15。备份路径：`~/corum-upgrade-backups/pre-0.2.1-rc3-20261027-090017`。fork-drift 真实基线 N=3。实录文件：`docs/UPGRADE-0.2.1-rc3.md`。
>
> **平台范围**：本册及阶段 0-3 均在 macOS 执行；Linux/Windows 实机验证仅到阶段 4（`06-verification.md`），阶段 0 的备份/守卫/快照命令不承诺跨平台。

## 1. 目标与范围

**目标**：在动任何代码之前，确保当前 0.1.5-rc.3 基线处于「可回滚」状态——完整备份 home
与工作区、确认 fork-drift 真实基线、记录基线快照供后续阶段对照、创建实录文件骨架。

**本阶段本质是「可回滚性的保证」**：不做任何代码修改，只做备份、快照、确认。

**范围**：
- 备份 `~/.corum`（用户 home 目录，含 sessions/settings/profiles/credentials）。
- 备份工作区（commit + push 当前所有 fork 包）。
- 跑 fork-drift 守卫确认 0.1.5-rc.3 真实基线（以真实 tag 导出重跑并记录实际 N 项）。
- 确认 dsh 仓 tag `dsh-v0.2.1-rc.3` 存在（只读对比用，不必 checkout）。
- 记录当前基线快照（override 条目数、fork 包数、版本号）。
- 新建实录文件 `docs/UPGRADE-0.2.1-rc3.md` 骨架。
- 确认主实例与 verify 实例状态（只读 status，不启停）。

## 2. 前置条件（准入门禁）

| # | 条件 | 验证方式 | 状态 |
|---|---|---|---|
| 1 | 阶段 -1 退出门禁通过 | `01-official-guide-mapping.md` 附录 A 映射表已填全（43/43 篇）+ 附录 B 实录已填 | ✅ |
| 2 | 当前工作区在 `main` 分支 | `git branch --show-current` 输出 `main` | ✅ |
| 3 | dsh 仓 tag 可读 | `git -C /Users/kukucai/dsh tag -l 'dsh-v0.1.5-rc.3'` 返回非空 | ✅ |

> **评审时快照（2026-10-27）**：HEAD=`ff51ee81`（`docs: 收口阶段-1指南映射门禁与完成状态`），本地 `main` 领先 `origin/main` **15 笔提交**。执行时须动态确认实际 HEAD 与领先数（`git log --oneline origin/main..HEAD | wc -l`），不得照抄此数字。

## 3. 输入与依赖

| 输入 | 来源 | 用途 |
|---|---|---|
| 当前 home | `~/.corum/` | 备份源 |
| 主实例 Electron user-data | `~/Library/Application Support/corum-desktop-ud-minimal-9222/` | 备份源 |
| Corum.app | `/Applications/Corum.app`（当前 0.7.0） | 备份源 |
| 当前工作区 | 本仓 `main` 分支 | commit + push |
| fork-drift 守卫脚本 | `./scripts/verify-fork-drift.sh` | 跑基线漂移检测 |
| dsh 仓 checkout | `/Users/kukucai/dsh` | 只读对比源（`DSH_CHECKOUT`） |
| 基线 tag | `dsh-v0.1.5-rc.3` | `DSH_BASELINE_TAG` |
| pnpm-workspace.yaml | 本仓 `pnpm-workspace.yaml` | 记录 override 基线条目数 |
| 实例脚本 | `./scripts/corum-instance.sh` | 实例状态检查（只读） |

## 4. 授权点（执行前须用户授权）

本阶段涉及以下需要用户授权的操作，其余均为只读或受控临时目录操作。**本阶段无 install/build/test、无实例启停。**

| 授权点 | 操作 | 原因 |
|---|---|---|
| **【需用户授权】备份** | 读取全部 `~/.corum`（含 sessions/settings/profiles/credentials 等用户隐私数据）+ 主实例 user-data + Corum.app，写入约 2 GB 到 `$HOME` | 读取用户 home/应用数据 + 磁盘写入 |
| **【需用户授权】push** | `git push origin main` 会推送**全部未推送提交**（评审时 15 笔），不只本阶段的提交 | 改变远端状态，一次性发布多笔既有本地提交 |

> 未获授权时：备份步骤不得执行（无备份不得进入 fork-drift 及后续）；push 步骤不得执行，阶段 0 退出门禁中 push 条目标阻塞待授权，不得伪装成已完成。其余步骤（fork-drift、tag 确认、快照记录、实录骨架）不需授权，可在备份完成后独立执行。

## 5. 执行步骤（命令级，逐步可执行，每步带验证命令）

### 步骤 1：完整备份【需用户授权】

> **授权**：本步骤读取用户 home/应用数据并写入约 2 GB 到家目录，须用户授权后执行。

统一备份到带时间戳的根目录，禁止覆盖：

```bash
# 备份根目录（统一带时间戳）
BACKUP_ROOT="$HOME/corum-upgrade-backups/pre-0.2.1-rc3-$(date +%Y%m%d-%H%M%S)"

# 禁止覆盖：目录不得已存在
test ! -e "$BACKUP_ROOT" || { echo "备份目录已存在：$BACKUP_ROOT，先归档或换名"; exit 1; }

mkdir -p "$BACKUP_ROOT"/{home,user-data,Corum.app}
```

#### 1a. 备份 ~/.corum（排除可重建的大体积项）

```bash
# 记录备份前基线大小（供事后对比）
du -sh ~/.corum
du -sh ~/.corum/engines/sd-models 2>/dev/null  # 约 9.9 GB，可重建

# rsync 备份 home（排除 engines/sd-models 约 9.9GB 可重建 + bin/*.part 未完成下载）
# 不要先复制再 rm——rsync --exclude 在拷贝时直接跳过
rsync -a --exclude='engines/sd-models/' --exclude='bin/*.part' \
  ~/.corum/ "$BACKUP_ROOT/home/"
```

> **排除项说明**：
> - `engines/sd-models/`（约 9.9 GB，AI 模型权重 flux/t5/clip safetensors+gguf，可重新下载重建）。
> - `bin/*.part`（未完成下载的断点续传文件，可重建）。
> - 其余全部备份：sessions/、settings.yaml、.credentials.yaml、.master-key、profiles/、skills/、extension-packs/、.agent-presets/、storages/、mcp-servers.json、sessions.json 等。

#### 1b. 备份主实例 Electron user-data

```bash
# 主实例 user-data（约 336 MB）
rsync -a \
  "$HOME/Library/Application Support/corum-desktop-ud-minimal-9222/" \
  "$BACKUP_ROOT/user-data/"
```

#### 1c. 备份 Corum.app（当前 0.7.0 完整副本）

```bash
# 复制当前 0.7.0 app 完整副本（若有官方 0.7.0 安装包/dmg 且有校验，可用其路径替代）
# 当前无 dmg 备份（~/Downloads 无 0.7.0 安装包），必须复制 app
rsync -a /Applications/Corum.app/ "$BACKUP_ROOT/Corum.app/"
```

#### 1d. 生成备份 manifest

```bash
cat > "$BACKUP_ROOT/manifest.md" << EOF
# 备份 manifest

- 备份开始时间：$(date '+%Y-%m-%d %H:%M:%S')
- 备份根目录：$BACKUP_ROOT
- 源路径：
  - home：~/.corum/（排除 engines/sd-models/、bin/*.part）
  - user-data：~/Library/Application Support/corum-desktop-ud-minimal-9222/
  - Corum.app：/Applications/Corum.app（版本 0.7.0）
- git HEAD：$(git -C "$PWD" rev-parse HEAD)
- git branch：$(git -C "$PWD" branch --show-current)
- app 版本：0.7.0（CFBundleShortVersionString）
- 排除项：engines/sd-models/（约 9.9 GB 可重建）、bin/*.part（未完成下载）
- 磁盘占用：
  - home：$(du -sh "$BACKUP_ROOT/home/" 2>/dev/null | cut -f1)
  - user-data：$(du -sh "$BACKUP_ROOT/user-data/" 2>/dev/null | cut -f1)
  - Corum.app：$(du -sh "$BACKUP_ROOT/Corum.app/" 2>/dev/null | cut -f1)
- 备份结束时间：$(date '+%Y-%m-%d %H:%M:%S')
EOF

# 注意：manifest 只记录元数据，不输出 credentials/master-key 内容
```

**验证**：
```bash
# a) 目录级完整性：关键子目录全部存在且非空
for d in sessions profiles skills extension-packs .agent-presets storages; do
  test -d "$BACKUP_ROOT/home/$d" && test -n "$(ls -A "$BACKUP_ROOT/home/$d")" \
    || echo "MISSING: $d"
done
# 应无 MISSING 输出

# b) 稳定文件 SHA256 一致（只显示 hash，不显示内容）
for f in .credentials.yaml .master-key settings.yaml mcp-servers.json sessions.json; do
  echo "$f:"
  shasum -a 256 "$HOME/.corum/$f" 2>/dev/null | cut -d' ' -f1
  shasum -a 256 "$BACKUP_ROOT/home/$f" 2>/dev/null | cut -d' ' -f1
done
# 每对 hash 应相同

# c) 备份目录大小与源对比（排除 engines 后应显著小于 11 GB）
du -sh "$BACKUP_ROOT/home/"
# 预期约 600 MB（11 GB 减去 9.9 GB engines + 排除 .part）

# d) Corum.app Info.plist 版本 = 0.7.0
defaults read "$BACKUP_ROOT/Corum.app/Contents/Info.plist" CFBundleShortVersionString
# 应输出 0.7.0

# e) manifest 存在
test -f "$BACKUP_ROOT/manifest.md"
```

### 步骤 2：热一致性处理（SQLite 在线备份）

> `cp`/`rsync` 非原子操作。sessions JSONL 是 append-only，拷贝时可能少最后几行（不影响可回滚性）。`storages/kv.sqlite` 是 **WAL 模式 SQLite**，运行中拷贝可能拿到主 db + WAL 不一致的快照。

**处理方式**：rsync 完成后，用 `sqlite3 .backup` 对备份目录中的 db 做在线一致备份，随后删除备份目录里 rsync 复制来的 WAL/SHM 文件（仅限备份路径，不碰源），再对备份 db 做 integrity_check。

```bash
# kv.sqlite 在线一致性备份
BACKUP_DB="$BACKUP_ROOT/home/storages/kv.sqlite"
SOURCE_DB="$HOME/.corum/storages/kv.sqlite"

# 用 sqlite3 .backup 做在线一致备份（覆盖 rsync 复制来的可能不一致的 db）
sqlite3 "$SOURCE_DB" ".backup '$BACKUP_DB'"

# 删除备份目录里 rsync 复制来的 WAL/SHM（仅限备份路径，不碰源）
rm -f "$BACKUP_ROOT/home/storages/kv.sqlite-wal"
rm -f "$BACKUP_ROOT/home/storages/kv.sqlite-shm"

# 对备份 db 做 integrity_check（必须 ok）
sqlite3 "$BACKUP_DB" "PRAGMA integrity_check;"
# 应输出 ok
```

> **注意**：路径含空格时，sqlite3 的 `.backup` 命令需正确引用（如上 `'...'` 包裹目标路径）。源 db 路径不含空格时可直接写。
>
> **user-data 仍为热副本**：Electron user-data 无法用 sqlite3 .backup 统一处理（含 IndexedDB/LevelDB 等多种格式），仅作为 rsync 热副本记录 caveat——恢复时如需一致 user-data，须先停实例后重备（本阶段不停实例）。

**验证**：
```bash
# 备份 db integrity_check 必须输出 ok
sqlite3 "$BACKUP_DB" "PRAGMA integrity_check;"
# 输出 ok

# 备份目录不再有 WAL/SHM 残留（rsync 复制来的已删，sqlite3 .backup 产出的是一致快照不含 WAL）
test ! -f "$BACKUP_ROOT/home/storages/kv.sqlite-wal"
test ! -f "$BACKUP_ROOT/home/storages/kv.sqlite-shm"
```

### 步骤 3：工作区全量 commit + push【需用户授权】

> **授权**：`git push origin main` 会推送**全部未推送提交**（评审时 15 笔），不只本阶段的提交。须用户授权后执行。

```bash
# 确认工作区状态
git status

# 确认本地领先远程的提交数（动态确认，不照抄评审时数字）
git log --oneline origin/main..HEAD | wc -l

# 如有未提交改动，全部提交
git diff --quiet || {
  git add -A
  git commit -m "chore: 升级前基线快照（0.1.5-rc.3 → 0.2.1-rc.3 前夕）"
}

# 推送到远程（推送全部未推送提交，不只本阶段）
git push origin main
```

**验证**：
```bash
# 工作区干净
git status --short
# 应输出空（无未提交改动）

# HEAD 已推送（本地与远程同步）
git log --oneline origin/main..HEAD
# 应输出空（无未推送提交）
```

> **未获授权时**：不得 push。退出门禁中 push 条目标阻塞待授权，不得伪装成已完成。备份和其余步骤可独立执行。

### 步骤 4：跑基线 fork-drift 守卫确认 0.1.5 真实基线

> **关键环境修复**：本机 `mktemp -d` 可能在 `/var/folders` 被沙箱拒绝，导致脚本静默回落到检出工作区（rc.2），使基线从未真正建立。必须在运行前设 `TMPDIR` 为仓内受控临时目录。

```bash
# 创建受控临时目录（该目录已在 .gitignore:57/.corum-tmp/）
mkdir -p .corum-tmp

# 确认 0.1.5-rc.3 真实基线（用真实 tag 导出，不回落到工作区）
TMPDIR="$PWD/.corum-tmp" \
DSH_CHECKOUT=/Users/kukucai/dsh \
DSH_BASELINE_TAG=dsh-v0.1.5-rc.3 \
./scripts/verify-fork-drift.sh
```

**验证**（必须逐条确认）：
1. **确认日志没有回落**：输出中**不得**出现 `⚠️ 无法导出` 或 `回落到检出工作区` 字样。若出现，说明 tag 导出失败、基线未真正建立，该次结果**无效**，须排查 TMPDIR/mktemp 后重跑。
2. **记录真实 tag**：日志应输出 `[baseline] 官方基线 = dsh-v0.1.5-rc.3（<short hash>）`。
3. **记录 exit code**：`echo $?`。
4. **记录完整失败清单**：将全部输出归档到实录。

**判定标准**：
- 真实 tag 导出成功（无回落警告）。
- 结果 = N 项失败，归档到实录。
- **后续升级不得新增失败项**——阶段 4 的 fork-drift 验证对照本阶段记录的基线 N 项，只许收敛不许扩大。
- **不要求 exit code 必须为 0**，也不依赖 grep `DRIFT DETECTED`（脚本无此字符串）。

> **关于「24 项既存失败」**：历史交接（`docs/HANDOFF-2026-09-25-…` §6，历史交接口径，当前不在库，仅作背景）曾记录 24 项。但该数字**没有当前在库证据**：评审试跑得 23 项但 TMPDIR 失效回落 rc.2，不能当真实基线。阶段 0 必须以真实 tag 导出重跑并记录实际 N 项；**未跑前不得宣称 0/23/24**。本阶段不修改守卫登记、不修改 fork 源码。

### 步骤 5：确认 dsh 仓 tag dsh-v0.2.1-rc.3 存在

```bash
# 确认目标 tag 存在（只读 tag 列表，不 checkout）
git -C /Users/kukucai/dsh tag -l 'dsh-v0.2.1-rc.3'
# 应输出：dsh-v0.2.1-rc.3

# 确认 tag 指向的 commit
git -C /Users/kukucai/dsh rev-parse dsh-v0.2.1-rc.3
# 应输出 commit hash（1f81c047fc48fa190a683e469daa699857e9afe8）

# 注意：当前 dsh 仓检出可能停在 rc.2，不需要 checkout 到 rc.3
# 跨版本对比只需 git show 即可，不改变工作树
git -C /Users/kukucai/dsh rev-parse HEAD
# 确认当前 HEAD（不必等于 rc.3，只需 tag 存在即可用 git show）
```

**验证**：
- `git tag -l` 输出包含 `dsh-v0.2.1-rc.3`。
- `git rev-parse dsh-v0.2.1-rc.3` 输出有效 commit hash。
- **不要 checkout dsh 仓到 rc.3**——dsh 仓是只读对比源，用 `git show` 即可。

### 步骤 6：记录当前基线快照

将以下基线数据记入实录文件（步骤 7 创建骨架后填入）。这些数据是后续阶段验证「改了什么」的对照基准。

**6a. override 基线（pnpm-workspace.yaml）**

```bash
# 统计 overrides 段条目数（稳健 awk 按段统计，不用失效 grep）
awk '/^overrides:/{f=1;next}/^[a-zA-Z]/{f=0}f&&/^  [^ #]/{c++}END{print c+0}' pnpm-workspace.yaml
# 预期：217 条（216 个 @deepseek-ai/* + 1 个 electron）

# 构成分解
awk '/^overrides:/{f=1;next}/^[a-zA-Z]/{f=0}f' pnpm-workspace.yaml | grep -c "'@deepseek-ai/"
# 预期：216
# 非 deepseek-ai override：仅 'electron': '43.4.1' 1 条

# 统计 minimumReleaseAgeExclude 段条目数
sed -n '308,$p' pnpm-workspace.yaml | grep -cE "^\s+'@"
# 预期：433 条

# 433 条版本分布（不全钉 0.1.3-alpha.1）
sed -n '308,$p' pnpm-workspace.yaml | grep -oE '@0\.[0-9]+[-.a-z0-9]*' | sort | uniq -c | sort -rn
# 预期：249 条 @0.1.3-alpha.1 + 184 条 @0.1.1-rc.2
```

> **数字口径**：override 总数 217 = 216 个 `@deepseek-ai/*` + 1 个 `electron`。433 条 minimumReleaseAgeExclude = 249 条 `0.1.3-alpha.1` + 184 条 `0.1.1-rc.2`（**不全钉 0.1.3-alpha.1**，近一半是 rc.2）。

**6b. fork 包基线**

```bash
# 统计 fork 包数
ls -d packages/plugins/agent/*/ packages/plugins/session/*/ packages/plugins/ui/*/ \
  | wc -l
# 预期：50 个（23 agent + 12 session + 15 ui）

# 逐组统计
echo "agent: $(ls -d packages/plugins/agent/*/ | wc -l)"
echo "session: $(ls -d packages/plugins/session/*/ | wc -l)"
echo "ui: $(ls -d packages/plugins/ui/*/ | wc -l)"
```

**6c. 版本号基线（从安装产物/package.json 读取，不手填）**

```bash
# desktop app 版本（从 package.json 读取）
grep '"version"' packages/desktop/package.json | head -1
# 预期：0.7.0

# 安装产物版本（VERSIONING 规则：取值从安装产物读）
defaults read /Applications/Corum.app/Contents/Info.plist CFBundleShortVersionString
# 预期：0.7.0

# 基座版本（从安装产物读——应用内「复制诊断信息」的基座版本行）
# 0.1.5-rc.3（当前基线 tag）
echo "基座基线：dsh-v0.1.5-rc.3"
echo "目标版本：dsh-v0.2.1-rc.3"

# cordis 版本（从 dsh tag 读取，本仓无 vendor/cordis/）
git -C /Users/kukucai/dsh show dsh-v0.1.5-rc.3:vendor/cordis/package.json | grep '"version"'
# 预期：4.0.2

# Electron 版本（从 package.json 读取）
grep '"electron"' packages/desktop/package.json | head -1
# 预期：43.4.1

# node 实际版本
node --version
# 预期：v26.4.0（homebrew）

# pnpm 版本
grep '"packageManager"' package.json
# 预期：pnpm@11.7.0
```

**6d. git 快照**

```bash
git branch --show-current
# 预期：main

git rev-parse HEAD
# 预期：当前 HEAD hash（评审时 ff51ee81，执行时动态确认）

git log --oneline origin/main..HEAD | wc -l
# 预期：未推送提交数（评审时 15，执行时动态确认）
```

**6e. 主实例运行形态**

```bash
# 记录主实例运行形态（只读 status，不启停）
scripts/corum-instance.sh status
# 预期输出：role=main、port=9222、mode=dev/packaged、home=~/.corum

# PID 文件内容
cat ~/.corum/run/coding.pid 2>/dev/null
# 评审时：{"pid":78023,"combo":"coding","home":"/Users/kukucai/.corum","debugPort":9222,"mode":"dev",...}
# 执行时动态确认——不能假设它运行或停止
```

**6f. 官方包总数与 minimumReleaseAgeExclude**

```bash
# 官方包总数（packages/ + apps/ 下 package.json 计数）
# 0.1.5-rc.3 = 278（packages 274 + apps 4）
# 0.2.1-rc.3 = 362（packages 352 + apps 10）
# 口径：packages/ + apps/ 下 package.json 计数
git -C /Users/kukucai/dsh ls-tree -r --name-only dsh-v0.1.5-rc.3 | grep 'package.json$' | grep -c '^packages/'
git -C /Users/kukucai/dsh ls-tree -r --name-only dsh-v0.1.5-rc.3 | grep 'package.json$' | grep -c '^apps/'
# 0.1.5-rc.3 合计 278

git -C /Users/kukucai/dsh ls-tree -r --name-only dsh-v0.2.1-rc.3 | grep 'package.json$' | grep -c '^packages/'
git -C /Users/kukucai/dsh ls-tree -r --name-only dsh-v0.2.1-rc.3 | grep 'package.json$' | grep -c '^apps/'
# 0.2.1-rc.3 合计 362

# minimumReleaseAgeExclude
# 见 6a：433 条 = 249 条 0.1.3-alpha.1 + 184 条 0.1.1-rc.2
```

**基线快照汇总表**（记入实录）：

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
| git HEAD | <执行时填> | — |
| git branch | main | — |
| 未推送提交数 | <执行时动态确认> | — |
| 主实例形态 | <执行时填 dev/packaged、home、port> | — |

### 步骤 7：新建实录文件 docs/UPGRADE-0.2.1-rc3.md 骨架

创建实录文件，写入骨架结构。**阶段 -1 的实录暂记在 01 册附录 B，本步骤需将附录 B 内容完整转录到实录文件的「阶段 -1」小节**（完整转录，不只 grep 标题）：

```markdown
# dsh 基座 0.1.5-rc.3 → 0.2.1-rc.3 升级实录

> 本文件记录升级全程的逐步执行实况。每个阶段执行时追加内容。
> 执行文档索引：docs/upgrade-0.2.1-rc3/README.md
> 可行性评估：docs/UPGRADE-0.2.1-rc3-feasibility.md

## 基线快照（阶段 0 记录）

| 维度 | 当前基线值 | 记录时间 |
|---|---|---|
| dsh 基座 | 0.1.5-rc.3 | <执行时填> |
| desktop app | <从安装产物读> | |
| 基座版本 | <从安装产物读> | |
| cordis | <从 dsh tag 读> | |
| Electron | <从 package.json 读> | |
| node | <实际版本> | |
| pnpm | <packageManager> | |
| override 总数 | <217 = 216+1> | |
| minimumReleaseAgeExclude | <433 = 249+184> | |
| fork 包 | <50 = 23+12+15> | |
| 官方包总数 | <278，口径 packages+apps> | |
| git HEAD | <执行时填> | |
| git branch | main | |
| 未推送提交数 | <动态确认> | |
| 主实例形态 | <dev/packaged、home、port> | |

## fork-drift 基线（阶段 0 记录）

- 守卫退出码：<填>
- 真实 tag 导出：<确认成功，无回落>
- 失败项数：N = <填>
- 完整失败清单：<填或归档路径>

## 回滚最低集合

- [ ] home 一致备份（$BACKUP_ROOT/home/，排除 engines/sd-models + bin/*.part）
- [ ] 主 user-data（$BACKUP_ROOT/user-data/）
- [ ] Corum.app（$BACKUP_ROOT/Corum.app/，版本 0.7.0）
- [ ] git 基线 commit（含 pnpm-lock.yaml）
- [ ] dsh-v0.1.5-rc.3 tag
- [ ] 备份 manifest（$BACKUP_ROOT/manifest.md）

## 阶段 -1：官方升级指南映射

<完整转录自 01 册附录 B>

## 阶段 0：前置准备

- 备份时间：<填>
- 备份路径：<填 $BACKUP_ROOT>
- 工作区 commit：<填 hash>
- push 结果：直推被 GH006 拒绝，改经 PR #155 合并完成远程回滚点
- fork-drift 结果：<N 项，归档>
- 偏差记录：<若有>

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
```

**验证**：
```bash
# 确认文件存在
ls -la docs/UPGRADE-0.2.1-rc3.md

# 确认骨架结构完整
grep -c "^## " docs/UPGRADE-0.2.1-rc3.md
# 应输出 10+（含基线快照 + 回滚最低集合 + 各阶段标题）

# 确认阶段 -1 实录已从 01 附录 B 完整转录
grep -c "阶段 -1" docs/UPGRADE-0.2.1-rc3.md
# 应 ≥1

# 确认附录 B 各小节（步骤1/2/3/5/偏差/时间）均可在实录中找到
for kw in "步骤 1 输出" "步骤 2 输出" "步骤 3 逐篇分析" "步骤 5 交叉校验" "偏差记录" "时间"; do
  grep -q "$kw" docs/UPGRADE-0.2.1-rc3.md || echo "缺失转录：$kw"
done
# 应无缺失输出
```

> **注意**：`docs/` 被 `.gitignore:76` 忽略；已有升级文档靠强制跟踪（`git add -f`）入库。新建 `docs/UPGRADE-0.2.1-rc3.md` 必须 `git add -f`。若不执行 `git add -f`，文件不会被 git 追踪。

```bash
git add -f docs/UPGRADE-0.2.1-rc3.md
```

### 步骤 8：实例状态确认（只读，禁止启停）

> **纪律**：主实例和 verify 实例均不得停止/重启。本阶段只允许 `status` 查询，禁止 `start`/`stop`/`restart`/`update`。

```bash
# 主实例状态（只读）
scripts/corum-instance.sh status
# 预期：role=main、port=9222、mode=dev/packaged
# 不能假设它运行或停止——执行时实核

# verify 实例状态（只读）
scripts/corum-instance.sh status --home=verify
# 预期：role=verify、port=9333
```

> **`--home=verify` 真实语义**：脚本 `--home=verify` 的实际语义 = role verify + port 9333，但 **home 仍为 `~/.corum`**（与主实例完全同一个 home），不是隔离 home。实例身份只靠 role + 端口（PID 文件 `verify-coding.pid`）区分。verify 实例与主实例**共写 `~/.corum`** ⇒ 阶段 0 备份期间若 verify 实例在跑，备份一致性和「升级期间 home 不被验证写入」都不成立。后续阶段需要独立临时 home，不能依赖 verify 的隔离。
>
> **记录到实录**：主实例 dev/packaged 形态、home、port、PID 文件路径；verify 实例状态、port、共写 home 风险说明。

**验证**：
- `scripts/corum-instance.sh` 存在且支持 `status` + `--home=<role>` 参数。
- 实例状态记录入实录（形态、home、port、PID）。
- **本阶段禁止执行 start/stop/restart/update**。

## 6. 验收标准（退出门禁，可判定）

| # | 标准 | 判定方式 | 状态 |
|---|---|---|---|
| 1 | `~/.corum` 已完整备份（排除 engines/sd-models + bin/*.part） | `$BACKUP_ROOT/home/` 存在 + 关键子目录（sessions/profiles/skills/extension-packs/.agent-presets/storages）存在且非空 + 稳定文件 SHA256 一致（只显示 hash） | ✅ |
| 2 | 主 user-data 已备份 | `$BACKUP_ROOT/user-data/` 存在 | ✅ |
| 3 | Corum.app 已备份（版本 0.7.0） | `$BACKUP_ROOT/Corum.app/` 存在 + Info.plist 版本 = 0.7.0 | ✅ |
| 4 | 备份 manifest 已生成 | `$BACKUP_ROOT/manifest.md` 存在（含起止时间、源/目标路径、git HEAD/branch、app 版本、排除项、磁盘占用） | ✅ |
| 5 | kv.sqlite 一致性备份 | `sqlite3 $BACKUP_DB "PRAGMA integrity_check;"` 输出 ok + 备份目录无 WAL/SHM 残留 | ✅ |
| 6 | 工作区干净且已 push | `git status --short` 输出空 + `git log --oneline origin/main..HEAD` 输出空 | ✅ 完成（远程经 PR #155：直推被 GH006 拒绝，改经 PR 合并完成远程回滚点） |
| 7 | fork-drift 真实基线已建立 | 日志无「无法导出/回落」+ 真实 tag 导出成功 + 失败项数 N 已归档到实录 | ✅ |
| 8 | dsh 仓 tag `dsh-v0.2.1-rc.3` 存在 | `git -C /Users/kukucai/dsh tag -l 'dsh-v0.2.1-rc.3'` 非空 | ✅ |
| 9 | 基线快照已记入实录 | 实录文件含基线快照表（override/fork/版本号/node/pnpm/git HEAD/主实例形态/官方包数） | ✅ |
| 10 | 实录文件骨架已创建 | `docs/UPGRADE-0.2.1-rc3.md` 存在 + 含各阶段标题 + 阶段 -1 实录已从 01 附录 B 完整转录（各小节可查）+ 回滚最低集合清单 | ✅ |
| 11 | 实例状态已确认（只读） | 实录中记录主实例 + verify 实例形态/home/port/PID + verify 共写 home 风险 + 禁止启停纪律 | ✅ |
| 12 | 稳定目录二次 rsync dry-run 无差异 | `rsync -a --dry-run --exclude='engines/sd-models/' --exclude='bin/*.part' ~/.corum/ $BACKUP_ROOT/home/` 无差异输出（live sessions/storages/run 允许备份窗口内变化并记录） | ✅ |
| 13 | 当前会话 cf58d502 相关文件存在于备份 | `find $BACKUP_ROOT/home/sessions/ -path '*cf58d502*'` 返回非空（该会话为目录，内含 session.v3.jsonl.zstd + session.lock） | ✅ |

## 7. 风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|---|
| 备份期间 home 有活动写入导致备份不完整 | 中 | cp/rsync 非原子；sessions JSONL 可能少最后几行（不影响可回滚性）；kv.sqlite 为 WAL 模式——用 `sqlite3 .backup` 做在线一致备份后删 WAL/SHM 再 integrity_check。**主实例不可停**（红线），接受备份窗口内 live sessions/storages/run 的变化并在实录记录 |
| verify 实例共写 `~/.corum` | 中 | verify `--home=verify` 实际 home 仍为 `~/.corum`（非隔离）；备份期间若 verify 在跑会影响一致性。后续阶段需独立临时 home，不依赖 verify 隔离 |
| fork-drift 守卫 mktemp 在 /var/folders 被沙箱拒 | 高 | 设 `TMPDIR="$PWD/.corum-tmp"`（该目录已在 .gitignore）防止回落 rc.2；运行后必须确认日志无回落警告 |
| fork-drift「24 项既存失败」无在库证据 | 中 | 阶段 0 必须以真实 tag 导出重跑记录实际 N 项；不宣称 0/23/24；不修改守卫登记或 fork 源码 |
| 工作区有 untracked 文件遗漏提交 | 低 | `git status` 确认干净；fork 包源码都在 `packages/plugins/` 下 |
| push 推送全部未推送提交 | 中 | push 标【需用户授权】，说明会推送全部未推送提交；直推被 GH006 拒绝后改经 PR #155 合并完成远程回滚点 |
| dsh 仓 checkout 被误改 | 低 | 只用 `git show` / `git ls-tree`，不 checkout；dsh 仓只读 |
| 实录文件忘记 `git add -f` | 中 | `docs/` 被 `.gitignore:76` 忽略；新建文件必须 `git add -f`；已有升级文档靠强制跟踪入库 |
| 备份目录命名冲突 | 低 | 统一带时间戳 `$HOME/corum-upgrade-backups/pre-0.2.1-rc3-YYYYmmdd-HHMMSS` + `test ! -e` 禁止覆盖 |

## 8. 回滚方案

**本阶段本质是「可回滚性的保证」，基线未动则无回滚需求。**

### 回滚到 0.1.5 可用状态的最低集合

| # | 回滚项 | 位置/来源 | 说明 |
|---|---|---|---|
| 1 | home 一致备份 | `$BACKUP_ROOT/home/` | 排除 engines/sd-models + bin/*.part；含 sessions/settings/credentials 的还原点；kv.sqlite 经 .backup 在线一致 |
| 2 | 主 user-data | `$BACKUP_ROOT/user-data/` | Electron 本地存储/窗口态（热副本，恢复时 caveat） |
| 3 | Corum.app / 安装包 | `$BACKUP_ROOT/Corum.app/`（版本 0.7.0） | 升级失败的回滚目标就是旧 app |
| 4 | git 基线 commit | 阶段 0 记录的 HEAD hash | 含 `pnpm-lock.yaml`（lockfile 随 git 基线恢复：`git checkout <基线hash> -- pnpm-lock.yaml` + `pnpm install`） |
| 5 | dsh-v0.1.5-rc.3 tag | dsh 仓本地已有 | 基座基线 tag |
| 6 | 备份 manifest | `$BACKUP_ROOT/manifest.md` | 记录备份元数据供恢复时核对 |

> **lockfile 恢复**：`pnpm-lock.yaml` 属于 git 基线的一部分，靠 commit 恢复（`git checkout <基线hash> -- pnpm-lock.yaml`），不需要单独备份 lockfile 文件。

### 本阶段失败回滚

| 场景 | 回滚动作 |
|---|---|
| 步骤 1-2 失败（备份未完成） | 无需回滚——本阶段未改任何代码，重做即可；删除不完整备份目录后重新开始 |
| 步骤 3 fork-drift 报红 | 不回滚——基线本就如此，记录实际 N 项；不修改守卫登记或 fork 源码 |
| 步骤 4-8 失败 | 无代码改动，重做即可 |

**关键**：本阶段不修改任何源码、不修改 `pnpm-workspace.yaml`、不修改任何 `package.json`。
唯一可能写入的是实录文件 `docs/UPGRADE-0.2.1-rc3.md`（纯文档）。
若本阶段失败，意味着基线本身有问题，需要先修基线再重做本阶段。

## 9. 产出物与下游接口

| 产出物 | 位置 | 下游消费者 |
|---|---|---|
| home 备份 | `$HOME/corum-upgrade-backups/pre-0.2.1-rc3-*/home/` | 全程——出问题时可恢复 |
| user-data 备份 | 同上根目录 `/user-data/` | 全程——Electron 状态恢复 |
| Corum.app 备份 | 同上根目录 `/Corum.app/` | 升级失败回滚旧 app |
| 备份 manifest | 同上根目录 `/manifest.md` | 恢复时核对元数据 |
| 工作区 commit | `main` 分支 HEAD | 全程——基线代码快照 |
| fork-drift 基线结果 | 实录文件 §fork-drift 基线 | 阶段 4——验证时对比 drift 变化（只许收敛不许扩大） |
| 基线快照表 | 实录文件 §基线快照 | 阶段 2——override 重算时对照 217→250-300 |
| 实录文件骨架 | `docs/UPGRADE-0.2.1-rc3.md` | 全程——各阶段执行时追加 |

**下游接口契约**：
- 阶段 1（`03-removed-packages.md`）的准入门禁第 1 条 = 本阶段退出门禁全部通过。
- 阶段 2（`04-overrides-lockfile.md`）的输入依赖基线快照表的 override 条目数（217 条 = 216 + 1）。
- 阶段 4（`06-verification.md`）的 fork-drift 验证对照本阶段记录的基线 N 项。

## 10. 实录要求（执行时往 `docs/UPGRADE-0.2.1-rc3.md` 记什么）

执行本阶段时，往实录文件记录以下内容：

1. **步骤 1**：备份命令 + 备份根目录路径 + 备份目录大小 + 耗时 + 排除项 + manifest 内容。
2. **步骤 2**：kv.sqlite `.backup` 命令 + integrity_check 输出 + WAL/SHM 删除确认 + user-data 热副本 caveat。
3. **步骤 3**：工作区 `git status` 输出 + commit hash + push 结果（直推被 GH006 拒绝 → 改经 PR #155 合并完成远程回滚点）。
4. **步骤 4**：fork-drift 守卫的完整输出 + TMPDIR 设置 + 确认无回落 + exit code + 真实 tag + 失败项清单。
5. **步骤 5**：`git tag -l` 输出 + `git rev-parse dsh-v0.2.1-rc.3` 输出 + 当前 dsh HEAD。
6. **步骤 6**：基线快照表（override 条目数 217=216+1 / 433=249+184 / fork 包数 / 版本号 / node/pnpm / git HEAD+branch / 主实例形态 / 官方包总数 278→362 口径）。
7. **步骤 7**：实录文件创建确认 + 从 01 册附录 B 完整转录阶段 -1 实录的确认（各小节可查）。
8. **步骤 8**：实例状态（主实例 + verify 实例形态/home/port/PID）+ verify 共写 home 风险记录 + 禁止启停纪律。
9. **偏差记录**：若实际数字与预期不符（如 override 不是 217 条），记录实际值与偏差原因。
10. **时间**：本阶段实际耗时。
