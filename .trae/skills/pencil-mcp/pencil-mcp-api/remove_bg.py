#!/usr/bin/env python3
"""去除 PNG 图片的纯色背景（白色/绿色），生成透明 PNG。

用法:
  python3 remove_bg.py --dir <图片目录> [--pattern <glob>] [--color white|green] [--threshold 25]

  --dir       图片目录路径（必填）
  --pattern   文件名匹配模式，默认 *.png
  --color     要去除的背景色，white 或 green，默认 white
  --threshold 颜色容差 0-255，默认 25

示例:
  python3 remove_bg.py --dir ./doc/images
  python3 remove_bg.py --dir ./doc/images --color green --threshold 40
  python3 remove_bg.py --dir ./doc/images --pattern "icon-*.png" --threshold 15
"""
import argparse
import glob
import os
import sys

from PIL import Image

# 背景色定义
COLORS = {
    "white": (255, 255, 255),
    "green": (127, 183, 126),  # #7FB77E
}


def remove_color_bg(input_path: str, output_path: str, target_rgb: tuple, threshold: int = 25):
    """去除指定颜色背景，生成带 alpha 通道的透明 PNG。"""
    img = Image.open(input_path).convert("RGBA")
    datas = img.getdata()
    tr, tg, tb = target_rgb
    new_data = []
    for item in datas:
        r, g, b, a = item
        if abs(r - tr) < threshold and abs(g - tg) < threshold and abs(b - tb) < threshold:
            new_data.append((255, 255, 255, 0))
        else:
            new_data.append(item)
    img.putdata(new_data)
    img.save(output_path, "PNG")
    print(f"  -> {os.path.basename(output_path)}")


def main():
    parser = argparse.ArgumentParser(description="去除 PNG 图片纯色背景")
    parser.add_argument("--dir", required=True, help="图片目录路径")
    parser.add_argument("--pattern", default="*.png", help="文件名匹配模式 (默认 *.png)")
    parser.add_argument("--color", default="white", choices=["white", "green"], help="要去除的背景色 (默认 white)")
    parser.add_argument("--threshold", type=int, default=25, help="颜色容差 0-255 (默认 25)")
    args = parser.parse_args()

    base_dir = os.path.abspath(args.dir)
    if not os.path.isdir(base_dir):
        print(f"Error: 目录不存在: {base_dir}")
        sys.exit(1)

    target_rgb = COLORS[args.color]
    files = sorted(glob.glob(os.path.join(base_dir, args.pattern)))

    # 排除已带 -transparent 后缀的文件
    files = [f for f in files if "-transparent" not in os.path.basename(f)]

    if not files:
        print(f"未找到匹配文件: {args.pattern}")
        sys.exit(0)

    print(f"目录: {base_dir}")
    print(f"模式: {args.pattern}")
    print(f"背景色: {args.color} {target_rgb}")
    print(f"容差: {args.threshold}")
    print(f"找到 {len(files)} 个文件\n")

    for filepath in files:
        base, ext = os.path.splitext(os.path.basename(filepath))
        output_path = os.path.join(base_dir, f"{base}-transparent{ext}")
        print(f"Processing: {os.path.basename(filepath)}")
        remove_color_bg(filepath, output_path, target_rgb, args.threshold)

    print(f"\nDone! {len(files)} 个透明 PNG 已生成。")


if __name__ == "__main__":
    main()