#!/usr/bin/env bash
#
# verify-refactor-guard.sh —— corum-agent 架构拆分（2026-09-21 轮）的机器守卫
#
# ## 为什么需要它
#
# 本轮把 `agent-service.ts`（2877 行）里的 6/7/8 三簇抽成独立模块。这些簇**本来就在
# 测试盲区里**（全仓 278 个测试没有一个真的构造该服务跑这些方法），于是「测试绿」在
# 本轮**连参考价值都有限**。上场已经付过一次学费：
#
# > `findLaneAgent` 的 `return undefined` 被切掉后，**编译通过、测试全绿**
# > ——只有 `git diff` 对照 HEAD 才发现。
#
# `git diff` 是**人工**判据（每步都要看）。本脚本是它的**机器补充**：把「搬完不该发生的
# 事」写成断言，让它们在 CI / 收尾时自动响。
#
# ## 本脚本断言什么（4 组）
#
#   ① **RPC 面冻结**：28 个 `@Remote` 名字集合与 HEAD 完全一致（搬实现不动注册面）。
#      这是本轮「contract 与 UI 零改动」的机器证据。
#   ② **已知地雷不得复活**：`findLaneAgent` 的 `return undefined`、`agents.list` 的
#      「方法/可迭代属性」两形态兼容 —— 两条都是实机事故留下的修复。
#   ③ **状态表访问按阶段收敛**：每个状态表有一个「允许被 service 直访」的计数上限，
#      **只许降不许升**。降到位后会被要求「必须为 0」（见 EXPECTED_ABSENT）。
#   ④ **不得反向依赖**：抽出的模块不许 import `agent-service.ts`（只允许 type-only，
#      且必须在白名单里）——防止拆分变成循环依赖。
#
# ## 用法
#
#   ./scripts/verify-refactor-guard.sh                # 全量（验收用这一种）
#   ./scripts/verify-refactor-guard.sh --explain      # 附每组的判据说明
#   ./scripts/verify-refactor-guard.sh --baseline     # 打印当前实测计数（刷新阈值用）
#
# 退出码：0 = 全部通过；1 = 有断言失败。

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG_DIR="$REPO_ROOT/packages/plugins/agent/corum-agent"
SERVICE="$PKG_DIR/src/agent-service.ts"

MODE="run"
case "${1:-}" in
  --explain) MODE="explain" ;;
  --baseline) MODE="baseline" ;;
  "") ;;
  *) echo "用法: $0 [--explain|--baseline]" >&2; exit 2 ;;
esac

FAILURES=0
CHECKS=0

pass() { CHECKS=$((CHECKS + 1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { CHECKS=$((CHECKS + 1)); FAILURES=$((FAILURES + 1)); printf '  \033[31m✗\033[0m %s\n' "$1"; }
info() { printf '    %s\n' "$1"; }
group() { printf '\n\033[1m%s\033[0m\n' "$1"; }

if [ ! -f "$SERVICE" ]; then
  echo "找不到 $SERVICE —— 本脚本必须在 corum 仓库内运行。" >&2
  exit 1
fi

# ─────────────────────────────────────────────────────────────────────────────
# 权威基线：26 个 RPC 名字（冻结，来自 2026-09-20 拆分开始前的 HEAD **减去**
# 已迁出的 project-lane 三个端点、**加上** 冻结后净增的 RPC_NAMES_ADDED）
# ─────────────────────────────────────────────────────────────────────────────
# 2026-09-26 项目模式剥离：`createAgentForType` / `runPromptForType` /
# `getSessionEventsForType` 三个 @Remote **随项目模式迁到闭源仓**
# Corum-Harness-Project 的 `@corum/corum-project` 插件（在 `/api/corumProject/*`
# 面重新暴露同名端点）——**RPC 面移动，不是删除**。故它们从冻结集合移入下面的
# RPC_NAMES_MOVED_TO_CLOSED：本仓不得再出现（出现即代表剥离回退），而 HEAD 对照
# 仍按「冻结 ∪ 已迁出」比对，这样第 ① 组继续保持它原本的语义——**除这次有意的
# 移仓之外，@Remote 名字集合不得有任何变化**。
RPC_NAMES_FROZEN="createAgent createTaskAgent deleteProfile getChildSessionProgress getEvents getImageCompatibility getPolishConfig getSubagentSessionMeta getSubagentSessionResult getTaskSessionEvents getWorktreeLedger listAgents listModels listPermissionPresets listProfiles listSkills listTaskAgents polishConversation polishPrompt runPrompt runPromptForTask saveProfile selectTaskAgentProfile setPolishConfig translatePrompt verify"
RPC_NAMES_MOVED_TO_CLOSED="createAgentForType runPromptForType getSessionEventsForType"
# 冻结之后**新增**的端点（与「移仓」区分：移仓是搬走，这里是净增）。
# 每加一个都必须在这里记账——否则第 ① 组与 HEAD 对照都会红，而那正是它该有的行为：
# 新 RPC 面必须是**有意的**，不是顺手长出来的。
#   getSubagentSessionResult  #98：子 Agent 最终返回正文（子 Agent 卡「结果」区数据源）。
#                             既有 getSubagentSessionMeta 只给父注入的任务指令，
#                             给不出「它干完回了什么」，故必须净增一个读端点。
RPC_NAMES_ADDED="getSubagentSessionResult"

# ─────────────────────────────────────────────────────────────────────────────
# 状态表直访预算（第 ③ 组）
#
# 语义：`agent-service.ts` 里 `this.<表>` 的**出现次数**上限（按出现次数、不按行数——
# `a.foo() ?? a.foo()` 写在一行里是两个写入者，`grep -c` 只会数成 1）。**只许降**。
# 「必须为 0」的表列在 EXPECTED_ABSENT：一旦某阶段搬完，把它从下面删掉、加到这里，
# 脚本就会在该表重新出现时立刻报错（防止搬运回退）。
#
# 刷新方式：`./scripts/verify-refactor-guard.sh --baseline`
# ─────────────────────────────────────────────────────────────────────────────
# 格式：每行 `表名 预算 用途说明`（用普通字符串而非关联数组——macOS 自带 bash 3.2
# **不支持 `declare -A`**，本仓脚本一律要能在系统 bash 下跑）。
STATE_BUDGET="\
pendingPermissions 3 待兑现权限档位
conductor 6 指挥模式运行时"

# 已经收走的表：必须出现 **0** 次（格式同上，预算恒为 0）。
EXPECTED_ABSENT="\
agents root Agent 表（P3-a 收进 AgentRegistry）
typeAgents 泳道会话表（P3-a 收进 AgentRegistry）
sessionLaneIndex 泳道归属索引（P3-a 收进 AgentRegistry）
taskAgents task 会话表（P3-a 收进 AgentRegistry）
taskSelections 模型选择 ref 表（P3-a 收进 AgentRegistry）
agentCreationsInFlight 在飞创建去重（P3-a 收进 AgentRegistry）
agentCreationTimes 重建风暴记账（P3-a 收进 AgentRegistry）
subagentProgress 子会话进度折叠表（P1-b 收进 SubagentProgressTracker）
subagentRoles 委派角色（P1-b 收进 SubagentProgressTracker）
subagentParents 子会话父会话（P1-b 收进 SubagentProgressTracker）
notifiedInterrupted 中断广播去重（P1-b 收进 SubagentProgressTracker）"

# 允许 import agent-service.ts 的**包内其他模块**。格式：`文件名|理由`。
# 2026-09-26 项目模式剥离：`runtime.ts` / `project-service.ts` /
# `project-data-service.ts` 三个条目随源文件迁到闭源仓 Corum-Harness-Project
# 而删除（闭源仓 `@corum/corum-project` 里仍合法地引用本服务——那是**跨包依赖**、
# 不是包内反向依赖，本组判据不覆盖也不该覆盖）。
BACKREF_ALLOW="\
index.ts|插件入口：导出 CorumAgentService（这是它的公开面，不是反向依赖）"

# ─────────────────────────────────────────────────────────────────────────────
if [ "$MODE" = "baseline" ]; then
  printf '\033[1m当前实测计数（可直接粘贴进 STATE_BUDGET）\033[0m\n'
  while read -r table _rest; do
    [ -z "$table" ] && continue
    n=$(grep -o "this\.${table}\b" "$SERVICE" | wc -l | tr -d ' ')
    printf '  %s %s\n' "$table" "${n:-0}"
  done <<< "$STATE_BUDGET"
  exit 0
fi

if [ "$MODE" = "explain" ]; then
  cat <<'EOF'
判据说明
────────
① RPC 面冻结
   本轮的硬约束：实现搬走、`@Remote` 留在 CorumAgentService。若某次改动让 RPC 名字
   集合变了，UI 侧 `/api/corumAgent/*` 就断了——这是「零改动」承诺的机器证据。

② 已知地雷不得复活
   · findLaneAgent 的 `return undefined`：返回类型本是 `| undefined`，falling off the
     end 语义相同 ⇒ 删掉它编译过、测试全绿（上场实测）。
   · agents.list 的两形态兼容：官方 registry 上 `list` 是**方法**，按属性 for...of 会抛
     `function is not iterable`，曾被 try/catch 吞掉导致「隔离」徽标与 integrated 标记
     长期静默失效（2026-09-12）。兼容写法删掉即复活。

③ 状态表直访预算
   与上一轮「收成单一写入者」同源：每张表最终应归一个所有者模块持有，服务只经窄接口
   访问。预算是**收敛轨迹**——只许降。降到 0 的表移入 EXPECTED_ABSENT，永久钉死。

④ 不得反向依赖
   抽出的模块 import 回 agent-service 会把「按关注点拆分」变成循环依赖（本仓红线 1/3
   的同族风险：模块实例与可见性都会变）。
EOF
  exit 0
fi

printf '\033[1mcorum-agent 拆分守卫\033[0m  (%s)\n' "$(basename "$SERVICE")"

# ── ① RPC 面冻结 ────────────────────────────────────────────────────────────
RPC_COUNT="$(printf '%s\n' $RPC_NAMES_FROZEN | wc -w | tr -d ' ')"
group "① RPC 面冻结（${RPC_COUNT} 个 @Remote 名字集合）"
ACTUAL_RPC="$(grep -o "@Remote('[a-zA-Z]*')" "$SERVICE" | sed "s/@Remote('//;s/')//" | sort | tr '\n' ' ' | sed 's/ $//')"
FROZEN_SORTED="$(printf '%s\n' $RPC_NAMES_FROZEN | sort | tr '\n' ' ' | sed 's/ $//')"
if [ "$ACTUAL_RPC" = "$FROZEN_SORTED" ]; then
  pass "@Remote 名字集合与冻结基线一致（${RPC_COUNT} 个）"
else
  fail "@Remote 名字集合与冻结基线不一致"
  info "冻结: $FROZEN_SORTED"
  info "实测: $ACTUAL_RPC"
  info "差集（实测多出/缺失）:"
  /usr/bin/diff <(printf '%s\n' $FROZEN_SORTED | tr ' ' '\n') <(printf '%s\n' $ACTUAL_RPC | tr ' ' '\n') | sed 's/^/      /'
fi

# ① -b 已迁到闭源仓的端点：本仓**不得**再出现（出现即代表剥离回退）。
# 判据与上面同源但方向相反——上面拦「多/少」，这里拦「搬走又搬回来」。
MOVED_BAD=0
for rpc in $RPC_NAMES_MOVED_TO_CLOSED; do
  if printf '%s\n' $ACTUAL_RPC | tr ' ' '\n' | grep -qx "$rpc"; then
    fail "@Remote('${rpc}') 又出现在本仓——它已随项目模式迁到闭源仓 @corum/corum-project"
    MOVED_BAD=$((MOVED_BAD + 1))
  fi
done
if [ "$MOVED_BAD" -eq 0 ]; then
  pass "project-lane 三个端点未回流（${RPC_NAMES_MOVED_TO_CLOSED}）"
fi

# 若在 git 仓库内，再与 HEAD 对照（防「只改了基线忘了实现」）。
# ⚠️ HEAD 对照的口径 = **HEAD 的 RPC 集合减去已迁出的三端点、加上冻结后净增的
# RPC_NAMES_ADDED**：否则这条判据会被「顺手改基线」绕过去（只比冻结集合的话，
# 把某个端点从两边一起删掉也会绿）。净增那一路同理——名字必须同时出现在实现里
# 和 RPC_NAMES_ADDED 里，两处只改一处都会红。
if command -v git >/dev/null 2>&1 && git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  HEAD_RPC="$(git -C "$REPO_ROOT" show HEAD:packages/plugins/agent/corum-agent/src/agent-service.ts 2>/dev/null \
    | grep -o "@Remote('[a-zA-Z]*')" | sed "s/@Remote('//;s/')//" | sort | tr '\n' ' ' | sed 's/ $//')"
  HEAD_BASE="$(printf '%s\n' $HEAD_RPC | tr ' ' '\n' | grep -vxF -e createAgentForType -e runPromptForType -e getSessionEventsForType)"
  HEAD_EXPECTED="$(printf '%s\n%s\n' "$HEAD_BASE" $RPC_NAMES_ADDED | grep -v '^$' | sort | tr '\n' ' ' | sed 's/ $//')"
  if [ -n "$HEAD_RPC" ]; then
    if [ "$ACTUAL_RPC" = "$HEAD_EXPECTED" ]; then
      pass "与 HEAD 的 @Remote 集合一致（差别仅为有意迁出的 project-lane 三端点 + 已记账的净增 ${RPC_NAMES_ADDED}）"
    else
      fail "与 HEAD 的 @Remote 集合不同（除 project-lane 三端点与 RPC_NAMES_ADDED 外还动了 RPC 面）"
      /usr/bin/diff <(printf '%s\n' $HEAD_EXPECTED | tr ' ' '\n') <(printf '%s\n' $ACTUAL_RPC | tr ' ' '\n') | sed 's/^/      /'
    fi
  else
    info "跳过 HEAD 对照（读不到 HEAD 版本的文件）"
  fi
fi

# ── ② 已知地雷不得复活 ───────────────────────────────────────────────────────
group "② 已知地雷不得复活"

# ② -a findLaneAgent 必须有显式 return undefined
# ⚠️ 实际实现已随 P3-a 搬进 AgentRegistry.findLaneBySession（服务侧只剩一跳），
# 故检查**实现文件**而不是服务文件 —— 判据本身不变（「必须有显式 return undefined」）。
REGISTRY="$PKG_DIR/src/agent-registry.ts"
if [ ! -f "$REGISTRY" ]; then
  fail "找不到 agent-registry.ts（findLaneBySession 的家）—— 搬家后请更新本检查"
else
  LANE_BODY="$(awk '/findLaneBySession\(sessionId: string\)/,/^  }$/' "$REGISTRY")"
  if printf '%s' "$LANE_BODY" | grep -q 'return undefined'; then
    pass "findLaneBySession 保留显式 return undefined（上场被误删过的那个）"
  else
    fail "findLaneBySession 缺少 return undefined（返回类型是 | undefined，编译与测试都发现不了！）"
  fi
  # 服务侧只该剩一跳，不得自己再实现一遍循环
  if grep -q 'for (const entry of this.lanes.values())' "$SERVICE" 2>/dev/null; then
    fail "agent-service 里又出现了泳道表遍历（应经 registry.findLaneBySession）"
  fi
fi

# ② -b agents.list 两形态兼容（三处独立实现）。
#
# ⚠️ 按**文件分别**断言而不是算总数（2026-09-21）：本轮 P2 把 buildChangeSummary 搬进
# change-summary.ts 后，总数从 3 掉到 2、本组变红——**红得对**，但若图省事改成「总数 ≥ 2」
# 就废掉了这条判据。按文件断言既容忍搬家，又能指出**哪一处**丢了兼容。
# 三处各自的位置：agent-service 的 agentRunning / childWorktreeIsolation，change-summary 的反查父会话。
COMPAT_FILES="\
agent-service.ts|2|agentRunning + childWorktreeIsolation
change-summary.ts|1|buildChangeSummary 反查父会话"
while IFS='|' read -r file want why; do
  [ -z "$file" ] && continue
  f="$PKG_DIR/src/$file"
  if [ ! -f "$f" ]; then
    fail "agents.list 兼容检查：找不到 ${file}（搬家后请更新本清单，别删条目）"
    continue
  fi
  # ⚠️ 排除**注释行**：这几个模块的头注里会引用该兼容写法作为说明（实测就这样把 1 处
  # 数成 2 处）。数注释会让判据既可能假绿也可能假红——两边都不可接受。
  n1=$(grep -v '^\s*\*' "$f" | grep -v '^\s*//' | grep -o "typeof raw === 'function' ? raw() : raw" | wc -l | tr -d ' ')
  n2=$(grep -v '^\s*\*' "$f" | grep -v '^\s*//' | grep -o "typeof rawList === 'function' ? rawList() : rawList" | wc -l | tr -d ' ')
  got=$((n1 + n2))
  if [ "$got" -eq "$want" ]; then
    pass "agents.list 两形态兼容：$file 有 ${got} 处（${why}）"
  else
    fail "agents.list 两形态兼容：$file 应有 ${want} 处、实测 ${got}（${why}）"
    info "删掉兼容写法会让 by-property for...of 抛 function is not iterable，并被 try/catch 吞掉"
  fi
done <<< "$COMPAT_FILES"

# ② -c 服务取用纪律：可选服务必须走 ctx.get
if awk '/applySubagentModelForSession\(/,/^  \}$/' "$SERVICE" | grep -q "this\.ctx\.get('sessionProjections'"; then
  pass "applySubagentModelForSession 走 ctx.get('sessionProjections')（不走属性访问）"
else
  fail "applySubagentModelForSession 未走 ctx.get('sessionProjections')（未 inject 时属性访问会抛）"
fi

# ── ③ 状态表直访预算（只许降） ────────────────────────────────────────────────
group "③ 状态表直访预算（只许降不许升）"
while read -r table budget _rest; do
  [ -z "$table" ] && continue
  actual="$(grep -o "this\.${table}\b" "$SERVICE" | wc -l | tr -d ' ')"
  if [ "$actual" -le "$budget" ]; then
    pass "this.${table}: ${actual} ≤ 预算 ${budget}"
  else
    fail "this.${table}: ${actual} > 预算 ${budget}（拆分在回退，或该表又新增写入者）"
  fi
done <<< "$STATE_BUDGET"
# 已收走的表：必须为 0（EXPECTED_ABSENT 为空时本组自动跳过）
if [ -n "$EXPECTED_ABSENT" ]; then
  while read -r table _rest; do
    [ -z "$table" ] && continue
    actual="$(grep -o "this\.${table}\b" "$SERVICE" | wc -l | tr -d ' ')"
    if [ "$actual" -eq 0 ]; then
      pass "this.${table}: 已收走（0 次，钉死）"
    else
      fail "this.${table}: 应为 0 次，实测 ${actual}（已收走的状态表又回来了）"
    fi
  done <<< "$EXPECTED_ABSENT"
fi

# ── ④ 反面依赖 ──────────────────────────────────────────────────────────────
group "④ 抽出的模块不得反向依赖 agent-service"
BACKREF_BAD=0
while IFS= read -r file; do
  base="$(basename "$file")"
  [ "$base" = "agent-service.ts" ] && continue
  # 只看真正的 import 语句（注释里提到 agent-service.ts 是合法的——大量模块头注都提到）
  imports="$(grep -nE "^import .*'\./agent-service\.ts'" "$file" || true)"
  if [ -n "$imports" ]; then
    reason="$(printf '%s\n' "$BACKREF_ALLOW" | awk -F'|' -v b="$base" '$1 == b { print $2 }')"
    if [ -n "$reason" ]; then
      pass "$base 引用 agent-service（已白名单：${reason}）"
    else
      fail "$base 反向 import agent-service.ts，且不在白名单"
      printf '%s\n' "$imports" | sed 's/^/      /'
      BACKREF_BAD=$((BACKREF_BAD + 1))
    fi
  fi
done < <(find "$PKG_DIR/src" -maxdepth 1 -name '*.ts' -print | sort | uniq)
if [ "$BACKREF_BAD" -eq 0 ]; then
  pass "无未白名单的反向依赖"
fi

# ── ⑤ 进度观测（不算失败，只报数） ──────────────────────────────────────────
group "⑤ 拆分进度（观测值，不参与判定）"
SERVICE_LINES="$(wc -l < "$SERVICE" | tr -d ' ')"
printf '  agent-service.ts: %s 行（本轮起点 2877，目标 ≈750）\n' "$SERVICE_LINES"
printf '  已抽出模块:\n'
for m in permission-policy polish-service conductor-runtime profile-compiler lane-registry \
         child-progress subagent-progress change-summary agent-registry task-lane; do
  f="$PKG_DIR/src/$m.ts"
  if [ -f "$f" ]; then
    printf '    ✓ %-24s %5s 行\n' "$m.ts" "$(wc -l < "$f" | tr -d ' ')"
  else
    printf '    · %-24s (未抽)\n' "$m.ts"
  fi
done

# ── ⑦ 改动审查快照：内容寻址缓存必须**接线**（D2，2026-09-28）───────────────
# 为什么值得钉：`filesOf` 原先对每个改动文件跑 4–5 个 git 子进程，一次 `corumReview/snapshot`
# 1.1–2.0 s；内容寻址缓存把 224 次调用里的 219 次压到 < 50 ms（p50 3 ms，见 PENDING §2.17）。
# 而它是**纯加速**：被删掉或漏传时行为完全不变、单测不会红 —— 只有实机变慢，最难发现的那类退化。
group "⑦ 改动审查快照：内容寻址缓存接线（D2）"
REVIEW_SRC="$REPO_ROOT/packages/desktop/src/host/corum-review.ts"
if [ -f "$REVIEW_SRC" ]; then
  pass "审查 host 源码存在"
  for needle in 'interface ReviewComputeCache' 'preimageText: Map<string, string>' 'diffStats: Map<string, { added: number; removed: number }>' 'blobHashes: Map<string, string>'; do
    if grep -qF "$needle" "$REVIEW_SRC"; then
      pass "缓存结构在位：${needle}"
    else
      fail "缓存结构缺失：${needle}"
    fi
  done
  for needle in 'preimageText(repo: RepoState, pre: Preimage, cache?: ReviewComputeCache)' 'hashObject(repo: RepoState, content: string, cache?: ReviewComputeCache)'; do
    if grep -qF "$needle" "$REVIEW_SRC"; then
      pass "重活入口接受缓存：${needle%%(*}"
    else
      fail "重活入口未接缓存：${needle%%(*}"
    fi
  done
  if grep -qF 'this.filesOf(round.workspace, round.touched, this.computeCacheFor(sessionId))' "$REVIEW_SRC"; then
    pass "snapshot 路径已把缓存传进 filesOf（否则缓存形同虚设）"
  else
    fail "snapshot 路径没有把缓存传进 filesOf —— 缓存未接线，实机会退回逐文件子进程"
  fi
  # D2b：批量路径（把「每文件 4–5 个子进程」压成整轮常数次）。删掉它行为不变、只是变慢 ⇒ 必须钉住。
  for needle in 'preimageTextBatch(' 'hashObjectBatch(' "'cat-file', '--batch'" "'hash-object', '-w', '--stdin-paths'"; do
    if grep -qF "$needle" "$REVIEW_SRC"; then
      pass "批量路径在位：$needle"
    else
      fail "批量路径缺失：${needle}（冷快照会退回逐文件子进程）"
    fi
  done
  if grep -qF 'await this.preimageTextBatch(repo, pres, cache)' "$REVIEW_SRC" && grep -qF 'await this.hashObjectBatch(repo, afterContents, cache)' "$REVIEW_SRC"; then
    pass "filesOf 已调用两条批量路径（否则批量为死代码）"
  else
    fail "filesOf 没有调用批量路径 —— 批量为死代码"
  fi
else
  fail "找不到审查 host 源码：$REVIEW_SRC"
fi

# ── ⑧ 子会话进度共享缓存必须接线（C3/C3b，2026-09-28）─────────────────────
# 为什么值得钉：卡片与花名册原本**各自**拉进度（花名册视图每次激活都重挂 ⇒ 每子会话又拉一次），
# 实测一轮动作 132 次 `getChildSessionProgress`；接上 chatRuntime 的共享缓存后降到 0（热态）。
# 这条同样是「纯加速」：漏传/删掉时行为不变、测试不红 —— 只有实机变慢。
group "⑧ 子会话进度共享缓存接线（C3 / C3b）"
CHAT_RT="$REPO_ROOT/packages/plugins/session/corum-ui-chat/src/client/chat-runtime.ts"
SESSION_BAR="$REPO_ROOT/packages/plugins/ui/corum-ide-ui/src/client/session-bar.tsx"
IDE_INDEX="$REPO_ROOT/packages/plugins/ui/corum-ide-ui/src/client/index.tsx"
for pair in "$CHAT_RT:childProgress(sessionId: string): Promise<CorumChildProgressValue | undefined>" \
            "$CHAT_RT:CHILD_PROGRESS_TERMINAL_TTL_MS" \
            "$SESSION_BAR:readChildProgress?: ReadChildProgress" \
            "$SESSION_BAR:readChildProgress === undefined" \
            "$IDE_INDEX:chatChildProgressCapable" \
            "$IDE_INDEX:readChildProgress: chatChildProgressCapable()"; do
  file="${pair%%:*}"; needle="${pair#*:}"
  if [ -f "$file" ] && grep -qF "$needle" "$file"; then
    pass "共享进度缓存接线在位：$(basename "${file}") · ${needle:0:38}"
  else
    fail "共享进度缓存接线缺失：$(basename "${file}") · ${needle:0:38}"
  fi
done

# ── 汇总 ────────────────────────────────────────────────────────────────────
# ── ⑥ 断言计数器自检（防「判据跑了但计数被 subshell 吞掉」） ────────────────
# 这条不是洁癖：本脚本第一版把状态表循环写成 `printf … | while read`，循环体在**子 shell**
# 里跑 ⇒ pass/fail 的计数全部丢失，于是「超预算」这类失败**悄悄不报**（实测踩到）。
if [ "$CHECKS" -lt 10 ]; then
  fail "断言计数器只记录了 ${CHECKS} 项（< 10）—— 有判据被 subshell 吞掉，本脚本的结论不可信"
fi

printf '\n'
if [ "$FAILURES" -eq 0 ]; then
  printf '\033[32m全部通过\033[0m（%s 项断言）\n' "$CHECKS"
  exit 0
fi
printf '\033[31m%s / %s 项断言失败\033[0m\n' "$FAILURES" "$CHECKS"
exit 1
