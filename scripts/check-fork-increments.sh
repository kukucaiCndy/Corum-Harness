#!/usr/bin/env bash
#
# check-fork-increments.sh —— fork 包升级后的**独立验收**：官方行零缺失 ∧ 我们的增量全在。
#
# ## 为什么需要它（用户口径 2026-09-28）
#
# 升级由**子 Agent** 完成，验收必须由**主会话独立做** —— 不能靠"子 Agent 说完成了"。
# 而人工逐文件核对整包 `src/` 既慢又容易漏（实测：我只挑了 `src/index.ts`/`src/types.ts` 比对，
# **漏了 `src/client/`** ⇒ 官方 12 行增量没合，是事后复核才发现的 ✗）。
#
# 本脚本把验收固化成一条命令：递归比对整包 `src/`，双向报告
#   ① **官方行缺失**（官方有而 fork 没有 ⇒ 升级漏合，必须修）
#   ② **我们的增量**（fork 有而官方没有 ⇒ 必须确认是有意的）
#
# ## 用法
#
#   ./scripts/check-fork-increments.sh <corum 包目录> <官方检出内路径> <标签>
#   # 例：
#   ./scripts/check-fork-increments.sh packages/plugins/session/corum-ui-settings-plugins \
#       packages/client/ui-settings-plugins dsh-v0.1.5-rc.3
#
#   ./scripts/check-fork-increments.sh --list     # 列出全部 fork 包 ↔ 官方路径（含基线标签）
#
# ## 判据说明
#
# - 用 `cmp -s` 判"逐字节相同"；**不用 `diff`**（本机 PATH 上的 `diff` 是 HarmonyOS SDK 的，
#   对内容不同的文件输出 0 行、退出 0 ⇒ 静默漏报；人读差异用 `/usr/bin/diff`）。
# - "官方行缺失"用**行集合**比较（不是逐行序）：某行只要在 fork 文件里出现过就不算缺失，
#   从而把「顺序不同」与「真缺」分开（实测坑：`goal/activation-changed` 一度被判缺失，
#   实际只是它排在第 39 行而官方第 26 行）。
# - `@deepseek-ai/dsh-*` → `@corum/corum-*` 的**改名**与注释重写会产生预期差异，
#   用 `--renames` 归一化后再比一次（默认开启）。

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH="${DSH_CHECKOUT:-/Users/kukucai/dsh}"

# fork 包 → [corum 目录, 官方检出路径, 说明]
# ⚠️ 官方路径以**检出**为准（`/Users/kukucai/dsh` 下的实际目录）；包名与目录名不一定同名。
FORKS=(
  "packages/plugins/agent/corum-agent|packages/agent/agent|host 域 fork #8"
  "packages/plugins/agent/corum-api-remotes|packages/api/remotes|fork #8b"
  "packages/plugins/agent/corum-credentials-local|packages/credentials/credentials-local|fork #7"
  "packages/plugins/agent/corum-fs-local|packages/fs/fs-local|fork #14"
  "packages/plugins/agent/corum-goal-round-driver|packages/goal/goal-round-driver|fork #17"
  "packages/plugins/agent/corum-sandbox-local|packages/sandbox/sandbox-local|fork #13"
  "packages/plugins/agent/corum-subagent|packages/subagent/subagent|fork #9"
  "packages/plugins/agent/corum-tool-subagent|packages/subagent/tool-subagent|fork #10"
  "packages/plugins/agent/corum-tools|packages/core/tools|fork #16"
  "packages/plugins/ui/corum-ui-renderer|packages/client/ui-renderer|fork #18"
  "packages/plugins/session/corum-session-query-sqlite|packages/session-query/session-query-sqlite|fork #19"
  "packages/plugins/session/corum-session-queue-revert|packages/session/session-queue-revert|fork #15"
  "packages/plugins/session/corum-ui-approval|packages/client/ui-approval|§4.3"
  "packages/plugins/session/corum-ui-chat|packages/client/ui-chat|§4.2"
  "packages/plugins/session/corum-ui-conversation|packages/client/ui-conversation|§4.1"
  "packages/plugins/session/corum-ui-model-selection|packages/client/ui-model-selection|§4.5"
  "packages/plugins/session/corum-ui-questions|packages/client/ui-user-questions|§4.4"
  "packages/plugins/session/corum-ui-settings-models|packages/client/ui-settings-models|§4.6"
  "packages/plugins/session/corum-ui-settings-plugins|packages/client/ui-settings-plugins|fork #11"
  "packages/plugins/session/corum-ui-trajectory|packages/client/ui-trajectory|fork #12"
)

if [ "${1:-}" = "--list" ]; then
  printf '%-52s %-42s %s\n' "corum 目录" "官方检出路径" "备注"
  for row in "${FORKS[@]}"; do
    IFS='|' read -r c o note <<< "$row"
    printf '%-52s %-42s %s\n' "$c" "$o" "$note"
  done
  exit 0
fi

CORUM_REL="${1:-}"; OFFICIAL_REL="${2:-}"; TAG="${3:-}"
if [ -z "$CORUM_REL" ] || [ -z "$OFFICIAL_REL" ] || [ -z "$TAG" ]; then
  printf '用法：%s <corum 包目录> <官方检出内路径> <标签>\n       %s --list\n' "$0" "$0" >&2
  exit 2
fi
[ -d "$REPO_ROOT/$CORUM_REL/src" ] || { printf '✗ corum 包没有 src/：%s\n' "$CORUM_REL" >&2; exit 2; }
[ -d "$DSH/.git" ] || { printf '✗ dsh 检出不存在：%s\n' "$DSH" >&2; exit 2; }
git -C "$DSH" rev-parse -q --verify "refs/tags/$TAG" >/dev/null \
  || { printf '✗ 检出里没有标签 %s\n' "$TAG" >&2; exit 2; }

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
git -C "$DSH" archive "$TAG" "$OFFICIAL_REL/src" 2>/dev/null | tar -x -C "$WORK" 2>/dev/null
OFF_SRC="$(find "$WORK" -type d -name src 2>/dev/null | head -1)"
[ -n "$OFF_SRC" ] || { printf '✗ 标签 %s 里没有 %s/src\n' "$TAG" "$OFFICIAL_REL" >&2; exit 2; }

printf '验收：%s\n  官方基线：%s（%s）\n\n' "$CORUM_REL" "$TAG" "$OFFICIAL_REL"

python3 - "$OFF_SRC" "$REPO_ROOT/$CORUM_REL/src" <<'PY'
import pathlib, re, subprocess, sys

off, cur = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
RENAME = [
    (r'@deepseek-ai/dsh-client-ui-[a-z0-9-]+', '@PKG'),
    (r'@corum/corum-ui-[a-z0-9-]+', '@PKG'),
    (r'@deepseek-ai/dsh-[a-z0-9-]+', '@PKG'),
    (r'@corum/corum-[a-z0-9-]+', '@PKG'),
]

def files(root):
    return sorted(str(p.relative_to(root)) for p in root.rglob('*') if p.is_file())

def readlines(p):
    try:
        return p.read_text(encoding='utf-8', errors='replace').splitlines()
    except Exception:
        return []

def norm(lines):
    out = []
    for l in lines:
        for pat, rep in RENAME:
            l = re.sub(pat, rep, l)
        out.append(l.rstrip())
    return out

o, c = set(files(off)), set(files(cur))
identical, differ = [], []
missing_official, our_extra = [], []

for f in sorted(o | c):
    if f not in c:
        missing_official.append((f, '整个文件在 fork 里缺失'))
        continue
    if f not in o:
        our_extra.append((f, 'fork 独有文件（我们的增量）'))
        continue
    op, cp = off / f, cur / f
    if subprocess.run(['cmp', '-s', str(op), str(cp)]).returncode == 0:
        identical.append(f)
        continue
    differ.append(f)
    ol, cl = readlines(op), readlines(cp)
    # 行集合比较（把"顺序不同"与"真缺"分开）；先按改名归一化
    oset = set(norm(ol))
    cset = set(norm(cl))
    miss = [l for l in ol if l.strip() and norm([l])[0] not in cset]
    extra = [l for l in cl if l.strip() and norm([l])[0] not in oset]
    if miss:
        missing_official.append((f, f'{len(miss)} 行官方行未见于 fork'))
    if extra:
        our_extra.append((f, f'{len(extra)} 行 fork 独有（我们的增量）'))

print(f'文件：官方 {len(o)} / fork {len(c)}；逐字节相同 {len(identical)}、有差异 {len(differ)}')
print(f'     官方独有 {len([1 for f in o if f not in c])}、fork 独有 {len([1 for f in c if f not in o])}')
if identical:
    print('  ✓ 逐字节相同：' + ', '.join(identical[:8]) + (' …' if len(identical) > 8 else ''))
print()
if missing_official:
    print(f'🔴 官方行/文件缺失（{len(missing_official)} 处）—— 升级可能漏合：')
    for f, why in missing_official:
        print(f'   ✗ {f}：{why}')
else:
    print('✅ 官方行零缺失（官方该有的都在 fork 里）')
print()
if our_extra:
    print(f'ℹ️ 我们的增量/差异（{len(our_extra)} 处）—— 须确认是有意的：')
    for f, why in our_extra:
        print(f'   · {f}：{why}')
else:
    print('ℹ️ 没有任何 fork 独有差异（该包与官方完全一致）')
sys.exit(1 if missing_official else 0)
PY
