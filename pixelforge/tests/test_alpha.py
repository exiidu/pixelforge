"""M5-0 网格 alpha（真透明与主体分离）的单元测试。"""

import io

import numpy as np
from PIL import Image

from engine.core.grid import build_mapping
from engine.pipeline import ALPHA_TRANSPARENT_THRESHOLD, ConversionPipeline, grid_alpha
from engine.recipe import load_recipe
from engine.server.api import _alpha_png
from engine.types import ConversionResult, IndexGrid, Palette


def _recipe(size: int = 8):
    return load_recipe("photo", {"target": {"width": size, "height": size}})


def test_grid_alpha_even_division_is_exact_mean():
    """8×8 源 → 4×4 网格：每格 2×2，alpha 应为源区均值二值化。"""
    a = np.zeros((8, 8), np.float32)
    a[0:2, 0:2] = 1.0     # 格(0,0) → 1
    a[2:4, 0:2] = 0.5     # 格(1,0) 均值 0.5 ≥ 0.35 → 1
    a[4:6, 0:2] = 0.2     # 格(2,0) 均值 0.2 < 0.35 → 0
    out = grid_alpha(a, build_mapping((8, 8), (4, 4)))
    assert out.shape == (4, 4) and out.dtype == np.uint8
    assert out[0, 0] == 1 and out[1, 0] == 1 and out[2, 0] == 0
    assert out[3, 0] == 0


def test_grid_alpha_threshold_boundary():
    hi = np.full((2, 2), ALPHA_TRANSPARENT_THRESHOLD + 0.02, np.float32)
    lo = np.full((2, 2), ALPHA_TRANSPARENT_THRESHOLD - 0.02, np.float32)
    assert (grid_alpha(hi, build_mapping((2, 2), (2, 2))) == 1).all()
    assert (grid_alpha(lo, build_mapping((2, 2), (2, 2))) == 0).all()


def test_grid_alpha_shape_mismatch_raises():
    try:
        grid_alpha(np.ones((4, 4), np.float32), build_mapping((8, 8), (4, 4)))
    except ValueError:
        return
    raise AssertionError("尺寸不符应抛 ValueError")


def test_grid_alpha_empty_cells_default_opaque():
    """放大时 build_mapping 会留空档；无源像素落入的格子不应被记为透明。"""
    alpha = np.zeros((2, 2), np.float32)      # 全透明源
    out = grid_alpha(alpha, build_mapping((2, 2), (4, 4)))
    assert out.shape == (4, 4)
    assert int((out == 0).sum()) == 4         # 4 个被源像素覆盖的格子透明
    assert int((out == 1).sum()) == 12        # 12 个空档格记不透明


def _image(seed: int = 0, w: int = 16, h: int = 16) -> np.ndarray:
    rng = np.random.default_rng(seed)
    return rng.integers(0, 256, (h, w, 3), dtype=np.uint8)


def test_pipeline_run_attaches_grid_alpha():
    img = _image()
    alpha = np.ones((16, 16), np.float32)
    alpha[:, :4] = 0.0  # 源左侧 4 列透明 → 16→8 下采样后占网格左 2 列
    result = ConversionPipeline().run(img, _recipe(), alpha)
    assert result.alpha is not None and result.alpha.shape == result.fill.data.shape
    assert (result.alpha[:, :2] == 0).all()   # 网格左 2 列透明
    assert (result.alpha[:, 4:] == 1).all()   # 右侧不透明


def test_pipeline_run_without_alpha_leaves_none():
    result = ConversionPipeline().run(_image(1), _recipe())
    assert result.alpha is None


def test_rerun_region_preserves_alpha():
    img, recipe = _image(2), _recipe()
    alpha = np.ones((16, 16), np.float32)
    alpha[0:4, :] = 0.0
    pipe = ConversionPipeline()
    base = pipe.run(img, recipe, alpha)
    mask = np.zeros((8, 8), bool)
    mask[2:5, 2:5] = True
    out = pipe.rerun_region(
        img, recipe, mask,
        {"sampling": {"weights": {"edge": 3.0, "dark": 2.0}, "merge_delta": 0.0}},
        base,
    )
    assert out.alpha is base.alpha  # 与 fill 正交：重算不改


def test_alpha_png_none_without_transparency():
    fill = IndexGrid(data=np.zeros((4, 4), np.int32))
    res = ConversionResult(fill=fill, ink=None, palette=Palette(colors=np.zeros((1, 3), np.uint8)))
    assert _alpha_png(res) is None                              # 未携带 alpha
    res.alpha = np.ones((4, 4), np.uint8)
    assert _alpha_png(res) is None                              # 全不透明 → 视作无 alpha 素材
    res.alpha[1, 1] = 0
    png = _alpha_png(res)
    assert isinstance(png, str) and len(png) > 0


def test_alpha_png_roundtrip_values():
    res = ConversionResult(
        fill=IndexGrid(data=np.zeros((2, 2), np.int32)),
        ink=None,
        palette=Palette(colors=np.zeros((1, 3), np.uint8)),
        alpha=np.array([[0, 1], [1, 0]], np.uint8),
    )
    import base64

    img = Image.open(io.BytesIO(base64.b64decode(_alpha_png(res)))).convert("L")
    arr = np.asarray(img)
    assert arr[0, 0] == 0 and arr[0, 1] == 255
    assert arr[1, 0] == 255 and arr[1, 1] == 0
