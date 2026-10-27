# PixelForge Engine

图片 → 分层像素画的确定性转换引擎，附带 FastAPI 本地服务与 MCP 服务器。
完整介绍、快速开始与编辑器说明见仓库根目录 [`README.md`](../README.md)。

## 管线

```
源图 → S0 预处理 → S1 结构/线稿 → S2 加权采样 → S3 OKLab 量化 → S4 墨线合成 → S5 后处理
                                                                          ↓
                                            Fill 层 + Ink 层 + 调色板（索引 PNG / 配方 JSON）
```

- `engine/pipeline.py`：管线组装、阶段缓存、局部重跑（`rerun_region`）。
- `engine/types.py` / `recipe.py`：数据模型与配方（预设、参数校验）。
- `engine/stages/`：六个阶段，各自独立。
- `engine/core/`：`grid`（源图像素→网格映射）、`palette`（提取/最近色）、`oklab`（色彩距离）。
- `engine/io_utils.py`：统一加载（RGBA 白底合成、ICC→sRGB）与保存。
- `engine/ai/`：可选 ONNX Provider（线稿 / 抠图）；模型缺失时自动降级。
- `engine/server/api.py`：FastAPI（转换、job 编辑、WS 同步、Agent、会话）。
- `engine/mcp_server.py` + `mcp_launcher.py`：stdio MCP 服务器（19 个工具）。
- `engine/cli.py`：命令行转换。

## 安装与运行

```bash
pip install -e ".[ai,mcp,dev]"
python -m uvicorn engine.server.api:app --host 127.0.0.1 --port 8700
```

模型可选：`python tools/download_models.py`（校验值见 `models/README.md`）。

## 测试

```bash
python -m pytest -q
python tools/check_mcp.py   # 需先启动引擎
```

## 文档

- [`../conversion-engine-design.md`](../conversion-engine-design.md)：管线与算法设计
- [`../mcp-design.md`](../mcp-design.md)：MCP 工具与 Agent 协议
- [`../editor-design.md`](../editor-design.md)：编辑器前端设计
- [`models/README.md`](models/README.md)：模型来源、许可与校验

许可：MIT，见 [`../LICENSE`](../LICENSE)；第三方声明见 [`../THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md)。
