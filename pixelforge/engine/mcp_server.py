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
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

from mcp.server.mcpserver import MCPServer  # MCP SDK 2.x（原 FastMCP）

ENGINE_URL = os.environ.get("PIXELFORGE_URL", "http://127.0.0.1:8700")
OUT_DIR = Path(
    os.environ.get("PIXELFORGE_MCP_OUT", "")
    or Path(__file__).resolve().parents[1] / ".cache" / "mcp_out"
)

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
def _request(method: str, path: str, payload: dict | None = None) -> dict:
    _validate_engine_url(ENGINE_URL)
    url = f"{ENGINE_URL}{path}"
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(
        url, data=data, method=method,
        headers={"Content-Type": "application/json"},
    )
    try:
        with _OPENER.open(req, timeout=180) as resp:
            return json.loads(resp.read().decode("utf-8"))
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


def _save_png_b64(b64: str, filename: str) -> str:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    path = OUT_DIR / filename
    path.write_bytes(base64.b64decode(b64))
    return str(path)


def _j(obj) -> str:
    return json.dumps(obj, ensure_ascii=False)


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
) -> str:
    """把图片转换为像素画（主引擎：加权众数 v1.1）。

    image_path: 建议绝对路径 | preset: photo | illustration
    size: 目标网格边长 16-256 | mode: weighted_mode | mean(对照)
    edge_w/dark_w/contrast_w: 采样权重（默认 2.0/1.5/1.0）
    palette: extract(从图提取) | gameboy | cga16 | gray8 | k: 提取颜色数
    lineart: 墨线线稿源 off | xdog | onnx；ink: 是否叠加墨线层
    返回 job_id、用色数、耗时和预览图文件路径（可直接查看）。
    """
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

    r = _request("POST", "/api/convert", {
        "image_path": image_path, "recipe": preset, "overrides": ov,
    })
    stem = Path(image_path).stem
    preview = _save_png_b64(r["preview_png"], f"{stem}_{size}px_preview.png")
    return _j({
        "job_id": r["job_id"], "grid": [r["width"], r["height"]],
        "palette_colors": len(r["palette"]), "meta": r["meta"],
        "preview_png": preview,
        "提示": "查看 preview_png 文件可核验效果；用 result_info/get_pixel 细查",
    })


@mcp.tool()
def pixelforge_extract_lineart(
    image_path: str, mode: str = "onnx", out_path: str | None = None
) -> str:
    """独立提取线稿（黑线白纸 PNG，与原图同尺寸）。mode: onnx(高质量，默认) | xdog(快速)。"""
    r = _request("POST", "/api/lineart", {"image_path": image_path, "mode": mode})
    path = out_path or str(OUT_DIR / f"{Path(image_path).stem}_lineart_{mode}.png")
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    Path(path).write_bytes(base64.b64decode(r["png"]))
    return _j({"mode": mode, "size": [r["width"], r["height"]], "png": str(Path(path).absolute())})


@mcp.tool()
def pixelforge_extract_palette(image_path: str, k: int = 64) -> str:
    """从图片提取调色板（OKLab k-means）。返回颜色 hex 列表。"""
    r = _request("POST", "/api/extract_palette", {"image_path": image_path, "k": k})
    hexes = ["#{:02x}{:02x}{:02x}".format(*c) for c in r["colors"]]
    return _j({"count": r["count"], "colors": hexes})


@mcp.tool()
def pixelforge_remove_background(image_path: str, out_path: str | None = None) -> str:
    """主体抠图（U2Net）：返回前景透明 PNG（RGBA）文件路径。"""
    r = _request("POST", "/api/matting", {"image_path": image_path})
    path = out_path or str(OUT_DIR / f"{Path(image_path).stem}_cutout.png")
    Path(path).write_bytes(base64.b64decode(r["png"]))
    return _j({"size": [r["width"], r["height"]], "png": str(Path(path).absolute())})


@mcp.tool()
def pixelforge_export_stage(
    job_id: str, stage: str = "preview", out_path: str | None = None
) -> str:
    """导出转换的中间产物。stage: p0 | edge | lineart | fill | ink | preview(合成结果)。"""
    r = _request("GET", f"/api/stage/{job_id}/{stage}")
    path = out_path or str(OUT_DIR / f"{job_id}_{stage}.png")
    Path(path).write_bytes(base64.b64decode(r["png"]))
    return _j({"stage": stage, "png": str(Path(path).absolute())})


@mcp.tool()
def pixelforge_result_info(job_id: str) -> str:
    """查询转换结果统计：尺寸、用色数、调色板使用占比 Top（调参决策用）。"""
    return _j(_request("GET", f"/api/result_info/{job_id}"))


@mcp.tool()
def pixelforge_get_pixel(job_id: str, x: int, y: int) -> str:
    """读取结果中某格子的颜色（x 列 y 行，从 0 起）。核验局部效果用。"""
    return _j(_request("GET", f"/api/get_pixel/{job_id}?x={x}&y={y}"))


if __name__ == "__main__":
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    mcp.run()
