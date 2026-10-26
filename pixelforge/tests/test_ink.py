"""S4 墨线层的单元测试。"""

import numpy as np

from engine.recipe import load_recipe
from engine.stages import s4_ink
from engine.types import IndexGrid, Palette


def _recipe(ink_over: dict):
    return load_recipe(None, {"ink": ink_over})


def _scene():
    L = np.zeros((16, 16), dtype=np.float32)
    L[:, 6:8] = 1.0  # 2px 竖线，完整落在第 2 列格子（cols 4..7）
    fill = IndexGrid(data=np.zeros((4, 4), dtype=np.int32))
    pal = Palette(colors=np.array([[200, 200, 200]], dtype=np.uint8))
    return L, fill, pal


def test_selective_ink_extends_palette():
    L, fill, pal = _scene()
    ink, pal2 = s4_ink.run(
        L, fill, pal,
        _recipe({"enable": True, "opacity": 1.0,
                 "recolor": {"mode": "selective", "darken": 0.5}}),
    )
    assert (ink.data[:, 1] >= 1).all()      # 线所在列全部为墨线（新调色板索引）
    assert (ink.data[:, 0] == -1).all()     # 非墨线格为哨兵
    assert len(pal2.colors) == 2            # 追加了一个加深色
    assert pal2.colors[1].astype(int).max() < 200  # 新色确实更暗


def test_black_ink_snaps_to_palette():
    L, fill, pal = _scene()
    pal = Palette(colors=np.array([[200, 200, 200], [20, 20, 20]], dtype=np.uint8))
    ink, pal2 = s4_ink.run(
        L, fill, pal,
        _recipe({"enable": True, "opacity": 1.0,
                 "recolor": {"mode": "black", "darken": 0.5}}),
    )
    assert (ink.data[:, 1] == 1).all()      # 吸附到最近的深色
    assert len(pal2.colors) == 2            # 调色板不变


def test_no_line_gives_empty_hidden_layer():
    L = np.zeros((16, 16), dtype=np.float32)
    fill, pal = _scene()[1], _scene()[2]
    ink, pal2 = s4_ink.run(
        L, fill, pal,
        _recipe({"enable": True, "opacity": 1.0,
                 "recolor": {"mode": "selective", "darken": 0.5}}),
    )
    assert not ink.visible
    assert (ink.data == -1).all()
    assert pal2 is pal
