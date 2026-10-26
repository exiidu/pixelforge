"""MCP 服务器端到端测试：以 stdio 客户端身份启动并调用全部 8 个工具。

运行：python tools/check_mcp.py（需引擎在线 :8700）
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCENE = str(ROOT / "tests" / "golden" / "scene.png")
UMBRELLA = str(ROOT / "tests" / "golden" / "inputs" / "girl_umbrella.png")


async def main() -> int:
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client

    params = StdioServerParameters(
        command=sys.executable,
        args=["-m", "engine.mcp_server"],
        cwd=str(ROOT),
    )
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()

            tools = await session.list_tools()
            names = [t.name for t in tools.tools]
            print(f"已连接，工具 {len(names)} 个: {names}")
            assert len(names) == 8, "应有 8 个工具"

            async def call(name: str, args: dict) -> str:
                res = await session.call_tool(name, args)
                assert not res.is_error, f"{name} 失败: {res.content}"
                return res.content[0].text

            print("\n-- health --")
            print(json.loads(await call("pixelforge_health", {}))["status"])

            print("-- convert（蘑菇小屋 48 格 gameboy）--")
            r = json.loads(await call("pixelforge_convert", {
                "image_path": SCENE, "preset": "photo", "size": 48,
                "palette": "gameboy",
            }))
            job = r["job_id"]
            print(f"job={job} 网格={r['grid']} 用色={r['palette_colors']} 预览={r['preview_png']}")
            assert Path(r["preview_png"]).exists()

            print("-- convert（雨伞女孩 64 格 + onnx 墨线）--")
            r2 = json.loads(await call("pixelforge_convert", {
                "image_path": UMBRELLA, "size": 64,
                "lineart": "onnx", "ink": True, "edge_w": 2.5,
            }))
            job2 = r2["job_id"]
            print(f"job={job2} meta={r2['meta'].get('colors_used')}色 {r2['meta'].get('grid_ms')}ms")

            print("-- extract_lineart（onnx）--")
            la = json.loads(await call("pixelforge_extract_lineart", {"image_path": UMBRELLA}))
            assert Path(la["png"]).exists() and Path(la["png"]).stat().st_size > 10000
            print(f"线稿 -> {la['png']}")

            print("-- extract_palette（k=12）--")
            pal = json.loads(await call("pixelforge_extract_palette", {"image_path": SCENE, "k": 12}))
            print(f"调色板 {pal['count']} 色前5: {pal['colors'][:5]}")

            print("-- remove_background --")
            mb = json.loads(await call("pixelforge_remove_background", {"image_path": SCENE}))
            assert Path(mb["png"]).exists()
            print(f"抠图 -> {mb['png']}")

            print("-- export_stage（edge）--")
            st = json.loads(await call("pixelforge_export_stage", {"job_id": job, "stage": "edge"}))
            assert Path(st["png"]).exists()
            print(f"边缘图 -> {st['png']}")

            print("-- result_info --")
            info = json.loads(await call("pixelforge_result_info", {"job_id": job}))
            print(f"用色 {info['colors_used']}，Top: {info['top_colors'][:3]}")

            print("-- get_pixel（16,16）--")
            px = json.loads(await call("pixelforge_get_pixel", {"job_id": job, "x": 16, "y": 16}))
            print(px)

            print("\n全部 8 个工具通过 ✅")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
