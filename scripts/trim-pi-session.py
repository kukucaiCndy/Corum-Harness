#!/usr/bin/env python3
"""Trim oversized content inside a pi session JSONL (Pen.app / pi agent sessions).

Why this exists: a pi session replays its whole message list on every request,
so inline base64 screenshots (200 KB–2 MB each) and giant tool results make the
HTTP body grow past the gateway's limit. The API then answers

    413: {"code":"413","message":"Request Entity Too Large"}

which is a *byte* limit, not a token limit — pi's automatic compaction
(triggered by tokens) can never rescue it (see docs/LESSONS.md /
HANDOFF-2026-10-31 §6).

The second, newer failure mode is an *image count* limit. The same replay
behaviour accumulates every screenshot ever read in the session, and the
gateway (deepseek-v4.1-flash via pen.dev) answers

    400: {"message":"Invalid image or video input","type":"invalid_request_error","code":400}

once a request carries too many image parts. Measured boundary (session
01a19cae, 2026-11-02): a request with 120 images went through, the next one
with 122 failed — so stay well under ~100 images per session. Every later
turn fails the same way (the history is replayed), so the session looks
dead until the images are trimmed. Note this error is NOT caught by size
checks: the 122 images were only 1.78 MB raw base64, each one a valid PNG
or baseline JPEG with the right mimeType.

This script keeps every entry and its id/parentId chain intact and only
shortens message payloads, so the conversation still loads and can continue:

  * oversized base64 image parts  -> a text marker (the main offender)
  * oversized tool-result text    -> head + "…[裁剪 N 字符]"
  * oversized tool-call arguments -> head (an execute() with a giant snippet)
  * oversized user-pasted text    -> head

Defaults are deliberately conservative on text (8 000 chars keeps the head of
"Created nodes by name" listings) and aggressive on images (anything above
4 000 base64 chars is dropped).

Usage:
    python3 scripts/trim-pi-session.py ~/.pencil/pi-sessions/<session>.jsonl
    python3 scripts/trim-pi-session.py --dry-run <file...>
    python3 scripts/trim-pi-session.py --backup-dir ~/.pencil/backup/<stamp> <file...>

Always run --dry-run first to see how much would be cut. The original bytes are
copied to a backup before the file is rewritten; the backup is the only way to
get the screenshots back, so keep it.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import time

DEFAULTS = {
    "max_tool_chars": 8000,
    "max_user_chars": 20000,
    "max_args_chars": 6000,
    "max_image_chars": 4000,
}


TRIM_MARK = "\n…[裁剪 "


def shorten(text: str, limit: int, kind: str) -> str:
    if len(text) <= limit:
        return text
    # Already trimmed by an earlier run: the marker sits just past the limit, so
    # re-slicing would only churn the file (same length, marker rewritten).
    if text.rfind(TRIM_MARK) != -1 and len(text) <= limit + 200:
        return text
    return f"{text[:limit]}{TRIM_MARK}{len(text) - limit} 字符 · {kind}]"


def trim_parts(parts, limit: int, kind: str, cfg) -> tuple[bool, int]:
    changed, saved = False, 0
    if not isinstance(parts, list):
        return changed, saved
    for i, part in enumerate(parts):
        if not isinstance(part, dict):
            continue
        ptype = part.get("type")
        if ptype == "text" and isinstance(part.get("text"), str):
            new = shorten(part["text"], limit, kind)
            if new != part["text"]:
                saved += len(part["text"]) - len(new)
                parts[i] = {**part, "text": new}
                changed = True
        elif ptype == "toolResult" and isinstance(part.get("content"), list):
            sub_changed, sub_saved = trim_parts(
                part["content"], cfg["max_tool_chars"], "工具结果", cfg
            )
            changed, saved = changed or sub_changed, saved + sub_saved
        elif ptype == "image":
            size = len(str(part.get("data") or ""))
            if size > cfg["max_image_chars"]:
                parts[i] = {
                    "type": "text",
                    "text": f"…[截图已裁剪：原 inline base64 {size} 字符，"
                    f"需要时重新 TakeScreenshot / Export]",
                }
                changed, saved = True, saved + size
    return changed, saved


def trim_entry(entry: dict, cfg) -> tuple[bool, int]:
    msg = entry.get("message")
    if not isinstance(msg, dict):
        return False, 0
    role = msg.get("role")
    if role == "system":
        return False, 0
    if role == "toolResult":
        limit = cfg["max_tool_chars"]
    else:
        limit = cfg["max_user_chars"]

    changed, saved = False, 0
    content = msg.get("content")
    if isinstance(content, str):
        new = shorten(content, limit, role)
        if new != content:
            saved += len(content) - len(new)
            msg["content"] = new
            changed = True
    else:
        changed, saved = trim_parts(content, limit, role, cfg)

    for part in content if isinstance(content, list) else []:
        if isinstance(part, dict) and part.get("type") == "toolCall":
            args = part.get("arguments")
            if isinstance(args, dict):
                for key, value in list(args.items()):
                    if isinstance(value, str) and len(value) > cfg["max_args_chars"]:
                        new = shorten(value, cfg["max_args_chars"], "工具参数")
                        if new != value:
                            saved += len(value) - len(new)
                            args[key] = new
                            changed = True
    return changed, saved


def check_integrity(rows: list[dict]) -> list[str]:
    problems = []
    ids = {row.get("id") for row in rows}
    for row in rows:
        parent = row.get("parentId")
        if parent and parent not in ids:
            problems.append(f"断链: {row.get('id')} -> {parent}")
        if "/" in str(row.get("id") or ""):
            problems.append(f"非法 id（含 /）: {row.get('id')}")
    return problems


def trim_file(path: str, cfg, backup_dir: str | None, dry_run: bool) -> bool:
    rows = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                rows.append(json.loads(line))

    problems = check_integrity(rows)
    before = os.path.getsize(path)
    touched, saved = 0, 0
    for row in rows:
        changed, entry_saved = trim_entry(row, cfg)
        if changed:
            touched += 1
            saved += entry_saved

    print(os.path.basename(path))
    print(f"  entries={len(rows)}  touched={touched}  saved={saved/1e6:.2f}M chars")
    print(f"  bytes  {before/1e6:.2f}MB -> {(before - saved)/1e6:.2f}MB (approx)")
    if problems:
        print(f"  ⚠ 链路问题 {len(problems)} 条: {problems[:3]}")
    if dry_run:
        print("  dry-run: 未写盘")
        return False
    if not touched:
        print("  无需裁剪")
        return False

    stamp = time.strftime("%Y%m%d-%H%M%S")
    if backup_dir:
        target = os.path.join(backup_dir, os.path.basename(path))
        os.makedirs(backup_dir, exist_ok=True)
        if os.path.exists(target):
            root, ext = os.path.splitext(target)
            target = f"{root}.{stamp}{ext}"
    else:
        target = f"{path}.bak-{stamp}"
    shutil.copy2(path, target)

    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        for row in rows:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")
    os.replace(tmp, path)

    after = os.path.getsize(path)
    print(f"  written: {after/1e6:.2f}MB  ≈{int(after/3.5/1000)}k tokens")
    print(f"  backup:  {target}")
    return True


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("files", nargs="+", help="pi session .jsonl files")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--backup-dir", default=None)
    for key, value in DEFAULTS.items():
        parser.add_argument("--" + key.replace("_", "-"), type=int, default=value)
    args = parser.parse_args(argv)
    cfg = {key: getattr(args, key) for key in DEFAULTS}

    missing = [f for f in args.files if not os.path.exists(f)]
    if missing:
        print("找不到文件: " + ", ".join(missing), file=sys.stderr)
        return 1

    changed = False
    for path in args.files:
        changed = trim_file(path, cfg, args.backup_dir, args.dry_run) or changed
    return 0 if changed or args.dry_run else 0


if __name__ == "__main__":
    sys.exit(main())
