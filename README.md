# PixelForge

**把任意图片转成分层、可编辑、索引色的像素画，并直接在里面继续画。**

PixelForge 是一个本地运行的图片转像素画引擎 + 像素编辑器。转换是确定性管线，
输出「底色层 + 墨线层 + 调色板」；编辑器在此之上提供手改、图层、选区、调色板变换、
局部细节重算与多格式导出。另附 MCP 服务器，让 AI Agent 可以通过标准工具调用引擎与编辑器。

> 中文 | [English](#english)

---

## 功能

- **确定性转换管线**：S0 预处理 → S1 结构/线稿 → S2 加权众数采样 → S3 OKLab 调色板量化 →
  S4 墨线合成 → S5 后处理；同一源图与配方可复现。
- **分层输出**：底色层 Fill、墨线层 Ink、调色板；支持索引 PNG（PLTE + tRNS）、真透明与主体分离。
- **像素编辑器**：多文档标签、14 种工具、逻辑图层栈、撤销/重做、选区、笔刷/对称、
  调色板排序与锁定、色板 OKLab 变换、描图底图、会话自动恢复。
- **批量与导出**：文件夹批量导入、参数广播到全部标签、PNG/JPEG/WEBP、索引 PNG、
  引擎线稿、像素墨线层、精灵图集、命名模板。
- **局部细节重算**：「细节」笔刷标记区域，只重算标记格，可撤销。
- **可选 AI**：线稿提取（Informative Drawings）与主体抠图（U²-Net / U²-NetP），模型按需下载。
- **MCP / Agent**：19 个工具覆盖转换、批量、配方、像素编辑、填充、调色板、局部重算与导出；
  编辑器提供 Agent 控制蒙版、功能权限与 WebSocket 实时同步。
- **产品化体验**：全局设置中心、中英双语界面、帮助中心、首次启动引导、内置示例项目。

## 环境要求

- Windows 10/11（当前主要在 Windows 验证；引擎与前端本身跨平台）
- Python 3.11+
- Node.js 18+
- 可选：`onnxruntime` 与模型权重（AI 线稿/抠图）

## 快速开始

```bash
git clone https://github.com/exiidu/pixelforge.git
cd pixelforge                      # 仓库根目录（内含同名的 pixelforge/ 包目录）
python -m pip install -e "pixelforge[ai,mcp,dev]"   # 安装引擎包
(cd pixelforge/web && npm install)                  # 安装前端依赖
```

下载可选模型（不下载也能用非 AI 功能，需在仓库根目录执行）：

```bash
python pixelforge/tools/download_models.py
```

启动（仓库根目录）：

```bat
start_all.bat
```

脚本会自动启动引擎（`127.0.0.1:8700`）与前端（`localhost:5173`）并打开浏览器。
手动启动（在仓库根目录执行）：

```bash
cd pixelforge
python -m uvicorn engine.server.api:app --host 127.0.0.1 --port 8700
# 另开终端，仍在仓库根目录
cd pixelforge/web && npm run dev
```

打开 `http://localhost:5173`。首次启动会引导选择语言，并可一键打开内置示例项目。

## MCP 接入

在 MCP 客户端（如 ZCode / Claude Desktop 等支持 stdio 的客户端）中加入：

```json
{
  "mcpServers": {
    "pixelforge": {
      "command": "python",
      "args": ["<repo>/pixelforge/mcp_launcher.py"],
      "env": { "PIXELFORGE_URL": "http://127.0.0.1:8700" }
    }
  }
}
```

先用上面的方式启动引擎。工具列表与参数说明见 `mcp-design.md`。

## 安全与隐私

- 引擎默认只监听回环地址；图片不上传云端，AI 模型在本机运行，无遥测。
- CORS 仅放行本机来源（`localhost` / `127.0.0.1`，任意端口）；可用
  `PIXELFORGE_CORS_ORIGINS` 追加。
- 通过路径读取图片时默认只允许用户主目录与仓库目录；可用
  `PIXELFORGE_ALLOWED_ROOTS`（`os.pathsep` 分隔）扩展。编辑器上传图片不受此限制。
- 模型权重不随仓库分发；下载与校验见 `pixelforge/models/README.md`。

## 开发与测试

```bash
# 后端测试
cd pixelforge && python -m pytest -q

# 前端类型检查与构建
cd pixelforge/web && npx tsc --noEmit && npm run build

# MCP 端到端（需先启动引擎）
cd pixelforge && python tools/check_mcp.py
```

## 项目结构

```
pixelforge/                 仓库根
├── pixelforge/             引擎 + 编辑器
│   ├── engine/             转换管线、AI Provider、FastAPI 服务、MCP 服务器
│   ├── web/                Vite + TypeScript 编辑器（无 UI 框架）
│   ├── tests/              pytest
│   ├── models/             模型目录与下载说明（权重不入库）
│   └── tools/              模型下载、MCP 端到端检查
├── start_all.bat           一键启动（引擎 + 前端）
├── start_all.sh            一键启动（macOS / Linux）
├── start_engine.bat        仅启动引擎
├── editor-design.md        编辑器设计（v1.12）
├── mcp-design.md           MCP 服务器设计
├── conversion-engine-design.md  转换引擎设计
├── productization-roadmap.md    产品化路线与 v1.0 门槛
├── THIRD_PARTY_NOTICES.md  第三方许可
└── LICENSE                 MIT
```

## 已知限制

- 首次启动引导与界面以简体中文/英文为主，其他语言未提供。
- 快捷键目前为固定映射，尚不支持自定义。
- 引擎默认 CPU；GPU 推理未接入。
- `.pixelforge` 项目文件与安装包在路线图（A5 / E）中，尚未实现。

## 许可

MIT，见 [LICENSE](LICENSE)。第三方组件与模型许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

---

## English

**PixelForge turns any image into a layered, editable, indexed-color pixel-art project — and lets you keep painting inside it.**

It is a local image-to-pixel-art engine plus a pixel editor. The conversion is a deterministic
pipeline producing a fill layer, an ink layer, and a palette; the editor adds manual edits,
layers, selections, palette transforms, local detail recompute, and multiple export formats.
An MCP server exposes the engine and editor to AI agents through standard tools.

### Features

- Deterministic pipeline (S0–S5) with weighted-mode sampling and OKLab palette quantization.
- Layered output: fill, ink, palette; indexed PNG (PLTE + tRNS), true transparency and subject matting.
- Multi-document editor with 14 tools, logical layers, undo/redo, selections, brushes, symmetry,
  palette sorting/locking, OKLab palette transforms, tracing underlay, and session restore.
- Batch import/export, parameter broadcasting, PNG/JPEG/WEBP, indexed PNG, engine line art,
  pixel ink layer, sprite atlases, and naming templates.
- Detail brush + partial recompute (only marked cells, undoable).
- Optional AI: line-art extraction (Informative Drawings) and matting (U²-Net / U²-NetP).
- MCP server with 19 tools, agent control overlay, feature permissions, and live WebSocket sync.
- Settings center, Chinese/English UI, help center, first-run onboarding, built-in sample project.

### Requirements

- Windows 10/11 (primary target; engine and web are cross-platform)
- Python 3.11+, Node.js 18+
- Optional: `onnxruntime` plus model weights for AI features

### Quick start

```bash
git clone https://github.com/exiidu/pixelforge.git
cd pixelforge                      # repo root (contains the pixelforge/ package)
python -m pip install -e "pixelforge[ai,mcp,dev]"
(cd pixelforge/web && npm install)
python pixelforge/tools/download_models.py   # optional AI models
```

Then run `start_all.bat` from the repo root, or start manually (also from the repo root):

```bash
cd pixelforge && python -m uvicorn engine.server.api:app --host 127.0.0.1 --port 8700
# in another terminal, still at the repo root:
cd pixelforge/web && npm run dev
```

Open http://localhost:5173.

### MCP

Point your stdio MCP client at `<repo>/pixelforge/mcp_launcher.py` and keep the engine running
on `127.0.0.1:8700`. See `mcp-design.md` for the tool reference.

### Security and privacy

The engine binds to loopback only, images never leave the machine, and there is no telemetry.
CORS allows local origins only; image paths are restricted to the user home and repository by
default (`PIXELFORGE_CORS_ORIGINS` / `PIXELFORGE_ALLOWED_ROOTS` extend them).

### License

MIT — see [LICENSE](LICENSE). Third-party notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
