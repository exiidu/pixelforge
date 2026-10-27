"""MCP 服务器端到端测试：以 stdio 客户端身份启动并调用全部工具。

运行：python tools/check_mcp.py（需引擎在线 :8700）
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENGINE_URL = os.environ.get("PIXELFORGE_URL", "http://127.0.0.1:8700")
AGENT_ID = os.environ.get("PIXELFORGE_AGENT_ID", "local-mcp")
SCENE = str(ROOT / "tests" / "golden" / "scene.png")
RGBA = str(ROOT / "tests" / "golden" / "inputs" / "rgba_test.png")
UMBRELLA = str(ROOT / "tests" / "golden" / "inputs" / "girl_umbrella.png")
MISSING = str(ROOT / "tests" / "golden" / "inputs" / "_missing_for_batch.png")
TEST_RECIPE = ROOT / "recipes" / "_mcp_selftest.json"


def http_json(method: str, path: str, payload: dict | None = None) -> dict:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(
        f"{ENGINE_URL}{path}", data=data, method=method,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8"))


async def main() -> int:
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client

    prior_agents = http_json("GET", "/api/agents").get("agents", [])
    prior_features = next(
        (dict(a.get("features") or {}) for a in prior_agents if a.get("id") == AGENT_ID),
        {},
    )

    params = StdioServerParameters(
        command=sys.executable,
        args=["-m", "engine.mcp_server"],
        cwd=str(ROOT),
        env=dict(os.environ),
    )
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()

            tools = await session.list_tools()
            names = [t.name for t in tools.tools]
            print(f"已连接，工具 {len(names)} 个: {names}")
            assert len(names) == 19, "应有 19 个工具"

            async def call(name: str, args: dict):
                res = await session.call_tool(name, args)
                assert not res.is_error, f"{name} 失败: {res.content}"
                return res

            async def call_error(name: str, args: dict) -> str:
                res = await session.call_tool(name, args)
                assert res.is_error, f"{name} 本应被拒绝: {res.content}"
                return res.content[0].text

            def text(res) -> str:
                return res.content[0].text

            def has_image(res) -> bool:
                return any(getattr(block, "type", None) == "image" for block in res.content)

            print("\n-- health --")
            print(json.loads(text(await call("pixelforge_health", {})))["status"])
            agents = http_json("GET", "/api/agents").get("agents", [])
            assert any(a["id"] == AGENT_ID and a["status"] == "connected" for a in agents), agents
            print(f"Agent 已登记: {AGENT_ID}")

            print("-- convert（蘑菇小屋 48 格 gameboy）--")
            res = await call("pixelforge_convert", {
                "image_path": SCENE, "preset": "photo", "size": 48,
                "palette": "gameboy",
            })
            r = json.loads(text(res))
            job = r["job_id"]
            print(f"job={job} 网格={r['grid']} 用色={r['palette_colors']} 预览={r['preview_png']}")
            assert Path(r["preview_png"]).exists()
            assert has_image(res), "convert 应返回 MCP image 内容块"

            print("-- convert（雨伞女孩 64 格 + onnx 墨线）--")
            r2 = json.loads(text(await call("pixelforge_convert", {
                "image_path": UMBRELLA, "size": 64,
                "lineart": "onnx", "ink": True, "edge_w": 2.5,
            })))
            job2 = r2["job_id"]
            print(f"job={job2} meta={r2['meta'].get('colors_used')}色 {r2['meta'].get('grid_ms')}ms")

            print("-- convert_batch（2 图并发 + 1 个坏文件）--")
            bres = await call("pixelforge_convert_batch", {
                "image_paths": [SCENE, RGBA, MISSING], "size": 32, "palette": "gameboy",
                "max_workers": 2, "include_previews": True,
            })
            batch = json.loads(text(bres))
            assert batch["total"] == 3 and batch["ok"] == 2 and batch["failed"] == 1, batch
            assert all(Path(item["preview_png"]).exists() for item in batch["results"])
            assert batch["failures"][0]["image_path"].endswith("_missing_for_batch.png")
            assert has_image(bres), "batch 应返回预览图片块"
            print(f"批量 {batch['ok']}/{batch['total']}，失败 {batch['failed']}，耗时 {batch['elapsed_s']}s -> {batch['out_dir']}")

            print("-- extract_lineart（onnx）--")
            la_res = await call("pixelforge_extract_lineart", {"image_path": UMBRELLA})
            la = json.loads(text(la_res))
            assert Path(la["png"]).exists() and Path(la["png"]).stat().st_size > 10000
            assert has_image(la_res), "线稿应返回 MCP image 内容块"
            print(f"线稿 -> {la['png']}")

            print("-- extract_palette（k=12）--")
            pal = json.loads(text(await call("pixelforge_extract_palette", {"image_path": SCENE, "k": 12})))
            print(f"调色板 {pal['count']} 色前5: {pal['colors'][:5]}")

            print("-- remove_background --")
            mb_res = await call("pixelforge_remove_background", {"image_path": SCENE})
            mb = json.loads(text(mb_res))
            assert Path(mb["png"]).exists()
            assert has_image(mb_res), "抠图应返回 MCP image 内容块"
            print(f"抠图 -> {mb['png']}")

            print("-- export_stage（edge）--")
            st_res = await call("pixelforge_export_stage", {"job_id": job, "stage": "edge"})
            st = json.loads(text(st_res))
            assert Path(st["png"]).exists()
            assert has_image(st_res), "阶段导出应返回 MCP image 内容块"
            print(f"边缘图 -> {st['png']}")

            print("-- result_info --")
            info = json.loads(text(await call("pixelforge_result_info", {"job_id": job})))
            print(f"用色 {info['colors_used']}，Top: {info['top_colors'][:3]}")

            print("-- get_pixel（16,16）--")
            px = json.loads(text(await call("pixelforge_get_pixel", {"job_id": job, "x": 16, "y": 16})))
            print(px)

            print("-- list_jobs --")
            jobs = json.loads(text(await call("pixelforge_list_jobs", {})))
            assert jobs["count"] >= 1 and any(item["job_id"] == job for item in jobs["jobs"])
            print(f"jobs={jobs['count']}，当前 job revision={next(i['revision'] for i in jobs['jobs'] if i['job_id'] == job)}")

            print("-- get_grid --")
            grid = json.loads(text(await call("pixelforge_get_grid", {"job_id": job})))
            assert grid["width"] == 48 and len(grid["fill"]) == 48
            n = len(grid["palette"])
            old_idx = grid["fill"][0][0]
            new_idx = (old_idx + 1) % n
            rev = grid["revision"]
            print(f"网格 {grid['width']}×{grid['height']}，调色板 {n} 色，revision={rev}")

            print("-- draw_pixels --")
            draw_res = await call("pixelforge_draw_pixels", {
                "job_id": job,
                "pixels": [
                    {"x": 0, "y": 0, "fill": new_idx},
                    {"x": 1, "y": 1, "alpha": 0},
                ],
                "revision": rev,
            })
            draw = json.loads(text(draw_res))
            assert draw["changed"] == 2 and draw["revision"] == rev + 1, draw
            assert has_image(draw_res)
            grid2 = json.loads(text(await call("pixelforge_get_grid", {"job_id": job})))
            assert grid2["fill"][0][0] == new_idx
            assert grid2["alpha"][1][1] == 0
            print(f"改格成功，revision={draw['revision']}")

            print("-- fill_region --")
            seed_idx = grid2["fill"][2][2]
            fill_idx = (seed_idx + 1) % n
            fill_res = await call("pixelforge_fill_region", {
                "job_id": job, "x": 2, "y": 2, "fill": fill_idx,
                "revision": grid2["revision"],
            })
            fill = json.loads(text(fill_res))
            assert fill["changed"] >= 1 and has_image(fill_res), fill
            grid3 = json.loads(text(await call("pixelforge_get_grid", {"job_id": job})))
            assert grid3["fill"][2][2] == fill_idx
            print(f"填充 {fill['changed']} 格，revision={fill['revision']}")

            print("-- palette_transform --")
            pal_res = await call("pixelforge_palette_transform", {
                "job_id": job, "lightness": 0.2, "hue": 30, "saturation": 0.1,
                "revision": grid3["revision"],
            })
            pal = json.loads(text(pal_res))
            assert pal["changed"] == 1 and len(pal["palette"]) == n, pal
            assert pal["palette"] != grid3["palette"] and has_image(pal_res)
            print(f"色板变换成功，revision={pal['revision']}")

            print("-- rerun_region --")
            rerun_res = await call("pixelforge_rerun_region", {
                "job_id": job,
                "rect": {"x0": 0, "y0": 0, "x1": 7, "y1": 7},
                "param_delta": {"sampling": {"weights": {"edge": 3.0}}},
                "revision": pal["revision"],
            })
            rerun = json.loads(text(rerun_res))
            assert "changed" in rerun and "appended_colors" in rerun, rerun
            assert has_image(rerun_res)
            print(f"局部重算 changed={rerun['changed']}，追加色={rerun['appended_colors']}，revision={rerun['revision']}")

            print("-- export（composite 2× + indexed 1×）--")
            exp_res = await call("pixelforge_export", {
                "job_id": job, "content": "composite", "scale": 2, "transparent": True,
            })
            exp = json.loads(text(exp_res))
            assert Path(exp["png_path"]).exists() and exp["width"] == 96 and exp["height"] == 96
            assert has_image(exp_res)
            idx_res = await call("pixelforge_export", {
                "job_id": job, "content": "indexed", "scale": 1, "transparent": True,
            })
            idx = json.loads(text(idx_res))
            assert Path(idx["png_path"]).exists() and idx["transparent"] is True
            print(f"导出：{exp['png_path']} / {idx['png_path']}")

            print("-- recipe save/get/list --")
            TEST_RECIPE.unlink(missing_ok=True)
            try:
                saved = json.loads(text(await call("pixelforge_save_recipe", {
                    "name": "_mcp_selftest", "job_id": job, "overwrite": True,
                })))
                assert Path(saved["path"]).exists()
                got = json.loads(text(await call("pixelforge_get_recipe", {"name": "_mcp_selftest"})))
                assert got["recipe"]["target"]["width"] == 48, got["recipe"]["target"]
                got_job = json.loads(text(await call("pixelforge_get_recipe", {"job_id": job})))
                assert got_job["source"] == "job"
                listed = json.loads(text(await call("pixelforge_list_recipes", {})))
                assert any(item["name"] == "_mcp_selftest" for item in listed["recipes"])

                conv_res = await call("pixelforge_convert", {
                    "image_path": SCENE, "recipe": "_mcp_selftest", "size": 32,
                })
                conv = json.loads(text(conv_res))
                assert conv["grid"] == [32, 32], conv["grid"]
                assert has_image(conv_res)
                print(f"配方存取通过：{saved['path']}")
            finally:
                TEST_RECIPE.unlink(missing_ok=True)

            print("-- feature permission --")
            try:
                http_json("POST", "/api/agents/features", {
                    "agent_id": AGENT_ID,
                    "features": {**prior_features, "edit": False},
                })
                await asyncio.sleep(2.2)  # 等待 MCP 端 2s 功能缓存过期
                err = await call_error("pixelforge_draw_pixels", {
                    "job_id": job,
                    "pixels": [{"x": 0, "y": 0, "fill": new_idx}],
                })
                assert "禁用" in err, err
                print("被禁用的像素编辑已被拒绝")
            finally:
                http_json("POST", "/api/agents/features", {
                    "agent_id": AGENT_ID, "features": prior_features,
                })

            print("\n全部 19 个工具通过 ✅")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
