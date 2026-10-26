"""grid.build_mapping 的单元测试。"""

import numpy as np
from PIL import Image

from engine.core.grid import build_mapping
from engine.recipe import load_recipe


def test_all_pixels_assigned():
    m = build_mapping((10, 10), (3, 3))
    assert m.cell_index.shape == (100,)
    assert m.cell_index.min() == 0
    assert m.cell_index.max() == 8


def test_even_division_counts():
    m = build_mapping((8, 8), (4, 4))
    counts = np.bincount(m.cell_index, minlength=16)
    assert (counts == 4).all()


def test_row_major_order():
    m = build_mapping((2, 2), (2, 2))
    assert list(m.cell_index) == [0, 1, 2, 3]


def test_uneven_scale_covers_all():
    m = build_mapping((10, 10), (3, 3))
    counts = np.bincount(m.cell_index, minlength=9)
    assert counts.sum() == 100
    assert (counts >= 9).all()  # 每格至少 3×3


def test_downscale_and_same_size_have_no_empty_cells():
    for src, grid in [((10, 10), (3, 3)), ((8, 8), (8, 8)), ((64, 64), (16, 16))]:
        m = build_mapping(src, grid)
        assert m.covered.all(), f"{src}→{grid} 不应有空档格"


def test_upscale_reports_empty_cells_and_representative_pixels():
    """放大网格：源像素数 < 格数 → 必然有空档格，且每格都有合法代表源像素。"""
    m = build_mapping((4, 4), (6, 6))
    assert int((~m.covered).sum()) == 6 * 6 - 4 * 4
    assert m.cell_src.shape == (36,)
    assert m.cell_src.min() >= 0 and m.cell_src.max() < 16
    # 覆盖格的代表像素应落在该格内（格中心 floor 的自然性质）
    cell_of_src = m.cell_index
    assert (cell_of_src[m.cell_src[m.covered]] == np.flatnonzero(m.covered)).all()


def test_upscale_representative_pixels_are_monotone():
    """代表源像素随格号单调不减（放大按最近邻展开，不应出现回跳）。"""
    m = build_mapping((48, 48), (64, 64))
    rows = m.cell_src.reshape(64, 64) // 48
    cols = m.cell_src.reshape(64, 64) % 48
    assert (np.diff(rows.astype(int), axis=0) >= 0).all()
    assert (np.diff(cols.astype(int), axis=1) >= 0).all()


# ---------------- 非正方形素材：target.preserve_aspect ----------------

def _aspect_recipe(size: int):
    return load_recipe("photo", {"target": {"width": size, "height": size, "preserve_aspect": True}})


def test_target_for_keeps_source_aspect():
    r = _aspect_recipe(64)
    assert r.target_for((1080, 1920)) == (64, 36)   # 16:9 横向 → 长边 64
    assert r.target_for((1920, 1080)) == (36, 64)   # 9:16 纵向 → 长边 64
    assert r.target_for((512, 512)) == (64, 64)     # 正方形不变
    assert r.target_for((100, 1000)) == (64, 6)     # 极扁：短边至少 1
    assert r.target_for((1000, 100)) == (6, 64)
    assert r.target_for((1, 2000)) == (64, 1)       # 退化为 1 px 也不报错


def test_target_for_default_does_not_change_behavior():
    """默认 preserve_aspect=False → 引擎行为与旧版完全一致（既有调用/测试不受影响）。"""
    r = load_recipe("photo", {"target": {"width": 32, "height": 32}})
    assert r.target_for((1080, 1920)) == (32, 32)
    assert r.target_wh == (32, 32)


def test_pipeline_produces_non_square_grid():
    from engine.pipeline import ConversionPipeline

    img = np.zeros((18, 32, 3), dtype=np.uint8)
    img[..., 0] = 200
    img[4:14, 8:24] = [40, 40, 220]

    out = ConversionPipeline().run(img, _aspect_recipe(16))
    assert out.fill.data.shape == (9, 16)   # 32:18 → 16:9
    assert out.ink is None or out.ink.data.shape == (9, 16)
