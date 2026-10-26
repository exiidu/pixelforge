"""引擎本地服务（编辑器后端）——已接真实管线。

路由总览（详见设计文档 §6）：
- GET  /api/health              状态：预设、模型在位情况、Provider 类型
- POST /api/convert             {image_path, recipe?, overrides?} → 转换结果 + job_id
- POST /api/convert_file        multipart 上传版 convert（编辑器文件选择用）
- GET  /api/stage/{job}/{stage} 中间产物导出 p0|edge|lineart|fill|ink|preview
- POST /api/extract_palette     {image_path, k} → 从图提取调色板
- POST /api/lineart             {image_path, mode} → 独立线稿提取（黑线白纸）
- POST /api/lineart_file        multipart 上传版线稿提取（编辑器文件选择用）
- GET/POST /api/session         编辑器会话自动保存（web/session.json）
- WS   /api/preview             参数变更实时预览推送
- POST /api/rerun_region        局部重转换（v1.5，暂 501）

返回的 fill/ink 为调色板索引二维数组（墨线层非线格为 -1），编辑器直接可编辑。
"""

from __future__ import annotations

import base64
import io
import json
import uuid
from pathlib import Path

import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image
from pydantic import BaseModel

from engine.pipeline import AIProviders, ConversionPipeline
from engine.recipe import Recipe, load_recipe, preset_names
from engine.stages import s5_post

app = FastAPI(title="PixelForge Engine", version="0.2.0")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)

_pipeline = ConversionPipeline()
_JOBS: dict[str, dict] = {}
UPLOAD_DIR = Path(__file__).resolve().parents[2] / ".cache" / "uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
SESSION_PATH = Path(__file__).resolve().parents[2] / "web" / "session.json"


class ConvertRequest(BaseModel):
    image_path: str
    recipe: str | None = None      # 预设名或文件路径
    overrides: dict | None = None  # 参数覆盖


class ExtractPaletteRequest(BaseModel):
    image_path: str
    k: int = 64


class LineartRequest(BaseModel):
    image_path: str
    mode: str = "onnx"    # onnx | xdog


class MattingRequest(BaseModel):
    image_path: str


class RerunRegionRequest(BaseModel):
    job_id: str
    region_png: str                # 区域蒙版（白=重算）
    param_delta: dict


class SessionRequest(BaseModel):
    data: dict                     # 编辑器序列化的会话（版本/文档/UI 状态）


def _load_image(path: str) -> np.ndarray:
    p = Path(path)
    if not p.is_absolute():
        p = Path.cwd() / p
    if not p.exists():
        raise HTTPException(404, f"图片不存在: {p}")
    from engine.io_utils import load_rgb

    try:
        img = load_rgb(p)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"图片无法解析: {e}") from e
    if img.ndim != 3 or img.shape[2] != 3:
        raise HTTPException(400, "非常规 RGB 图片")
    return img


def _png_b64(arr: np.ndarray, mode: str) -> str:
    buf = io.BytesIO()
    Image.fromarray(arr, mode=mode).save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


def _thumb_b64(image: np.ndarray) -> str:
    """源图缩略（≤1024）：编辑器对比浮层/描图底图用。"""
    src = Image.fromarray(image)
    src.thumbnail((1024, 1024))
    buf = io.BytesIO()
    src.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


def _result_payload(job_id: str, result, source_png: str | None = None) -> dict:
    preview = s5_post.composite_preview(result, scale=1)
    buf = io.BytesIO()
    preview.save(buf, format="PNG")
    return {
        "job_id": job_id,
        "width": int(result.fill.data.shape[1]),
        "height": int(result.fill.data.shape[0]),
        "palette": result.palette.colors.tolist(),
        "fill": result.fill.data.tolist(),
        "ink": result.ink.data.tolist() if result.ink is not None else None,
        "preview_png": base64.b64encode(buf.getvalue()).decode(),
        "source_png": source_png,
        "meta": {k: v for k, v in result.meta.items() if k != "recipe"},
        "recipe": result.meta.get("recipe"),
    }


def _convert(image: np.ndarray, recipe: Recipe) -> dict:
    result = _pipeline.run(image, recipe)
    job_id = uuid.uuid4().hex[:12]
    _JOBS[job_id] = {"image": image, "recipe": recipe, "result": result}
    # 源图缩略（编辑器对比浮层 / 描图底图用）
    return _result_payload(job_id, result, _thumb_b64(image))


@app.get("/api/health")
def health():
    models_dir = Path(__file__).resolve().parents[2] / "models"
    ai = AIProviders()  # 惰性构造，仅看类型
    return {
        "status": "ok",
        "version": app.version,
        "presets": preset_names(),
        "models": {
            "lineart": (models_dir / "lineart" / "model.onnx").exists(),
            "matting_u2net": (models_dir / "matting" / "u2net.onnx").exists(),
            "matting_u2netp": (models_dir / "matting" / "u2netp.onnx").exists(),
        },
        "providers": {
            "lineart": type(ai.lineart).__name__,
            "matting": type(ai.matting).__name__,
            "regen": type(ai.regen).__name__,
        },
        "jobs_cached": len(_JOBS),
    }


@app.post("/api/convert")
def convert(req: ConvertRequest):
    image = _load_image(req.image_path)
    recipe = load_recipe(req.recipe, req.overrides)
    return _convert(image, recipe)


@app.post("/api/convert_file")
async def convert_file(
    file: UploadFile = File(...),
    recipe: str | None = Form(None),
    overrides: str | None = Form(None),
):
    raw = await file.read()
    from engine.io_utils import load_rgb as _load_rgb

    try:
        image = _load_rgb(raw)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"上传图片无法解析: {e}") from e
    ov = json.loads(overrides) if overrides else None
    dest = UPLOAD_DIR / f"{uuid.uuid4().hex[:12]}_{Path(file.filename or 'img').name}"
    dest.write_bytes(raw)
    return _convert(image, load_recipe(recipe, ov))


@app.get("/api/stage/{job_id}/{stage}")
def stage_export(job_id: str, stage: str):
    job = _JOBS.get(job_id)
    if job is None:
        raise HTTPException(404, f"job 不存在: {job_id}")
    if stage in ("p0", "edge", "lineart"):
        art = _pipeline._precompute(job["image"], job["recipe"])  # 已有缓存，命中即返回
        m = {"p0": art.P0, "edge": art.E, "lineart": art.L}
        if m[stage] is None:
            raise HTTPException(404, f"该 job 无 {stage} 产物")
        arr = m[stage]
        png = _png_b64(arr if arr.ndim == 3 else (arr * 255).astype(np.uint8),
                       "RGB" if arr.ndim == 3 else "L")
    elif stage in ("fill", "ink", "preview"):
        result = job["result"]
        if stage == "fill":
            png = _png_b64(result.palette.colors[result.fill.data], "RGB")
        elif stage == "ink":
            if result.ink is None:
                raise HTTPException(404, "该 job 无墨线层")
            rgb = result.palette.colors[np.clip(result.ink.data, 0, None)].astype(np.uint8)
            rgba = np.dstack([rgb, (result.ink.data >= 0).astype(np.uint8) * 255])
            buf = io.BytesIO()
            Image.fromarray(rgba, mode="RGBA").save(buf, format="PNG")
            png = base64.b64encode(buf.getvalue()).decode()
        else:
            png = _png_b64(np.asarray(s5_post.composite_preview(result, scale=1)), "RGB")
    else:
        raise HTTPException(400, f"未知 stage: {stage}（p0|edge|lineart|fill|ink|preview）")
    return {"job_id": job_id, "stage": stage, "png": png}


@app.post("/api/extract_palette")
def extract_palette(req: ExtractPaletteRequest):
    from engine.core.palette import extract_from_image

    image = _load_image(req.image_path)
    h, w = image.shape[:2]
    scale = min(1.0, 256 / max(h, w))  # 提取前压到 ≤256 边长，k-means 才够快
    if scale < 1.0:
        import cv2

        image = cv2.resize(image, (int(w * scale), int(h * scale)),
                           interpolation=cv2.INTER_AREA)
    pal = extract_from_image(image, max(1, min(req.k, 256)))
    return {"colors": pal.colors.tolist(), "count": len(pal.colors)}


@app.post("/api/lineart")
def lineart(req: LineartRequest):
    """独立线稿提取：黑线白纸 PNG（base64）。mode: onnx(默认) | xdog。"""
    from engine import lineart as lineart_mod

    image = _load_image(req.image_path)
    try:
        L = lineart_mod.extract(image, req.mode)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    paper = np.clip(255.0 * (1.0 - L), 0, 255).astype(np.uint8)
    return {
        "mode": req.mode,
        "width": int(image.shape[1]),
        "height": int(image.shape[0]),
        "png": _png_b64(paper, "L"),
        "source_png": _thumb_b64(image),
    }


@app.post("/api/lineart_file")
async def lineart_file(
    file: UploadFile = File(...),
    mode: str = Form("onnx"),
):
    """上传版独立线稿提取（编辑器文件选择用）：黑线白纸 PNG（base64，源图分辨率）。"""
    raw = await file.read()
    from engine.io_utils import load_rgb as _load_rgb

    try:
        image = _load_rgb(raw)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"上传图片无法解析: {e}") from e
    from engine import lineart as lineart_mod

    try:
        L = lineart_mod.extract(image, mode)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    paper = np.clip(255.0 * (1.0 - L), 0, 255).astype(np.uint8)
    return {
        "mode": mode,
        "width": int(image.shape[1]),
        "height": int(image.shape[0]),
        "png": _png_b64(paper, "L"),
        "source_png": _thumb_b64(image),
    }


@app.post("/api/matting")
def matting(req: MattingRequest):
    """主体抠图：返回前景 RGBA PNG（alpha 即蒙版）。"""
    image = _load_image(req.image_path)
    try:
        _fg, alpha = _pipeline.ai.matting.remove_background(image)
    except NotImplementedError as e:
        raise HTTPException(503, f"抠图不可用：{e}") from e
    rgba = np.dstack([_fg, (alpha * 255).astype(np.uint8)])
    buf = io.BytesIO()
    Image.fromarray(rgba, mode="RGBA").save(buf, format="PNG")
    return {
        "width": int(image.shape[1]),
        "height": int(image.shape[0]),
        "png": base64.b64encode(buf.getvalue()).decode(),
    }


@app.get("/api/result_info/{job_id}")
def result_info(job_id: str):
    """转换结果统计：尺寸、用色、调色板使用占比 Top。"""
    job = _JOBS.get(job_id)
    if job is None:
        raise HTTPException(404, f"job 不存在: {job_id}")
    result = job["result"]
    counts = np.bincount(result.fill.data.ravel(),
                         minlength=len(result.palette.colors))
    order = counts.argsort()[::-1]
    used = int((counts > 0).sum())
    top = [
        {"index": int(i), "hex": "#{:02x}{:02x}{:02x}".format(*result.palette.colors[i]),
         "share": round(float(counts[i]) / counts.sum(), 3)}
        for i in order[:min(8, used)] if counts[i] > 0
    ]
    return {"size": result.meta.get("size"), "colors_used": used, "top_colors": top}


@app.get("/api/get_pixel/{job_id}")
def get_pixel(job_id: str, x: int, y: int):
    """读取结果格子：调色板索引与颜色 hex。"""
    job = _JOBS.get(job_id)
    if job is None:
        raise HTTPException(404, f"job 不存在: {job_id}")
    d = job["result"].fill.data
    h, w = d.shape
    if not (0 <= x < w and 0 <= y < h):
        raise HTTPException(400, f"越界: x∈[0,{w}), y∈[0,{h})")
    idx = int(d[y, x])
    return {"x": x, "y": y, "index": idx,
            "hex": "#{:02x}{:02x}{:02x}".format(*job["result"].palette.colors[idx])}


@app.get("/api/session")
def session_load():
    """读取最近一次自动保存的编辑器会话（无则 404）。"""
    if not SESSION_PATH.exists():
        raise HTTPException(404, "无自动保存")
    try:
        return json.loads(SESSION_PATH.read_text(encoding="utf-8"))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"会话文件损坏: {e}") from e


@app.post("/api/session")
def session_save(req: SessionRequest):
    """原子写入会话文件（含 fill/ink/覆盖表；编辑器每 30s 自动调用）。"""
    SESSION_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = SESSION_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(req.data, ensure_ascii=False), encoding="utf-8")
    tmp.replace(SESSION_PATH)
    return {"ok": True, "bytes": SESSION_PATH.stat().st_size}


@app.post("/api/rerun_region")
def rerun_region(req: RerunRegionRequest):
    raise HTTPException(501, "rerun_region: v1.5 实现（分区参数 + 局部重跑）")


@app.websocket("/api/preview")
async def preview_ws(ws: WebSocket):
    await ws.accept()
    try:
        while True:
            msg = json.loads(await ws.receive_text())
            try:
                image = _load_image(msg["image_path"])
                recipe = load_recipe(msg.get("recipe"), msg.get("overrides"))
                result = _pipeline.run(image, recipe)
                preview = s5_post.composite_preview(result, scale=1)
                buf = io.BytesIO()
                preview.save(buf, format="PNG")
                await ws.send_json({
                    "preview_png": base64.b64encode(buf.getvalue()).decode(),
                    "meta": {k: v for k, v in result.meta.items() if k != "recipe"},
                })
            except HTTPException as e:
                await ws.send_json({"error": e.detail})
            except Exception as e:  # noqa: BLE001 —— 预览通道不因单次失败断开
                await ws.send_json({"error": str(e)})
    except WebSocketDisconnect:
        return
