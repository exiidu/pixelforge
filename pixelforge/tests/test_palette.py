"""调色板模块的单元测试。"""

import numpy as np

from engine.core.palette import extract_from_image, load_builtin, nearest_palette_index
from engine.recipe import load_recipe
from engine.stages import s3_quantize


def _img(seed: int = 0, n: int = 32) -> np.ndarray:
    rng = np.random.default_rng(seed)
    return rng.integers(0, 256, (n, n, 3), dtype=np.uint8)


def test_extract_few_colors_exact():
    img = np.zeros((4, 4, 3), dtype=np.uint8)
    img[:2] = [255, 0, 0]
    img[2:] = [0, 0, 255]
    pal = extract_from_image(img, 8)
    assert len(pal.colors) == 2
    idx = nearest_palette_index(img, pal)
    assert idx[:2].max() != idx[2:].max()  # 红/蓝分属不同索引
    assert (idx[:2] == idx[0, 0]).all() and (idx[2:] == idx[2, 0]).all()


def test_builtin_load():
    pal = load_builtin("gameboy")
    assert pal.colors.shape == (4, 3)
    assert pal.source == "builtin"


def test_builtin_roundtrip_index():
    img = np.array([[[15, 56, 15], [155, 188, 15]]], dtype=np.uint8)  # Game Boy 首末色
    pal = load_builtin("gameboy")
    idx = nearest_palette_index(img, pal)
    assert idx.tolist() == [[0, 3]]


# ------------------------------------------------ M5-4 色板锁定（seed_colors）

def _recipe(max_colors: int, seeds: list[list[int]] | None = None):
    over = {"quantize": {"palette": {"source": "extract", "max_colors": max_colors}}}
    if seeds is not None:
        over["quantize"]["palette"]["seed_colors"] = seeds
    return load_recipe("photo", over)


def test_seed_colors_kept_at_tail():
    seeds = [[255, 0, 255], [0, 255, 255]]
    _grid, pal = s3_quantize.run(_img(1), _recipe(8, seeds))
    assert len(pal.colors) <= 8
    tail = [c.tolist() for c in pal.colors[-2:]]
    assert tail == seeds  # 锁定色追加在尾部


def test_seed_colors_reduce_extract_budget():
    no_seed = s3_quantize.run(_img(2), _recipe(8, []))[1]
    with_seed = s3_quantize.run(_img(2), _recipe(8, [[255, 0, 255]]))[1]
    # 种子占掉一个预算：提取色数减少 1，总数不变
    assert len(with_seed.colors) == len(no_seed.colors)
    assert [c.tolist() for c in with_seed.colors[-1:]] == [[255, 0, 255]]


def test_seed_colors_dedupe_against_extracted():
    """锁定色与提取色过近（ΔE<0.03）时丢弃，不重复入板。"""
    img = np.zeros((8, 8, 3), dtype=np.uint8)
    img[...] = [10, 200, 30]
    _grid, pal = s3_quantize.run(img, _recipe(8, [[10, 200, 30]]))
    assert len(pal.colors) == 1  # 唯一色，锁定色被去重


def test_seed_colors_seed_only_when_budget_exhausted():
    seeds = [[255, 0, 0], [0, 255, 0], [0, 0, 255]]
    _grid, pal = s3_quantize.run(_img(3), _recipe(3, seeds))
    assert [c.tolist() for c in pal.colors] == seeds  # 预算全给锁定色
    assert s3_quantize.run(_img(3), _recipe(8, seeds))[1].colors[-3:].tolist() == seeds


def test_seed_colors_capped_at_32():
    seeds = [[i % 256, (i * 5) % 256, (i * 11) % 256] for i in range(40)]
    arr = s3_quantize._seed_colors({"seed_colors": seeds})
    assert len(arr) == 32 and arr.dtype == np.uint8


def test_seed_colors_respect_max_colors_and_builtin_ignores_them():
    seeds = [[i * 6, (i * 13) % 256, (i * 29) % 256] for i in range(16)]
    _grid, pal = s3_quantize.run(_img(4), _recipe(16, seeds))
    assert len(pal.colors) <= 16
    # builtin 不受锁定影响
    builtin_recipe = load_recipe("photo", {
        "quantize": {"palette": {"source": "builtin", "ref": "gameboy",
                                 "max_colors": 4, "seed_colors": seeds}},
    })
    pal2 = s3_quantize.run(_img(4), builtin_recipe)[1]
    assert pal2.source == "builtin" and len(pal2.colors) == 4
