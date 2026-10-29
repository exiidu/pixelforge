# PixelForge

[![CI](https://github.com/exiidu/pixelforge/actions/workflows/ci.yml/badge.svg)](https://github.com/exiidu/pixelforge/actions/workflows/ci.yml)

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
- **像素编辑器**：多文档标签（重命名/拖拽打开）、13 种工具、逻辑图层栈、撤销/重做、选区、笔刷/对称、
  调色板排序与锁定、色板 OKLab 变换与可辨性检查、描图底图、会话自动恢复。
- **项目文件**：`.pixelforge` 保存配方、图层、手改与源图；支持原位保存、最近项目、拖拽打开与未保存确认。
- **批量与导出**：文件夹批量导入（可取消）、失败项重试与导入报告、重复源检测、参数广播到全部标签、PNG/JPEG/WEBP、索引 PNG、
  引擎线稿、像素墨线层、精灵图集（含 JSON 元数据）、命名模板、导出预设记忆。
- **局部细节重算**：「细节」笔刷标记区域，只重算标记格，可撤销。
- **可选 AI**：线稿提取（Informative Drawings）与主体抠图（U²-Net / U²-NetP），模型按需下载；可选 CUDA / DirectML GPU 推理。
- **MCP / Agent**：19 个工具覆盖转换、批量、配方、像素编辑、填充、调色板、局部重算与导出；
  编辑器提供 Agent 控制蒙版、功能权限与 WebSocket 实时同步。
- **产品化体验**：全局设置中心、中英双语界面、帮助中心、首次启动引导、内置示例项目。
- **可访问性**：全键盘焦点、标签/图层/调色板键盘操作、读屏状态播报、高对比度模式。

## 环境要求

- Windows 10/11（当前主要在 Windows 验证；引擎与前端本身跨平台）
- Python 3.11+
- Node.js 20+（仅开发/构建前端；便携版不需要）
- 可选：`onnxruntime` 与模型权重（AI 线稿/抠图）

## 快速开始

```bash
git clone https://github.com/exiidu/pixelforge.git
cd pixelforge                      # 仓库根目录（内含同名的 pixelforge/ 包目录）
python -m pip install -e "pixelforge[ai,mcp,dev]"   # 安装引擎包
cd pixelforge/web
npm install
cd ../..                            # 回到仓库根目录
```

下载可选模型（不下载也能用非 AI 功能，需在仓库根目录执行）：

```bash
python pixelforge/tools/download_models.py
```

模型接入细节（固定路径、手动下载、离线与 Git LFS）见下文「模型接入」。

启动（仓库根目录）：

```bat
start_all.bat
```

macOS / Linux 使用 `bash start_all.sh`。

脚本会自动启动引擎（`127.0.0.1:8700`）与前端（`localhost:5173`）并打开浏览器。
若 `pixelforge/web/dist` 已存在（构建过前端），`start_all.bat` 会只启动引擎并直接打开
`http://127.0.0.1:8700/`，不需要 Node。
手动启动（在仓库根目录执行）：

```bash
cd pixelforge
python -m uvicorn engine.server.api:app --host 127.0.0.1 --port 8700
# 另开终端，仍在仓库根目录
cd pixelforge/web && npm run dev
```

打开 `http://localhost:5173`。首次启动会引导选择语言，并可一键打开内置示例项目。

## 性能与 GPU

转换管线 S0–S5 默认使用 CPU；0.4.0 起 AI 线稿/抠图可选择 GPU：

- **CUDA（NVIDIA）**：`pip install -e "pixelforge[gpu]"`（或 `pip install onnxruntime-gpu`），需匹配的 CUDA / cuDNN；RTX 50 系列（sm_120）需要 CUDA 12.8+ 与对应版本。
- **DirectML（Windows，任意 GPU）**：`pip install -e "pixelforge[directml]"`。
- **设备选择**：环境变量 `PIXELFORGE_DEVICE=auto|cuda|dml|cpu`，默认 `auto`（CUDA → DirectML → CPU）；不可用时自动回退。
- 设置 → 引擎 →「AI 运行设备」可查看实际设备、ORT 版本与回退原因。

不要同时安装 `onnxruntime` 与 GPU 版（导入名相同，二者只能保留一个）。

本机 CPU 实测（2048×1536 输入，photo 配方）：512 格整条管线约 **1.8s**（0.3.0 约 7.4s），其中 S2 约 1.0s、S3 约 0.6s；64 格约 0.8s。GPU 主要加速 AI 推理（线稿 CPU 约 3s，GPU 通常百毫秒级）。

## 模型接入（可选 AI）

AI 线稿与主体抠图需要 3 个 ONNX 文件，合计约 **198 MB**。**权重不随仓库分发**：

- GitHub 单文件硬上限 100 MB，`matting/u2net.onnx` 约 176 MB，直接 `git add` 会被拒绝。
- 三个文件全部入库会让每次 clone 与仓库历史膨胀约 200 MB；权重也不适合走普通 Git 差异存储。

把文件放到以下固定路径即可（文件名必须一致）：

```
pixelforge/models/
├── lineart/
│   └── model.onnx       # ~17 MB   Informative Drawings 线稿
└── matting/
    ├── u2net.onnx       # ~176 MB  U²-Net 主体抠图（默认）
    └── u2netp.onnx      # ~4.6 MB  U²-NetP 轻量快速档
```

推荐用下载脚本（自动选择镜像并校验 SHA-256）：

```bash
python pixelforge/tools/download_models.py          # 缺失的才下载
python pixelforge/tools/download_models.py --check  # 只校验已有文件
python pixelforge/tools/download_models.py --force  # 重新下载全部
```

内网/离线：手动下载后按上表命名放到对应目录，再执行 `--check` 校验。
下载源、文件大小与 SHA-256 见 [models/README.md](pixelforge/models/README.md)。

启用：`pip install onnxruntime`（GPU 版见上一节），重启引擎。设置 → 引擎应显示
「AI 模型 ✓」；转换预设选「线稿提取」，或在转换参数里开启线稿 / 抠图。

如果确实需要把权重纳入版本控制（只建议私有 fork，不建议主仓库）：
GitHub 的 Git LFS 免费额度为 1 GB 存储 / 1 GB 月流量，克隆时会拉取约 198 MB。

```bash
git lfs install
git lfs track "pixelforge/models/**/*.onnx"
git add .gitattributes pixelforge/models
```

## 便携包（单进程）

```bash
python pixelforge/tools/build_release.py
```

生成 `dist/pixelforge-<version>-portable.zip`（引擎 + 前端 dist + 启动脚本；不含模型与缓存）。
解压后仍需 Python 环境：

```bash
python -m pip install -e "pixelforge"
python pixelforge/tools/download_models.py   # 可选：下载 AI 模型
start_all.bat                                # 或 bash start_all.sh
```

前端由引擎在 `http://127.0.0.1:8700/` 直接托管，不需要 Node。

### 免 Python 版（Windows x64）

```bash
python pixelforge/tools/build_standalone.py
```

生成 `dist/pixelforge-<version>-windows-x64-noinstall.zip`（约 120 MB）：内置 Python 3.12 运行时、
FastAPI / NumPy / OpenCV / Pillow / uvicorn / onnxruntime / MCP SDK 与前端 dist，不依赖系统 Python 或 Node。
构建机需要联网下载 Python embeddable 包与依赖（缓存在 `.cache/standalone`）。

解压后：

- 双击 `PixelForge.bat`：启动引擎并打开浏览器（默认 8700，可用 `PIXELFORGE_PORT` 改端口）。
- 双击 `download_models.bat`：下载可选 AI 模型（默认缺失才下载；可加 `--check`）。
- MCP 客户端使用包内解释器：`command` 填 `<解压目录>\python\python.exe`，
  `args` 填 `["<解压目录>\pixelforge\mcp_launcher.py"]`。

模型权重与用户数据不随包分发；会话、上传缓存与日志仍写入系统数据目录。U 盘等便携场景可设置
`PIXELFORGE_DATA_DIR=<解压目录>\data`。目前仅提供 Windows x64 免 Python 包；
macOS/Linux 仍使用便携 zip + 系统 Python。

## 数据目录与诊断

自动保存会话、上传缓存与引擎日志不再写进安装目录，默认位置：

- Windows：`%LOCALAPPDATA%\PixelForge`
- macOS：`~/Library/Application Support/PixelForge`
- Linux：`~/.local/share/pixelforge`

可用 `PIXELFORGE_DATA_DIR` 指定其他可写目录（便携包/U 盘场景）。会话每次保存前保留
`session.json.bak`，主文件损坏时自动回退；旧版 `web/session.json` 仍可读取一次。
设置 → 引擎 →「导出诊断包」会下载包含版本、平台、AI 设备、模型状态、数据目录与最近日志的 JSON。

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

`<repo>` 替换为仓库的绝对路径（Windows 示例：`D:/path/to/pixelforge`）。先用上面的方式启动引擎。
工具列表与参数说明见 `mcp-design.md`。

## 安全与隐私

- 引擎默认只监听回环地址；图片不上传云端，AI 模型在本机运行，无遥测。
- CORS 仅放行本机来源（`localhost` / `127.0.0.1`，任意端口）；可用
  `PIXELFORGE_CORS_ORIGINS` 追加。
- 通过路径读取图片时默认只允许用户主目录与仓库目录；可用
  `PIXELFORGE_ALLOWED_ROOTS`（`os.pathsep` 分隔）扩展。编辑器上传图片不受此限制。
- Agent 写操作带审计记录（时间、Agent、方法+路径、状态码），可在设置 → MCP / Agent 查看；会话保存上限 8MB。
- 模型权重不随仓库分发；下载与校验见 `pixelforge/models/README.md`。

## 开发与测试

以下命令均从仓库根目录执行：

```bash
# 后端测试（当前 130 个用例）
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
│   └── tools/              脚本：模型下载、便携包 / 免 Python 包构建、MCP 检查、测试图生成
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

- 界面支持简体中文 / English；其他语言未提供。
- 快捷键目前为固定映射，尚不支持自定义。
- 引擎默认 CPU；GPU 加速目前覆盖 ONNX 推理（CUDA / DirectML），S0–S5 仍为 CPU（大网格已做稀疏与分块优化）。
- 画布绘制仍以指针为主；键盘可完成工具切换、标签/图层/调色板导航与弹窗操作。
- 项目文件为单文档快照；多文档工程仍在路线图；Windows 免 Python 包已提供（0.11.0）。

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
- Multi-document editor with 13 tools, logical layers, undo/redo, selections, brushes, symmetry,
  palette sorting/locking, OKLab palette transforms, tracing underlay, and session restore.
- Batch import/export, parameter broadcasting, PNG/JPEG/WEBP, indexed PNG, engine line art,
  pixel ink layer, sprite atlases, and naming templates.
- Detail brush + partial recompute (only marked cells, undoable).
- Optional AI: line-art extraction (Informative Drawings) and matting (U²-Net / U²-NetP).
- MCP server with 19 tools, agent control overlay, feature permissions, and live WebSocket sync.
- Settings center, Chinese/English UI, help center, first-run onboarding, built-in sample project.
- Accessibility: keyboard focus throughout, keyboard-operable tabs/layers/palette, screen-reader live status, and a high-contrast mode.

### Requirements

- Windows 10/11 (primary target; engine and web are cross-platform)
- Python 3.11+, Node.js 20+ (Node is only needed to build the web UI; the portable build does not)
- Optional: `onnxruntime` plus model weights for AI features; CUDA or DirectML GPU inference is also supported

### Quick start

```bash
git clone https://github.com/exiidu/pixelforge.git
cd pixelforge                      # repo root (contains the pixelforge/ package)
python -m pip install -e "pixelforge[ai,mcp,dev]"
cd pixelforge/web
npm install
cd ../..                            # back to the repo root
python pixelforge/tools/download_models.py   # optional AI models
```

Then run `start_all.bat` from the repo root (`bash start_all.sh` on macOS/Linux),
or start manually (also from the repo root):

```bash
cd pixelforge && python -m uvicorn engine.server.api:app --host 127.0.0.1 --port 8700
# in another terminal, still at the repo root:
cd pixelforge/web && npm run dev
```

Open http://localhost:5173.

For GPU inference install `pixelforge[gpu]` (CUDA) or `pixelforge[directml]`, then set
`PIXELFORGE_DEVICE=auto|cuda|dml|cpu`. Do not install `onnxruntime` and its GPU variant side by side.
The engine reports the active device under Settings → Engine.

Portable build: `python pixelforge/tools/build_release.py` produces
`dist/pixelforge-<version>-portable.zip`. The engine then serves `web/dist` at
`http://127.0.0.1:8700/`, so Node is not required at runtime.

No-Python build (Windows x64): `python pixelforge/tools/build_standalone.py` produces
`dist/pixelforge-<version>-windows-x64-noinstall.zip` (~120 MB) with a bundled Python 3.12 runtime,
all engine dependencies, and `web/dist`. Extract the zip and run `PixelForge.bat`; no Python or Node
installation is required. `download_models.bat` fetches optional AI models.

### AI models (optional)

Model weights are **not committed** (~198 MB total): GitHub rejects files over 100 MB
(`u2net.onnx` is ~176 MB), and committing all three would bloat every clone. Put the files at:

```
pixelforge/models/lineart/model.onnx      (~17 MB)
pixelforge/models/matting/u2net.onnx      (~176 MB, default)
pixelforge/models/matting/u2netp.onnx     (~4.6 MB, fast)
```

or run `python pixelforge/tools/download_models.py` (add `--check` to verify, `--force` to redownload).
Sources, sizes, and SHA-256 are listed in `pixelforge/models/README.md`. For offline use, copy the files
manually and run `--check`. A private fork that must version the weights can use Git LFS
(`git lfs track "pixelforge/models/**/*.onnx"`), but note the 1 GB free storage/bandwidth quota.

### MCP

Point your stdio MCP client at `<repo>/pixelforge/mcp_launcher.py` and keep the engine running
on `127.0.0.1:8700`. Replace `<repo>` with the absolute path to the repository
(for example `D:/path/to/pixelforge`). See `mcp-design.md` for the tool reference.

### Security and privacy

The engine binds to loopback only, images never leave the machine, and there is no telemetry.
CORS allows local origins only; image paths are restricted to the user home and repository by
default (`PIXELFORGE_CORS_ORIGINS` / `PIXELFORGE_ALLOWED_ROOTS` extend them).

### License

MIT — see [LICENSE](LICENSE). Third-party notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
