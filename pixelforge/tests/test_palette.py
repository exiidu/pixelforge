"""调色板模块的单元测试。"""

import numpy as np

from engine.core.palette import extract_from_image, load_builtin, nearest_palette_index


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
