#!/usr/bin/env python3
"""裁剪透明PNG的边缘残留（黑灰色边框），再补透明背景回原尺寸。

用法:
  python3 crop_pad.py --dir <图片目录> [--pattern <glob>] [--crop-percent <百分比>]

  --dir          图片目录路径（必填）
  --pattern      文件名匹配模式，默认 *-transparent.png
  --crop-percent 每边裁剪百分比（1-20），默认 6（即每边裁掉6%）

示例:
  python3 crop_pad.py --dir ./doc/UXDesign/images
  python3 crop_pad.py --dir ./doc/UXDesign/images --pattern "icon-*-transparent.png" --crop-percent 8
"""
import argparse
import glob
import os
import sys

from PIL import Image


def crop_and_pad(input_path: str, output_path: str, crop_percent: float):
    """从中心裁剪边缘，再补透明背景回原尺寸。"""
    img = Image.open(input_path).convert("RGBA")
    w, h = img.size

    # 计算裁剪量（每边裁掉 crop_percent%）
    crop_x = int(w * crop_percent / 100)
    crop_y = int(h * crop_percent / 100)

    # 从中心裁剪
    left = crop_x
    top = crop_y
    right = w - crop_x
    bottom = h - crop_y
    cropped = img.crop((left, top, right, bottom))

    # 创建透明背景画布（原尺寸），将裁剪后的图像居中粘贴
    result = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    paste_x = (w - cropped.width) // 2
    paste_y = (h - cropped.height) // 2
    result.paste(cropped, (paste_x, paste_y), cropped)

    result.save(output_path, "PNG")
    print(f"  -> {os.path.basename(output_path)}  (crop {crop_percent}% per side, {w}x{h} -> {cropped.width}x{cropped.height} -> {w}x{h})")


def main():
    parser = argparse.ArgumentParser(description="裁剪透明PNG边缘残留并补透明背景")
    parser.add_argument("--dir", required=True, help="图片目录路径")
    parser.add_argument("--pattern", default="*-transparent.png", help="文件名匹配模式 (默认 *-transparent.png)")
    parser.add_argument("--crop-percent", type=float, default=6, help="每边裁剪百分比 1-20 (默认 6)")
    parser.add_argument("--suffix", default="-t", help="输出文件后缀 (默认 -t，如 icon-baby-transparent-t.png)")
    args = parser.parse_args()

    base_dir = os.path.abspath(args.dir)
    if not os.path.isdir(base_dir):
        print(f"Error: 目录不存在: {base_dir}")
        sys.exit(1)

    files = sorted(glob.glob(os.path.join(base_dir, args.pattern)))
    # 排除已处理后缀的文件
    files = [f for f in files if not os.path.basename(f).endswith(args.suffix + ".png")]

    if not files:
        print(f"未找到匹配文件: {args.pattern}")
        sys.exit(0)

    print(f"目录: {base_dir}")
    print(f"模式: {args.pattern}")
    print(f"每边裁剪: {args.crop_percent}%")
    print(f"输出后缀: {args.suffix}")
    print(f"找到 {len(files)} 个文件\n")

    for filepath in files:
        base, ext = os.path.splitext(os.path.basename(filepath))
        output_path = os.path.join(base_dir, f"{base}{args.suffix}{ext}")
        print(f"Processing: {os.path.basename(filepath)}")
        crop_and_pad(filepath, output_path, args.crop_percent)

    print(f"\nDone! {len(files)} 个文件已处理。")


if __name__ == "__main__":
    main()
