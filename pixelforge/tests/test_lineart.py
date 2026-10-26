"""XDoG 线稿的单元测试。"""

import numpy as np

from engine.recipe import load_recipe
from engine.stages.s1_structure import xdog_lineart


def test_xdog_outlines_square_and_ignores_flats():
    img = np.full((48, 48, 3), 255, dtype=np.uint8)
    img[12:36, 12:36] = 40  # 深色方块
    L = xdog_lineart(img, load_recipe(None))

    assert L.shape == (48, 48)
    assert L[12, 24] > 0.3   # 上边缘是线
    assert L[24, 12] > 0.3   # 左边缘是线
    assert L[36 - 1, 24] > 0.3 or L[35, 24] > 0.3  # 下边缘附近有响应
    assert L[3, 3] < 0.1     # 亮平区无线
    assert L[24, 24] < 0.1   # 暗平区被边缘门控压掉（XDoG 已知特性）
