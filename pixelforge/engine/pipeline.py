"""管线组装：阶段调度、缓存、增量重跑。引擎的全貌入口。

两级结构（性能模型见设计文档 §7）：
- 预计算 S0+S1：百毫秒级，按 (源图哈希, S0/S1参数) 缓存，参数不变不重算
- 网格级 S2–S5：毫秒级，任何参数改动全量重跑也够快；rerun_region 只重算区域

AI 插点：recipe 的 preprocess.matting.enable / structure.lineart.mode=="onnx" 时经
AIProviders 调用；模型在位自动挂真 Provider（惰性加载），缺失回退 UnavailableProvider。
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass

import numpy as np

from engine.ai.base import LineartProvider, MattingProvider, RegenerationProvider
from engine.ai.stub import UnavailableProvider
from engine.recipe import Recipe
from engine.types import ConversionArtifacts, ConversionResult, IndexGrid, Palette, RGBImage

# M5-0 网格 alpha：源区 alpha 均值 < 该阈值记透明（像素画按格二值化）
ALPHA_TRANSPARENT_THRESHOLD = 0.35


def grid_alpha(alpha: np.ndarray, mapping, threshold: float = ALPHA_TRANSPARENT_THRESHOLD) -> np.ndarray:
    """源分辨率 alpha (H, W) 0..1 → 网格 (th, tw) uint8 0/1（源区均值 ≥ 阈值记不透明）。

    用与 S2 采样相同的网格归属，保证 alpha 格与 fill 格一一对应。
    无源像素落入的格子（放大时 build_mapping 会留空档）无 alpha 信息 → 记不透明，
    避免把"没有数据"误判成透明。
    """
    a = np.asarray(alpha, dtype=np.float64)
    if a.shape[:2] != mapping.src_shape:
        raise ValueError(f"alpha 尺寸必须为 {mapping.src_shape}，实际 {a.shape[:2]}")
    th, tw = mapping.grid_shape
    n_cells = th * tw
    counts = np.bincount(mapping.cell_index, minlength=n_cells).astype(np.float64)
    sums = np.bincount(mapping.cell_index, weights=a.reshape(-1), minlength=n_cells)
    mean = sums / np.maximum(counts, 1.0)
    opaque = (counts <= 0) | (mean >= threshold)
    return opaque.astype(np.uint8).reshape(th, tw)


@dataclass
class AIProviders:
    lineart: LineartProvider = None        # type: ignore[assignment]
    matting: MattingProvider = None        # type: ignore[assignment]
    regen: RegenerationProvider = None     # type: ignore[assignment]

    def __post_init__(self) -> None:
        # 模型文件在位则挂真 Provider（惰性加载，构造零开销），否则回退不可用实现
        from pathlib import Path

        models_dir = Path(__file__).resolve().parent.parent / "models"
        if self.lineart is None:
            if (models_dir / "lineart" / "model.onnx").exists():
                from engine.ai.onnx_lineart import OnnxLineartProvider

                self.lineart = OnnxLineartProvider()
            else:
                self.lineart = UnavailableProvider("lineart")
        if self.matting is None:
            matting_dir = models_dir / "matting"
            if (matting_dir / "u2net.onnx").exists() or (matting_dir / "u2netp.onnx").exists():
                from engine.ai.rembg_matting import U2NetMattingProvider

                self.matting = U2NetMattingProvider()
            else:
                self.matting = UnavailableProvider("matting")
        # ComfyUI 重绘档后续接入，保持不可用实现
        self.regen = self.regen or UnavailableProvider("comfyui.img2img")


class ConversionPipeline:
    def __init__(self, ai: AIProviders | None = None) -> None:
        self.ai = ai or AIProviders()
        self._art_cache: dict[str, ConversionArtifacts] = {}

    # ------------------------------------------------------------------
    def run(
        self, image: RGBImage, recipe: Recipe, alpha: np.ndarray | None = None
    ) -> ConversionResult:
        art = self._precompute(image, recipe)
        result = self._grid_stages(image, art, recipe)
        if alpha is not None:
            from engine.core.grid import build_mapping

            tw, th = recipe.target_for(art.P0.shape[:2])
            mapping = build_mapping(art.P0.shape[:2], (th, tw))
            result.alpha = grid_alpha(alpha, mapping)
        return result

    def rerun_region(
        self,
        image: RGBImage,
        recipe: Recipe,
        region: "np.ndarray",
        param_delta: dict,
        base: ConversionResult,
        expand_colors: int = 0,
    ) -> ConversionResult:
        """局部重转换（M4）：region 内用 param_delta 重跑 S2，区域外保留 base。

        约束（与编辑器契约一致）：
        - 只接受 sampling 增量；量化沿用 base 调色板，旧索引语义不变；
        - 区域不再是 extract 色板时，可从区域片追加 ≤expand_colors 个新色到色板尾部；
        - 墨线层原样保留（不改 ink，避免 s4 重着色再动色板）。
        """
        import copy
        import time

        from engine.core.oklab import delta_e, rgb_to_oklab
        from engine.core.palette import extract_from_image, nearest_palette_index
        from engine.stages import s2_sampling

        t0 = time.perf_counter()
        th, tw = base.fill.data.shape  # 网格以 base 为准（可能非正方形）
        mask = np.asarray(region, dtype=bool)
        if mask.shape != (th, tw):
            raise ValueError(f"区域掩码尺寸必须为 {tw}×{th}，实际 {mask.shape[::-1]}")

        raw = copy.deepcopy(recipe.raw)
        for k, v in (param_delta or {}).items():
            if isinstance(v, dict) and isinstance(raw.get(k), dict):
                raw[k] = {**raw[k], **v}
            else:
                raw[k] = v
        merged = Recipe(raw=raw)

        art = self._precompute(image, recipe)  # preprocess/structure 未变 → 命中缓存
        small = s2_sampling.run(art.P0, art.E, merged, (tw, th))

        palette = base.palette
        appended = 0
        if expand_colors > 0 and palette.source == "extract" and mask.any():
            extra = extract_from_image(small[mask].reshape(-1, 1, 3), int(expand_colors))
            old_labs = rgb_to_oklab(palette.colors)
            keep: list[np.ndarray] = []
            for c in extra.colors:
                lab = rgb_to_oklab(c.reshape(1, 1, 3))
                if len(old_labs) and float(delta_e(lab, old_labs).min()) < 0.03:
                    continue  # 与现有色太近，不追加
                if keep:
                    kl = rgb_to_oklab(np.stack(keep).reshape(-1, 1, 3))
                    if float(delta_e(lab, kl).min()) < 0.03:
                        continue  # 与已追加色重复
                keep.append(c.astype(np.uint8))
                if len(keep) >= int(expand_colors):
                    break
            if keep:
                palette = Palette(
                    colors=np.vstack([palette.colors, np.stack(keep)]),
                    name=palette.name,
                    source=palette.source,
                )
                appended = len(keep)

        idx = nearest_palette_index(small, palette)
        fill_data = base.fill.data.copy()
        changed = int((idx[mask] != fill_data[mask]).sum())
        fill_data[mask] = idx[mask]

        meta = {
            "size": recipe.target_wh,
            "changed_cells": changed,
            "appended_colors": appended,
            "region_ms": round((time.perf_counter() - t0) * 1000, 1),
        }
        return ConversionResult(
            fill=IndexGrid(data=fill_data),
            ink=base.ink,  # 墨线原样保留
            palette=palette,
            meta=meta,
            alpha=base.alpha,  # M5-0：网格 alpha 与 fill 正交，重算不改
        )

    # ------------------------------------------------------------------
    def _precompute(self, image: RGBImage, recipe: Recipe) -> ConversionArtifacts:
        """S0 预处理 + S1 结构分析（含可选 AI 插点），按缓存键复用。TODO"""
        key = self._art_cache_key(image, recipe)
        if key not in self._art_cache:
            from engine.stages import s0_preprocess, s1_structure  # 延迟导入避免环

            P0 = s0_preprocess.run(image, recipe, self.ai.matting)
            E, L = s1_structure.run(P0, recipe, self.ai.lineart)
            self._art_cache[key] = ConversionArtifacts(P0=P0, E=E, L=L)
        return self._art_cache[key]

    def _grid_stages(
        self, image: RGBImage, art: ConversionArtifacts, recipe: Recipe
    ) -> ConversionResult:
        """S2 采样 → S3 量化 → S4 墨线(线稿缺位时跳过) → S5 后处理。"""
        import time

        from engine.stages import s2_sampling, s3_quantize, s4_ink, s5_post

        t0 = time.perf_counter()
        tw, th = recipe.target_for(art.P0.shape[:2])  # 可能非正方形（preserve_aspect）
        small = s2_sampling.run(art.P0, art.E, recipe, (tw, th))
        fill, palette = s3_quantize.run(small, recipe)

        meta: dict = {"recipe": recipe.raw, "size": (tw, th)}
        ink = None
        if recipe.raw["ink"]["enable"]:
            if art.L is None:
                meta["ink_skipped"] = "线稿不可用（lineart 模式为 off）"
            else:
                ink, palette = s4_ink.run(art.L, fill, palette, recipe)

        result = ConversionResult(fill=fill, ink=ink, palette=palette, meta=meta)
        s5_post.despeckle(result, int(recipe.raw["post"]["despeckle"]))
        used = len(np.unique(fill.data))
        result.meta["colors_used"] = used
        result.meta["grid_ms"] = round((time.perf_counter() - t0) * 1000, 1)
        return result

    @staticmethod
    def _art_cache_key(image: RGBImage, recipe: Recipe) -> str:
        h = hashlib.sha256(np.ascontiguousarray(image)).hexdigest()[:16]
        p0 = recipe.raw["preprocess"]
        p1 = recipe.raw["structure"]
        return f"{h}|{p0}|{p1}"
