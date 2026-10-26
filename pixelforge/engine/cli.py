"""命令行入口（验证阶段用）：

    python -m engine.cli INPUT.png -o OUT.png [--preset photo] [--size 64]
        [--mode mean|weighted_mode] [--palette extract|gameboy|cga16|gray8]
        [--k 64] [--edge-w 2] [--dark-w 1.5] [--preview-scale 8]

输出：OUT.png（索引 PNG）+ OUT_preview.png（整数倍放大预览）。
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image

from engine.pipeline import ConversionPipeline
from engine.recipe import Recipe, load_recipe
from engine.stages import s5_post


def build_argparser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="pixelforge", description="图片转像素画（验证版）")
    ap.add_argument("input", help="输入图片路径")
    ap.add_argument("-o", "--output", default="out.png", help="输出索引 PNG 路径")
    ap.add_argument("--preset", default="photo", help="配方预设（photo/illustration）")
    ap.add_argument("--size", type=int, help="目标网格边长")
    ap.add_argument("--mode", choices=["mean", "weighted_mode"], help="采样模式")
    ap.add_argument("--palette", help="extract 或内置名（gameboy/cga16/gray8）")
    ap.add_argument("--k", type=int, help="提取颜色数")
    ap.add_argument("--edge-w", type=float, help="边缘权重")
    ap.add_argument("--dark-w", type=float, help="暗部权重")
    ap.add_argument("--contrast-w", type=float, help="局部显著性权重（v1.1）")
    ap.add_argument("--lineart", choices=["off", "xdog", "onnx"], help="线稿模式（转换管线用；独立提取时作为提取模式）")
    ap.add_argument("--lineart-out", metavar="PATH", help="独立线稿提取：输出黑线白纸 PNG（配合 --lineart 选模式，默认 onnx）")
    ap.add_argument("--ink", action="store_true", help="强制启用墨线层")
    ap.add_argument("--preview-scale", type=int, default=8, help="预览放大倍数")
    return ap


def overrides_from_args(args: argparse.Namespace) -> dict:
    ov: dict = {}
    if args.size:
        ov["target"] = {"width": args.size, "height": args.size}
    if args.mode or args.edge_w is not None or args.dark_w is not None or args.contrast_w is not None:
        ov["sampling"] = {}
        if args.mode:
            ov["sampling"]["mode"] = args.mode
        weights = {}
        if args.edge_w is not None:
            weights["edge"] = args.edge_w
        if args.dark_w is not None:
            weights["dark"] = args.dark_w
        if args.contrast_w is not None:
            weights["contrast"] = args.contrast_w
        if weights:
            ov["sampling"]["weights"] = weights
    if args.palette or args.k is not None:
        pal: dict = {}
        if args.palette:
            if args.palette == "extract":
                pal["source"] = "extract"
                pal["ref"] = None
            else:
                pal["source"] = "builtin"
                pal["ref"] = args.palette
        if args.k is not None:
            pal["max_colors"] = args.k
        ov["quantize"] = {"palette": pal}
    if args.lineart:
        ov["structure"] = {"lineart": {"mode": args.lineart}}
    if args.ink:
        ov["ink"] = {"enable": True}
    return ov


def main(argv: list[str] | None = None) -> int:
    args = build_argparser().parse_args(argv)
    src = Path(args.input)
    if not src.exists():
        print(f"输入不存在: {src}", file=sys.stderr)
        return 1

    recipe: Recipe = load_recipe(args.preset, overrides_from_args(args))
    from engine.io_utils import load_rgb

    try:
        image = load_rgb(src)
    except Exception as e:  # noqa: BLE001
        print(f"图片无法解析: {e}", file=sys.stderr)
        return 1

    if args.lineart_out:
        from engine import lineart as lineart_mod

        mode = args.lineart if args.lineart in ("xdog", "onnx") else "onnx"
        L = lineart_mod.extract(image, mode)
        out = Path(args.lineart_out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(lineart_mod.to_paper_png_bytes(L))
        print(f"线稿（{mode}）{image.shape[1]}×{image.shape[0]} -> {out}")
        return 0
    print(f"输入 {image.shape[1]}×{image.shape[0]} → 目标 {recipe.target_wh[0]}×{recipe.target_wh[1]}"
          f"（预设 {args.preset}，模式 {recipe.raw['sampling']['mode']}）")

    t0 = time.perf_counter()
    result = ConversionPipeline().run(image, recipe)
    total_ms = (time.perf_counter() - t0) * 1000

    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(s5_post.export_png(result))
    preview = s5_post.composite_preview(result, args.preview_scale)
    preview_path = out.with_name(out.stem + "_preview.png")
    preview.save(preview_path)

    m = result.meta
    print(f"完成: 网格 {m['size']}，用色 {m['colors_used']}，"
          f"网格阶段 {m['grid_ms']}ms，总计 {total_ms:.1f}ms")
    print(f"  索引图  -> {out}")
    print(f"  预览图  -> {preview_path}（{preview.width}×{preview.height}）")
    if "ink_skipped" in m:
        print(f"  注意: 墨线层跳过（{m['ink_skipped']}）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
