"""M5-1 索引 PNG 导出（/api/export_indexed）的单元测试。"""

import base64
import io

import numpy as np
import pytest
from fastapi import HTTPException
from PIL import Image

from engine.server.api import ExportIndexedRequest, export_indexed

PAL = [[10, 20, 30], [200, 40, 40], [30, 120, 220]]


def _decode(png_b64: str) -> Image.Image:
    return Image.open(io.BytesIO(base64.b64decode(png_b64)))


def test_indexed_png_with_transparency():
    indices = [[0, 1], [-1, 2]]
    r = export_indexed(ExportIndexedRequest(palette=PAL, indices=indices))
    assert r["width"] == 2 and r["height"] == 2
    assert r["transparent"] is True and r["colors"] == 4  # 占位 + 3 用色
    img = _decode(r["png"])
    assert img.mode == "P"
    rgba = np.asarray(img.convert("RGBA"))
    assert tuple(rgba[0, 0]) == (10, 20, 30, 255)
    assert tuple(rgba[0, 1]) == (200, 40, 40, 255)
    assert tuple(rgba[1, 0]) == (0, 0, 0, 0)      # 透明格
    assert tuple(rgba[1, 1]) == (30, 120, 220, 255)


def test_indexed_png_opaque_has_no_trns():
    r = export_indexed(ExportIndexedRequest(palette=PAL, indices=[[0, 1], [1, 2]]))
    assert r["transparent"] is False and r["colors"] == 3
    raw = base64.b64decode(r["png"])
    assert b"tRNS" not in raw
    img = _decode(r["png"])
    assert tuple(np.asarray(img.convert("RGBA"))[0, 0]) == (10, 20, 30, 255)


def test_indexed_png_only_keeps_used_colors():
    """未用到的调色板颜色不进输出；输出索引按用色重排。"""
    r = export_indexed(ExportIndexedRequest(palette=PAL, indices=[[2, 2], [2, 2]]))
    assert r["colors"] == 1
    assert tuple(np.asarray(_decode(r["png"]).convert("RGBA"))[0, 0]) == (30, 120, 220, 255)


def test_indexed_png_resize_nearest():
    r = export_indexed(
        ExportIndexedRequest(palette=PAL, indices=[[0, 1], [-1, 2]], width=4, height=4))
    assert r["width"] == 4 and r["height"] == 4
    rgba = np.asarray(_decode(r["png"]).convert("RGBA"))
    assert tuple(rgba[0, 0]) == (10, 20, 30, 255)   # 最近邻放大：2×2 块
    assert tuple(rgba[0, 3]) == (200, 40, 40, 255)
    assert tuple(rgba[3, 0]) == (0, 0, 0, 0)
    assert tuple(rgba[3, 3]) == (30, 120, 220, 255)


def test_indexed_png_rejects_over_256_colors():
    pal = [[i % 256, (i * 7) % 256, (i * 13) % 256] for i in range(300)]
    indices = [list(range(300))]
    with pytest.raises(HTTPException) as e:
        export_indexed(ExportIndexedRequest(palette=pal, indices=indices))
    assert e.value.status_code == 400


def test_indexed_png_rejects_bad_input():
    with pytest.raises(HTTPException):
        export_indexed(ExportIndexedRequest(palette=PAL, indices=[[0, 9]]))  # 越界
    with pytest.raises(HTTPException):
        export_indexed(ExportIndexedRequest(palette=PAL, indices=[]))       # 空
    with pytest.raises(HTTPException):
        export_indexed(ExportIndexedRequest(palette=[[1, 2]], indices=[[0]]))  # 调色板非 N×3
    with pytest.raises(HTTPException):
        export_indexed(ExportIndexedRequest(palette=PAL, indices=[[0]], width=99999))
