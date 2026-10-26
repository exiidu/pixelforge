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
from engine.types import ConversionArtifacts, ConversionResult, RGBImage


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
    def run(self, image: RGBImage, recipe: Recipe) -> ConversionResult:
        art = self._precompute(image, recipe)
        return self._grid_stages(image, art, recipe)

    def rerun_region(
        self, image: RGBImage, recipe: Recipe, region: "np.ndarray", param_delta: dict
    ) -> ConversionResult:
        """局部重转换：region 内以 param_delta 覆盖参数重跑 S2–S5，区域外保留原结果。
        v1.5 实现；契约先行占位。"""
        raise NotImplementedError

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
        small = s2_sampling.run(art.P0, art.E, recipe, recipe.target_wh)
        fill, palette = s3_quantize.run(small, recipe)

        meta: dict = {"recipe": recipe.raw, "size": recipe.target_wh}
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
