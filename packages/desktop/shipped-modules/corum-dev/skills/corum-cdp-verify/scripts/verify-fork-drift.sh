#!/usr/bin/env bash
#
# verify-fork-drift.sh —— fork 包与官方基线的机器校验（P2-9，.dbg/event-bus-audit-2026-09.md）
#
# 解决什么问题：fork 包（尤其 @corum/corum-api-remotes）与官方同名包共用「核心文件
# 逐字节一致 + 只在声明过的位置加增量」的维护纪律。人工 rebase 时最容易漏的是：
#   ① 官方核心文件被无意改动（下次升级 rebase 冲突面扩大）；
#   ② 新增 corum 事件只写了声明、忘了进转发 allowlist（renderer 永远收不到）；
#   ③ allowlist 里留了早已删除的死事件（或事件改名后两边不同步）；
#   ④ 领域事件（corum-agent/events.ts）与转发声明（corum-events.ts）名字漂移。
# 本脚本把这些变成可执行的断言，退出码非 0 即 drift。
#
# 用法：
#   scripts/verify-fork-drift.sh                        # 全量（验收只用这一种跑法）
#   DSH_CHECKOUT=/path/to/dsh scripts/verify-fork-drift.sh
#   DSH_CHECKOUT=/path/to/dsh DSH_BASELINE_TAG=dsh-v0.1.5-rc.3 scripts/verify-fork-drift.sh
#       ↑ 指定官方**基线标签**（升级期间必修：检出 HEAD 可能已前进到 0.1.7，
#         而我们当前目标是 0.1.5-rc.3 ⇒ 不设这个变量会拿 HEAD 当基线、长期假红）
#   scripts/verify-fork-drift.sh --help                 # 用法 + 分区清单 + 快速通道警告
#   scripts/verify-fork-drift.sh --only 8 --only 15b    # 快速通道：只跑指定分区（可重复）
#   scripts/verify-fork-drift.sh --fast                 # 快速通道：只跑最快、最要命的若干分区
#
# ⚠ 快速通道（--only / --fast）**只供开发迭代，不能作为验收依据**：
#   未选中的分区会被直接排除——不执行、不计入 failures/skips，输出里逐条标注「已排除」，
#   末行也会显式声明「过滤运行」，因此过滤运行的「绿」只代表被选中的那几个分区绿。
#   **最终验收必须运行无参数的全量**：
#       ./scripts/verify-fork-drift.sh
#
# --fast 选区（单一事实源 = 下面 CLI 段的 FAST_LANE_SECTIONS）：
#   [8]   客户端插件挂载点覆盖（dsh.client → 挂载行 + desktop 依赖）
#   [11]  模型选择单一 owner（corum-agent 用 installTaskModelSelection）
#   [12]  GPU 合成默认开启（CORUM_DISABLE_GPU 显式回退）
#   [13]  打包闭包版本一致性（pnpm overrides 逐个钉 + pack 时断言）
#   [15b] fork #14（corum-fs-local）：edit 定位提示 + 解析面 override
#   [18]  corum-cdp-verify 技能：打包副本 == 仓库脚本（逐字节）
#   选它们的理由：全部是本机 grep/cmp 断言（不依赖官方检出、不起 node/pnpm 子进程，
#   秒级返回），且各自守的都是一次真实的「静默失效」事故（挂载丢失 / 换模型被吞 /
#   掉帧 / 混版闭包 / fork 不生效 / 技能副本漂移）。
#
# 跨分区依赖（分区筛选必须先知道这些）：[3][4] 用 [2] 解析出的 declared，[14] 用 [12]
# 定义的 DESKTOP_MAIN。这两处赋值已前置到分区之外（纯读取、无副作用），因此任意
# --only 组合都能单独跑；全量路径的判定与输出不变。
#
# 官方检出缺失时只跳过「逐字节一致」类断言（并明确提示），事件一致性断言仍然执行。
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# 官方检出根。**不预置机器专属路径**：未设置时留空，所有「逐字节一致」类断言会因文件
# 不存在走 skip 分支；事件一致性断言不依赖检出，仍然执行（见文件头说明）。
DSH_CHECKOUT="${DSH_CHECKOUT:-}"
DSH_BASELINE_TAG="${DSH_BASELINE_TAG:-}"

# ── 基线标签支持（升级期必修）─────────────────────────────────────────────
# 为什么需要：守卫读的是 `$DSH_CHECKOUT/<路径>` 的**工作区文件**，而检出 HEAD 会随官���推进而前进
# （实测：HEAD=0.1.7-rc.2，而 corum 当前目标是 0.1.5-rc.3 ⇒ 逐字节断言会拿错基线、长期假红且无法区分
# 「我们落后」与「我们改错了」）。设 DSH_BASELINE_TAG 后改为 `git archive <tag>` 取官方基线。
if [ -n "$DSH_BASELINE_TAG" ] && [ -d "$DSH_CHECKOUT/.git" ]; then
  BASELINE_DIR="$(mktemp -d)"
  if git -C "$DSH_CHECKOUT" archive "$DSH_BASELINE_TAG" packages 2>/dev/null | tar -x -C "$BASELINE_DIR" 2>/dev/null; then
    printf '[baseline] 官方基线 = %s（%s）\n' "$DSH_BASELINE_TAG" "$(git -C "$DSH_CHECKOUT" rev-parse --short "$DSH_BASELINE_TAG" 2>/dev/null)"
    trap 'rm -rf "$BASELINE_DIR"' EXIT
    DSH_CHECKOUT="$BASELINE_DIR"
  else
    printf '[baseline] ⚠️ 无法导出 %s ⇒ 回落到检出工作区 %s\n' "$DSH_BASELINE_TAG" "$DSH_CHECKOUT"
  fi
fi
FORK_API_REMOTES="$REPO_ROOT/packages/plugins/agent/corum-api-remotes"
OFFICIAL_API_REMOTES="$DSH_CHECKOUT/packages/api/remotes"
AGENT_EVENTS="$REPO_ROOT/packages/plugins/agent/corum-agent/src/events.ts"
AGENT_CONTRACT="$REPO_ROOT/packages/plugins/agent/corum-agent/src/contract/agent.ts"
AGENT_SERVICE="$REPO_ROOT/packages/plugins/agent/corum-agent/src/agent-service.ts"

# ── 闭源仓（项目模式）——2026-09-26 开源/闭源剥离 ──────────────────────────────
#
# `corum/task/*` 与 `corum/group/*` 这些**领域事件**（域调度器的因果记录）随项目模式
# 迁到了闭源仓 Corum-Harness-Project 的 `@corum/corum-project`；开源仓只保留事件的
# **声明与转发面**（`corum-api-remotes/src/corum-events.ts` + `remote-events.ts`，
# 因为开源侧 `packages/desktop/src/client/notification-bridge.ts` 仍在消费它们）。
#
# 故本脚本对这两类事件的「声明 ↔ 实现」断言改为**跨仓**：闭源仓检出在场就照旧断言，
# 不在场就 **skip 并说明为什么**（不是静默放过——静默会正好把「闭源侧没 emit」这种
# 真故障变成看不见）。路径可经 `CORUM_CLOSED_REPO` 覆盖（CI/别处检出）。
#
# ⚠️ 判据**没有降级**：断言本身一字未改，只是取样面从「开源仓取不到就不判」变成
# 「按仓归属取样」。开源单独检出时本组事件**报 skip**（明确计数），其余 18 组照常。
#
# 候选路径（按序取第一个在场的）：显式覆盖（`CORUM_CLOSED_REPO`）→ 工作树内的
# `Corum-Harness-Project/`（迁移期形态：闭源码树暂存在工作树根、待用户落盘）→
# 与开源仓**并排的兄弟目录**（落盘后的正式形态）。
CORUM_CLOSED_REPO="${CORUM_CLOSED_REPO:-}"
CLOSED_PROJECT_SRC=""
if [ -z "$CORUM_CLOSED_REPO" ]; then
  for cand in "$REPO_ROOT/Corum-Harness-Project" "$REPO_ROOT/../Corum-Harness-Project"; do
    if [ -d "$cand/packages/corum-project/src" ]; then
      CORUM_CLOSED_REPO="$(cd "$cand" && pwd)"
      break
    fi
  done
fi
if [ -n "$CORUM_CLOSED_REPO" ]; then
  CLOSED_PROJECT_SRC="$CORUM_CLOSED_REPO/packages/corum-project/src"
else
  # 两者都不在：留一个**可读**的路径给 skip 文案（说明在找哪儿）。
  CLOSED_PROJECT_SRC="$REPO_ROOT/../Corum-Harness-Project/packages/corum-project/src"
fi

failures=0
skips=0

pass() { printf '  ✓ %s\n' "$*"; }
fail() { printf '  ✗ %s\n' "$*"; failures=$((failures + 1)); }
skip() { printf '  – %s\n' "$*"; skips=$((skips + 1)); }

section() { printf '\n%s\n' "$*"; }

# ── 注释剥离 / 「命中即证据」的统一口径（2026-09-14 P0 修复）────────────────
# 背景：§8 原先用 `grep -qF "$pkg_name" <mount file>` 判定「包已挂载」，而注释行
# 也算命中——@corum/corum-ide-explorer-ui / @corum/corum-ide-statusbar-ui 的
# **全部**命中都是 YAML 注释（行本来就注释掉了），守卫却对它们打印「✓ 已挂载」。
# 同型审计：本脚本所有「grep 命中即证据」的判定段都必须过同一口径。
#
# 口径：
#   uncomment_*：按语言剥掉注释（C 系 // 与 /* */；YAML/Shell 的 # 行首与行尾；
#                引号内的 # / // 不算注释起点）。剥离是**状态机**而非逐行正则——
#                逐行 `sed 's/#.*//'` 会误伤字符串里的 #（'@corum/x#y'）。
#   code_has：在剥注释后的文本里找固定串（等价 grep -F）。
#   code_has_re：在剥注释后的文本里找正则（等价 grep -E；BRE 也支持，因为走
#                awk ~ 而不是 grep -E）。
# 标记字面量本身可以**跨行**（如 CSS 注释里的「必须显式归零」），所以 MUST_CONTAIN
# 这类「标记是否存在」的断言剥注释后仍然命中——但同一段落的代码被删光、只剩注释
# 时不再命中（这正是我们要的收敛，见 §5(2) 的注释说明）。
uncomment_c() {
  # 注意 inb（块注释态）/ inch（引号态）**必须跨行保持**：JSDoc 头注释是多行 /* */，
  # 若按行重置，第二行起的 `* …` 会被当成活代码（§6 的假红就是这么来的）。
  # 引号态在行尾重置（模板串跨行罕见，宁可少剥也不误剥）。
  awk '
    BEGIN { inb=0 }
    { line=$0; out=""; j=1; n=length(line); inch=""
      while (j<=n) {
        ch=substr(line,j,1); nx=substr(line,j+1,1)
        if (inb) { if (ch=="*" && nx=="/") { inb=0; j+=2; continue } ; j++; continue }
        if (inch) {
          out=out ch
          if (ch=="\\") { out=out nx; j+=2; continue }
          if (ch==inch) inch=""
          j++; continue
        }
        if (ch=="\"" || ch=="'"'"'") { inch=ch; out=out ch; j++; continue }
        if (ch=="/" && nx=="/") break
        if (ch=="/" && nx=="*") { inb=1; j+=2; continue }
        out=out ch; j++
      }
      print out
    }' "$1"
}
uncomment_yaml() {
  awk '
    { line=$0; out=""; j=1; n=length(line); inch=""
      while (j<=n) {
        ch=substr(line,j,1)
        if (inch) { out=out ch; if (ch==inch) inch=""; j++; continue }
        if (ch=="\"" || ch=="'"'"'") { inch=ch; out=out ch; j++; continue }
        if (ch=="#") break
        out=out ch; j++
      }
      print out
    }' "$1"
}
# 文本剥注释（不落盘）——**按扩展名分派**，不能两种都剥：
#   · C 系（ts/tsx/js/jsx/mjs/cjs/mts/cts/css/json）：只剥 // 与 /* */；
#     绝不能碰 `#`（TS 私有字段 `#x`、CSS id 选择器 `#foo`）。
#   · YAML/Shell（yml/yaml/sh）：只剥 `#`；绝不能碰 `/* */`
#     ——YAML 注释里写 `corum/task/*` 会被 C 剥除当成块注释起点，把后面整文件吃掉
#     （2026-09-14 实测：cordis.patch.yml 第 101 行就踩过，§8 全表假红）。
#   · 未知扩展名：两者都剥（保守，用于无后缀的临时夹具）。
uncomment_all() {
  case "$1" in
    *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.mts|*.cts|*.css|*.json|*.map) uncomment_c "$1" ;;
    *.yml|*.yaml|*.sh|*.bash|*.zsh) uncomment_yaml "$1" ;;
    *) uncomment_c "$1" | uncomment_yaml /dev/stdin ;;
  esac
}
code_has() { # code_has <needle> <file>…
  local needle="$1"; shift
  [ "$needle" = "--" ] && { needle="$1"; shift; }  # 兼容调用方写 `code_has -- '<以 -- 开头的标记>'`
  local f
  for f in "$@"; do
    [ -f "$f" ] || continue
    # 用 awk（而非 `grep -q`）收尾：本脚本 set -o pipefail，grep -q 命中即退会
    # 给上游 uncomment_c 发 SIGPIPE（141），管道整体判失败——假 MISS。
    uncomment_all "$f" | awk -v n="$needle" 'index($0,n){found=1} END{exit found?0:1}' && return 0
  done
  return 1
}
code_has_re() { # code_has_re <regex> <file>…（awk 动态正则）
  local re="$1"; shift
  local f
  # ⚠️ 用 ENVIRON 传递正则，**不要用 `awk -v re="$re"`**：-v 会对值做转义处理，
  # `\[`、`\.` 这类被「吃掉」一个反斜杠（实测 `AGENT_DIMENSIONS = \[[^]]*'通用'`
  # 经 -v 变成无转义的 `[`，awk 直接报 nonterminated character class 或永不命中）。
  # ENVIRON 是原样字符串，`~` 用动态正则时才与 grep -E 的写法行为一致。
  for f in "$@"; do
    [ -f "$f" ] || continue
    uncomment_all "$f" | CODE_RE="$re" awk '
      { if ($0 ~ ENVIRON["CODE_RE"]) hit=1 } END { exit hit ? 0 : 1 }' && return 0
  done
  return 1
}
# 在目录树里递归找固定串（等价 grep -rqF），跳过注释。
code_has_r() { # code_has_r <needle> <dir>…
  local needle="$1"; shift
  local d
  for d in "$@"; do
    [ -d "$d" ] || continue
    while IFS= read -r f; do
      # 同上：awk 收尾避免 pipefail 下 grep -q 早退引起的 SIGPIPE 假 MISS。
      uncomment_all "$f" | awk -v n="$needle" 'index($0,n){found=1} END{exit found?0:1}' && return 0
    done < <(find "$d" -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.mts' -o -name '*.cts' -o -name '*.js' -o -name '*.mjs' -o -name '*.cjs' -o -name '*.json' -o -name '*.yml' -o -name '*.yaml' -o -name '*.css' -o -name '*.sh' \) -not -path '*/node_modules/*' 2>/dev/null)
  done
  return 1
}
# ── CLI：快速通道（--only / --fast）────────────────────────────────────────
# 设计要点（改这一段前先读）：
#   • 本段**不做任何校验工作**，只决定「哪些分区要跑」；所有 select_section 为假的分区
#     整块跳过（输出一行「已排除」，不调用 fail/skip，因此不计入 failures/skips）。
#   • 无参数（全量）路径：FAST_LANE=0 且 ONLY_REQUESTED 为空 → select_section 恒真 →
#     section() 输出与跳过分区逻辑完全不介入，行为与加 CLI 之前逐字节一致。
#   • 未知 --only token 必须**响亮失败**（非 0 退出 + 列出合法 token），
#     否则「跑零个分区 + 打印通过」会把 typo 伪装成全绿。
SECTION_TOKENS=(1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 15b 16 16b 17 18)
# --fast 选区（选区理由与警告见文件头注释，两处必须同步）。
FAST_LANE_SECTIONS="8 11 12 13 15b 16b 18"
# --only 选区（空格分隔的 token 串，便于 case 匹配）；空串 = 未启用筛选。
ONLY_SELECTED=" "
FAST_LANE=0

section_token_valid() {
  case " ${SECTION_TOKENS[*]} " in
    *" $1 "*) return 0 ;;
    *) return 1 ;;
  esac
}

# section_is_selected <token> —— 是否应当执行该分区。
# 全量（未启用任何筛选）恒真；--fast 看 FAST_LANE_SECTIONS；--only 看 ONLY_SELECTED。
# 两者同时给时 **--only 优先**（显式选区覆盖预设选区），不会求并集——这一点已写进
# --help，避免「--fast --only 9」被误读成还会跑 --fast 的 6 个分区。
section_is_selected() {
  if [ -n "${ONLY_REQUESTED:-}" ]; then
    case "$ONLY_SELECTED" in
      *" $1 "*) return 0 ;;
      *) return 1 ;;
    esac
  fi
  if [ "$FAST_LANE" = 1 ]; then
    case " $FAST_LANE_SECTIONS " in
      *" $1 "*) return 0 ;;
      *) return 1 ;;
    esac
  fi
  return 0
}

# 未选中的分区：一行提示，计入 section_excluded，但**不**触碰 failures/skips。
# 末尾汇总会把这些计数显式打出来，避免「过滤运行的绿」被读成「全量绿」。
section_excluded=0
excluded_list=""
select_section() {
  if section_is_selected "$1"; then return 0; fi
  section_excluded=$((section_excluded + 1))
  excluded_list="${excluded_list}${1} "
  printf '\n[%s] 已排除（快速通道：非本次选区，未执行、不计入结论）\n' "$1"
  return 1
}

usage() {
  cat <<'USAGE'
用法：
  scripts/verify-fork-drift.sh                        # 全量校验（唯一可用于验收的跑法）
  DSH_CHECKOUT=/path/to/dsh scripts/verify-fork-drift.sh
  scripts/verify-fork-drift.sh --only <token> [...]   # 只跑指定分区（可重复）
  scripts/verify-fork-drift.sh --fast                 # 只跑快速通道选区
  scripts/verify-fork-drift.sh --help                 # 本帮助

选项：
  --only <token>    只运行 token 对应的分区；可重复（--only 8 --only 17）。
                    也支持 --only=8 写法。
  --fast            运行快速通道选区（见下），用于 tight iteration。
                    若同时给了 --only，则以 --only 为准（--fast 被忽略）。
  -h, --help        打印本帮助。

合法分区 token（即分区标题方括号里的标识）：
  [1] [2] [3] [4] [5] [6] [7] [8] [9] [10] [11] [12] [13] [14] [15] [15b] [16] [16b] [17] [18]
  写法：--only 8（选中 [8]）、--only 15b（选中 [15b]）。
  未知 token 会立即以非 0 退出并列出上面的清单（不会静默跑零个分区）。

--fast 选区（6 个分区，全部为秒级 grep/cmp 断言）：
  [8]   客户端插件挂载点覆盖（dsh.client → 挂载行 + desktop 依赖）
  [11]  模型选择单一 owner（corum-agent 用 installTaskModelSelection）
  [12]  GPU 合成默认开启（CORUM_DISABLE_GPU 显式回退）
  [13]  打包闭包版本一致性（pnpm overrides 逐个钉 + pack 时断言）
  [15b] fork #14（corum-fs-local）：edit 定位提示 + 解析面 override
  [16b] fork #16（corum-tools）：errorMessage 归一化 + 解析面 override
  [18]  corum-cdp-verify 技能：打包副本 == 仓库脚本（逐字节）

⚠⚠ 快速通道（--only / --fast）只供开发迭代，不能作为验收依据 ⚠⚠
  未选中的分区会被直接排除：不执行、不计入 failures/skips，输出里逐条标注「已排除」，
  汇总行也会显式声明这是「过滤运行」。
  因此过滤运行的「通过」只代表被选中的那几个分区通过，不等于全量通过。
  最终验收必须运行无参数的全量：
      ./scripts/verify-fork-drift.sh
USAGE
}

ONLY_REQUESTED=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --help|-h)
      usage
      exit 0
      ;;
    --fast)
      FAST_LANE=1
      ;;
    --only)
      if [ "$#" -lt 2 ]; then
        printf '错误：--only 需要一个分区 token（如 --only 8 / --only 15b）\n\n' >&2
        usage >&2
        exit 2
      fi
      token="$2"
      if ! section_token_valid "$token"; then
        printf '错误：未知分区 token「%s」——不会静默跑零个分区。\n' "$token" >&2
        printf '合法 token：%s\n' "${SECTION_TOKENS[*]}" >&2
        printf '（提示：token 是分区标题方括号里的标识，如 --only 8 / --only 15b）\n' >&2
        exit 2
      fi
      ONLY_REQUESTED=1
      case "$ONLY_SELECTED" in
        *" $token "*) : ;;                       # 重复给同一个 token：幂等
        *) ONLY_SELECTED="${ONLY_SELECTED}${token} " ;;
      esac
      shift
      ;;
    --only=*)
      token="${1#--only=}"
      if ! section_token_valid "$token"; then
        printf '错误：未知分区 token「%s」——不会静默跑零个分区。\n' "$token" >&2
        printf '合法 token：%s\n' "${SECTION_TOKENS[*]}" >&2
        printf '（提示：token 是分区标题方括号里的标识，如 --only 8 / --only 15b）\n' >&2
        exit 2
      fi
      ONLY_REQUESTED=1
      case "$ONLY_SELECTED" in
        *" $token "*) : ;;
        *) ONLY_SELECTED="${ONLY_SELECTED}${token} " ;;
      esac
      ;;
    *)
      printf '错误：未知参数「%s」\n\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

# 快速通道启动横幅：过滤运行必须在输出最前面就说清「这不是全量」。
FILTER_ACTIVE=0
if [ -n "$ONLY_REQUESTED" ] || [ "$FAST_LANE" = 1 ]; then
  FILTER_ACTIVE=1
  printf '%s\n' '⚠ 快速通道（过滤运行）：本 run 只执行选区内的分区，不能作为验收依据。'
  if [ -n "$ONLY_REQUESTED" ]; then
    printf '  选区（--only）：%s\n' "$(printf '%s' "$ONLY_SELECTED" | sed 's/^ *//; s/ *$//')"
  fi
  if [ "$FAST_LANE" = 1 ]; then
    printf '  选区（--fast）：%s\n' "$FAST_LANE_SECTIONS"
  fi
  printf '  未选中的分区不执行、不计入 failures/skips；最终验收请跑无参数的全量：\n'
  printf '      ./scripts/verify-fork-drift.sh\n'
fi

# ── 跨分区依赖：前置到分区之外（纯读取，无副作用）──────────────────────────
# [3][4] 依赖 [2] 解析出的 declared；[14] 依赖 [12] 定义的 DESKTOP_MAIN。
# 这两处原本写在各自分区体内，一旦用 --only 3 / --only 14 单跑就会因 set -u 未定义
# 变量而崩；前置后任意选区都能跑，且全量路径的取值/顺序/输出完全不变。
declared=$(uncomment_all "$FORK_API_REMOTES/src/corum-events.ts" | grep -oE "'corum/[a-z/-]+'" | tr -d "'" | sort -u)
DESKTOP_MAIN="$REPO_ROOT/packages/desktop/src/electron/main.ts"

# ── 1. 核心文件逐字节一致（官方检出存在时）─────────────────────────────────
if select_section 1; then
section "[1] @corum/corum-api-remotes 核心文件与官方逐字节一致"
if [ -d "$OFFICIAL_API_REMOTES/src" ]; then
  for f in index.ts types.ts; do
    if [ ! -f "$FORK_API_REMOTES/src/$f" ]; then
      fail "fork 缺文件 src/$f"
    elif [ ! -f "$OFFICIAL_API_REMOTES/src/$f" ]; then
      skip "官方无 src/${f}（官方改名？需人工核对台账）"
    elif cmp -s "$FORK_API_REMOTES/src/$f" "$OFFICIAL_API_REMOTES/src/$f"; then
      pass "src/$f 逐字节一致"
    else
      fail "src/$f 与官方有差异（fork 纪律：核心文件不加增量，增量放 corum-events.ts / remote-events.ts）"
    fi
  done
  # 官方基线版本提示（升级时对照台账 §8/§9）。
  ver=$(python3 -c "import json;print(json.load(open('$OFFICIAL_API_REMOTES/package.json'))['version'])" 2>/dev/null || echo '?')
  printf '  i 官方基线版本：%s\n' "$ver"
else
  skip "官方检出不存在（${OFFICIAL_API_REMOTES}）——跳过逐字节断言"
fi

# ── 2. corum 事件：声明 ↔ 转发 allowlist 双向一致 ──────────────────────────
# ⚠️ 2026-09-14 同型收紧：抽取口径也要剥注释。否则「注释掉一个声明/转发行」
# 既能骗过「声明↔转发」双向一致性（注释行照样被当成声明），又会把文档里举例的
# 事件名（如头部注释 `ctx.remote.$on('corum/...', cb)`）混进事件表。
fi  # ← select_section 1
if select_section 2; then
section "[2] corum 事件：声明（corum-events.ts）↔ 转发（remote-events.ts）"
forwarded=$(uncomment_all "$FORK_API_REMOTES/src/remote-events.ts" | grep -oE "event: 'corum/[a-z/-]+'" | sed "s/event: //; s/'//g" | sort -u)

if [ -z "$declared" ]; then
  fail "corum-events.ts 未解析到任何 corum 事件（正则失配？）"
else
  pass "声明 $(printf '%s\n' "$declared" | wc -l | tr -d ' ') 个事件"
fi

missing_forward=$(comm -23 <(printf '%s\n' "$declared") <(printf '%s\n' "$forwarded"))
if [ -n "$missing_forward" ]; then
  fail "已声明但未转发（renderer 收不到）：$(printf '%s ' $missing_forward)"
else
  pass "每个声明事件都有转发条目"
fi

dead_forward=$(comm -13 <(printf '%s\n' "$declared") <(printf '%s\n' "$forwarded"))
if [ -n "$dead_forward" ]; then
  fail "allowlist 里的死事件（无声明）：$(printf '%s ' $dead_forward)"
else
  pass "allowlist 无死事件"
fi

# ── 3. 领域事件（events.ts）↔ 转发声明名字对齐 ──────────────────────────────
#
# 2026-09-26 项目模式剥离：`events.ts`（领域事件声明）已迁到闭源仓
# `@corum/corum-project`；本节的取样面随之改成 **闭源仓优先、开源仓兜底**
# ——这样本脚本对「剥离前后」都保持同一判据（不认识事件的仓 → 照旧 skip）。
fi  # ← select_section 2
if select_section 3; then
section "[3] 领域事件（events.ts）↔ corum-events.ts 名字对齐"
DOMAIN_EVENTS_SRC=""
if [ -f "$CLOSED_PROJECT_SRC/events.ts" ]; then
  DOMAIN_EVENTS_SRC="$CLOSED_PROJECT_SRC/events.ts"
  DOMAIN_EVENTS_OWNER="闭源仓 corum-project"
elif [ -f "$AGENT_EVENTS" ]; then
  DOMAIN_EVENTS_SRC="$AGENT_EVENTS"
  DOMAIN_EVENTS_OWNER="开源仓 corum-agent"
fi
if [ -n "$DOMAIN_EVENTS_SRC" ]; then
  domain=$(uncomment_all "$DOMAIN_EVENTS_SRC" | grep -oE "'corum/(task|group)/[a-z-]+'" | tr -d "'" | sort -u)
  if [ -z "$domain" ]; then
    fail "$DOMAIN_EVENTS_SRC 未解析到 corum/task|group 事件（正则失配？）"
  else
    domain_missing=$(comm -23 <(printf '%s\n' "$domain") <(printf '%s\n' "$declared"))
    if [ -n "$domain_missing" ]; then
      fail "领域事件未在 corum-events.ts 声明：$(printf '%s ' $domain_missing)"
    else
      pass "领域事件全部有转发声明（$(printf '%s\n' "$domain" | wc -l | tr -d ' ') 个；事实源=${DOMAIN_EVENTS_OWNER}）"
    fi
  fi
else
  skip "找不到领域事件声明（既无 ${CLOSED_PROJECT_SRC}/events.ts 也无 ${AGENT_EVENTS}）"
fi

# ── 4. 宿主 emit 面 ↔ 声明（防「声明了但 host 从不 emit」）──────────────────
fi  # ← select_section 3
if select_section 4; then
# ⚠️ 2026-09-14 P0 同型审计：本节的「归属判定」原先用 grep -rqF，注释里出现
# `'corum/xxx'`（例如 fork 包把头部的「拉入 corum 领域事件声明」说明写成带引号的
# 事件名，或某文件只有一行注释提到该事件）也会算命中。更糟的是 —— 事件名既出现在
# 真 emit 行，也出现在**循环里的类型注解 / 事件表字面量**中（如 events.ts 的
# `'corum/task/assigned'(data): void`），两者都算「源码里有字面量」，判定本质上
# 只证明「有人写了这个名字」。故本节一并收紧为：
#   ① 剥注释（uncomment_all）；② 事件名必须出现在 **host 半的 src**（旧口径会把
#   `lib/` 构建产物、测试夹具、client 半的 $on 监听也算成 host emit）。
# 这仍然只是必要条件（名字在 host 源码出现），不是充分条件——真正的语义断言在
# corum-api-remotes 的 host spec 里（多路转发/丢弃/降级）。守卫只挡「注释假命中」。
section "[4] host emit 面：声明的事件是否真有人 emit"
for ev in $declared; do
  case "$ev" in
    corum/task/*|corum/group/*)
      # 领域事件由 AgentRuntime.record 统一 emit（事件名以字符串字面量出现）。
      # 2026-09-26 项目模式剥离：emit 点（events.ts / runtime.ts / project-service.ts）
      # 随项目模式迁到闭源仓 `@corum/corum-project` ⇒ 取样面改为**闭源仓优先**。
      # 闭源仓不在场时报 **skip 并说明原因**——不是静默放过：静默会把「闭源侧没
      # emit」这种真故障变成看不见，而 skip 会计入 skips 计数、在结尾摘要里显式出现。
      if [ -d "$CLOSED_PROJECT_SRC" ]; then
        code_has_r "'$ev'" "$CLOSED_PROJECT_SRC" \
          && pass "${ev}：闭源仓 corum-project 有 emit" \
          || fail "${ev}：闭源仓 corum-project 源码中无 emit 字面量（注释不算）"
      else
        skip "${ev}：需闭源仓检出（未找到 ${CLOSED_PROJECT_SRC}）—— 该事件的 emit 点已随项目模式迁出"
      fi
      ;;
    corum/terminal/output)
      code_has "'$ev'" "$REPO_ROOT/packages/desktop/src/host/corum-terminal.ts" \
        && pass "${ev}：host corum-terminal 有 emit" \
        || fail "${ev}：corum-terminal.ts 无 emit（注释不算）"
      ;;
    corum/file/changed)
      code_has "'$ev'" "$REPO_ROOT/packages/desktop/src/host/corum-fs.ts" \
        && pass "${ev}：host corum-fs 有 emit" \
        || fail "${ev}：corum-fs.ts 无 emit（注释不算）"
      ;;
    corum/subagent/progress)
      code_has_r "'$ev'" "$REPO_ROOT/packages/plugins/agent/corum-agent/src" \
        && pass "${ev}：corum-agent 有 emit" \
        || fail "${ev}：corum-agent 无 emit（注释不算）"
      ;;
    corum/subagent/child)
      # spawn 精确父子映射（2026-09-09）：emit 在 fork #10 工具包的 corumEmitChildStarted。
      code_has_r "'$ev'" "$REPO_ROOT/packages/plugins/agent/corum-tool-subagent/src" \
        && pass "${ev}：corum-tool-subagent 有 emit" \
        || fail "${ev}：corum-tool-subagent 无 emit（注释不算）"
      ;;
    corum/worktree-ledger)
      code_has_r "'$ev'" "$REPO_ROOT/packages/plugins/agent/corum-orchestration/src" \
        && pass "${ev}：corum-orchestration 有 emit" \
        || fail "${ev}：corum-orchestration 无 emit（注释不算）"
      ;;
    corum/subagent/interrupted)
      # 「半途失去运行」在**发现点**（读进度 RPC 时判出）补发的一次性广播（2026-09-13）。
      code_has_r "'$ev'" "$REPO_ROOT/packages/plugins/agent/corum-agent/src" \
        && pass "${ev}：corum-agent 有 emit" \
        || fail "${ev}：corum-agent 无 emit（注释不算）"
      ;;
    corum/artgen/*)
      code_has_r "'$ev'" "$REPO_ROOT/packages/plugins/agent/corum-artgen/src" \
        && pass "${ev}：corum-artgen 有 emit" \
        || fail "${ev}：corum-artgen 无 emit（注释不算）"
      ;;
    corum/ollama/*)
      code_has_r "'$ev'" "$REPO_ROOT/packages/plugins/agent/corum-ollama/src" \
        && pass "${ev}：corum-ollama 有 emit" \
        || fail "${ev}：corum-ollama 无 emit（注释不算）"
      ;;
    corum/model-ask/request)
      # 机制级模型询问（waterfall，不是 emit）：发起点是委派工具的失败收尾。
      # 归 corum-tool-subagent——它 `ctx.waterfall` 该事件，client 插件
      # @corum/corum-ui-model-ask 应答。刻意不走 userQuestions（见 model-ask.ts 头注释）。
      code_has_r "'$ev'" "$REPO_ROOT/packages/plugins/agent/corum-tool-subagent/src" \
        && pass "${ev}：corum-tool-subagent 有 waterfall 发起" \
        || fail "${ev}：corum-tool-subagent 无发起（注释不算）"
      ;;
    *)
      skip "${ev}：无 emit 面映射（新增事件请在脚本里登记归属）"
      ;;
  esac
done

# ── 5. fork 定制面不得被官方整文件覆盖（静默还原检测）──────────────────────
# 背景：2026-09-07 的 0.1.3 合并（commit f09aa05b）把
# corum-ui-chat/chat/TurnNavigator.module.css 整文件拷成官方版，把「左 gutter
# 8×8 圆点刻度」（设计稿 vESwF）静默还原成官方右侧横线刻度——typecheck/build
# 全绿、console 零错误，直到 2026-09-09 用户看 UI 才发现。
# 纪律：官方文件里凡带 corum 定制，合并时只能逐处三方合并，禁止整文件覆盖。
# 本节把这条纪律变成可执行断言；新增 fork 定制面时把文件登记进下面两张表。
fi  # ← select_section 4
if select_section 5; then
section "[5] fork 定制面：不得与官方逐字节一致（静默覆盖检测）"

# (1) 必须与官方「有差异」的定制文件。格式：corum 相对路径::官方相对路径
MUST_DIFFER=(
  "packages/plugins/session/corum-ui-chat/src/client/chat/TurnNavigator.module.css::packages/client/ui-chat/src/client/chat/TurnNavigator.module.css"
  "packages/plugins/session/corum-ui-chat/src/client/chat/MessageItem.tsx::packages/client/ui-chat/src/client/chat/MessageItem.tsx"
  "packages/plugins/session/corum-ui-chat/src/client/chat/TurnTailNodeView.tsx::packages/client/ui-chat/src/client/chat/TurnTailNodeView.tsx"
  "packages/plugins/session/corum-ui-chat/src/client/chat/ChatNodeSeat.tsx::packages/client/ui-chat/src/client/chat/ChatNodeSeat.tsx"
  "packages/plugins/session/corum-ui-conversation/src/client/skeleton/InputBar.tsx::packages/client/ui-conversation/src/client/skeleton/InputBar.tsx"
  "packages/plugins/session/corum-ui-conversation/src/client/skeleton/ConversationRoot.tsx::packages/client/ui-conversation/src/client/skeleton/ConversationRoot.tsx"
  "packages/plugins/session/corum-ui-conversation/src/client/apply.ts::packages/client/ui-conversation/src/client/apply.ts"
  "packages/plugins/session/corum-ui-approval/src/client/ApprovalPanel.tsx::packages/client/ui-approval/src/client/ApprovalPanel.tsx"
)
for entry in "${MUST_DIFFER[@]}"; do
  corum_rel="${entry%%::*}"
  off_rel="${entry##*::}"
  if [ ! -f "$REPO_ROOT/$corum_rel" ]; then
    fail "${corum_rel} 不存在（台账登记了定制，文件却没了）"
  elif [ ! -f "$DSH_CHECKOUT/$off_rel" ]; then
    skip "${corum_rel}：官方检出缺 ${off_rel}（官方改名？需人工核对台账）"
  elif cmp -s "$REPO_ROOT/$corum_rel" "$DSH_CHECKOUT/$off_rel"; then
    fail "${corum_rel} 与官方逐字节一致——corum 定制疑似被官方整文件覆盖（还原成原生了）"
  else
    pass "${corum_rel} 保留 corum 定制（与官方有差异）"
  fi
done

# (2) 必须含定制实现标记的文件（比 (1) 更强：防止只留注释、实现被覆盖）。
#     格式：相对路径::标记字面量[::可选「必须同时活着」的活代码标记]
#
# ⚠️ 2026-09-14：本节原先用 grep -F 全文件匹配，**注释里的标记也算命中**——把实现
# 换成官方版、只留一句「此处曾有 X」的注释就能骗过守卫。现在按「剥注释后仍命中」
# 判定（code_has），语义收敛为「标记必须落在活的代码/样式行上」。
# 有一个标记**天生就在注释里**（"必须显式归零" 是解释「为什么 .tbtn 必须 padding:0」
# 的中文说明），剥注释会把它连说明一起消掉。这类条目用第三段 `::<活代码标记>`
# 改判：说明文字在**原文**里必须在（保留解释力），`<活代码标记>` 在**剥注释后**必须
# 仍在（实现没被换掉）。只留注释、实现被删 => 判红；注释和实现都被删 => 判红。
MUST_CONTAIN=(
  "packages/plugins/session/corum-ui-chat/src/client/chat/TurnNavigator.module.css::left: calc(12px - (var(--dsh-composer-side-clearance) + 16px))"
  "packages/plugins/session/corum-ui-chat/src/client/chat/TurnNavigator.module.css::border-radius: 50%;"
  "packages/plugins/session/corum-ui-chat/src/client/chat/TurnNavigator.module.css::background: var(--dsw-alias-brand-primary);"
  "packages/plugins/session/corum-ui-chat/src/client/chat/TurnNavigator.module.css::left: calc(100% + 10px);"
  # 设计稿 tbtn-voice：2026-09-09 曾被 commit 523e7aca 整块换成官方 <ContextMeter/>（用户报障）。
  "packages/plugins/session/corum-ui-conversation/src/client/skeleton/InputBar.tsx::aria-label=\"语音输入\""
  # .tbtn 必须显式 padding: 0（否则吃 UA 的 button padding 1px 6px，26 宽剩 14px，图标被压扁）。
  # 标记在 CSS 注释里 => 追加活代码标记 `padding: 0;`（剥注释后必须仍在）。
  "packages/plugins/session/corum-ui-conversation/src/client/skeleton/InputBar.module.css::必须显式归零::padding: 0;"
  # 提示词润色唯一入口 = 输入区右上角 sparkle（2026-09-09 去重：toolbar 里那个 Wand2 已删）。
  "packages/plugins/session/corum-ui-conversation/src/client/skeleton/InputBar.tsx::polishDraft"
  "packages/plugins/session/corum-ui-conversation/src/client/contract/slots.ts::polishDraft?: (sessionId: string, text: string) => Promise<string>"
)
for entry in "${MUST_CONTAIN[@]}"; do
  corum_rel="${entry%%::*}"
  rest="${entry#*::}"
  marker="${rest%%::*}"
  live_marker=''
  [ "$rest" != "$marker" ] && live_marker="${rest##*::}"
  if [ ! -f "$REPO_ROOT/$corum_rel" ]; then
    fail "${corum_rel} 不存在（标记检查：${marker}）"
  elif [ -z "$live_marker" ]; then
    # 普通条目：标记本身必须落在**剥注释后的活代码**上。
    if code_has "$marker" "$REPO_ROOT/$corum_rel"; then
      pass "$(basename "$corum_rel") 含定制标记：${marker}"
    else
      fail "$(basename "$corum_rel") 缺定制标记「${marker}」——定制被覆盖或写法被改写（注释里提到不算）"
    fi
  elif grep -qF -- "$marker" "$REPO_ROOT/$corum_rel" && code_has "$live_marker" "$REPO_ROOT/$corum_rel"; then
    # 注释型标记条目：说明文字按原文判 + 配套活代码按剥注释后判（两者都要在）。
    pass "$(basename "$corum_rel") 含定制标记：${marker}（活代码：${live_marker}）"
  else
    fail "$(basename "$corum_rel") 缺定制标记「${marker}」或配套活代码「${live_marker}」——定制被覆盖或写法被改写"
  fi
done

# ── 6. inline-css 标记卫生（防「样式注入到错误标签 / 静默跳过注入」）────────
# 背景：corum-ide-plugin-manager-ui 的 scripts/inline-css.mjs 是从 explorer 包
# 拷贝的——id 写死成 `@corum/corum-ide-explorer-ui`，幂等判定用泛
# `client.includes('data-plugin')`；而该包源码里有 `data-plugin-manager-overlay`
# 属性，于是每次构建都误判「已注入」并删掉 lib/style.css → 插件中心面板长期
# 无样式（position:static、无圆角无底色），2026-09-09 CDP 实测才发现。
# 断言：① 禁用泛 'data-plugin' 判定；② 写死的 id 必须等于本包名（推荐从
# package.json 读，见 corum-ui-conversation / corum-ui-trajectory 的写法）。
fi  # ← select_section 5
if select_section 6; then
section "[6] inline-css 标记卫生（id 归属 + 幂等判定）"
while IFS= read -r script; do
  pkg_dir="$(dirname "$(dirname "$script")")"
  pkg_name=$(node -e "try{console.log(require('$pkg_dir/package.json').name)}catch(e){console.log('?')}" 2>/dev/null)
  # 只看代码行：注释里出现该字符串（说明为什么禁止）不算违规。
  # ⚠️ 2026-09-14 收紧：原判定用 `grep -n … | grep -vE '^[0-9]+:[[:space:]]*(\*|//)'`，
  # 只挡「行首是 * 或 //」的整行注释——行尾注释、`/* */` 块注释体内的行都漏。
  # 现在按「剥注释后是否仍命中」判定（code_has），并把命中行打印出来备查。
  bad_line=$(uncomment_all "$script" | awk '/includes\(.data-plugin.\)/{print NR": "$0; exit}')
  if [ -n "$bad_line" ]; then
    fail "$(echo "$script" | sed "s|$REPO_ROOT/||") 用泛 'data-plugin' 做幂等判定（业务源码含该字符串会误判，导致跳过注入）：${bad_line}"
  fi
  hardcoded=$(grep -oE 'data-plugin="@[^"]*"' "$script" | head -1 | sed 's/data-plugin="//; s/"//')
  if [ -n "$hardcoded" ] && [ "$hardcoded" != "$pkg_name" ]; then
    fail "$(echo "$script" | sed "s|$REPO_ROOT/||") 写死的 id「${hardcoded}」≠ 本包名「${pkg_name}」（样式会注入到别人的标签下）"
  elif [ -n "$hardcoded" ]; then
    pass "$(basename "$pkg_dir") inline-css id 与包名一致"
  else
    pass "$(basename "$pkg_dir") inline-css 从 package.json 读 id"
  fi
done < <(find "$REPO_ROOT/packages" -path '*/scripts/inline-css.mjs' -not -path '*/node_modules/*' | sort)

# ── 7. 只写标准 backdrop-filter（-webkit- 别名在 Chromium 150 已被移除）────
# 背景：源码同时写两条时构建压缩只保留后一条（惯例是 -webkit- 在后），而
# Electron 43 / Chromium 150 的 CSS.supports('-webkit-backdrop-filter') === false
# → 全仓「液态玻璃」模糊静默失效（2026-09-09 清理 42 处后加此断言）。
fi  # ← select_section 6
if select_section 7; then
section "[7] corum CSS 不含 -webkit-backdrop-filter 声明"
wb_hits=$(grep -rn --include='*.css' -e '^[[:space:]]*-webkit-backdrop-filter' \
  "$REPO_ROOT/packages/plugins" "$REPO_ROOT/packages/desktop/src" 2>/dev/null \
  | grep -v '/node_modules/' | grep -v '/lib/' | grep -v '/build/' | grep -v '/dist/')
if [ -n "$wb_hits" ]; then
  printf '%s\n' "$wb_hits" | while IFS= read -r line; do
    fail "含 -webkit-backdrop-filter 声明：$(echo "$line" | sed "s|$REPO_ROOT/||")"
  done
  failures=$((failures + $(printf '%s\n' "$wb_hits" | wc -l | tr -d ' ')))
else
  pass "源码 CSS 无 -webkit-backdrop-filter 声明（Chromium 150 已不支持该别名）"
fi

# ── 8. 客户端插件必须挂在某个组合里（防「挂载只存在于未提交的工作树」）──────
# 背景：@corum/corum-ollama / @corum/corum-artgen 的挂载（cordis.patch.yml 的
# insert 行 + desktop package.json 依赖）当时只写在**未提交的工作树**里，0.1.3
# 基座升级期间工作树被重置 → 两个插件的设置页一起消失（2026-09-09 用户报障）。
# 断言：凡带 dsh.client 的包，必须①出现在某个挂载点，②是 desktop 的 workspace
# 依赖（否则 host 解析不到包）。有意不挂的包登记在 ALLOW_UNMOUNTED 并写清原因。
fi  # ← select_section 7
if select_section 8; then
#
# ⚠️ 2026-09-14 P0：本节的挂载判定**必须只看真实结构行**。原先用
# `grep -qF "$pkg_name" <挂载文件>` —— 注释行也算命中，于是
# @corum/corum-ide-explorer-ui / @corum/corum-ide-statusbar-ui（当时唯一命中
# 全是 YAML 注释，行本身被注释掉了）被打印成「✓ 已挂载」，守卫给未挂载的包发绿灯。
# 现在改为两段式：先剥掉注释（uncomment_all），再要求命中**挂载行正则**
# （`name: '<包名>'` 的引号/裸写法，或 combos.ts 的 `plugins: [...]` 数组元素），
# 并在打印 ✓ 时回显命中的**行号**（便于复核「命中的到底是哪一行」）。
section "[8] 客户端插件挂载点覆盖（dsh.client → 挂载行 + desktop 依赖）"
MOUNT_FILES=(
  "$REPO_ROOT/packages/desktop/cordis.patch.yml"
  "$REPO_ROOT/packages/desktop/cordis.ide.patch.yml"
  "$REPO_ROOT/cordis.patch.yml"
  "$REPO_ROOT/packages/desktop/src/electron/combos.ts"
)
# 每个挂载行只认两种真实结构：patch yml 的 `name: '<包名>'`（引号可省），
# 或 combos.ts 的插件数组元素 `'<包名>'`。注释剥除后仍逐行匹配 + 返回行号。
mount_line_in() { # mount_line_in <pkg> <file> → stdout: "<lineno>:<text>"，未命中 exit 1
  local pkg="$1" file="$2"
  uncomment_all "$file" | awk -v pkg="$pkg" -v q="'" '
    {
      t=$0; sub(/^[[:space:]]+/, "", t)
      if (t ~ /^-?[[:space:]]*name:/) {
        if (index(t, q pkg q) > 0 || t ~ ("name:[[:space:]]*" pkg "[[:space:]]*$")) { print NR ":" t; exit }
      }
      if (index(t, q pkg q) > 0 && t ~ /plugins:/) { print NR ":" t; exit }
    }'
}
# 每个包名一条 ALLOW 条目：`<包名>|<分类>|<原因>`
#   <分类> = test   ：测试/占位插件，仅在开发期按需手工挂载
#   <分类> = retired：功能已被其它机制取代，行有意注释保留（附取代者）
#   <分类> = reserved：预留包，尚未接线，行有意注释保留
# 分类只影响打印文案；**不在清单里的包仍然判红**（fail，退出码非 0）。
# ⚠️ 「忘了挂」与「有意不挂」的唯一区别就是本清单：没登记 = 忘了 = 红。
ALLOW_UNMOUNTED=(
  "@corum/corum-ide-test-conversation-ui|test|测试插件：仅按需手工挂载"
  "@corum/corum-ide-test-sidebar-ui|test|测试插件：仅按需手工挂载"
  "@corum/corum-ide-test-statusbar-ui|test|测试插件：仅按需手工挂载"
  "@corum/corum-ide-explorer-ui|retired|功能已并入 corum-desktop 编辑器合并卡的资源管理器子面板（原独立区域形态，见 cordis.ide.patch.yml 该行注释）；行有意保持注释"
  "@corum/corum-ide-statusbar-ui|retired|corum.statusBar 槽已随状态栏整体从 ide-shell 移除（无声明者=无处可挂）；代码留作备查，恢复状态栏时重新挂载（见 cordis.ide.patch.yml 该行注释）"
)
desktop_deps=$(node -e "console.log(Object.keys(require('$REPO_ROOT/packages/desktop/package.json').dependencies||{}).join('\n'))" 2>/dev/null)
for pkg_json in "$REPO_ROOT"/packages/plugins/*/*/package.json; do
  [ -f "$pkg_json" ] || continue
  pkg_name=$(node -e "try{const p=require('$pkg_json');console.log(p.dsh&&p.dsh.client?p.name:'')}catch(e){console.log('')}" 2>/dev/null)
  [ -z "$pkg_name" ] && continue
  allowed=''
  for a in "${ALLOW_UNMOUNTED[@]}"; do [ "$pkg_name" = "${a%%|*}" ] && allowed="$a"; done
  if [ -n "$allowed" ]; then
    skip "${pkg_name} 有意不挂载（$(echo "$allowed" | cut -d'|' -f2)：$(echo "$allowed" | cut -d'|' -f3)）"
    continue
  fi
  mount_hit=''
  mount_ln=''
  for f in "${MOUNT_FILES[@]}"; do
    [ -f "$f" ] || continue
    hit=$(mount_line_in "$pkg_name" "$f") || true
    if [ -n "$hit" ]; then mount_hit="$f"; mount_ln="${hit%%:*}"; break; fi
  done
  if [ -z "$mount_hit" ]; then
    fail "${pkg_name} 有 dsh.client 但没有任何挂载点（注释/文档里提到不算）——插件不会加载（设置页/功能整体消失）；若确为有意不挂载，请登记进本节 ALLOW_UNMOUNTED 并写清原因"
    continue
  fi
  if printf '%s\n' "$desktop_deps" | grep -qxF "$pkg_name"; then
    pass "${pkg_name} 已挂载（$(basename "$mount_hit"):${mount_ln}）+ desktop 依赖"
  else
    fail "${pkg_name} 挂在 $(basename "$mount_hit"):${mount_ln} 但不在 packages/desktop/package.json 依赖里——host 解析不到包（pnpm install 后仍 404）"
  fi
done

# ── 9. corumAgent 契约方法 ↔ 宿主 @Remote 实现（防「声明了但没实现」）────────
# 背景：AI 润色的 5 个方法（getPolishConfig/setPolishConfig/polishPrompt/
# polishConversation/translatePrompt）契约、配置存储、客户端按钮都在，宿主端
# 实现在基座升级重置未提交工作树时丢失 → 点按钮 404（2026-09-09，PROGRESS 第 50/51 轮）。
# 断言：contract/agent.ts 的 CORUM_AGENT_METHODS 里每个方法，agent-service.ts 必须有
# 对应的 `@Remote('<method>')`。
fi  # ← select_section 8
if select_section 9; then
# ⚠️ 2026-09-14：`@Remote('x')` 命中改为剥注释后判定（code_has）——注释里写一句
# 「corumAgent/x 的宿主实现见 …」不该被当成本节要的证据（同型审计）。
section "[9] corumAgent 契约方法 ↔ 宿主 @Remote 实现"
if [ ! -f "$AGENT_CONTRACT" ] || [ ! -f "$AGENT_SERVICE" ]; then
  skip "找不到 contract/agent.ts 或 agent-service.ts"
else
  methods=$(uncomment_all "$AGENT_CONTRACT" | grep -oE "^  [a-zA-Z]+: '[a-zA-Z]+'," | sed "s/.*: '//; s/',//" | sort -u)
  if [ -z "$methods" ]; then
    fail "contract/agent.ts 未解析到 CORUM_AGENT_METHODS（正则失配？）"
  else
    for method in $methods; do
      if code_has "@Remote('$method')" "$AGENT_SERVICE"; then
        pass "corumAgent/$method 有宿主实现"
      else
        fail "corumAgent/$method 在契约里声明了，但 agent-service.ts 没有 @Remote 实现（调用必 404；注释里提到不算）"
      fi
    done
  fi
fi

# ── 10. 目录型 provider 的 discoverModels 兜底（防「换个入口又弹 NO_DISCOVERY」）──
# 背景：官方 llm-deepseek 不注册 model discovery，discoverModels 必抛 NO_DISCOVERY；
# corum 模型页把它当硬错误显示 → 正式包「添加 DeepSeek 供应商」直接失败（2026-09-09，
# PROGRESS 第 56 轮）。修复抽成 catalog-fallback.ts，但**四处调用点**必须都接兜底——
# 只修用户报的那一处，下次换入口（添加模型/连通性测试）还会撞。
# 断言：client 下每个调用 discoverModels 的文件都必须 import 兜底模块。
fi  # ← select_section 9
if select_section 10; then
section "[10] 目录型 provider 的 discoverModels 兜底（catalog-fallback）"
MODELS_CLIENT="$REPO_ROOT/packages/plugins/session/corum-ui-settings-models/src/client"
if [ ! -d "$MODELS_CLIENT" ]; then
  skip "找不到 corum-ui-settings-models/src/client"
elif [ ! -f "$MODELS_CLIENT/catalog-fallback.ts" ]; then
  fail "缺少 catalog-fallback.ts（目录型 provider 的 NO_DISCOVERY 兜底单一事实源）"
else
  # ⚠️ 调用点枚举也剥注释：某文件只在注释里写着 `discoverModels(` 不算调用点，
  # 否则会要求一个根本没调用它的文件「必须 import 兜底」，制造假红。
  call_sites=$(for _f in "$MODELS_CLIENT"/*.ts "$MODELS_CLIENT"/*.tsx; do
    [ -f "$_f" ] || continue
    [ "$(basename "$_f")" = 'catalog-fallback.ts' ] && continue
    code_has 'discoverModels(' "$_f" && printf '%s\n' "$_f"
  done)
  if [ -z "$call_sites" ]; then
    fail "未找到任何 discoverModels 调用点（正则失配？）"
  else
    while IFS= read -r file; do
      [ -n "$file" ] || continue
      if code_has "from './catalog-fallback.ts'" "$file"; then
        pass "$(basename "$file") 接了 catalog 兜底"
      else
        fail "$(basename "$file") 调 discoverModels 但没接 catalog 兜底——NO_DISCOVERY 会当错误弹给用户（注释里 import 不算）"
      fi
    done <<< "$call_sites"
  fi
fi

# ── 11. 模型选择单一 owner（防「用户换模型被吞」回归）──────────────────────
# 背景：官方 installModelSelection 的 agent/request 监听用安装时的选择覆盖结果，且
# waterfall 先注册的是外层——corum 在 create setup 里装自己的 ref 会让官方
# session/selectModel 永远失效（2026-09-09 用户实测，PROGRESS 第 57 轮）。
# 断言：agent-service.ts 只用 corum 的 installTaskModelSelection，不得再出现官方
# 包里的 installModelSelection 调用。
fi  # ← select_section 10
if select_section 11; then
section "[11] 模型选择单一 owner（corum-agent 用 installTaskModelSelection）"
if [ ! -f "$AGENT_SERVICE" ]; then
  skip "找不到 agent-service.ts"
else
  if code_has "installTaskModelSelection(" "$AGENT_SERVICE"; then
    pass "agent-service.ts 使用 installTaskModelSelection"
  else
    fail "agent-service.ts 未使用 installTaskModelSelection——模型选择会退回被官方 ref 覆盖的老毛病"
  fi
  if code_has_re "^import \{[^}]*installModelSelection[^}]*\} from '@deepseek-ai/dsh-agent'" "$AGENT_SERVICE"; then
    fail "agent-service.ts 仍导入官方 installModelSelection（同一机制两个 owner，用户换模型会被吞）"
  else
    pass "未导入官方 installModelSelection"
  fi
fi

# ── 12. GPU 合成不得被无条件关闭（防「设置页卡成 7 FPS」回归）──────────────
# 背景：main.ts 曾无条件 appendSwitch('disable-gpu')，而 corum 的玻璃皮肤到处是
# backdrop-filter：设置面板打开时整屏 mask blur(8px) + 面板 blur(16px) 每帧重算，
# 串流对话下实测从 44 FPS 掉到 7 FPS（2026-09-09 用户报障，PROGRESS 第 58 轮）。
# 断言：禁用 GPU 必须走 CORUM_DISABLE_GPU 显式开关（默认开启 GPU）。
fi  # ← select_section 11
if select_section 12; then
section "[12] GPU 合成默认开启（CORUM_DISABLE_GPU 显式回退）"
# DESKTOP_MAIN 已在分区之外统一定义（[14] 也用它，见文件头「跨分区依赖」）。
if [ ! -f "$DESKTOP_MAIN" ]; then
  skip "找不到 packages/desktop/src/electron/main.ts"
else
  if code_has_re "^  app\.commandLine\.appendSwitch\('disable-gpu'\)" "$DESKTOP_MAIN"; then
    fail "main.ts 仍无条件 appendSwitch('disable-gpu')——玻璃 UI 会退回软件光栅，设置页打开即掉帧"
  else
    pass "未无条件禁用 GPU"
  fi
  if code_has "CORUM_DISABLE_GPU" "$DESKTOP_MAIN"; then
    pass "保留 CORUM_DISABLE_GPU 显式回退开关"
  else
    fail "缺少 CORUM_DISABLE_GPU 回退开关（需要软件渲染时无路可走）"
  fi
fi

# ── 13. 打包闭包版本一致性（防「混版闭包」回归）────────────────────────────
# 背景：pnpm deploy --legacy 忽略 lockfile 重新解析，`^0.1.3-alpha.1` 漂到 registry 上的
# alpha.2 → 正式包闭包 131 个 dsh 包是 alpha.2、session 核心是 alpha.1，冷读历史日志报
# 「events is not iterable」（2026-09-09，PROGRESS 第 58 轮）。修复：pnpm-workspace.yaml
# 逐个钉死（pnpm 11 的 override 不支持 glob，实测通配无效）+ pack 时硬断言。
fi  # ← select_section 12
if select_section 13; then
section "[13] 打包闭包版本一致性（pnpm overrides 逐个钉 + pack 时断言）"
WORKSPACE_YAML="$REPO_ROOT/pnpm-workspace.yaml"
PACK_SCRIPT="$REPO_ROOT/packages/desktop/scripts/pack-macos.mjs"
if [ ! -f "$WORKSPACE_YAML" ]; then
  skip "找不到 pnpm-workspace.yaml"
else
  if code_has "'@deepseek-ai/dsh-*'" "$WORKSPACE_YAML"; then
    fail "pnpm-workspace.yaml 里用了 glob override '@deepseek-ai/dsh-*'——pnpm 11 不支持，实测无效（会静默漂版）"
  else
    pass "overrides 未使用无效的 glob 写法"
  fi
  # 计数口径：注释掉的 override 行不算（否则删光真行、只留注释也能过 ≥150 门槛）。
  # 2026-09-29 升级 0.1.5-rc.3：目标版本随升级推进（此前是 0.1.3-alpha.1）。
  # 判据 = 「每个 dsh 包都被逐个钉到当前目标版本」，门槛 150 是覆盖面下限。
  pinned=$(uncomment_all "$WORKSPACE_YAML" | grep -cE "^  '@deepseek-ai/dsh-[^']*': '0\\.1\\.5-rc\\.3'$")
  if [ "$pinned" -ge 150 ]; then
    pass "逐个钉定 $pinned 个 dsh 包到 0.1.5-rc.3"
  else
    fail "只钉了 $pinned 个 dsh 包（预期 ≥150）——deploy 会重新解析出其它版本"
  fi
fi
if [ -f "$PACK_SCRIPT" ] && code_has "assertUniformDshVersions" "$PACK_SCRIPT"; then
  pass "pack-macos.mjs 含闭包版本一致性硬断言"
else
  fail "pack-macos.mjs 缺少闭包版本一致性断言（混版闭包会静默打进 .app）"
fi

# ── 14. host 子进程不得变成孤儿（防「模型选择失败 / 历史打不开」回归）──────────
# 背景：before-quit 只 app.exit(0) 不杀子进程，子进程 stdin EOF 后又被 webserver
# 句柄吊着 → 每次退出留一个孤儿 host，攥着 session.lock；下一代启动读不到那些会话
# （2026-09-09 用户报「模型选择失败」，PROGRESS 第 60 轮）。三条断言：父进程退出杀
# 子进程、子进程 stdin EOF 自杀、启动时回收上一代孤儿。
fi  # ← select_section 13
if select_section 14; then
section "[14] host 子进程生命周期（防孤儿）"
BRIDGE_SRC="$REPO_ROOT/packages/desktop/src/host/bridge.ts"
if [ ! -f "$BRIDGE_SRC" ]; then
  skip "找不到 packages/desktop/src/host/bridge.ts"
else
  if code_has "parent gone (stdin EOF)" "$BRIDGE_SRC"; then
    pass "bridge.ts 在父进程 stdin EOF 时主动退出"
  else
    fail "bridge.ts 缺 stdin EOF 自杀路径——父进程崩溃/被强杀时会留下孤儿 host"
  fi
  if code_has "reapStaleHost" "$BRIDGE_SRC"; then
    pass "bridge.ts 启动时回收上一代孤儿 host"
  else
    fail "bridge.ts 缺 reapStaleHost——老版本留下的孤儿会一直攥着 session.lock"
  fi
  if code_has "watchParent" "$BRIDGE_SRC" && code_has "CORUM_PARENT_PID" "$BRIDGE_SRC"; then
    pass "bridge.ts 有父进程探活看门狗（stdin EOF 会被继承的写端吞掉）"
  else
    fail "bridge.ts 缺父进程探活看门狗——打包版 kill -9 主进程后 host 会变孤儿"
  fi
fi
if [ -f "$DESKTOP_MAIN" ]; then
  if code_has "bridge?.dispose()" "$DESKTOP_MAIN"; then
    pass "main.ts before-quit 显式杀掉 host 子进程"
  else
    fail "main.ts before-quit 未调用 bridge?.dispose()——每次退出都会留下孤儿 host"
  fi
else
  skip "找不到 packages/desktop/src/electron/main.ts"
fi

# ── 15. 沙箱 fork：git 元数据可写根（隔离子 Agent 能不能提交）──────────────
# 背景（2026-09-09 用户实机复现）：官方 sandbox-local 的可写根 = workspaceRoot +
# /tmp + tmpdir；隔离 worktree 的 git 状态在主仓 .git（在 workspace 之外）→
# `git add` 报 index.lock: Operation not permitted，子 Agent 永远提交不了。
# 断言：① index.ts 与官方逐字节一致（增量只能在 profiles/git-write-roots）；
#       ② profiles.ts 确实含并集标记；③ git 探测模块在位；④ 装配面完整
#       （禁官方行 + 挂 fork 行 + desktop 依赖）。
fi  # ← select_section 14
if select_section 15; then
section "[15] 沙箱 fork（@corum/corum-sandbox-local）：git 元数据可写根"
SANDBOX_FORK="$REPO_ROOT/packages/plugins/agent/corum-sandbox-local"
OFFICIAL_SANDBOX_LOCAL="$DSH_CHECKOUT/packages/sandbox/sandbox-local"
if [ -f "$OFFICIAL_SANDBOX_LOCAL/src/index.ts" ]; then
  if cmp -s "$SANDBOX_FORK/src/index.ts" "$OFFICIAL_SANDBOX_LOCAL/src/index.ts"; then
    pass "src/index.ts 与官方逐字节一致"
  else
    fail "src/index.ts 与官方有差异——增量必须只在 profiles.ts / git-write-roots.ts（否则每次升级三方合并面扩大）"
  fi
else
  skip "官方检出缺 packages/sandbox/sandbox-local/src/index.ts（跳过逐字节断言）"
fi
if code_has 'corumGitWriteRoots' "$SANDBOX_FORK/src/profiles.ts"; then
  pass "profiles.ts 三个平台 builder 都并集 git 元数据可写根"
else
  fail "profiles.ts 未接 corumGitWriteRoots——隔离子 Agent 的 git 提交会退回 EPERM"
fi
if code_has "--git-common-dir" "$SANDBOX_FORK/src/git-write-roots.ts"; then
  pass "git-write-roots.ts 用 git rev-parse 探测 gitdir + common dir"
else
  fail "git-write-roots.ts 缺 git rev-parse 探测（拿不到主仓 .git）"
fi
if code_has_re '^- id: sandbox$' "$REPO_ROOT/packages/desktop/cordis.patch.yml" && code_has_re "name: '@corum/corum-sandbox-local'" "$REPO_ROOT/packages/desktop/cordis.patch.yml"; then
  pass "desktop patch 禁官方 sandbox 行 + 挂 fork 行"
else
  fail "desktop patch 缺「禁官方 sandbox 行 + 挂 fork 行」——fork 不会生效"
fi
if code_has '"@corum/corum-sandbox-local"' "$REPO_ROOT/packages/desktop/package.json"; then
  pass "desktop package.json 已链 fork 包"
else
  fail "desktop package.json 未链 @corum/corum-sandbox-local——打包闭包缺包"
fi
if code_has '"@corum/corum-sandbox-local"' "$REPO_ROOT/packages/desktop/desktop-host/package.json"; then
  pass "desktop-host deploy 清单已含 fork 包（打包闭包）"
else
  fail "desktop-host/package.json 缺 @corum/corum-sandbox-local——正式包 host 闭包会缺包（本轮教训：新插件必须同时进 desktop 与 desktop-host 依赖）"
fi

# ── 15b. fork #14（@corum/corum-fs-local）：edit 失败定位提示 + 解析面 ──────────
# 用户 2026-09-13 拍板「fork 吧」：官方 applyLiteralEdit 只回一句 `old_string was not found`，
# 模型不差在哪就原地重试（BUG-28）。增量落在 fsio.ts 的失败分支 + 独立 edit-candidates 模块。
# 本节的**关键**是「解析面」：桌面 base 的 ctx.fs 由官方 dsh-fs-sandbox 提供，而它是
# LocalFileSystem 的子类 —— fork 必须通过 pnpm-workspace.yaml 的 link: override 生效，
# 否则 fork 编好、测试全绿、应用里却一行都没跑到（静默失效）。
fi  # ← select_section 15

# ── 15a. 「cordis 行挂的 @corum 包必须进 desktop-host 依赖」的通例断言 ──────────
# 由来（2026-09-21 实测的发布阻断）：@corum/corum-memory 的 host 半在 cordis.patch.yml
# 有挂载行、也进了 packages/desktop/package.json，但**漏了 desktop-host/package.json**
# —— 于是 pack-macos 的 top-up（按 desktop-host 声明的 workspace:* 清单补齐闭包）不知道
# 要补它，打包闭包 `build/host/node_modules/@corum/` 里**没有 corum-memory** ⇒
# 打包态启动时那行 cordis 挂载解析不到包 ⇒ 记忆功能整体缺失（而 dev 态一切正常）。
#
# ⚠️ 上面 15 节那三条硬编码断言（sandbox-local / fs-local / tools）**只覆盖 fork 包**，
# 对「新插件漏登记」这类漏检完全无感 —— 正是本插件踩中的缺口。故这里补一条**通例**：
# 扫 cordis.patch.yml 里所有 `name: '@corum/…'` 的挂载行，要求每个包都出现在
# desktop-host 依赖里。这样「以后再加插件时忘了登记」会被当场拦下，而不是等到打包态
# 才发现功能整块不见。
if select_section 15a; then
section "[15a] cordis 挂载的 @corum 包 ↦ desktop-host 依赖（打包闭包不漏包）"
PATCH_YML="$REPO_ROOT/packages/desktop/cordis.patch.yml"
DESKTOP_HOST_PKG="$REPO_ROOT/packages/desktop/desktop-host/package.json"
# 只取**真实挂载行**（剥注释），避免被注释里的包名骗过（§8 的历史教训）。
mounted_corum=$(uncomment_all "$PATCH_YML" \
  | grep -oE "name:[[:space:]]*'@corum/[a-z0-9-]+'" \
  | grep -oE "@corum/[a-z0-9-]+" \
  | sort -u)
missing_host=''
for pkg in $mounted_corum; do
  if ! code_has "\"$pkg\"" "$DESKTOP_HOST_PKG"; then
    missing_host="$missing_host $pkg"
  fi
done
if [ -z "$missing_host" ]; then
  pass "cordis 挂载的 $(printf '%s\n' "$mounted_corum" | wc -l | tr -d ' ') 个 @corum 包全部登记在 desktop-host 依赖"
else
  fail "desktop-host/package.json 缺这些 cordis 挂载的包：$missing_host —— 打包闭包不会带它们（pack-macos 的 top-up 只按 desktop-host 声明补齐）⇒ 打包态该行解析不到包、功能整块缺失。修法：把包名加进 packages/desktop/desktop-host/package.json 的 dependencies"
fi
fi  # ← select_section 15a

if select_section 15b; then
section "[15b] fork #14（@corum/corum-fs-local）：edit 定位提示 + 解析面 override"
FS_LOCAL_FORK="$REPO_ROOT/packages/plugins/agent/corum-fs-local"
OFFICIAL_FS_LOCAL="$DSH_CHECKOUT/packages/fs/fs-local"
if [ -f "$OFFICIAL_FS_LOCAL/src/index.ts" ]; then
  # 官方文件（index.ts / win32.ts）不得被改动：增量只在 fsio.ts + 新增模块。
  for official_file in index.ts win32.ts; do
    if cmp -s "$FS_LOCAL_FORK/src/$official_file" "$OFFICIAL_FS_LOCAL/src/$official_file"; then
      pass "src/$official_file 与官方逐字节一致"
    else
      fail "src/$official_file 与官方有差异——增量必须只在 fsio.ts / edit-candidates.ts"
    fi
  done
else
  skip "官方检出缺 packages/fs/fs-local（跳过逐字节断言）"
fi
if code_has 'editNotFoundHint' "$FS_LOCAL_FORK/src/fsio.ts" && code_has 'matchLineNumbers' "$FS_LOCAL_FORK/src/fsio.ts"; then
  pass "fsio.ts 的两条失败分支都接了定位提示"
else
  fail "fsio.ts 缺 editNotFoundHint / matchLineNumbers——edit 失败会退回官方的一句 not found"
fi
if code_has 'Closest places in the file' "$FS_LOCAL_FORK/src/edit-candidates.ts"; then
  pass "edit-candidates.ts 含候选提示文案（打包闭包检查同款标记）"
else
  fail "edit-candidates.ts 缺候选提示文案"
fi
if code_has_re "^  '@deepseek-ai/dsh-fs-local': 'link:packages/plugins/agent/corum-fs-local'" "$REPO_ROOT/pnpm-workspace.yaml"; then
  pass "pnpm-workspace.yaml 把 dsh-fs-local 解析到 fork（fs-sandbox 是它的子类）"
else
  fail "pnpm-workspace.yaml 缺 dsh-fs-local 的 link: override——fork 不会在应用里生效（官方 fs-sandbox 仍加载官方包）"
fi
if code_has '"@corum/corum-fs-local"' "$REPO_ROOT/packages/desktop/desktop-host/package.json"; then
  pass "desktop-host 闭包登记 fork（deploy 物化为真实目录）"
else
  fail "desktop-host/package.json 缺 @corum/corum-fs-local——正式包闭包里它只会是软链"
fi
if code_has 'Closest places in the file' "$REPO_ROOT/packages/desktop/scripts/pack-macos.mjs"; then
  pass "pack-macos 会断言闭包里的 dsh-fs-local 是 fork（缺失/退回官方即打包失败）"
else
  fail "pack-macos.mjs 缺闭包断言——fork 没进闭包时会静默发行"
fi

# ── 16. fork #9（subagent seam）增量必须「opt-in」────────────────────────────
# 用户 2026-09-09 提问：官方 preset（standard/ptc/cordis）仍挂官方 dsh-tool-subagent，
# 而服务层已被 fork #9 取代——两者会不会行为不一致？答案取决于 fork #9 的增量是否
# **只在调用方显式传 cwd 时生效**（官方工具从不传 cwd）。本节把这条不变量机器化：
#   ① 官方 src 的每个文件，除下表登记的文件外必须逐字节一致；
#   ② 登记文件必须确实有差异（防静默回退成官方）；
#   ③ cwd 缺省路径必须仍是「继承父会话 cwd」（官方语义）；
#   ④ 两个入口（one-shot start / continuable）都必须做 assertChildCwd。
fi  # ← select_section 15b

# ── 16b. fork #16（@corum/corum-tools）：工具失败错误归一化 + 解析面 ──────────
# 官方 `errorMessage`/`toolErrorResult` 是模块私有（未导出），不可经 cordis 服务/装饰覆盖，
# 只能整包 fork（10 模块整拷官方 + 只改 errorMessage 一处）。本节的**关键**与 15b 同：
# 「解析面」——corum-tool-subagent / corum-orchestration / corum-subagent / corum-agent /
# corum-ui-chat 都 import `@deepseek-ai/dsh-tools`，fork 必须经 pnpm-workspace.yaml 的
# link: override 生效，否则 fork 编好、测试全绿、应用里却一行都没跑到（静默失效）。
if select_section 16b; then
section "[16b] fork #16（@corum/corum-tools）：errorMessage 归一化 + 解析面 override"
TOOLS_FORK="$REPO_ROOT/packages/plugins/agent/corum-tools"
OFFICIAL_TOOLS="$DSH_CHECKOUT/packages/core/tools"
if [ -f "$OFFICIAL_TOOLS/src/index.ts" ]; then
  # 官方文件（除 index.ts 外的 9 个模块）不得被改动：增量只在 index.ts 的 errorMessage。
  for official_file in invariant.ts json-schema.ts presentation.ts ptc.ts py-types.ts schema.ts testing.ts ts-types.ts types.ts; do
    if cmp -s "$TOOLS_FORK/src/$official_file" "$OFFICIAL_TOOLS/src/$official_file"; then
      pass "src/$official_file 与官方逐字节一致"
    else
      fail "src/$official_file 与官方有差异——增量必须只在 index.ts 的 errorMessage"
    fi
  done
else
  skip "官方检出缺 packages/core/tools（跳过逐字节断言）"
fi
if code_has 'JSON.stringify(error)' "$TOOLS_FORK/src/index.ts" && code_has 'json.length > 500' "$TOOLS_FORK/src/index.ts"; then
  pass "index.ts 的 errorMessage 对无 message 对象走 JSON.stringify（不再 [object Object]）"
else
  fail "index.ts 的 errorMessage 缺 JSON.stringify 增量——工具失败对象会退回官方 [object Object]"
fi
if code_has_re "^  '@deepseek-ai/dsh-tools': 'link:packages/plugins/agent/corum-tools'" "$REPO_ROOT/pnpm-workspace.yaml"; then
  pass "pnpm-workspace.yaml 把 dsh-tools 解析到 fork（消费方共用它）"
else
  fail "pnpm-workspace.yaml 缺 dsh-tools 的 link: override——fork 不会在应用里生效（消费方仍加载官方包）"
fi
if code_has '"@corum/corum-tools"' "$REPO_ROOT/packages/desktop/desktop-host/package.json"; then
  pass "desktop-host 闭包登记 fork（deploy 物化为真实目录）"
else
  fail "desktop-host/package.json 缺 @corum/corum-tools——正式包闭包里它只会是软链"
fi
if code_has 'JSON.stringify(error)' "$REPO_ROOT/packages/desktop/scripts/pack-macos.mjs"; then
  pass "pack-macos 会断言闭包里的 dsh-tools 是 fork（缺失/退回官方即打包失败）"
else
  fail "pack-macos.mjs 缺 dsh-tools 闭包断言——fork 没进闭包时会静默发行"
fi
fi  # ← select_section 16b
if select_section 16; then
section "[16] fork #9（corum-subagent）：增量 opt-in（官方 preset 行为等价）"
SUBAGENT_FORK="$REPO_ROOT/packages/plugins/agent/corum-subagent"
OFFICIAL_SUBAGENT="$DSH_CHECKOUT/packages/subagent/subagent"
# 允许有差异的文件（围绕 cwd 透传；invariant 是模板改名）+ 2026-09-20 子 Agent 人格分层：
#   · descriptor.ts —— durable 描述符增 kind/personaHint（人格按种类重放，��落盘会漂移）；
#   · 新增 child-roles.ts —— 两份角色契约（执行者/调查员）+ 注入层上限，官方无对应物。
# 2026-09-29 升级 0.1.5-rc.3 后重登：官方把 continuation.ts 拆成 4 文件，故新增
# continuation-activation.ts / continuation-messages.ts / inbox.ts 也属「登记为有差异」
# （它们是 hybrid：官方为底 + corum 三块旗舰增量贴回）；其余为长期 fork 面。
SUBAGENT_DELTA_FILES="types.ts child-agent.ts continuation.ts descriptor.ts depth.ts index.ts invariant.ts continuation-activation.ts continuation-messages.ts inbox.ts assistant-output.ts client.ts control.ts control-types.ts internal.ts out-of-process.ts projection-types.ts"
SUBAGENT_NEW_FILES="child-roles.ts driver escalation-answerer.ts escalation-grants.ts escalation-policy.ts fork isolated routing-guard.ts spawn"
if [ -d "$OFFICIAL_SUBAGENT/src" ]; then
  drift=0
  for official_file in "$OFFICIAL_SUBAGENT"/src/*.ts; do
    base="$(basename "$official_file")"
    fork_file="$SUBAGENT_FORK/src/$base"
    if [ ! -f "$fork_file" ]; then
      # 2026-09-29 升级 0.1.5-rc.3：官方新增 catalog.ts（parent-owned durable
      # catalog 持久化）。用户已裁决**暂不引入**（corum 的 listChildren 走
      # sessionPersistence 扫描，已工作；引入会多一套名册来源）。故登记为「有意不引入」，
      # 不视为漂移；将来引入时删掉本分支即可。
      case "$base" in
        catalog.ts)
          continue
          ;;
      esac
      fail "fork #9 缺官方文件 src/$base"
      drift=1
      continue
    fi
    case " $SUBAGENT_DELTA_FILES " in
      *" $base "*)
        if cmp -s "$official_file" "$fork_file"; then
          fail "src/$base 与官方逐字节一致——登记为增量文件却无差异（cwd 透传被静默回退？）"
          drift=1
        fi
        ;;
      *)
        if ! cmp -s "$official_file" "$fork_file"; then
          fail "src/$base 与官方有差异——未登记的增量（opt-in 不变量被破坏，官方 preset 行为可能偏移）"
          drift=1
        fi
        ;;
    esac
  done
  [ "$drift" = 0 ] && pass "官方 src 文件：登记文件有差异、其余逐字节一致"
  for extra in "$SUBAGENT_FORK"/src/*.ts; do
    base="$(basename "$extra")"
    [ -f "$OFFICIAL_SUBAGENT/src/$base" ] || {
      case " $SUBAGENT_NEW_FILES " in
        *" $base "*) ;;
        *) fail "fork #9 新增 src/$base 未登记（登记到 SUBAGENT_NEW_FILES 并同步 fork-delta §10）" ;;
      esac
    }
  done
else
  skip "官方检出缺 packages/subagent/subagent/src（跳过 fork #9 逐字节断言）"
fi
if code_has 'cwd ?? parentHeader.cwd' "$SUBAGENT_FORK/src/child-agent.ts"; then
  pass "cwd 缺省仍继承父会话 cwd（官方语义）"
else
  fail "child-agent.ts 的 cwd 缺省路径被改——官方工具不传 cwd，会偏离官方行为"
fi
if code_has 'assertChildCwd(request.cwd)' "$SUBAGENT_FORK/src/index.ts" && code_has 'assertChildCwd(request.cwd)' "$SUBAGENT_FORK/src/continuation.ts"; then
  pass "两个入口（start / continuable）都做 cwd 校验"
else
  fail "缺 assertChildCwd 入口（one-shot 或 continuable 之一漏校验）"
fi

# ── 17. 官方 preset 本地副本（shipped-presets/official）──────────────────────
# 用户 2026-09-09 拍板「给官方换上」：官方四模式（standard/ptc/cordis/minimal）
# 也必须走 corum 编排（并发感知隔离 / 模型锁 / settlement notice / orchestrate），
# 因此本仓 `shipped-presets/official/` 是官方 preset 的**本地副本**，standard/
# ptc/cordis/conductor 的 subagent 行被替换为 @corum/corum-tool-subagent **三实例**
# （worker + research + fork）；官方 workflow/ralph 恢复挂载但子 Agent 走 corum provider
# （2026-09-10 用户要求「三个工具按 corum 机制改造，保证官方能力被包含」）。
# 三条静默失效路径必须机器化守住：
#   ① `agent-presets` 服务把**包内置** `presets/` 根无条件排在最前，本仓副本会被
#      遮蔽 → 运行时毫无变化（2026-09-09 实机踩过）。故 boot.ts 必须带
#      `includeShippedRoot: false`；
#   ② 官方升级后本地副本与新版官方漂移（新行/改行没跟）→ 本节断言「官方行 id
#      一个不少、新增行在登记表内」；
#   ③ 恢复的三个官方能力必须走 corum provider（fork → corum-fork、workflow/ralph →
#      corum-spawn），否则子 Agent 绕过 fork #9 的 cwd 透传（台账说隔离、实际没隔离）。
fi  # ← select_section 16
if select_section 17; then
section "[17] 官方 preset 本地副本：corum 编排替换 + 官方能力经 corum provider 恢复"
VENDORED_PRESETS="$REPO_ROOT/packages/desktop/shipped-presets/official"
OFFICIAL_PRESETS="$DSH_CHECKOUT/packages/preset/agent-presets/presets"
# 本仓副本允许出现的「官方没有的行」（新增 corum 实例）。
PRESET_EXTRA_ROWS="tool-subagent-research"
# 恢复挂载的官方能力行（必须启用且走 corum provider）。workflow **工具行** 2026-09-10
# 起在四个 preset 一律 disabled（设计语义并入 orchestrate 的 script 模式，引擎保留）；
# 引擎行（workflow-worker-thread）与 ralph 仍恢复挂载。
PRESET_RESTORED_ROWS="tool-subagent-fork workflow-worker-thread tool-ralph"
if [ -f "$REPO_ROOT/packages/desktop/src/host/boot.ts" ]; then
  if code_has_re '^[[:space:]]*includeShippedRoot: false,?[[:space:]]*$' "$REPO_ROOT/packages/desktop/src/host/boot.ts"; then
    pass "boot.ts 关闭包内置 preset 根（否则 shipped-presets/official 被遮蔽、改动无效）"
  else
    fail "boot.ts 缺 includeShippedRoot: false——本仓 official 副本会被包内置版本静默遮蔽"
  fi
else
  fail "缺 packages/desktop/src/host/boot.ts（无法校验 preset 根注入）"
fi
if code_has "join(DESKTOP_ROOT, 'shipped-presets', 'official')" "$REPO_ROOT/packages/desktop/scripts/pack-macos.mjs" \
  && code_has 'SHIPPED_PRESETS_DIR' "$REPO_ROOT/packages/desktop/scripts/pack-macos.mjs"; then
  pass "pack-macos.mjs 把本仓 official 副本物化进打包闭包"
else
  fail "pack-macos.mjs 未物化 shipped-presets/official——正式包会退回包内置 preset"
fi
# 退役行是否显式 disabled（读该行到下一个 `- id:` 之间的内容）。
# ⚠️ 2026-09-14 同型收紧：原先直接 awk 原文件，`disabled: true` 出现在**注释里**
# （例如「本行曾 disabled: true，后恢复」）也算命中，会把仍启用的行判成已退役。
# 现在先剥注释再扫，且 `- id:` 边界也用剥除后的文本（注释里的 `- id:` 不再截断区块）。
row_disabled() {
  uncomment_all "$1" | awk -v id="$2" '
    $0 ~ ("^[[:space:]]*- id: " id "[[:space:]]*$") { hit=1; next }
    hit && $0 ~ /^[[:space:]]*- id: / { exit }
    hit && /disabled:[[:space:]]*true/ { found=1 }
    END { exit found ? 0 : 1 }
  '
}
# 行 id 列表（顺序保留）。
# ⚠️ 剥注释后再取行 id：preset yml 的注释里常引用别的行 id（如「该行已被 X
# 取代」），注释里的 `- id:` 不该进对账表（否则 §17 的「官方行 id 一个不少 /
# 新增行在登记表内」会拿注释当行）。剥除按行进行，不删行、行号不变。
preset_row_ids() { uncomment_all "$1" | grep -oE '^[[:space:]]*- id: [A-Za-z0-9._-]+' | sed -E 's/.*- id: //'; }
if [ -d "$VENDORED_PRESETS" ]; then
  # conductor（指挥模式）与 standard 共用同一份 corum 编排替换，但语义不同：
  # 主 Agent 的执行工具由 corum-agent 运行时裁剪（agent scope），preset 工具面
  # 必须与 standard 完全一致（否则子 Agent 也失去执行工具）。下面额外断言二者
  # 行面逐字节一致 + 代码常量与目录/显示名对账。
  CONDUCTOR_SRC="$REPO_ROOT/packages/plugins/agent/corum-agent/src/conductor.ts"
  if [ -f "$CONDUCTOR_SRC" ] && code_has "CONDUCTOR_PRESET_ID = 'conductor'" "$CONDUCTOR_SRC"; then
    pass "指挥模式常量 CONDUCTOR_PRESET_ID = 'conductor'"
  else
    fail "conductor.ts 缺 CONDUCTOR_PRESET_ID = 'conductor'（指挥模式判定失效）"
  fi
  # 指挥模式是三处联动：preset 目录 / corum profile 的 baseMode / UI 下拉。任一处漏改
  # 都会让「继承指挥模式」静默失效（profile 编译出普通工具面、或编辑器里选不到）。
  PROFILE_SRC="$REPO_ROOT/packages/plugins/agent/corum-agent/src/profile.ts"
  BUILTIN_SRC="$REPO_ROOT/packages/plugins/agent/corum-agent/src/builtin-profiles.ts"
  UI_PRESET_SRC="$REPO_ROOT/packages/plugins/ui/corum-ide-ui/src/client/settings/sections/SettingsAgentPresetsSection.tsx"
  if code_has_re "^export type BaseMode = .*'conductor'" "$PROFILE_SRC"; then
    pass "BaseMode 含 'conductor'（corum 角色可继承指挥模式）"
  else
    fail "profile.ts 的 BaseMode 缺 'conductor'——corum 角色无法继承指挥模式"
  fi
  if code_has "id: 'conductor-lead'" "$BUILTIN_SRC" && code_has "baseMode: 'conductor'" "$BUILTIN_SRC"; then
    pass "内置角色「指挥者」（conductor-lead）继承指挥模式"
  else
    fail "builtin-profiles.ts 缺 conductor-lead 角色或未用 baseMode: 'conductor'"
  fi
  # 全能/通用助手（2026-09-10 用户需求「岗位要有全能/通用助手，不能只限于编程」）：
  # 岗位 + 新增「通用」维度必须在后端联合类型、后端校验、UI 下拉三处同步。
  if code_has "id: 'general-assistant'" "$BUILTIN_SRC" && code_has "dimension: '通用'" "$BUILTIN_SRC"; then
    pass "内置岗位「全能助手」（general-assistant，通用维度）存在"
  else
    fail "builtin-profiles.ts 缺 general-assistant 岗位或未用 dimension: '通用'"
  fi
  if code_has_re "^export type AgentDimension = .*'通用'" "$PROFILE_SRC" \
    && code_has_re "v === '通用'" "$PROFILE_SRC" \
    && code_has_re "AGENT_DIMENSIONS = \[[^]]*'通用'" "$UI_PRESET_SRC"; then
    pass "「通用」维度在后端类型/校验/UI 下拉三处同步"
  else
    fail "「通用」维度三处未同步（AgentDimension / isValidAgentDimension / AGENT_DIMENSIONS）"
  fi
  # 只读搜索子 Agent 的指引必须与 orchestrate 可见性解耦（2026-09-10 用户需求
  # 「每个 Agent 都配备了 search Agent，所有模式都应该提到这一点」）。
  SUBAGENT_TOOL_SRC="$REPO_ROOT/packages/plugins/agent/corum-tool-subagent/src/index.ts"
  # 2026-09-27 重排：条目文案由 `- ANY read-only work` 改为 `- READ-ONLY work (research, search,
  # fact-finding …`（同段去重后只出现一次）。判据不变：只读指引存在 **且** 挂在 hasResearch 分支上
  # ⇒ 不依赖 orchestrate 可见性（所有带 worker 实例的模式都会提到）。
  if code_has 'hasResearch' "$SUBAGENT_TOOL_SRC" \
    && code_has 'READ-ONLY work (research, search, fact-finding' "$SUBAGENT_TOOL_SRC" \
    && code_has 'subagent_research' "$SUBAGENT_TOOL_SRC"; then
    pass "只读搜索子 Agent 指引与 orchestrate 可见性解耦（所有带 worker 的模式都会提到）"
  else
    fail "机制段缺「只读搜索子 Agent」指引或仍绑在 orchestrate 可见性上"
  fi
  if code_has "'deepseek-orchestrator'" "$BUILTIN_SRC"; then
    if code_has "RETIRED_BUILTIN_ROLE_IDS" "$BUILTIN_SRC"; then
      pass "旧「Deepseek 编排者」已退役（仅在 RETIRED_BUILTIN_ROLE_IDS 里作清理项）"
    else
      fail "builtin-profiles.ts 仍以内置角色形式保留 deepseek-orchestrator（应改为退役清理项）"
    fi
  else
    fail "builtin-profiles.ts 缺 RETIRED_BUILTIN_ROLE_IDS 的退役项（升级用户的家目录副本不会被清理）"
  fi
  if code_has "id: 'conductor', label: BASE_MODE_LABELS.conductor" "$UI_PRESET_SRC"; then
    pass "Agent 预设编辑器的基础模式下拉含指挥模式"
  else
    fail "SettingsAgentPresetsSection 的基础模式下拉缺 conductor——用户无法在编辑器里选指挥模式"
  fi
  if [ -f "$VENDORED_PRESETS/conductor/agent.cordis.yml" ] && [ -f "$VENDORED_PRESETS/standard/agent.cordis.yml" ]; then
    if [ "$(sed -n '/^- id: /,$p' "$VENDORED_PRESETS/conductor/agent.cordis.yml")"       = "$(sed -n '/^- id: /,$p' "$VENDORED_PRESETS/standard/agent.cordis.yml")" ]; then
      pass "指挥模式工具面与标准模式逐行一致（裁剪只在运行时 agent scope）"
    else
      fail "指挥模式 agent.cordis.yml 行面与标准模式不一致——preset 裁行会连子 Agent 一起裁掉"
    fi
    if code_has 'name: 指挥模式' "$VENDORED_PRESETS/conductor/preset.yml" \
      && code_has "CONDUCTOR_MODE_LABEL = '指挥模式'" "$CONDUCTOR_SRC"; then
      pass "指挥模式显示名（preset.yml ↔ 代码常量）一致"
    else
      fail "指挥模式显示名漂移（preset.yml name 与 CONDUCTOR_MODE_LABEL 必须同为「指挥模式」）"
    fi
  else
    fail "缺 shipped-presets/official/conductor（指挥模式基准 preset）"
  fi
  for preset in standard ptc cordis minimal conductor; do
    vendored="$VENDORED_PRESETS/$preset/agent.cordis.yml"
    if [ ! -f "$vendored" ]; then
      fail "shipped-presets/official/$preset/agent.cordis.yml 缺失"
      continue
    fi
    if [ "$preset" = "minimal" ]; then
      # minimal 不做 corum 替换（双工具极简面，无编排语义）——必须与官方逐字节一致。
      if [ -f "$OFFICIAL_PRESETS/minimal/agent.cordis.yml" ]; then
        if cmp -s "$vendored" "$OFFICIAL_PRESETS/minimal/agent.cordis.yml"; then
          pass "minimal 副本与官方逐字节一致（未替换，无编排面）"
        else
          fail "minimal 副本与官方有差异——本仓未计划替换 minimal，请同步或登记为替换 preset"
        fi
      else
        skip "官方检出缺 minimal preset（跳过逐字节断言）"
      fi
      continue
    fi
    # ① corum 编排替换：三实例（worker + research + fork）+ provider + 只读研究实例。
    if [ "$(uncomment_all "$vendored" | grep -cF "name: '@corum/corum-tool-subagent'")" -eq 3 ]; then
      pass "${preset}：corum 三实例（worker + research + fork）指向 @corum/corum-tool-subagent"
    else
      fail "${preset}：corum subagent 实例数不是 3（worker + research + fork）"
    fi
    code_has 'provider: corum-spawn' "$vendored" \
      && pass "${preset}：provider corum-spawn" \
      || fail "${preset}：缺 provider: corum-spawn（子 Agent 会走官方 spawn provider，无 corum 机制）"
    code_has 'readonlyResearch: true' "$vendored" \
      && pass "${preset}：research 只读实例已挂" \
      || fail "${preset}：缺 readonlyResearch: true（subagent_research 只读语义丢失）"
    # ② 官方 subagent 工具行不得仍处于启用态（按行块判定：同一 `- id:` 块内
    #    `name: '@deepseek-ai/dsh-tool-subagent'` 必须伴随 disabled: true）。
    if awk '
      /^[[:space:]]*- id: / { if (index(blk, OFFICIAL_SUBAGENT_ROW) > 0 && index(blk, "disabled: true") == 0) bad=1; blk="" }
      { blk = blk $0 "\n" }
      END { if (index(blk, OFFICIAL_SUBAGENT_ROW) > 0 && index(blk, "disabled: true") == 0) bad=1; exit bad ? 0 : 1 }
    ' OFFICIAL_SUBAGENT_ROW="name: '@deepseek-ai/dsh-tool-subagent'" "$vendored"; then
      fail "${preset}：官方 subagent 工具行仍启用（与 corum 工具重复，提示词/机制双份）"
    else
      pass "${preset}：官方 subagent 工具行已退役（disabled 或改挂 corum 实例）"
    fi
    # ③ 恢复挂载的官方能力行必须启用且走 corum provider（2026-09-10）。
    for restored in $PRESET_RESTORED_ROWS; do
      if ! code_has_re "^[[:space:]]*- id: $restored[[:space:]]*$" "$vendored"; then
        fail "${preset}：恢复行 $restored 消失（官方能力被丢掉）"
      elif row_disabled "$vendored" "$restored"; then
        fail "${preset}：恢复行 $restored 仍是 disabled: true"
      fi
    done
    if ! row_disabled "$vendored" tool-subagent-fork && ! code_has 'provider: corum-fork' "$vendored"; then
      fail "${preset}：subagent_fork 未走 corum-fork provider（子会话会绕过 fork #9 的 cwd 透传）"
    fi
    if ! row_disabled "$vendored" workflow-worker-thread && ! code_has 'provider: corum-spawn' "$vendored"; then
      fail "${preset}：workflow 引擎未走 corum-spawn provider"
    fi
    if ! row_disabled "$vendored" tool-ralph && ! code_has 'subagentProvider: corum-tracked' "$vendored"; then
      fail "${preset}：ralph 未走 corum-tracked provider（子 Agent 不计数）"
    fi
    # workflow 工具行：四个 preset 一律 disabled（语义并入 orchestrate script 模式）；
    # 引擎行必须保留启用，否则 orchestrate script 模式与 ralph 都没有引擎。
    if row_disabled "$vendored" tool-workflow; then
      pass "${preset}：tool-workflow 已退役（语义并入 orchestrate script 模式）"
    else
      fail "${preset}：tool-workflow 仍启用——模型面出现第二个自撰编排语言"
    fi
    if row_disabled "$vendored" workflow-worker-thread; then
      fail "${preset}：workflow 引擎行被禁用——orchestrate script 模式/ralph 失去引擎"
    fi
    # codex / claude-code 保持官方默认（provider 未安装）。
    for optional in tool-subagent-codex tool-subagent-claude-code; do
      if code_has_re "^[[:space:]]*- id: $optional[[:space:]]*$" "$vendored" && ! row_disabled "$vendored" "$optional"; then
        fail "${preset}：可选 provider 行 $optional 被启用（官方默认 disabled）"
      fi
    done
    # ④ 官方行 id 一个不少（升级漂移检测）+ 新增行在登记表内。
    if [ -f "$OFFICIAL_PRESETS/$preset/agent.cordis.yml" ]; then
      missing=0
      while IFS= read -r official_id; do
        code_has_re "^[[:space:]]*- id: $official_id[[:space:]]*$" "$vendored" || { missing=1; fail "${preset}：官方行 $official_id 在本地副本中消失（升级漂移）"; }
      done < <(preset_row_ids "$OFFICIAL_PRESETS/$preset/agent.cordis.yml")
      [ "$missing" = 0 ] && pass "${preset}：官方行 id 全部保留"
      extra=0
      while IFS= read -r vendored_id; do
        code_has_re "^[[:space:]]*- id: $vendored_id[[:space:]]*$" "$OFFICIAL_PRESETS/$preset/agent.cordis.yml" && continue
        case " $PRESET_EXTRA_ROWS " in
          *" $vendored_id "*) ;;
          *) extra=1; fail "${preset}：新增行 $vendored_id 未登记（请同步本节 PRESET_EXTRA_ROWS 与 fork-delta §4.1）" ;;
        esac
      done < <(preset_row_ids "$vendored")
      [ "$extra" = 0 ] && pass "${preset}：新增行均在登记表内"
    else
      skip "官方检出缺 $preset preset（跳过行 id 对账）"
    fi
  done
  # ⑥ fork #9 的 corum fork provider：官方语义（completed-turn seed）保留，driver 换成
  # corum 的（cwd 透传），provider 名不与官方 'fork' 抢名；host patch 必须挂它。
  CORUM_FORK_PROVIDER="$REPO_ROOT/packages/plugins/agent/corum-subagent/src/fork/index.ts"
  if [ -f "$CORUM_FORK_PROVIDER" ] \
    && code_has "providerName: z.string().default('corum-fork')" "$CORUM_FORK_PROVIDER" \
    && code_has "from '../driver/index.ts'" "$CORUM_FORK_PROVIDER" \
    && code_has 'completedTurnPrefix' "$CORUM_FORK_PROVIDER" \
    && code_has 'inheritsParentContext = true' "$CORUM_FORK_PROVIDER"; then
    pass "corum fork provider：官方 seed 语义 + corum driver（cwd 透传）"
  else
    fail "corum-subagent/src/fork/index.ts 缺 corum-fork provider 或偏离官方语义"
  fi
  if code_has "name: '@corum/corum-subagent/fork'" "$REPO_ROOT/packages/desktop/cordis.patch.yml"; then
    pass "host patch 挂载 @corum/corum-subagent/fork"
  else
    fail "desktop/cordis.patch.yml 未挂载 corum-fork provider"
  fi
  # ⑦ isolated provider（workflow 语义并入 orchestrate 的隔离机制）：provider 文件保留
  # worktree/台账/通知三件事，host patch 必须挂它，orchestrate 必须按 run 指定它。
  CORUM_ISOLATED_PROVIDER="$REPO_ROOT/packages/plugins/agent/corum-subagent/src/isolated/index.ts"
  if [ -f "$CORUM_ISOLATED_PROVIDER" ] \
    && code_has "providerName: z.string().default('corum-isolated')" "$CORUM_ISOLATED_PROVIDER" \
    && code_has 'createWorktreeChild' "$CORUM_ISOLATED_PROVIDER" \
    && code_has 'bindRunId' "$CORUM_ISOLATED_PROVIDER" \
    && code_has 'discardEntry' "$CORUM_ISOLATED_PROVIDER" \
    && code_has "from '@corum/corum-orchestration'" "$CORUM_ISOLATED_PROVIDER" \
    && code_has 'corumIsolationNotice(' "$CORUM_ISOLATED_PROVIDER" \
    && code_has 'corumDirectWriteNotice(' "$CORUM_ISOLATED_PROVIDER"; then
    pass "corum isolated provider：worktree + 台账绑定 + 失败回滚 + 隔离通知"
  else
    fail "corum-subagent/src/isolated/index.ts 缺隔离三件事（worktree/绑定/回滚）或通知注入"
  fi
  if code_has "name: '@corum/corum-subagent/isolated'" "$REPO_ROOT/packages/desktop/cordis.patch.yml"; then
    pass "host patch 挂载 @corum/corum-subagent/isolated"
  else
    fail "desktop/cordis.patch.yml 未挂载 corum-isolated provider"
  fi
  # tracked provider（ralph 纳入并发计数）：同一 provider 的 track 模式行必须存在，
  # 且实现里保留「计数 + 直连纪律 + 幂等注销」三件事。
  if code_has "providerName: corum-tracked" "$REPO_ROOT/packages/desktop/cordis.patch.yml" \
    && code_has "mode: track" "$REPO_ROOT/packages/desktop/cordis.patch.yml"; then
    pass "host patch 挂载 corum-tracked provider（mode: track）"
  else
    fail "desktop/cordis.patch.yml 缺 corum-tracked provider 行"
  fi
  if code_has 'export function prepareTrackedChild' "$CORUM_ISOLATED_PROVIDER" \
    && code_has 'beginWriteChild' "$CORUM_ISOLATED_PROVIDER" \
    && code_has 'endWriteChild' "$CORUM_ISOLATED_PROVIDER" \
    && code_has 'corumDirectWriteNotice' "$CORUM_ISOLATED_PROVIDER"; then
    pass "track 模式：登记/注销在跑写子 Agent + 注入直连纪律"
  else
    fail "isolated provider 缺 track 模式（计数 + 直连纪律）"
  fi
  # 2026-09-16 不变式⑤（凡写委派恒隔离）：script 模式**不得**再有 `isolate:'off'` 绕过口
  # ——它此前直接选 `corum-spawn`（不建 worktree）而不经过 corumShouldIsolate，是隔离判定
  # 之外的一条独立逃逸路径。现在恒选 `corum-isolated`，并断言那个开关已从代码里消失。
  if code_has "subagentProvider: scriptProvider" "$SUBAGENT_TOOL_SRC" \
    && code_has "const scriptProvider = 'corum-isolated'" "$SUBAGENT_TOOL_SRC" \
    && code_has "runtimeCtx.get('workflowEngine'" "$SUBAGENT_TOOL_SRC"; then
    pass "orchestrate script 模式：引擎 + 恒选隔离 provider（不变式⑤，无 off 绕过口）"
  else
    fail "orchestrate 缺 script 模式接线（引擎/隔离 provider 选择）"
  fi
  if code_has "isolate === 'off'" "$SUBAGENT_TOOL_SRC"; then
    fail "orchestrate script 模式仍有 isolate:'off' 绕过口（违反不变式⑤）"
  else
    pass "orchestrate script 模式：isolate:'off' 绕过口已清除"
  fi
  # ⑤ 改名残留（mode: code）目录不得存在——它会与 mode 枚举冲突、挂载即失败。
  for stale in "$VENDORED_PRESETS"/*/; do
    [ -d "$stale" ] || continue
    case "$(basename "$stale")" in
      standard|ptc|cordis|minimal|conductor) ;;
      *) fail "shipped-presets/official/$(basename "$stale") 不是官方 preset id（改名残留会让 agent-presets 挂载失败）" ;;
    esac
  done
else
  fail "缺 packages/desktop/shipped-presets/official——官方 preset 的 corum 编排替换不存在"
fi

# ── 18. 技能打包副本与仓库脚本一致（2026-09-12 用户定调）────────────────────
# 用户定调：**脚本和 skill 原文打包进 CORUM_HOME 的技能路径**，技能要自带全套脚本
# （隔离 worktree 里的子 Agent 也要能用）。仓库 `scripts/*` 是源，技能里的 `scripts/*`
# 是打包副本——两处漂移就等于「技能里那份是旧的」，而这类失效在实机上极难发现。
fi  # ← select_section 17
if select_section 18; then
section "[18] corum-cdp-verify 技能：打包副本 == 仓库脚本（逐字节）"
# 2026-09-26：默认 home 改为共享的 ~/.corum（dev/verify/packaged 同一份），技能也随之装在
# 那里。这里**按候选顺序**找技能目录，而不是写死一个路径 —— 写死会让本节在 home 迁移后
# **静默 skip**（本该变红的一致性断言变成「跳过」，是最危险的一种弱化）。扫描顺序：
#   ① 显式 CORUM_HOME  ② ~/.corum（当前默认）  ③ ~/.agents 链接  ④ 旧 dev/verify home
_skill_dir_candidates=(
  "${CORUM_HOME:-}/skills/corum-cdp-verify"
  "$HOME/.corum/skills/corum-cdp-verify"
  "$HOME/.agents/skills/corum-cdp-verify"
  "$REPO_ROOT/packages/desktop/.corum-dev-home/skills/corum-cdp-verify"
  "$REPO_ROOT/packages/desktop/.corum-verify-home/skills/corum-cdp-verify"
)
SKILL_DIR=""
for _c in "${_skill_dir_candidates[@]}"; do
  [[ -n "$_c" && -d "$_c/scripts" ]] && { SKILL_DIR="$_c"; break; }
done
# 全都没有 ⇒ 保留原默认值，让下面的 [ -d ] 走 skip 分支（并给出准确路径）
[[ -z "$SKILL_DIR" ]] && SKILL_DIR="${CORUM_HOME:-$REPO_ROOT/packages/desktop/.corum-dev-home}/skills/corum-cdp-verify"
if [ -d "$SKILL_DIR/scripts" ]; then
  # 2026-09-25：5 个启动脚本（cdp.sh / verify-instance.sh / dev-ide.sh / combo.sh /
  # pack-instance.sh）合并为 **corum-instance.sh**（唯一实现 + 长选项区分实例），
  # 旧文件名**已删除**（彻底合并，不留分发壳）；SKILL.md 与本文档同步改为新入口。
  # 故本节逐字节断言的对象从 cdp.sh/verify-instance.sh 换成 corum-instance.sh。
  #
  # 2026-10-11 补 `verify-fork-drift.sh` 自己：它此前**不在**本清单里，于是技能副本
  # 静默漂移到 2026-09-26 版（实测 89,900 B vs 仓库 96,370 B；sha256 不同，而本机
  # PATH 上的 `diff` 是 HarmonyOS SDK 的会**漏报 0 差异**，只有 `cmp`/sha256 判得出）
  # ——「守别人漂移的脚本自己没人守」。加进来后，技能副本必须与仓库逐字节一致。
  SKILL_ASSETS="cdp.mjs rpc-helper.js ui-verify.mjs app-launch-guard.sh corum-instance.sh verify-fork-drift.sh"
  skill_bad=0
  for asset in $SKILL_ASSETS; do
    if [ ! -f "$REPO_ROOT/scripts/$asset" ]; then
      fail "仓库缺 scripts/${asset}（技能打包的源）"
      skill_bad=1
      continue
    fi
    if [ ! -f "$SKILL_DIR/scripts/$asset" ]; then
      fail "技能缺 scripts/$asset —— 打包：cp scripts/$asset \"$SKILL_DIR/scripts/\""
      skill_bad=1
      continue
    fi
    if ! cmp -s "$REPO_ROOT/scripts/$asset" "$SKILL_DIR/scripts/$asset"; then
      fail "技能副本 scripts/$asset 与仓库不一致 —— 同步：cp scripts/$asset \"$SKILL_DIR/scripts/\""
      skill_bad=1
    fi
  done
  [ "$skill_bad" = "0" ] && pass "验证脚本：技能副本与仓库逐字节一致（$SKILL_DIR/scripts）"
  [ -f "$SKILL_DIR/SKILL.md" ] && pass "技能自带 SKILL.md" || fail "技能缺 SKILL.md"
else
  skip "未安装 corum-cdp-verify 技能（$SKILL_DIR 不存在）——跳过打包副本对账"
fi

# 随包那份 scripts/ 也必须与仓库一致（2026-10-11 补）。
#
# 为什么单独一段：上面的对账只覆盖**已安装到 home** 的那份技能（`$SKILL_DIR`），
# 而随包技能里的 `scripts/` 是**打包 staging 的源**——它是另一份实体。补这段之前实测：
# 故意往随包副本的 `cdp.mjs` 追加一行，§18 照旧报「通过」（漏网），也就是说**发到
# 用户手里的那份脚本无人守**。两份都守才是完整的。
#
# 2026-10-11（W3）：corum-cdp-verify 已随 corum-dev 模块从 `shipped-skills/` 搬到
# `shipped-modules/corum-dev/skills/`。路径变了，但「随包那份 scripts 必须与仓库一致」
# 的守卫语义不变——只改指向的新位置。
SHIPPED_SKILL="$REPO_ROOT/packages/desktop/shipped-modules/corum-dev/skills/corum-cdp-verify"
if [ -d "$SHIPPED_SKILL/scripts" ]; then
  shipped_bad=0
  for asset in $SKILL_ASSETS; do
    if [ ! -f "$SHIPPED_SKILL/scripts/$asset" ]; then
      fail "随包技能缺 scripts/$asset —— 同步：cp \"$SKILL_DIR/scripts/$asset\" \"$SHIPPED_SKILL/scripts/\""
      shipped_bad=1
      continue
    fi
    if ! cmp -s "$REPO_ROOT/scripts/$asset" "$SHIPPED_SKILL/scripts/$asset"; then
      fail "随包技能副本 scripts/$asset 与仓库不一致 —— 同步：cp scripts/$asset \"$SHIPPED_SKILL/scripts/\""
      shipped_bad=1
    fi
  done
  [ "$shipped_bad" = "0" ] && pass "随包技能：scripts 与仓库逐字节一致（shipped-modules/corum-dev/skills/corum-cdp-verify）"
else
  fail "随包技能 corum-cdp-verify 缺失（它已随 corum-dev 模块分发，见 shipped-skills/PROVENANCE.md）"
fi

# ── skills/ ↔ shipped-modules/corum-dev/skills/ 双份技能的一致性（2026-10-11 加，
#   2026-10-11 W3 改指向）─────────────────────────────────────────────────────
#
# 背景：`skills/<name>/` 是**编写源**（AGENTS.md / docs 引用它，改规范先改这里），
# `packages/desktop/shipped-modules/corum-dev/skills/<name>/` 是**分发副本**（随预设模块
# 分发，打包 staging，用户点「导入内置技能」才落 home）。同一个技能因此在仓库里有
# **两份实体**。
#
# 为什么必须守：这正是本仓付过学费的失效类——「同一事实两处，改一处忘另一处 ⇒ 静默
# 漂移」（`docs/LESSONS.md` §4.28 同型）。用户 2026-10-11 定调「corum 自研技能随包」
# 之后，双份从「1 个」变成「2 个」，漂移面扩大。判据用 `cmp` 逐字节（**不用 `diff`**：
# 本机 PATH 上的 `diff` 是 HarmonyOS SDK 的，会漏报 0 差异，见 §18 的注释）。
#
# 2026-10-11（W3）：corum 自研技能随 corum-dev 模块走，分发副本从 `shipped-skills/`
# 搬到了 `shipped-modules/corum-dev/skills/`。有编写源的（`corum-dev-conventions`、
# `corum-official-upgrade`）继续守双份一致；孤儿技能（`corum-cdp-verify`、
# `pencil-to-corum-ide`，仓库无编写源）在下面的「4 个目录都存在」断言里单独守。
for _dual in corum-dev-conventions corum-official-upgrade; do
  _a="$REPO_ROOT/skills/$_dual"
  _b="$REPO_ROOT/packages/desktop/shipped-modules/corum-dev/skills/$_dual"
  if [ ! -d "$_a" ]; then
    fail "skills/$_dual 缺失（它是编写源；模块里那份是它的分发副本）"
    continue
  fi
  if [ ! -d "$_b" ]; then
    fail "shipped-modules/corum-dev/skills/$_dual 缺失 —— 用户定调 corum 自研技能随 corum-dev 模块：cp -R skills/$_dual packages/desktop/shipped-modules/corum-dev/skills/"
    continue
  fi
  _drift=0
  while IFS= read -r _f; do
    _rel="${_f#"$_a"/}"
    if [ ! -f "$_b/$_rel" ]; then
      fail "shipped-modules/corum-dev/skills/$_dual 缺文件 $_rel（同步：cp -R skills/$_dual/. packages/desktop/shipped-modules/corum-dev/skills/$_dual/）"
      _drift=1
    elif ! cmp -s "$_f" "$_b/$_rel"; then
      fail "shipped-modules/corum-dev/skills/$_dual/$_rel 与 skills/$_dual 漂移（同步：cp -R skills/$_dual/. packages/desktop/shipped-modules/corum-dev/skills/$_dual/）"
      _drift=1
    fi
  done < <(find "$_a" -type f -not -path '*/.versions/*' -not -name 'skill-versions.json')
  # 反向：分发副本不得多出源里没有的文件（多出来的一定是漏删的旧文件）。
  while IFS= read -r _f; do
    _rel="${_f#"$_b"/}"
    [ -f "$_a/$_rel" ] || { fail "shipped-modules/corum-dev/skills/$_dual/$_rel 在编写源里不存在（多余文件，应删）"; _drift=1; }
  done < <(find "$_b" -type f)
  [ "$_drift" = "0" ] && pass "双份技能一致：skills/$_dual ↔ shipped-modules/corum-dev/skills/$_dual"
done

# ── corum-dev 模块的 4 个技能目录都必须存在（2026-10-11 W3 加）───────────────
#
# 为什么单独守：上面只守有编写源的两个；另外两个（`corum-cdp-verify`、
# `pencil-to-corum-ide`）仓库里**没有编写源**（孤儿技能），搬进模块后这份是唯一副本。
# 如果将来有人又把它们从模块里挪走（或重命名），上面的双份守卫不会变红（它根本
# 不扫这两个），于是搬迁会**静默失真**——这正是本仓反复付过学费的失效类。
# 这里硬断言这 4 个目录在 corum-dev 模块里一个不少。
# ⚠️ 用 `${_sk}` 显式界定变量名：本脚本 `set -u`，而 bash 3.2（macOS 默认）
# 会把紧跟变量后的**多字节全角括号**（这里的「（见」）吞进变量名 ⇒ `_sk（` 被当成
# 一个未定义变量 ⇒ `unbound variable` 退出。这是本仓付过学费的坑（AGENTS.md
# 交接 §6 / docs 同型），所有 `$_sk` 都必须写成 `${_sk}`。
for _sk in corum-cdp-verify corum-dev-conventions corum-official-upgrade pencil-to-corum-ide; do
  _d="$REPO_ROOT/packages/desktop/shipped-modules/corum-dev/skills/${_sk}"
  if [ -d "$_d" ] && [ -f "$_d/SKILL.md" ]; then
    pass "corum-dev 模块技能目录存在：shipped-modules/corum-dev/skills/${_sk}"
  else
    fail "corum-dev 模块缺技能目录：shipped-modules/corum-dev/skills/${_sk}（见 shipped-skills/PROVENANCE.md）"
  fi
done
fi  # select_section 18

# ── 汇总 ───────────────────────────────────────────────────────────────────
# 全量路径（FILTER_ACTIVE=0）的输出与加 CLI 之前逐字节一致：section_excluded 恒为 0，
# 下面两个 if 都不进，只剩原来的两行。过滤运行时则显式声明「已排除 N 个分区、这是
# 过滤运行」，确保过滤运行的绿不可能被读成「全量绿」。
printf '\n'
if [ "$FILTER_ACTIVE" = 1 ]; then
  # 选区回显。两者同时给时 --only 优先（与 section_is_selected 一致），故 --fast 只作
  # 「被覆盖」提示回显，绝不把它那 6 个分区算进本次覆盖范围。
  if [ -n "$ONLY_REQUESTED" ]; then
    selected_echo="$(printf '%s' "$ONLY_SELECTED" | sed 's/^ *//; s/ *$//')"
    if [ "$FAST_LANE" = 1 ]; then
      selected_echo="${selected_echo}（--fast 选区 ${FAST_LANE_SECTIONS} 已被 --only 覆盖，未执行）"
    fi
  else
    # 注意：必须写成 ${VAR}——bash 3.2 会把紧跟其后的多字节全角括号吞进变量名
    # （曾导致 `--fast` 走到这里报 unbound variable 并以 1 退出）。
    selected_echo="${FAST_LANE_SECTIONS}（--fast）"
  fi
  printf '⚠ 过滤运行（快速通道）：已排除 %d 个分区，未执行也不计入结论：%s\n' \
    "$section_excluded" "$(printf '%s' "$excluded_list" | sed 's/ *$//')"
  printf '  本次只覆盖选区：%s\n' "$selected_echo"
  printf '  本结果**不能**作为验收依据；最终验收必须运行无参数的全量：./scripts/verify-fork-drift.sh\n'
fi
if [ "$failures" -gt 0 ]; then
  printf 'fork drift 校验失败：%d 项\n' "$failures"
  exit 1
fi
if [ "$FILTER_ACTIVE" = 1 ]; then
  printf 'fork drift 校验通过（过滤运行：仅 %d/%d 个分区被选中并通过，已排除 %d 个分区，跳过 %d 项）\n' \
    "$(( ${#SECTION_TOKENS[@]} - section_excluded ))" "${#SECTION_TOKENS[@]}" "$section_excluded" "$skips"
  printf '⚠ 这不是全量通过：未排除任何分区前，请以无参数全量运行为准。\n'
  exit 0
fi
printf 'fork drift 校验通过（跳过 %d 项）\n' "$skips"
