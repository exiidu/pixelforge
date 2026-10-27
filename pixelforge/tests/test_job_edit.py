"""MCP-3A job 编辑接口的单元测试。"""

from __future__ import annotations

import base64
import io

import numpy as np
import pytest
from fastapi import HTTPException
from PIL import Image

from engine.recipe import load_recipe
from engine.server import api
from engine.types import ConversionResult, IndexGrid, Palette

JOB_ID = "edit-test"
FILL = np.array([
    [0, 1, 2, 0],
    [1, 0, 2, 1],
    [2, 2, 0, 1],
    [0, 1, 2, 0],
], dtype=np.int32)
PAL = np.array([
    [10, 20, 30],
    [200, 40, 40],
    [30, 120, 220],
], dtype=np.uint8)


def _make_job(alpha: np.ndarray | None = None) -> dict:
    result = ConversionResult(
        fill=IndexGrid(data=FILL.copy()),
        ink=None,
        palette=Palette(colors=PAL.copy(), name="test", source="custom"),
        alpha=alpha,
        meta={},
    )
    return {
        "image": np.zeros((4, 4, 3), dtype=np.uint8),
        "recipe": load_recipe("photo"),
        "result": result,
        "revision": 0,
    }


@pytest.fixture()
def job() -> dict:
    api._JOBS[JOB_ID] = _make_job()
    try:
        yield api._JOBS[JOB_ID]
    finally:
        api._JOBS.pop(JOB_ID, None)


def _decode(png_b64: str) -> Image.Image:
    return Image.open(io.BytesIO(base64.b64decode(png_b64)))


def test_grid_and_pixels(job):
    grid = api.job_grid(JOB_ID)
    assert grid["width"] == 4 and grid["height"] == 4
    assert grid["fill"] == FILL.tolist() and grid["alpha"] is None

    new_index = (FILL[0, 0] + 1) % len(PAL)
    r = api.job_pixels(JOB_ID, api.JobPixelsRequest(pixels=[
        api.PixelEdit(x=0, y=0, fill=new_index),
        api.PixelEdit(x=1, y=1, alpha=0),
    ]))
    assert r["changed"] == 2 and r["revision"] == 1
    assert r["alpha_png"] is not None

    after = api.job_grid(JOB_ID)
    assert after["fill"][0][0] == new_index
    assert after["alpha"][1][1] == 0 and after["alpha"][0][0] == 1
    assert after["revision"] == 1


def test_pixels_creates_ink_layer(job):
    r = api.job_pixels(JOB_ID, api.JobPixelsRequest(pixels=[
        api.PixelEdit(x=2, y=2, ink=1),
    ]))
    assert r["changed"] == 1
    grid = api.job_grid(JOB_ID)
    assert grid["ink"] is not None and grid["ink"][2][2] == 1
    assert grid["ink_visible"] is True


@pytest.mark.parametrize("kwargs", [
    {"x": 9, "y": 0, "fill": 0},
    {"x": 0, "y": 0, "fill": 99},
    {"x": 0, "y": 0, "ink": 99},
    {"x": 0, "y": 0, "alpha": 2},
])
def test_pixels_rejects_invalid_fields(job, kwargs):
    with pytest.raises(HTTPException) as exc:
        api.job_pixels(JOB_ID, api.JobPixelsRequest(pixels=[api.PixelEdit(**kwargs)]))
    assert exc.value.status_code == 400


def test_pixels_revision_conflict(job):
    with pytest.raises(HTTPException) as exc:
        api.job_pixels(JOB_ID, api.JobPixelsRequest(
            pixels=[api.PixelEdit(x=0, y=0, fill=1)], revision=99,
        ))
    assert exc.value.status_code == 409


def test_fill_region_non_contiguous(job):
    r = api.job_fill(JOB_ID, api.JobFillRequest(
        x=0, y=0, fill=2, contiguous=False,
    ))
    assert r["changed"] == int((FILL == 0).sum())
    assert (api._JOBS[JOB_ID]["result"].fill.data == np.where(FILL == 0, 2, FILL)).all()


def test_palette_transform_keeps_indices(job):
    before_fill = api._JOBS[JOB_ID]["result"].fill.data.copy()
    r = api.job_palette(JOB_ID, api.PaletteTransformRequest(
        lightness=0.2, hue=30, saturation=0.1,
    ))
    assert r["changed"] == 1
    assert len(r["palette"]) == len(PAL) and r["palette"] != PAL.tolist()
    assert (api._JOBS[JOB_ID]["result"].fill.data == before_fill).all()
    assert api._JOBS[JOB_ID]["revision"] == 1


def test_palette_transform_rejects_range(job):
    with pytest.raises(HTTPException) as exc:
        api.job_palette(JOB_ID, api.PaletteTransformRequest(hue=999))
    assert exc.value.status_code == 400


def test_export_composite_and_indexed(job):
    alpha = np.ones((4, 4), dtype=np.uint8)
    alpha[1, 1] = 0
    api._JOBS[JOB_ID]["result"].alpha = alpha

    comp = api.job_export(JOB_ID, api.JobExportRequest(
        content="composite", scale=2, transparent=True,
    ))
    assert comp["width"] == 8 and comp["height"] == 8 and comp["transparent"] is True
    rgba = np.asarray(_decode(comp["png"]).convert("RGBA"))
    assert tuple(rgba[0, 0]) == (10, 20, 30, 255)
    assert rgba[2, 2, 3] == 0  # 4×4 的 (1,1) 在 2× 后是 (2,2)

    idx = api.job_export(JOB_ID, api.JobExportRequest(
        content="indexed", scale=1, transparent=True,
    ))
    assert idx["transparent"] is True
    img = _decode(idx["png"])
    assert img.mode == "P"
    assert tuple(np.asarray(img.convert("RGBA"))[1, 1]) == (0, 0, 0, 0)


@pytest.mark.parametrize("content,scale", [("bad", 1), ("composite", 0), ("indexed", 17)])
def test_export_rejects_invalid(job, content, scale):
    with pytest.raises(HTTPException) as exc:
        api.job_export(JOB_ID, api.JobExportRequest(content=content, scale=scale))
    assert exc.value.status_code == 400


def test_rerun_region_builds_rect_mask(job, monkeypatch):
    captured: dict = {}

    def fake_rerun(image, recipe, mask, delta, base, expand_colors=0):
        captured["mask"] = mask.copy()
        captured["delta"] = delta
        return base

    monkeypatch.setattr(api._pipeline, "rerun_region", fake_rerun)
    r = api.job_rerun(JOB_ID, api.JobRerunRequest(
        rect=api.RegionRect(x0=0, y0=0, x1=1, y1=1),
        param_delta={"sampling": {"weights": {"edge": 3.0}}},
    ))
    assert captured["mask"].sum() == 4
    assert captured["delta"] == {"sampling": {"weights": {"edge": 3.0}}}
    assert r["changed"] == 0 and r["revision"] == 1


def test_rerun_region_requires_area(job):
    with pytest.raises(HTTPException) as exc:
        api.job_rerun(JOB_ID, api.JobRerunRequest())
    assert exc.value.status_code == 400
