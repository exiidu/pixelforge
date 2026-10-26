"""M4 局部细节重算（rerun_region）的单元测试。"""

import base64
import io

import numpy as np
import pytest
from fastapi import HTTPException
from PIL import Image

from engine.pipeline import ConversionPipeline
from engine.recipe import load_recipe
from engine.server.api import _decode_region_mask, _validate_region_delta
from engine.types import IndexGrid

DELTA = {"sampling": {"weights": {"edge": 3.5, "dark": 2.0}, "soft_ratio": 0.8, "merge_delta": 0.0}}


def _image(seed: int = 0, w: int = 48, h: int = 40) -> np.ndarray:
    rng = np.random.default_rng(seed)
    # 平滑色块 + 噪点：既有可采样区域，也能验证色板追加
    yy, xx = np.mgrid[0:h, 0:w]
    base = np.stack([(xx * 255 // w), (yy * 255 // h), ((xx + yy) * 128 // (w + h))], -1)
    noise = rng.integers(-12, 13, (h, w, 3))
    return np.clip(base + noise, 0, 255).astype(np.uint8)


def _recipe(**over):
    return load_recipe("photo", {"target": {"width": 16, "height": 16}, **over})


def _mask(x0: int, y0: int, x1: int, y1: int, n: int = 16) -> np.ndarray:
    m = np.zeros((n, n), dtype=bool)
    m[y0:y1, x0:x1] = True
    return m


def test_region_only_changes_mask_cells():
    img, recipe = _image(), _recipe()
    pipe = ConversionPipeline()
    base = pipe.run(img, recipe)
    mask = _mask(4, 4, 9, 9)
    out = pipe.rerun_region(img, recipe, mask, DELTA, base, expand_colors=0)
    assert out.fill.data.shape == base.fill.data.shape
    assert (out.fill.data[~mask] == base.fill.data[~mask]).all()
    assert out.meta["changed_cells"] <= int(mask.sum())


def test_palette_prefix_stable_without_expand():
    img, recipe = _image(1), _recipe()
    pipe = ConversionPipeline()
    base = pipe.run(img, recipe)
    out = pipe.rerun_region(img, recipe, _mask(2, 2, 7, 7), DELTA, base, expand_colors=0)
    assert (out.palette.colors == base.palette.colors).all()
    assert out.meta["appended_colors"] == 0


def test_palette_appends_at_tail():
    img, recipe = _image(2), _recipe()
    over = {"quantize": {"palette": {"source": "extract", "max_colors": 4}}}
    recipe = load_recipe("photo", {"target": {"width": 32, "height": 32}, **over})
    pipe = ConversionPipeline()
    base = pipe.run(img, recipe)
    out = pipe.rerun_region(
        img, recipe, _mask(8, 8, 24, 24, 32),
        {"sampling": {"weights": {"edge": 2.5, "dark": 1.8}, "merge_delta": 0.0}},
        base, expand_colors=8,
    )
    assert (out.palette.colors[:len(base.palette.colors)] == base.palette.colors).all()
    assert 0 <= out.meta["appended_colors"] <= 8
    assert len(out.palette.colors) == len(base.palette.colors) + out.meta["appended_colors"]
    assert out.fill.data.max() < len(out.palette.colors)


def test_empty_mask_is_noop():
    img, recipe = _image(3), _recipe()
    pipe = ConversionPipeline()
    base = pipe.run(img, recipe)
    out = pipe.rerun_region(img, recipe, np.zeros((16, 16), bool), DELTA, base, expand_colors=8)
    assert (out.fill.data == base.fill.data).all()
    assert out.meta["changed_cells"] == 0


def test_mask_shape_mismatch_raises():
    img, recipe = _image(4), _recipe()
    pipe = ConversionPipeline()
    base = pipe.run(img, recipe)
    with pytest.raises(ValueError):
        pipe.rerun_region(img, recipe, np.zeros((8, 8), bool), DELTA, base)


def test_chained_rerun_keeps_previous_region():
    img, recipe = _image(5), _recipe()
    pipe = ConversionPipeline()
    base = pipe.run(img, recipe)
    first = _mask(1, 1, 6, 6)
    out1 = pipe.rerun_region(img, recipe, first, DELTA, base, expand_colors=0)
    second = _mask(9, 9, 14, 14)
    out2 = pipe.rerun_region(img, recipe, second, DELTA, out1, expand_colors=0)
    assert (out2.fill.data[~second] == out1.fill.data[~second]).all()


def test_ink_layer_preserved():
    img, recipe = _image(6), _recipe()
    pipe = ConversionPipeline()
    base = pipe.run(img, recipe)
    ink = IndexGrid(data=np.full(base.fill.data.shape, -1, dtype=np.int32))
    ink.data[0, 0] = len(base.palette.colors) - 1
    base.ink = ink
    out = pipe.rerun_region(img, recipe, _mask(0, 0, 4, 4), DELTA, base)
    assert out.ink is ink


def test_builtin_palette_never_expands():
    img = _image(7)
    recipe = load_recipe("photo", {
        "target": {"width": 16, "height": 16},
        "quantize": {"palette": {"source": "builtin", "ref": "gameboy", "max_colors": 4}},
    })
    pipe = ConversionPipeline()
    base = pipe.run(img, recipe)
    assert base.palette.source == "builtin"
    out = pipe.rerun_region(img, recipe, _mask(3, 3, 10, 10), DELTA, base, expand_colors=8)
    assert out.meta["appended_colors"] == 0
    assert (out.palette.colors == base.palette.colors).all()


def test_delta_rejects_non_sampling_keys():
    with pytest.raises(HTTPException) as e:
        _validate_region_delta({"quantize": {"max_colors": 8}})
    assert e.value.status_code == 400
    with pytest.raises(HTTPException):
        _validate_region_delta({"sampling": {"dither": {}}})
    with pytest.raises(HTTPException):
        _validate_region_delta({"sampling": {"weights": {"unknown": 1}}})


def test_delta_accepts_sampling_whitelist():
    out = _validate_region_delta({
        "sampling": {"weights": {"edge": 2.5, "dark": 1.8}, "soft_ratio": 0.8, "merge_delta": 0.0},
    })
    assert out["sampling"]["weights"]["edge"] == 2.5
    assert _validate_region_delta({}) == {}


def _mask_png(w: int, h: int) -> str:
    buf = io.BytesIO()
    Image.fromarray(np.full((h, w), 255, dtype=np.uint8), mode="L").save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


def test_decode_mask_size_check():
    mask = _decode_region_mask(_mask_png(16, 16), 16, 16)
    assert mask.shape == (16, 16) and mask.all()
    with pytest.raises(HTTPException) as e:
        _decode_region_mask(_mask_png(8, 8), 16, 16)
    assert e.value.status_code == 400
