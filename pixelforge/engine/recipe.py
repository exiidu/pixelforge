"""配方(Recipe)：一次转换的全部参数，JSON 可序列化、可存档。

数据结构与 ../conversion-engine-design.md §5 一致；
字段含义的权威定义以设计文档为准，这里只做加载与默认值填充。
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

RECIPES_DIR = Path(__file__).resolve().parent.parent / "recipes"

DEFAULT_RECIPE: dict = {
    "target": {"width": 64, "height": 64},
    "preprocess": {
        "bilateral": {"enable": True, "radius": 3, "strength": 0.6},
        "levels": {"saturation": 1.15, "contrast": 1.05},
        "matting": {"enable": False},
    },
    "structure": {
        "edge": {"dog_sigma": 1.2, "sobel_weight": 0.5},
        "lineart": {"mode": "off", "xdog": {"p": 20, "epsilon": 0.6}},
    },
    "ai": {  # v1 仅接口：enable 恒为 False，接入后由 pipeline 调 Provider
        "enable": False,
        "provider": "comfyui",
        "denoise": 0.55,
        "seed": -1,
    },
    "sampling": {
        "mode": "weighted_mode",  # weighted_mode(主引擎 v1.1) | mean(对照)
        "weights": {"edge": 2.0, "dark": 1.5, "contrast": 1.0},
        "soft_ratio": 1.4,        # v1.1: 前两名票数比低于此值时混合（吸收均值平滑性）
        "merge_delta": 0.05,      # v1.1: ΔE 小于此值的候选桶合并（修复跨桶选票分裂）
        "regions": [],            # v1.5: [{mask, override}]
    },
    "quantize": {
        "palette": {"source": "extract", "ref": None, "max_colors": 64},
        "dither": {"mode": "off", "matrix": 4},
    },
    "ink": {
        "enable": False,
        "opacity": 1.0,
        "recolor": {"mode": "selective", "darken": 0.25},
    },
    "post": {"despeckle": 1},
}


def _merge(base: dict, override: dict) -> dict:
    out = dict(base)
    for k, v in override.items():
        out[k] = _merge(out[k], v) if isinstance(v, dict) and isinstance(out.get(k), dict) else v
    return out


@dataclass
class Recipe:
    """加载后的配方。raw 保留原始 JSON 以便存档与前端回显。"""

    raw: dict = field(default_factory=lambda: json.loads(json.dumps(DEFAULT_RECIPE)))

    @property
    def target_wh(self) -> tuple[int, int]:
        t = self.raw["target"]
        return int(t["width"]), int(t["height"])


def load_recipe(path: str | Path | None = None, overrides: dict | None = None) -> Recipe:
    """加载配方：内置默认值 <- 预设文件 <- 调用方覆盖，三层合并。"""
    data = DEFAULT_RECIPE
    if path is not None:
        p = Path(path)
        if not p.is_absolute() and not p.exists():
            # 无后缀的视为预设名，在 recipes/ 下补 .json 查找
            candidate = RECIPES_DIR / (p.name if p.suffix else f"{p.name}.json")
            if candidate.exists():
                p = candidate
        data = _merge(data, json.loads(p.read_text(encoding="utf-8")))
    if overrides:
        data = _merge(data, overrides)
    return Recipe(raw=data)


def preset_names() -> list[str]:
    return sorted(p.stem for p in RECIPES_DIR.glob("*.json"))
