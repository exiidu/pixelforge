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
- POST /api/rerun_region        局部重转换（M4：掩码区内重采样，色板固定/可追加）

MCP-3A job 编辑（服务端唯一事实源，带 revision 乐观锁）：
- GET  /api/jobs/{job}/grid     读取 fill/ink/alpha/调色板/revision
- POST /api/jobs/{job}/pixels   批量写格（fill/ink/alpha）
- POST /api/jobs/{job}/fill     区域泛洪填充
- POST /api/jobs/{job}/palette  整板 OKLab 变换（索引不动）
- POST /api/jobs/{job}/rerun    局部重算（rect/cells，不用传蒙版 PNG）
- POST /api/jobs/{job}/export   导出 composite(RGBA) / indexed(PLTE+tRNS)

返回的 fill/ink 为调色板索引二维数组（墨线层非线格为 -1），编辑器直接可编辑。
"""

from __future__ import annotations

import asyncio
import base64
import io
import json
import os
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image
from pydantic import BaseModel

from engine.pipeline import AIProviders, ConversionPipeline
from engine.recipe import Recipe, load_recipe, preset_names
from engine.stages import s5_post
from engine.types import ConversionResult, IndexGrid, Palette

@asynccontextmanager
async def _lifespan(_app: FastAPI):
    """保存事件循环引用：同步编辑接口通过它向 WS 订阅者广播。"""
    global _LOOP
    _LOOP = asyncio.get_running_loop()
    yield


app = FastAPI(title="PixelForge Engine", version="0.2.0", lifespan=_lifespan)


def _cors_origins() -> list[str]:
    """CORS 白名单：默认只放行本机前端端口，可用环境变量追加。

    `PIXELFORGE_CORS_ORIGINS` 用逗号分隔；默认额外允许 localhost/127.0.0.1 的任意端口
    （Vite 端口被占用时自动切换），非本机来源一律不放行。
    """
    raw = os.environ.get("PIXELFORGE_CORS_ORIGINS", "")
    return [item.strip() for item in raw.split(",") if item.strip()]


_LOCAL_ORIGIN = r"^http://(localhost|127\.0\.0\.1)(:\d+)?$"

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins(),
    allow_origin_regex=_LOCAL_ORIGIN,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)

_pipeline = ConversionPipeline()
_JOBS: dict[str, dict] = {}
_JOB_WS: dict[str, set[WebSocket]] = {}
_AGENTS: dict[str, dict] = {}
_AGENT_ONLINE_TTL = 30.0
_MAX_JOBS = 128
_LOOP: asyncio.AbstractEventLoop | None = None
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
    region_png: str                # 网格尺寸蒙版 PNG（白=重算）
    param_delta: dict = {}
    expand_colors: int = 0         # 从区域追加到色板尾部的新色上限（0=不改板）
    revision: int | None = None    # 可选乐观锁；不传则保持旧行为


class PixelEdit(BaseModel):
    x: int
    y: int
    fill: int | None = None        # 调色板索引（0..N-1）
    ink: int | None = None         # 调色板索引；-1 = 清除该格墨线
    alpha: int | None = None       # 0=透明 1=不透明


class JobPixelsRequest(BaseModel):
    pixels: list[PixelEdit]
    revision: int | None = None


class JobFillRequest(BaseModel):
    x: int
    y: int
    fill: int                      # 目标调色板索引
    target: int | None = None      # 要替换的颜色索引；空 = 以种子格当前色为准
    contiguous: bool = True        # true=四连通泛洪；false=整图同色替换
    revision: int | None = None


class PaletteTransformRequest(BaseModel):
    lightness: float = 0.0         # -1..1（前端滑杆 -100..100）
    hue: float = 0.0               # 角度 -180..180
    saturation: float = 0.0        # -1..1（1 + saturation 为色度倍率）
    revision: int | None = None


class RegionRect(BaseModel):
    x0: int
    y0: int
    x1: int
    y1: int


class JobRerunRequest(BaseModel):
    rect: RegionRect | None = None
    cells: list[list[int]] | None = None   # [[x,y], ...]
    param_delta: dict = {}
    expand_colors: int = 0
    revision: int | None = None


class JobExportRequest(BaseModel):
    content: str = "composite"     # composite | indexed
    scale: int = 1                 # 1..16 最近邻放大
    transparent: bool = True       # 有 alpha 时输出真透明；false 则忽略 alpha


class AgentRegisterRequest(BaseModel):
    id: str
    name: str
    subtitle: str = ""
    features: dict | None = None


class AgentControlRequest(BaseModel):
    agent_id: str
    active: bool = True
    activity: str = ""
    hold_seconds: float = 2.0


class AgentFeaturesRequest(BaseModel):
    agent_id: str
    features: dict


class SessionRequest(BaseModel):
    data: dict                     # 编辑器序列化的会话（版本/文档/UI 状态）


def _media_roots() -> list[Path]:
    """允许读取的媒体根目录。

    默认只允许用户主目录与仓库根目录（覆盖常见照片位置，同时挡住系统目录）；
    可用 `PIXELFORGE_ALLOWED_ROOTS`（`os.pathsep` 分隔）显式扩展。
    """
    raw = os.environ.get("PIXELFORGE_ALLOWED_ROOTS", "")
    if raw.strip():
        return [Path(item).expanduser().resolve() for item in raw.split(os.pathsep) if item.strip()]
    return [Path.home().resolve(), Path(__file__).resolve().parents[2]]


def _check_media_path(path: Path) -> Path:
    """校验路径位于允许的媒体根目录内（解析符号链接后），返回绝对路径。"""
    resolved = path.resolve()
    for root in _media_roots():
        if resolved == root or resolved.is_relative_to(root):
            return resolved
    raise HTTPException(403, f"路径不在允许的媒体根目录内: {resolved}")


def _load_image(path: str) -> np.ndarray:
    p = Path(path)
    if not p.is_absolute():
        p = Path.cwd() / p
    if not p.exists():
        raise HTTPException(404, f"图片不存在: {p}")
    p = _check_media_path(p)
    from engine.io_utils import load_rgb

    try:
        img = load_rgb(p)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"图片无法解析: {e}") from e
    if img.ndim != 3 or img.shape[2] != 3:
        raise HTTPException(400, "非常规 RGB 图片")
    return img


def _load_image_rgba(path: str) -> tuple[np.ndarray, np.ndarray]:
    """加载为 (rgb, alpha)：alpha 为源分辨率 (H, W) float32 0..1（M5-0）。"""
    p = Path(path)
    if not p.is_absolute():
        p = Path.cwd() / p
    if not p.exists():
        raise HTTPException(404, f"图片不存在: {p}")
    p = _check_media_path(p)
    from engine.io_utils import load_rgb_with_alpha

    try:
        rgb, alpha = load_rgb_with_alpha(p)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"图片无法解析: {e}") from e
    if rgb.ndim != 3 or rgb.shape[2] != 3:
        raise HTTPException(400, "非常规 RGB 图片")
    return rgb, alpha


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


def _alpha_png(result) -> str | None:
    """网格 alpha → 灰度 PNG base64；无透明格（或未携带 alpha）返回 None（前端回退边缘泛洪）。"""
    if result.alpha is None:
        return None
    a = np.asarray(result.alpha, dtype=np.uint8)
    if a.size == 0 or (a != 0).all():  # 无透明格：视作"无 alpha 素材"
        return None
    return _png_b64(a * 255, "L")


def _result_payload(
    job_id: str,
    result,
    source_png: str | None = None,
    revision: int | None = None,
) -> dict:
    preview = s5_post.composite_preview(result, scale=1)
    buf = io.BytesIO()
    preview.save(buf, format="PNG")
    return {
        "job_id": job_id,
        "revision": revision,
        "width": int(result.fill.data.shape[1]),
        "height": int(result.fill.data.shape[0]),
        "palette": result.palette.colors.tolist(),
        "fill": result.fill.data.tolist(),
        "ink": result.ink.data.tolist() if result.ink is not None else None,
        "alpha_png": _alpha_png(result),
        "preview_png": base64.b64encode(buf.getvalue()).decode(),
        "source_png": source_png,
        "meta": {k: v for k, v in result.meta.items() if k != "recipe"},
        "recipe": result.meta.get("recipe"),
    }


def _convert(
    image: np.ndarray,
    recipe: Recipe,
    alpha: np.ndarray | None = None,
    *,
    name: str = "图像",
    source_path: str | None = None,
) -> dict:
    result = _pipeline.run(image, recipe, alpha)
    job_id = uuid.uuid4().hex[:12]
    now = time.time()
    _JOBS[job_id] = {
        "image": image,
        "recipe": recipe,
        "result": result,
        "revision": 0,
        "name": name,
        "source_path": source_path,
        "created_at": now,
        "updated_at": now,
    }
    # 源图缩略（编辑器对比浮层 / 描图底图用）
    _evict_jobs(job_id)
    return _result_payload(job_id, result, _thumb_b64(image), revision=0)


# ---------------------------------------------------------------- MCP-3A 编辑基座
def _evict_jobs(keep_id: str | None = None) -> None:
    """限制内存 job 数：优先淘汰没有 WS 订阅者的最老 job。"""
    overflow = len(_JOBS) - _MAX_JOBS
    if overflow <= 0:
        return
    candidates = sorted(
        (
            float(job.get("created_at", 0.0)),
            job_id,
        )
        for job_id, job in _JOBS.items()
        if job_id != keep_id and not _JOB_WS.get(job_id)
    )
    for _, job_id in candidates[:overflow]:
        _JOBS.pop(job_id, None)


def _job_or_404(job_id: str) -> dict:
    job = _JOBS.get(job_id)
    if job is None:
        raise HTTPException(404, f"job 不存在: {job_id}")
    job.setdefault("revision", 0)
    return job


def _check_revision(job: dict, revision: int | None) -> None:
    if revision is not None and int(revision) != int(job.get("revision", 0)):
        raise HTTPException(
            409,
            f"revision 不匹配：当前 {job.get('revision', 0)}，请求 {revision}（请重新读取网格）",
        )


def _bump_revision(job: dict) -> int:
    job["revision"] = int(job.get("revision", 0)) + 1
    job["updated_at"] = time.time()
    return job["revision"]


def _preview_b64(result, scale: int = 4) -> str:
    preview = s5_post.composite_preview(result, scale=scale)
    buf = io.BytesIO()
    preview.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


def _mutation_payload(job_id: str, job: dict, changed: int) -> dict:
    result = job["result"]
    return {
        "job_id": job_id,
        "revision": int(job.get("revision", 0)),
        "width": int(result.fill.data.shape[1]),
        "height": int(result.fill.data.shape[0]),
        "changed": int(changed),
        "palette": result.palette.colors.tolist(),
        "alpha_png": _alpha_png(result),
        "preview_png": _preview_b64(result),
    }


def _job_grid_payload(job_id: str, job: dict) -> dict:
    result = job["result"]
    return {
        "job_id": job_id,
        "revision": int(job.get("revision", 0)),
        "width": int(result.fill.data.shape[1]),
        "height": int(result.fill.data.shape[0]),
        "fill": result.fill.data.tolist(),
        "ink": result.ink.data.tolist() if result.ink is not None else None,
        "alpha": result.alpha.tolist() if result.alpha is not None else None,
        "palette": result.palette.colors.tolist(),
        "ink_visible": bool(result.ink.visible) if result.ink is not None else False,
    }


def _job_ws_payload(job_id: str, job: dict, kind: str, action: str = "") -> dict:
    base = _job_grid_payload(job_id, job)
    base.pop("alpha", None)  # WS 用 alpha_png，避免 h×w 的 0/1 JSON 列表
    result = job["result"]
    return {
        **base,
        "type": kind,             # job_snapshot | job_update
        "action": action,
        "name": job.get("name", "图像"),
        "alpha_png": _alpha_png(result),
    }


def _broadcast_ws(job_id: str, payload: dict) -> None:
    sockets = list(_JOB_WS.get(job_id, ()))
    if not sockets or _LOOP is None or _LOOP.is_closed():
        return

    async def send_all() -> None:
        dead: list[WebSocket] = []
        for ws in sockets:
            try:
                await ws.send_json(payload)
            except Exception:  # noqa: BLE001 —— 单个订阅者断开不影响其他订阅者
                dead.append(ws)
        if dead:
            current = _JOB_WS.get(job_id)
            if current:
                for ws in dead:
                    current.discard(ws)

    asyncio.run_coroutine_threadsafe(send_all(), _LOOP)


def _broadcast_job(job_id: str, action: str) -> None:
    job = _JOBS.get(job_id)
    if job is not None:
        _broadcast_ws(job_id, _job_ws_payload(job_id, job, "job_update", action))


def _agent_view(agent: dict) -> dict:
    now = time.time()
    online = bool(agent.get("last_seen")) and now - float(agent["last_seen"]) <= _AGENT_ONLINE_TTL
    controlling = now < float(agent.get("control_until", 0.0))
    return {
        "id": agent["id"],
        "name": agent.get("name", agent["id"]),
        "subtitle": agent.get("subtitle", ""),
        "status": "connected" if online else "offline",
        "controlling": controlling,
        "activity": agent.get("activity", "") if controlling else "",
        "features": dict(agent.get("features") or {}),
        "last_seen": agent.get("last_seen", 0.0),
    }


def _agent_or_create(agent_id: str) -> dict:
    agent = _AGENTS.get(agent_id)
    if agent is None:
        agent = {
            "id": agent_id,
            "name": agent_id,
            "subtitle": "MCP",
            "last_seen": 0.0,
            "control_until": 0.0,
            "activity": "",
            "features": {},
        }
        _AGENTS[agent_id] = agent
    return agent


def _validate_fill_index(value: int, palette_size: int) -> int:
    value = int(value)
    if not 0 <= value < palette_size:
        raise HTTPException(400, f"fill 索引越界: {value}（调色板 {palette_size} 色）")
    return value


def _validate_ink_index(value: int, palette_size: int) -> int:
    value = int(value)
    if value != -1 and not 0 <= value < palette_size:
        raise HTTPException(400, f"ink 索引越界: {value}（调色板 {palette_size} 色，-1=清除）")
    return value


def _validate_alpha(value: int) -> int:
    value = int(value)
    if value not in (0, 1):
        raise HTTPException(400, f"alpha 只能是 0 或 1，当前 {value}")
    return value


def _flood_mask(fill: np.ndarray, x: int, y: int, target: int, contiguous: bool) -> np.ndarray:
    h, w = fill.shape
    if not contiguous:
        return fill == target
    if int(fill[y, x]) != target:
        return np.zeros((h, w), dtype=bool)
    seen = np.zeros(h * w, dtype=bool)
    start = y * w + x
    seen[start] = True
    stack = [start]
    while stack:
        i = stack.pop()
        yy, xx = divmod(i, w)
        for j, ok in (
            (i - 1, xx > 0),
            (i + 1, xx + 1 < w),
            (i - w, yy > 0),
            (i + w, yy + 1 < h),
        ):
            if ok and not seen[j] and int(fill.flat[j]) == target:
                seen[j] = True
                stack.append(j)
    return seen.reshape(h, w)


def _transform_palette(
    colors: np.ndarray, lightness: float, hue: float, saturation: float
) -> np.ndarray:
    """与前端 transformPalette 同一公式：OKLab 明度偏移/色相旋转/色度倍率。"""
    from engine.core.oklab import linear_to_srgb, oklab_to_linear_rgb, rgb_to_oklab

    lab = rgb_to_oklab(colors.reshape(1, -1, 3))[0]
    L = np.clip(lab[:, 0] + float(lightness) * 0.3, 0.0, 1.0)
    h = np.arctan2(lab[:, 2], lab[:, 1]) + np.deg2rad(float(hue))
    c = np.hypot(lab[:, 1], lab[:, 2]) * max(0.0, 1.0 + float(saturation))
    new_lab = np.stack([L, np.cos(h) * c, np.sin(h) * c], axis=-1)
    return linear_to_srgb(oklab_to_linear_rgb(new_lab))


def _encode_composite_png(result, scale: int = 1, transparent: bool = True) -> dict:
    h, w = result.fill.data.shape
    rgb = result.palette.colors[result.fill.data].astype(np.uint8)
    if result.ink is not None and result.ink.visible:
        idx = result.ink.data
        mask = idx >= 0
        rgb[mask] = result.palette.colors[idx[mask]].astype(np.uint8)
    alpha = np.full((h, w), 255, dtype=np.uint8)
    has_transparency = False
    if transparent and result.alpha is not None:
        src_alpha = np.asarray(result.alpha, dtype=np.uint8)
        has_transparency = bool((src_alpha == 0).any())
        alpha = src_alpha * 255
    rgba = np.dstack([rgb, alpha])
    img = Image.fromarray(rgba, mode="RGBA")
    tw, th = w * scale, h * scale
    if not (1 <= tw <= 8192 and 1 <= th <= 8192):
        raise HTTPException(400, "输出尺寸需在 1..8192")
    if scale != 1:
        img = img.resize((tw, th), Image.NEAREST)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return {
        "png": base64.b64encode(buf.getvalue()).decode(),
        "width": tw,
        "height": th,
        "transparent": has_transparency,
    }


def _job_index_grid(result, transparent: bool) -> np.ndarray:
    """合成索引用网格：fill 为底，墨线格用墨线索引覆盖，透明格记 -1。"""
    grid = result.fill.data.copy()
    if result.ink is not None and result.ink.visible:
        ink = result.ink.data
        mask = ink >= 0
        grid[mask] = ink[mask]
    if transparent and result.alpha is not None:
        grid[np.asarray(result.alpha) == 0] = -1
    return grid


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
        "max_jobs": _MAX_JOBS,
        "ws_subscribers": sum(len(v) for v in _JOB_WS.values()),
    }


@app.get("/api/jobs")
def jobs_list():
    """列出当前内存中的 job（MCP agent 挑选编辑器文档用）。"""
    now = time.time()
    items = []
    for job_id, job in _JOBS.items():
        result = job["result"]
        items.append({
            "job_id": job_id,
            "name": job.get("name", "图像"),
            "source_path": job.get("source_path"),
            "width": int(result.fill.data.shape[1]),
            "height": int(result.fill.data.shape[0]),
            "colors_used": len({int(v) for v in np.unique(result.fill.data) if v >= 0}),
            "palette_colors": len(result.palette.colors),
            "revision": int(job.get("revision", 0)),
            "created_at": job.get("created_at", 0.0),
            "updated_at": job.get("updated_at", 0.0),
            "age_s": round(now - float(job.get("created_at", now)), 1),
            "ws_subscribers": len(_JOB_WS.get(job_id, ())),
        })
    items.sort(key=lambda item: item["created_at"], reverse=True)
    return {"count": len(items), "jobs": items}


# ---------------------------------------------------------------- Agent 注册 / 控制
def _clean_features(raw: dict | None) -> dict:
    if not isinstance(raw, dict):
        return {}
    return {str(k): bool(v) for k, v in raw.items()}


@app.get("/api/agents")
def agents_list():
    return {"agents": [_agent_view(agent) for agent in _AGENTS.values()]}


@app.post("/api/agents/register")
def agent_register(req: AgentRegisterRequest):
    agent = _agent_or_create(req.id)
    agent["name"] = req.name or req.id
    agent["subtitle"] = req.subtitle
    agent["last_seen"] = time.time()
    if req.features is not None:
        agent["features"] = _clean_features(req.features)
    return _agent_view(agent)


@app.post("/api/agents/control")
def agent_control(req: AgentControlRequest):
    agent = _agent_or_create(req.agent_id)
    now = time.time()
    agent["last_seen"] = now
    if req.active:
        hold = max(0.5, min(600.0, float(req.hold_seconds)))
        agent["control_until"] = now + hold
        agent["activity"] = (req.activity or "")[:200]
    else:
        agent["control_until"] = 0.0
        agent["activity"] = ""
    return _agent_view(agent)


@app.post("/api/agents/features")
def agent_features(req: AgentFeaturesRequest):
    agent = _agent_or_create(req.agent_id)
    agent["features"] = _clean_features(req.features)
    return _agent_view(agent)


@app.post("/api/convert")
def convert(req: ConvertRequest):
    image, alpha = _load_image_rgba(req.image_path)
    recipe = load_recipe(req.recipe, req.overrides)
    return _convert(
        image, recipe, alpha,
        name=Path(req.image_path).name or "图像",
        source_path=str(Path(req.image_path).resolve()),
    )


@app.post("/api/convert_file")
async def convert_file(
    file: UploadFile = File(...),
    recipe: str | None = Form(None),
    overrides: str | None = Form(None),
):
    raw = await file.read()
    from engine.io_utils import load_rgb_with_alpha as _load_rgba

    try:
        image, alpha = _load_rgba(raw)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"上传图片无法解析: {e}") from e
    ov = json.loads(overrides) if overrides else None
    dest = UPLOAD_DIR / f"{uuid.uuid4().hex[:12]}_{Path(file.filename or 'img').name}"
    dest.write_bytes(raw)
    return _convert(
        image, load_recipe(recipe, ov), alpha,
        name=file.filename or "上传图片",
        source_path=str(dest),
    )


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


class ExportIndexedRequest(BaseModel):
    palette: list[list[int]]        # 网格索引引用的调色板（N×3，RGB）
    indices: list[list[int]]        # 网格索引（h×w），-1 = 透明
    width: int | None = None        # 目标输出宽（最近邻放大）；空 = 原网格尺寸
    height: int | None = None


def _encode_indexed_png(
    palette,
    indices,
    width: int | None = None,
    height: int | None = None,
) -> dict:
    """索引网格 → 带 PLTE(+tRNS) 的 PNG；只保留实际用到的颜色。"""
    grid = np.asarray(indices, dtype=np.int32)
    if grid.ndim != 2 or grid.size == 0:
        raise HTTPException(400, "indices 必须是二维非空数组")
    pal = np.asarray(palette, dtype=np.int32)
    if pal.ndim != 2 or pal.shape[1] != 3:
        raise HTTPException(400, "palette 必须是 N×3 的 RGB 列表")
    h, w = grid.shape
    transparent = bool((grid < 0).any())
    used = sorted({int(v) for v in np.unique(grid) if v >= 0})
    if any(v >= len(pal) for v in used):
        raise HTTPException(400, "indices 超出调色板范围")
    offset = 1 if transparent else 0
    if len(used) + offset > 256:
        raise HTTPException(
            400, f"索引 PNG 最多 256 色（含透明占位），当前需 {len(used) + offset} 色，请先降色数"
        )

    out = np.zeros((h, w), dtype=np.uint8)
    for i, k in enumerate(used):
        out[grid == k] = i + offset
    img = Image.fromarray(out, mode="P")
    entries = ([[0, 0, 0]] if transparent else []) + [pal[k].tolist() for k in used]
    flat = [c for e in entries for c in e]
    img.putpalette(flat + [0] * (768 - len(flat)))

    tw = int(width or w)
    th = int(height or h)
    if not (1 <= tw <= 8192 and 1 <= th <= 8192):
        raise HTTPException(400, "输出尺寸需在 1..8192")
    if (tw, th) != (w, h):
        img = img.resize((tw, th), Image.NEAREST)

    buf = io.BytesIO()
    if transparent:
        img.save(buf, format="PNG", transparency=bytes([0] + [255] * len(used)))
    else:
        img.save(buf, format="PNG")
    return {
        "png": base64.b64encode(buf.getvalue()).decode(),
        "width": tw,
        "height": th,
        "colors": len(entries),
        "transparent": transparent,
    }


@app.post("/api/export_indexed")
def export_indexed(req: ExportIndexedRequest):
    """把前端最终的索引网格写成带 PLTE(+tRNS) 的索引 PNG（游戏引擎/像素工具友好）。"""
    return _encode_indexed_png(req.palette, req.indices, req.width, req.height)



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
    """区域细节重算（M4）：只改掩码内的 fill，色板前缀不动（可尾部追加）。"""
    job = _job_or_404(req.job_id)
    _check_revision(job, req.revision)
    result = job["result"]
    h, w = result.fill.data.shape
    mask = _decode_region_mask(req.region_png, w, h)
    delta = _validate_region_delta(req.param_delta)
    try:
        new_result = _pipeline.rerun_region(
            job["image"], job["recipe"], mask, delta, result,
            expand_colors=max(0, min(16, int(req.expand_colors))),
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    job["result"] = new_result  # 连续调用可链式生效
    _bump_revision(job)
    _broadcast_job(req.job_id, "rerun")
    return {
        "job_id": req.job_id,
        "revision": int(job.get("revision", 0)),
        "width": int(new_result.fill.data.shape[1]),
        "height": int(new_result.fill.data.shape[0]),
        "palette": new_result.palette.colors.tolist(),
        "fill": new_result.fill.data.tolist(),
        "ink": new_result.ink.data.tolist() if new_result.ink is not None else None,
        "meta": new_result.meta,
    }


_REGION_DELTA_KEYS = {"weights", "soft_ratio", "merge_delta"}
_REGION_WEIGHT_KEYS = {"edge", "dark", "contrast"}


def _decode_region_mask(region_png: str, w: int, h: int) -> np.ndarray:
    """解码网格尺寸蒙版：白（>127）= 重算。"""
    raw = region_png.split(",", 1)[-1] if region_png.startswith("data:") else region_png
    try:
        img = Image.open(io.BytesIO(base64.b64decode(raw))).convert("L")
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"蒙版无法解析: {e}") from e
    mask = np.array(img) > 127
    if mask.shape != (h, w):
        raise HTTPException(400, f"蒙版尺寸必须为 {w}×{h}，实际 {mask.shape[1]}×{mask.shape[0]}")
    return mask


def _validate_region_delta(delta: dict | None) -> dict:
    """只允许采样参数：量化/预处理/结构/墨线改动会破坏索引或全局语义。"""
    if not delta:
        return {}
    if not isinstance(delta, dict) or set(delta) - {"sampling"}:
        raise HTTPException(400, "param_delta 仅支持 sampling（权重/软边/合并阈值）")
    out: dict = {}
    for k, v in (delta.get("sampling") or {}).items():
        if k not in _REGION_DELTA_KEYS:
            raise HTTPException(400, f"采样参数不支持: {k}")
        if k == "weights":
            if not isinstance(v, dict) or set(v) - _REGION_WEIGHT_KEYS:
                raise HTTPException(400, "weights 仅支持 edge/dark/contrast")
            out["weights"] = {key: float(val) for key, val in v.items()}
        else:
            out[k] = float(v)
    return {"sampling": out} if out else {}


# ---------------------------------------------------------------- MCP-3A job 编辑接口
@app.get("/api/jobs/{job_id}/grid")
def job_grid(job_id: str):
    """读取 job 的完整网格状态（fill/ink/alpha/调色板/revision）。"""
    return _job_grid_payload(job_id, _job_or_404(job_id))


@app.post("/api/jobs/{job_id}/pixels")
def job_pixels(job_id: str, req: JobPixelsRequest):
    """批量写格：只改请求中给出的通道，其余保持不变。"""
    job = _job_or_404(job_id)
    _check_revision(job, req.revision)
    if not req.pixels:
        raise HTTPException(400, "pixels 不能为空")
    if len(req.pixels) > 200_000:
        raise HTTPException(400, "单次最多编辑 200000 格")

    result = job["result"]
    fill = result.fill.data
    h, w = fill.shape
    n = len(result.palette.colors)
    prepared: list[tuple[int, int, int | None, int | None, int | None]] = []
    for p in req.pixels:
        if not (0 <= p.x < w and 0 <= p.y < h):
            raise HTTPException(400, f"坐标越界: ({p.x},{p.y})，网格 {w}×{h}")
        prepared.append((
            int(p.y),
            int(p.x),
            None if p.fill is None else _validate_fill_index(p.fill, n),
            None if p.ink is None else _validate_ink_index(p.ink, n),
            None if p.alpha is None else _validate_alpha(p.alpha),
        ))

    if result.ink is None and any(item[3] is not None and item[3] >= 0 for item in prepared):
        result.ink = IndexGrid(data=np.full((h, w), -1, dtype=np.int32), visible=True)
    if result.alpha is None and any(item[4] == 0 for item in prepared):
        result.alpha = np.ones((h, w), dtype=np.uint8)

    changed = 0
    for y, x, f, ink_value, alpha_value in prepared:
        did = False
        if f is not None and int(fill[y, x]) != f:
            fill[y, x] = f
            did = True
        if ink_value is not None and result.ink is not None:
            if int(result.ink.data[y, x]) != ink_value:
                result.ink.data[y, x] = ink_value
                did = True
        if alpha_value is not None and result.alpha is not None:
            if int(result.alpha[y, x]) != alpha_value:
                result.alpha[y, x] = alpha_value
                did = True
        changed += int(did)

    if changed:
        _bump_revision(job)
        _broadcast_job(job_id, "pixels")
    return _mutation_payload(job_id, job, changed)


@app.post("/api/jobs/{job_id}/fill")
def job_fill(job_id: str, req: JobFillRequest):
    """区域填充：默认四连通泛洪，也可整图替换同色。"""
    job = _job_or_404(job_id)
    _check_revision(job, req.revision)
    result = job["result"]
    fill = result.fill.data
    h, w = fill.shape
    n = len(result.palette.colors)
    if not (0 <= req.x < w and 0 <= req.y < h):
        raise HTTPException(400, f"种子坐标越界: ({req.x},{req.y})，网格 {w}×{h}")
    new_index = _validate_fill_index(req.fill, n)
    target = int(fill[req.y, req.x]) if req.target is None else _validate_fill_index(req.target, n)
    mask = _flood_mask(fill, req.x, req.y, target, req.contiguous)
    changed = 0 if new_index == target else int(mask.sum())
    if changed:
        fill[mask] = new_index
        _bump_revision(job)
        _broadcast_job(job_id, "fill")
    return _mutation_payload(job_id, job, changed)


@app.post("/api/jobs/{job_id}/palette")
def job_palette(job_id: str, req: PaletteTransformRequest):
    """整板 OKLab 变换：格子索引不动，只重生成颜色。"""
    job = _job_or_404(job_id)
    _check_revision(job, req.revision)
    for label, value, lo, hi in (
        ("lightness", req.lightness, -1.0, 1.0),
        ("hue", req.hue, -180.0, 180.0),
        ("saturation", req.saturation, -1.0, 1.0),
    ):
        if not np.isfinite(value) or not lo <= float(value) <= hi:
            raise HTTPException(400, f"{label} 需在 {lo}..{hi}")
    result = job["result"]
    before = result.palette.colors.copy()
    after = _transform_palette(before, req.lightness, req.hue, req.saturation)
    changed = int(not np.array_equal(before, after))
    if changed:
        result.palette = Palette(
            colors=after.astype(np.uint8),
            name=result.palette.name,
            source=result.palette.source,
        )
        _bump_revision(job)
        _broadcast_job(job_id, "palette")
    return _mutation_payload(job_id, job, changed)


@app.post("/api/jobs/{job_id}/rerun")
def job_rerun(job_id: str, req: JobRerunRequest):
    """局部重算：用 rect 或 cells 指定区域，只接受 sampling 参数增量。"""
    job = _job_or_404(job_id)
    _check_revision(job, req.revision)
    result = job["result"]
    h, w = result.fill.data.shape
    mask = np.zeros((h, w), dtype=bool)

    if req.rect is not None:
        xa, xb = sorted((int(req.rect.x0), int(req.rect.x1)))
        ya, yb = sorted((int(req.rect.y0), int(req.rect.y1)))
        if xb < 0 or ya >= h or yb < 0 or xa >= w:
            raise HTTPException(400, "rect 完全在网格之外")
        x0, x1 = max(0, xa), min(w - 1, xb)
        y0, y1 = max(0, ya), min(h - 1, yb)
        mask[y0:y1 + 1, x0:x1 + 1] = True

    if req.cells:
        if len(req.cells) > 200_000:
            raise HTTPException(400, "cells 最多 200000 个")
        for pair in req.cells:
            if len(pair) != 2:
                raise HTTPException(400, "cells 每项必须是 [x, y]")
            x, y = int(pair[0]), int(pair[1])
            if not (0 <= x < w and 0 <= y < h):
                raise HTTPException(400, f"cells 坐标越界: ({x},{y})，网格 {w}×{h}")
            mask[y, x] = True

    if not mask.any():
        raise HTTPException(400, "区域为空：请提供 rect 或 cells")

    delta = _validate_region_delta(req.param_delta)
    old_fill = result.fill.data.copy()
    old_palette_len = len(result.palette.colors)
    try:
        new_result = _pipeline.rerun_region(
            job["image"], job["recipe"], mask, delta, result,
            expand_colors=max(0, min(16, int(req.expand_colors))),
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    changed = int((new_result.fill.data[mask] != old_fill[mask]).sum())
    job["result"] = new_result
    _bump_revision(job)
    _broadcast_job(job_id, "rerun")
    payload = _mutation_payload(job_id, job, changed)
    payload["appended_colors"] = len(new_result.palette.colors) - old_palette_len
    return payload


@app.post("/api/jobs/{job_id}/export")
def job_export(job_id: str, req: JobExportRequest):
    """导出 job 当前状态：composite（RGBA）或 indexed（PLTE+tRNS）。"""
    job = _job_or_404(job_id)
    result = job["result"]
    content = (req.content or "").lower()
    if content not in {"composite", "indexed"}:
        raise HTTPException(400, "content 仅支持 composite | indexed")
    if not 1 <= int(req.scale) <= 16:
        raise HTTPException(400, "scale 需在 1..16")
    scale = int(req.scale)
    h, w = result.fill.data.shape

    if content == "composite":
        encoded = _encode_composite_png(result, scale=scale, transparent=req.transparent)
    else:
        grid = _job_index_grid(result, transparent=req.transparent)
        encoded = _encode_indexed_png(
            result.palette.colors, grid, width=w * scale, height=h * scale
        )
    return {
        "job_id": job_id,
        "revision": int(job.get("revision", 0)),
        "content": content,
        "scale": scale,
        **encoded,
    }


@app.websocket("/api/jobs/{job_id}")
async def job_ws(ws: WebSocket, job_id: str):
    """订阅一个 job 的实时更新：连接即发当前快照，之后每次编辑广播新 revision。"""
    job = _JOBS.get(job_id)
    if job is None:
        await ws.close(code=1008)
        return
    await ws.accept()
    _JOB_WS.setdefault(job_id, set()).add(ws)
    try:
        await ws.send_json(_job_ws_payload(job_id, job, "job_snapshot"))
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        subscribers = _JOB_WS.get(job_id)
        if subscribers:
            subscribers.discard(ws)


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
