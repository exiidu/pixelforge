# 第三方组件与模型许可说明

PixelForge 本体以 **MIT** 许可发布（见根目录 `LICENSE`）。仓库不分发任何 AI 模型权重，
模型由使用者自行下载；下表列出运行时依赖与可选模型的来源与许可。

## 可选 AI 模型（不随仓库分发）

| 组件 | 用途 | 许可 | 来源 |
|---|---|---|---|
| Informative Drawings（`lineart/model.onnx`） | 线稿提取 | MIT | https://github.com/carolineec/informative-drawings |
| U²-Net（`matting/u2net.onnx`） | 主体抠图（质量档） | Apache-2.0 | https://github.com/xuebinqin/U-2-Net |
| U²-NetP（`matting/u2netp.onnx`） | 主体抠图（轻量档） | Apache-2.0 | https://github.com/xuebinqin/U-2-Net |

- 本项目的预处理按 U²-Net / rembg 的公开实现对齐，但**未打包 rembg 代码或其依赖**。
- ComfyUI 仅保留 Provider 接口占位，仓库不包含 ComfyUI 代码（其许可为 GPL-3.0，若未来直接集成需重新评估）。

## 运行时依赖（主要）

| 依赖 | 许可 |
|---|---|
| Python / FastAPI / Uvicorn | PSF-2.0 / MIT / BSD-3-Clause |
| NumPy / Pillow / OpenCV | BSD-3-Clause / HPND / Apache-2.0 |
| onnxruntime | MIT |
| MCP Python SDK | MIT |
| Vite / TypeScript | MIT / Apache-2.0 |

完整依赖树以 `pixelforge/pyproject.toml` 与 `pixelforge/web/package-lock.json` 为准；
发布二进制时请同时附带本文件与各依赖的许可文本。

## 素材

- 内置示例项目（`web/src/sample.ts`）由代码程序化绘制，不使用第三方图片。
- PICO-8 调色板仅作为颜色值参考，不包含其运行时或美术素材。
