"""PixelForge MCP 服务器（stdio）——AI 客户端驱动转换引擎的薄代理层。

运行：python -m engine.mcp_server（需引擎在线：uvicorn engine.server.api:app --port 8700）
地址可用环境变量 PIXELFORGE_URL 覆盖；产物落盘目录 PIXELFORGE_MCP_OUT（默认 .cache/mcp_out）。
设计文档见 ../mcp-design.md。

安全边界：本服务按设计只连接用户本机的 PixelForge 引擎——URL 强制校验
协议 http/https 且主机在显式回环白名单内，并禁用重定向，不访问任何其他地址。
"""

from __future__ import annotations

import base64
import json
import os
import re
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.parse import urlparse

from mcp.server.mcpserver import MCPServer  # MCP SDK 2.x（原 FastMCP）
from mcp.server.mcpserver.exceptions import ToolError
from mcp.types import CallToolResult, ImageContent, TextContent

ENGINE_URL = os.environ.get("PIXELFORGE_URL", "http://127.0.0.1:8700")
AGENT_ID = os.environ.get("PIXELFORGE_AGENT_ID", "local-mcp")
AGENT_NAME = os.environ.get("PIXELFORGE_AGENT_NAME", "本地 MCP")
OUT_DIR = Path(
    os.environ.get("PIXELFORGE_MCP_OUT", "")
    or Path(__file__).resolve().parents[1] / ".cache" / "mcp_out"
)
RECIPES_DIR = Path(__file__).resolve().parents[1] / "recipes"
BUILTIN_RECIPES = {"photo", "illustration", "lineart"}
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}
_RECIPE_CACHE_MAX = 256
_RECIPE_CACHE: dict[str, dict] = {}
_HEARTBEAT_INTERVAL = 10.0
_last_heartbeat = 0.0
_FEATURE_CACHE: dict = {"at": 0.0, "features": {}}

# 仅允许连接本机回环上的引擎（用户显式部署的本地服务），拒绝一切其他目标
_ALLOWED_HOSTS = {"127.0.0.1", "localhost", "::1"}


def _validate_engine_url(url: str) -> None:
    p = urlparse(url)
    if p.scheme not in ("http", "https"):
        raise ValueError(f"PIXELFORGE_URL 仅允许 http/https: {url}")
    host = (p.hostname or "").lower()
    if host not in _ALLOWED_HOSTS:
        raise ValueError(
            f"引擎地址必须是本机回环地址（白名单 {sorted(_ALLOWED_HOSTS)}），当前: {host}"
        )


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D102
        return None  # 禁止跟随重定向，防止地址漂移


_OPENER = urllib.request.build_opener(_NoRedirect)
mcp = MCPServer("pixelforge")


# ---------------------------------------------------------------- HTTP 基座
def _open(method: str, path: str, payload: dict | None = None, timeout: float = 180) -> dict:
    _validate_engine_url(ENGINE_URL)
    url = f"{ENGINE_URL}{path}"
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(
        url, data=data, method=method,
        headers={"Content-Type": "application/json"},
    )
    with _OPENER.open(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _heartbeat_agent(force: bool = False) -> None:
    """向引擎登记/续期本 Agent；引擎离线时静默跳过。"""
    global _last_heartbeat
    now = time.monotonic()
    if not force and now - _last_heartbeat < _HEARTBEAT_INTERVAL:
        return
    _last_heartbeat = now
    try:
        _open("POST", "/api/agents/register", {
            "id": AGENT_ID, "name": AGENT_NAME, "subtitle": "stdio · 已接入",
        }, timeout=2)
    except Exception:  # noqa: BLE001 —— 登记失败不应阻断工具调用
        pass


def _agent_features(force: bool = False) -> dict:
    now = time.monotonic()
    if not force and now - float(_FEATURE_CACHE["at"]) < 2.0:
        return _FEATURE_CACHE["features"]
    features: dict = {}
    try:
        data = _open("GET", "/api/agents", timeout=2)
        for agent in data.get("agents", []):
            if agent.get("id") == AGENT_ID:
                features = dict(agent.get("features") or {})
                break
    except Exception:  # noqa: BLE001 —— 读不到配置时按“未限制”处理
        features = {}
    _FEATURE_CACHE["at"] = now
    _FEATURE_CACHE["features"] = features
    return features


def _feature_for_path(path: str) -> str | None:
    p = path.split("?", 1)[0]
    if p in {"/api/convert", "/api/convert_file"}:
        return "convert"
    if p == "/api/extract_palette" or p.startswith("/api/lineart") or p.startswith("/api/matting"):
        return "ai"
    if re.fullmatch(r"/api/jobs/[^/]+/grid", p):
        return "inspect"
    if re.fullmatch(r"/api/jobs/[^/]+/(pixels|fill)", p):
        return "edit"
    if re.fullmatch(r"/api/jobs/[^/]+/palette", p):
        return "palette"
    if re.fullmatch(r"/api/jobs/[^/]+/rerun", p) or p == "/api/rerun_region":
        return "rerun"
    if (
        re.fullmatch(r"/api/jobs/[^/]+/export", p)
        or p.startswith("/api/export_indexed")
        or p.startswith("/api/stage/")
    ):
        return "export"
    if p.startswith("/api/result_info/") or p.startswith("/api/get_pixel/") or p == "/api/jobs":
        return "inspect"
    return None


def _require_feature(feature: str) -> None:
    features = _agent_features()
    if features.get(feature) is False:
        raise ToolError(f"功能已在 MCP 管理中被用户禁用: {feature}")


def _agent_control(active: bool, activity: str = "", hold_seconds: float = 2.0) -> None:
    """申请/释放编辑器控制蒙版；best-effort，不阻断工具本身。"""
    try:
        _open("POST", "/api/agents/control", {
            "agent_id": AGENT_ID,
            "active": active,
            "activity": activity,
            "hold_seconds": hold_seconds,
        }, timeout=2)
    except Exception:  # noqa: BLE001
        pass


def _request(method: str, path: str, payload: dict | None = None) -> dict:
    _validate_engine_url(ENGINE_URL)
    _heartbeat_agent()
    feature = _feature_for_path(path)
    if feature:
        _require_feature(feature)
    try:
        return _open(method, path, payload)
    except urllib.error.HTTPError as e:
        try:
            detail = json.loads(e.read().decode("utf-8")).get("detail", e.reason)
        except Exception:  # noqa: BLE001
            detail = e.reason
        raise RuntimeError(f"引擎返回 {e.code}: {detail}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(
            f"引擎离线（{ENGINE_URL}）：请先在 D:\\pixelforge\\pixelforge 下运行 "
            "`python -m uvicorn engine.server.api:app --port 8700`"
        ) from e


def _save_png_b64(b64: str, filename: str, out_dir: Path | None = None) -> str:
    target_dir = out_dir or OUT_DIR
    target_dir.mkdir(parents=True, exist_ok=True)
    path = target_dir / filename
    path.write_bytes(base64.b64decode(b64))
    return str(path)


def _j(obj) -> str:
    return json.dumps(obj, ensure_ascii=False)


def _text_result(payload: dict) -> CallToolResult:
    return CallToolResult(content=[TextContent(type="text", text=_j(payload))])


def _text_image_result(
    payload: dict,
    *,
    image_path: str | Path | None = None,
    image_data: bytes | None = None,
) -> CallToolResult:
    """文本摘要 + MCP image 内容块；客户端不支持图片时仍可读取文本与路径。"""
    content = [TextContent(type="text", text=_j(payload))]
    if image_data is None and image_path is not None:
        try:
            image_data = Path(image_path).read_bytes()
        except OSError:
            image_data = None
    if image_data:
        content.append(ImageContent(
            type="image",
            data=base64.b64encode(image_data).decode(),
            mime_type="image/png",
        ))
    return CallToolResult(content=content)


def _text_images_result(payload: dict, image_paths: list[str], limit: int = 4) -> CallToolResult:
    """批量结果只回传有限张预览，避免一次塞入过多图片。"""
    content = [TextContent(type="text", text=_j(payload))]
    for path in image_paths[:limit]:
        try:
            data = Path(path).read_bytes()
        except OSError:
            continue
        content.append(ImageContent(
            type="image",
            data=base64.b64encode(data).decode(),
            mime_type="image/png",
        ))
    return CallToolResult(content=content)


def _record_recipe(job_id: str, raw: dict) -> None:
    """缓存本次 MCP 进程内的完整配方，供 save_recipe(job_id=...) 使用。"""
    if not isinstance(raw, dict):
        return
    if len(_RECIPE_CACHE) >= _RECIPE_CACHE_MAX:
        _RECIPE_CACHE.pop(next(iter(_RECIPE_CACHE)), None)
    _RECIPE_CACHE[job_id] = json.loads(json.dumps(raw, ensure_ascii=False))


def _full_recipe(recipe_name: str | None, preset: str, overrides: dict) -> dict:
    from engine.recipe import load_recipe  # 本地合并逻辑与引擎一致，不经过 HTTP

    return load_recipe(recipe_name or preset, overrides).raw


def _safe_recipe_name(name: str) -> str:
    raw = (name or "").strip()
    if raw.lower().endswith(".json"):
        raw = raw[:-5].strip()
    if not raw:
        raise ValueError("配方名不能为空")
    if len(raw) > 64:
        raise ValueError("配方名过长（最多 64 字符）")
    if raw.startswith(".") or raw in {".", ".."}:
        raise ValueError("配方名不能以 . 开头")
    if re.search(r'[\\/:*?"<>|]', raw) or any(ord(ch) < 32 for ch in raw):
        raise ValueError("配方名不能包含路径分隔符或控制字符")
    if raw.rstrip(" .") != raw:
        raise ValueError("配方名不能以空格或点结尾")
    reserved = {"CON", "PRN", "AUX", "NUL"} | {f"COM{i}" for i in range(1, 10)} | {f"LPT{i}" for i in range(1, 10)}
    if raw.upper() in reserved:
        raise ValueError(f"配方名是系统保留名: {raw}")
    return raw


def _collect_images(
    input_path: str | None,
    image_paths: list[str] | None,
    recursive: bool,
    pattern: str,
) -> list[Path]:
    """收集批量输入：目录按扩展名过滤，显式路径保留以便把错误计入失败清单。"""
    found: list[Path] = []
    seen: set[Path] = set()

    def add(path: Path) -> None:
        resolved = path.resolve()
        if resolved not in seen:
            seen.add(resolved)
            found.append(resolved)

    def add_dir(root: Path) -> None:
        it = root.rglob(pattern) if recursive else root.glob(pattern)
        for path in sorted(it):
            if path.is_file() and path.suffix.lower() in IMAGE_EXTS:
                add(path)

    for raw in image_paths or []:
        path = Path(raw).expanduser()
        if path.is_dir():
            add_dir(path)
        else:
            add(path)

    if input_path:
        root = Path(input_path).expanduser()
        if root.is_dir():
            add_dir(root)
        elif root.is_file():
            add(root)
        else:
            raise RuntimeError(f"输入路径不存在: {root}")

    if not found:
        raise RuntimeError("未找到可转换的图片（支持 png/jpg/jpeg/webp/bmp/tif/tiff）")
    return found


def _build_convert_overrides(
    size: int,
    mode: str | None,
    edge_w: float | None,
    dark_w: float | None,
    contrast_w: float | None,
    palette: str | None,
    k: int | None,
    lineart: str | None,
    ink: bool,
) -> dict:
    ov: dict = {"target": {"width": size, "height": size}}
    weights = {}
    if edge_w is not None:
        weights["edge"] = edge_w
    if dark_w is not None:
        weights["dark"] = dark_w
    if contrast_w is not None:
        weights["contrast"] = contrast_w
    if mode or weights:
        ov["sampling"] = {}
        if mode:
            ov["sampling"]["mode"] = mode
        if weights:
            ov["sampling"]["weights"] = weights
    if palette or k is not None:
        pal: dict = {}
        if palette:
            if palette == "extract":
                pal = {"source": "extract", "ref": None}
            else:
                pal = {"source": "builtin", "ref": palette}
        if k is not None:
            pal["max_colors"] = k
        ov["quantize"] = {"palette": pal}
    if lineart:
        ov["structure"] = {"lineart": {"mode": lineart}}
    if ink:
        ov["ink"] = {"enable": True}
    return ov


def _convert_and_save(
    image_path: str,
    *,
    preset: str,
    recipe: str | None,
    size: int,
    overrides: dict,
    preview_dir: Path | None = None,
    prefix: str = "",
) -> dict:
    r = _request("POST", "/api/convert", {
        "image_path": image_path,
        "recipe": recipe or preset,
        "overrides": overrides,
    })
    stem = Path(image_path).stem or "image"
    preview = _save_png_b64(
        r["preview_png"], f"{prefix}{stem}_{size}px_preview.png", preview_dir
    )
    try:
        _record_recipe(r["job_id"], _full_recipe(recipe, preset, overrides))
    except Exception:  # noqa: BLE001 —— 配方缓存失败不应影响转换结果
        pass
    return {
        "job_id": r["job_id"],
        "revision": r.get("revision"),
        "grid": [r["width"], r["height"]],
        "palette_colors": len(r["palette"]),
        "meta": r["meta"],
        "preview_png": preview,
        "提示": "查看 preview_png 文件可核验效果；用 result_info/get_pixel 细查",
    }


# ---------------------------------------------------------------- 工具定义
@mcp.tool()
def pixelforge_health() -> str:
    """检查 PixelForge 引擎状态：在线状态、可用预设、AI 模型在位情况。调用其他工具前先看这个。"""
    return _j(_request("GET", "/api/health"))


@mcp.tool()
def pixelforge_convert(
    image_path: str,
    preset: str = "photo",
    size: int = 64,
    mode: str | None = None,
    edge_w: float | None = None,
    dark_w: float | None = None,
    contrast_w: float | None = None,
    palette: str | None = None,
    k: int | None = None,
    lineart: str | None = None,
    ink: bool = False,
    recipe: str | None = None,
    include_image: bool = True,
) -> CallToolResult:
    """把图片转换为像素画（主引擎：加权众数 v1.1）。

    image_path: 建议绝对路径 | preset: photo | illustration
    size: 目标网格边长 16-256 | mode: weighted_mode | mean(对照)
    edge_w/dark_w/contrast_w: 采样权重（默认 2.0/1.5/1.0）
    palette: extract(从图提取) | gameboy | cga16 | gray8 | k: 提取颜色数
    lineart: 墨线线稿源 off | xdog | onnx；ink: 是否叠加墨线层
    recipe: 已保存的配方名或 JSON 路径（优先于 preset）
    include_image: 是否同时返回 MCP image 内容块（默认 true）
    返回 job_id、用色数、耗时和预览图文件路径（可直接查看）。
    """
    _agent_control(True, "转换图片", 1.5)
    ov = _build_convert_overrides(
        size, mode, edge_w, dark_w, contrast_w, palette, k, lineart, ink
    )
    payload = _convert_and_save(
        image_path, preset=preset, recipe=recipe, size=size, overrides=ov
    )
    if include_image:
        return _text_image_result(payload, image_path=payload["preview_png"])
    return _text_result(payload)


@mcp.tool()
def pixelforge_convert_batch(
    input_path: str | None = None,
    image_paths: list[str] | None = None,
    preset: str = "photo",
    size: int = 64,
    mode: str | None = None,
    edge_w: float | None = None,
    dark_w: float | None = None,
    contrast_w: float | None = None,
    palette: str | None = None,
    k: int | None = None,
    lineart: str | None = None,
    ink: bool = False,
    recipe: str | None = None,
    recursive: bool = False,
    pattern: str = "*",
    max_workers: int = 4,
    out_dir: str | None = None,
    include_previews: bool = False,
) -> CallToolResult:
    """批量转换图片：目录递归、并发执行、坏文件跳过并汇总失败清单。

    input_path: 图片文件或目录 | image_paths: 显式文件列表（可与 input_path 并用）
    recursive/pattern: 目录扫描是否递归及 glob 模式（默认 *，按图片扩展名过滤）
    max_workers: 并发数 1-8（默认 4；引擎为 CPU 计算，过大反而变慢）
    out_dir: 预览输出目录（默认 .cache/mcp_out/batch_时间戳）
    include_previews: 是否把前 4 张预览作为 MCP image 内容块返回
    其余参数含义同 pixelforge_convert；recipe 优先于 preset。
    """
    files = _collect_images(input_path, image_paths, recursive, pattern)
    _request("GET", "/api/health")  # 先探活，避免每个文件都报同一句离线错误

    workers = max(1, min(8, int(max_workers), len(files)))
    ov = _build_convert_overrides(
        size, mode, edge_w, dark_w, contrast_w, palette, k, lineart, ink
    )
    batch_dir = (
        Path(out_dir).expanduser()
        if out_dir
        else OUT_DIR / f"batch_{time.strftime('%Y%m%d_%H%M%S')}"
    )
    started = time.perf_counter()

    def work(index: int, path: Path) -> dict:
        try:
            payload = _convert_and_save(
                str(path),
                preset=preset,
                recipe=recipe,
                size=size,
                overrides=ov,
                preview_dir=batch_dir,
                prefix=f"{index:03d}_",
            )
            return {"ok": True, "index": index, "image_path": str(path), **payload}
        except Exception as e:  # noqa: BLE001 —— 单个文件失败不中断批量
            return {"ok": False, "index": index, "image_path": str(path), "error": str(e)}

    outcomes: list[dict] = []
    _agent_control(True, f"批量转换 {len(files)} 张", 60.0)
    try:
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = [pool.submit(work, i, path) for i, path in enumerate(files)]
            for future in as_completed(futures):
                outcomes.append(future.result())
    finally:
        _agent_control(False, "", 0.0)
    outcomes.sort(key=lambda item: item["index"])

    ok = [item for item in outcomes if item["ok"]]
    failures = [
        {"image_path": item["image_path"], "error": item["error"]}
        for item in outcomes if not item["ok"]
    ]
    payload = {
        "total": len(files),
        "ok": len(ok),
        "failed": len(failures),
        "elapsed_s": round(time.perf_counter() - started, 2),
        "out_dir": str(batch_dir),
        "results": ok,
        "failures": failures,
    }
    if include_previews:
        return _text_images_result(payload, [item["preview_png"] for item in ok])
    return _text_result(payload)


@mcp.tool()
def pixelforge_extract_lineart(
    image_path: str,
    mode: str = "onnx",
    out_path: str | None = None,
    include_image: bool = True,
) -> CallToolResult:
    """独立提取线稿（黑线白纸 PNG，与原图同尺寸）。mode: onnx(高质量，默认) | xdog(快速)。"""
    r = _request("POST", "/api/lineart", {"image_path": image_path, "mode": mode})
    path = out_path or str(OUT_DIR / f"{Path(image_path).stem}_lineart_{mode}.png")
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    Path(path).write_bytes(base64.b64decode(r["png"]))
    payload = {
        "mode": mode,
        "size": [r["width"], r["height"]],
        "png": str(Path(path).absolute()),
    }
    if include_image:
        return _text_image_result(payload, image_path=path)
    return _text_result(payload)


@mcp.tool()
def pixelforge_extract_palette(image_path: str, k: int = 64) -> str:
    """从图片提取调色板（OKLab k-means）。返回颜色 hex 列表。"""
    r = _request("POST", "/api/extract_palette", {"image_path": image_path, "k": k})
    hexes = ["#{:02x}{:02x}{:02x}".format(*c) for c in r["colors"]]
    return _j({"count": r["count"], "colors": hexes})


@mcp.tool()
def pixelforge_remove_background(
    image_path: str,
    out_path: str | None = None,
    include_image: bool = True,
) -> CallToolResult:
    """主体抠图（U2Net）：返回前景透明 PNG（RGBA）文件路径。"""
    r = _request("POST", "/api/matting", {"image_path": image_path})
    path = out_path or str(OUT_DIR / f"{Path(image_path).stem}_cutout.png")
    Path(path).write_bytes(base64.b64decode(r["png"]))
    payload = {"size": [r["width"], r["height"]], "png": str(Path(path).absolute())}
    if include_image:
        return _text_image_result(payload, image_path=path)
    return _text_result(payload)


@mcp.tool()
def pixelforge_export_stage(
    job_id: str,
    stage: str = "preview",
    out_path: str | None = None,
    include_image: bool = True,
) -> CallToolResult:
    """导出转换的中间产物。stage: p0 | edge | lineart | fill | ink | preview(合成结果)。"""
    r = _request("GET", f"/api/stage/{job_id}/{stage}")
    path = out_path or str(OUT_DIR / f"{job_id}_{stage}.png")
    Path(path).write_bytes(base64.b64decode(r["png"]))
    payload = {"stage": stage, "png": str(Path(path).absolute())}
    if include_image:
        return _text_image_result(payload, image_path=path)
    return _text_result(payload)


@mcp.tool()
def pixelforge_result_info(job_id: str) -> str:
    """查询转换结果统计：尺寸、用色数、调色板使用占比 Top（调参决策用）。"""
    return _j(_request("GET", f"/api/result_info/{job_id}"))


@mcp.tool()
def pixelforge_list_jobs() -> str:
    """列出引擎内存中的 job（含编辑器打开的文档），可用于挑选要编辑的 job_id。"""
    return _j(_request("GET", "/api/jobs"))


@mcp.tool()
def pixelforge_get_pixel(job_id: str, x: int, y: int) -> str:
    """读取结果中某格子的颜色（x 列 y 行，从 0 起）。核验局部效果用。"""
    return _j(_request("GET", f"/api/get_pixel/{job_id}?x={x}&y={y}"))


# ---------------------------------------------------------------- MCP-3A 像素编辑
def _edit_payload(job_id: str, payload: dict, suffix: str, include_image: bool) -> CallToolResult:
    preview = _save_png_b64(payload.pop("preview_png"), f"{job_id}_{suffix}.png")
    payload["preview_png"] = preview
    if include_image:
        return _text_image_result(payload, image_path=preview)
    return _text_result(payload)


@mcp.tool()
def pixelforge_get_grid(job_id: str) -> str:
    """读取 job 当前完整网格：fill/ink/alpha、调色板、尺寸与 revision。编辑前先读它。"""
    return _j(_request("GET", f"/api/jobs/{job_id}/grid"))


@mcp.tool()
def pixelforge_draw_pixels(
    job_id: str,
    pixels: list[dict],
    revision: int | None = None,
    include_image: bool = True,
) -> CallToolResult:
    """批量写格。pixels 每项：{x, y, fill?, ink?, alpha?}。

    fill: 调色板索引（0..N-1）| ink: 调色板索引，-1=清除墨线 | alpha: 0=透明 1=不透明。
    只改给出的通道；revision 可选，用于避免覆盖他人编辑。返回修订号与预览图。
    """
    _agent_control(True, "像素编辑", 1.5)
    payload = _request("POST", f"/api/jobs/{job_id}/pixels", {
        "pixels": pixels, "revision": revision,
    })
    return _edit_payload(job_id, payload, "pixels", include_image)


@mcp.tool()
def pixelforge_fill_region(
    job_id: str,
    x: int,
    y: int,
    fill: int,
    target: int | None = None,
    contiguous: bool = True,
    revision: int | None = None,
    include_image: bool = True,
) -> CallToolResult:
    """区域填充。默认从种子 (x,y) 做四连通泛洪；contiguous=false 则替换整图同色。

    fill: 新调色板索引 | target: 要替换的旧索引（空=种子格当前色）。
    """
    _agent_control(True, "区域填充", 1.5)
    payload = _request("POST", f"/api/jobs/{job_id}/fill", {
        "x": x, "y": y, "fill": fill, "target": target,
        "contiguous": contiguous, "revision": revision,
    })
    return _edit_payload(job_id, payload, "fill", include_image)


@mcp.tool()
def pixelforge_palette_transform(
    job_id: str,
    lightness: float = 0.0,
    hue: float = 0.0,
    saturation: float = 0.0,
    revision: int | None = None,
    include_image: bool = True,
) -> CallToolResult:
    """整板 OKLab 变换：索引不动，只改颜色。lightness -1..1 | hue -180..180 | saturation -1..1。"""
    _agent_control(True, "调色板变换", 1.5)
    payload = _request("POST", f"/api/jobs/{job_id}/palette", {
        "lightness": lightness, "hue": hue, "saturation": saturation,
        "revision": revision,
    })
    return _edit_payload(job_id, payload, "palette", include_image)


@mcp.tool()
def pixelforge_rerun_region(
    job_id: str,
    rect: dict | None = None,
    cells: list[list[int]] | None = None,
    param_delta: dict | None = None,
    expand_colors: int = 0,
    revision: int | None = None,
    include_image: bool = True,
) -> CallToolResult:
    """局部重算（只跑 S2 采样，固定沿用现有色板）。

    rect: {x0,y0,x1,y1}（含端点）| cells: [[x,y], ...] | 两者至少给一个。
    param_delta: {"sampling": {"weights": {"edge": 2.5}, "soft_ratio": 1.2, "merge_delta": 0.02}}
    expand_colors: 允许追加到色板尾部的新色上限 0..16。
    """
    _agent_control(True, "局部重算", 3.0)
    payload = _request("POST", f"/api/jobs/{job_id}/rerun", {
        "rect": rect, "cells": cells, "param_delta": param_delta or {},
        "expand_colors": expand_colors, "revision": revision,
    })
    return _edit_payload(job_id, payload, "rerun", include_image)


@mcp.tool()
def pixelforge_export(
    job_id: str,
    content: str = "composite",
    scale: int = 1,
    transparent: bool = True,
    out_path: str | None = None,
    include_image: bool = True,
) -> CallToolResult:
    """导出 job 当前状态为 PNG。content: composite(RGBA) | indexed(PLTE+tRNS)。scale: 1..16。"""
    payload = _request("POST", f"/api/jobs/{job_id}/export", {
        "content": content, "scale": scale, "transparent": transparent,
    })
    if out_path:
        path = Path(out_path).expanduser()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(base64.b64decode(payload.pop("png")))
        png_path = str(path.absolute())
    else:
        png_path = _save_png_b64(
            payload.pop("png"),
            f"{job_id}_{content}_{scale}x{'_alpha' if transparent else '_opaque'}.png",
        )
    payload["png_path"] = png_path
    if include_image:
        return _text_image_result(payload, image_path=png_path)
    return _text_result(payload)


# ---------------------------------------------------------------- 配方存取（MCP-2）
@mcp.tool()
def pixelforge_list_recipes() -> str:
    """列出全部配方（内置 photo/illustration/lineart 与用户保存的配方）。"""
    _require_feature("recipes")
    items: list[dict] = []
    for path in sorted(RECIPES_DIR.glob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception as e:  # noqa: BLE001 —— 坏文件也列出，方便定位
            items.append({"name": path.stem, "path": str(path), "error": str(e)})
            continue
        target = data.get("target") or {}
        items.append({
            "name": path.stem,
            "path": str(path),
            "builtin": path.stem in BUILTIN_RECIPES,
            "target": [target.get("width"), target.get("height")],
        })
    return _j({"count": len(items), "recipes": items})


@mcp.tool()
def pixelforge_save_recipe(
    name: str,
    job_id: str | None = None,
    recipe: dict | None = None,
    preset: str | None = None,
    overrides: dict | None = None,
    overwrite: bool = False,
) -> str:
    """把一次调好的参数保存为 recipes/<name>.json。

    来源三选一（优先级从高到低）：
    - recipe: 直接给完整或部分配方 JSON；
    - job_id: 取本 MCP 进程刚转换过的 job 配方（跨进程不保证）；
    - preset/overrides: 用内置预设 + 覆盖参数生成完整配方。
    name 不接受路径分隔符；同名文件默认拒绝，需 overwrite=true。
    """
    _require_feature("recipes")
    if recipe is not None:
        if not isinstance(recipe, dict):
            raise ValueError("recipe 必须是 JSON 对象")
        data = json.loads(json.dumps(recipe, ensure_ascii=False))
    elif job_id:
        cached = _RECIPE_CACHE.get(job_id)
        if cached is None:
            raise ValueError(
                "该 job 不在当前 MCP 进程的配方缓存中；请改用 recipe 或 preset/overrides"
            )
        data = json.loads(json.dumps(cached, ensure_ascii=False))
    else:
        data = json.loads(json.dumps(
            _full_recipe(None, preset or "photo", overrides or {}),
            ensure_ascii=False,
        ))

    safe = _safe_recipe_name(name)
    path = RECIPES_DIR / f"{safe}.json"
    existed = path.exists()
    if existed and not overwrite:
        raise ValueError(f"配方已存在: {safe}.json（覆盖请传 overwrite=true）")
    RECIPES_DIR.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)
    return _j({
        "name": safe,
        "path": str(path),
        "overwritten": existed,
        "builtin": safe in BUILTIN_RECIPES,
    })


@mcp.tool()
def pixelforge_get_recipe(
    job_id: str | None = None,
    name: str | None = None,
) -> str:
    """读取配方：name 读 recipes/<name>.json；job_id 读本 MCP 进程缓存的转换配方。"""
    _require_feature("recipes")
    if name:
        safe = _safe_recipe_name(name)
        path = RECIPES_DIR / f"{safe}.json"
        if not path.exists():
            raise ValueError(f"配方不存在: {safe}.json")
        return _j({
            "source": "file",
            "name": safe,
            "path": str(path),
            "recipe": json.loads(path.read_text(encoding="utf-8")),
        })
    if job_id:
        cached = _RECIPE_CACHE.get(job_id)
        if cached is None:
            raise ValueError(
                "该 job 的配方不在当前 MCP 进程缓存中；请用 name 读取已保存配方"
            )
        return _j({"source": "job", "job_id": job_id, "recipe": cached})
    raise ValueError("请传 name 或 job_id")


if __name__ == "__main__":
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    mcp.run()
