"""grid.build_mapping 的单元测试。"""

import numpy as np

from engine.core.grid import build_mapping


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
