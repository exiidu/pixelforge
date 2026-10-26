# PixelForge MCP 设计方案 v1.0

> 目标：让任意 AI 客户端（ZCode / Claude Desktop / Cursor…）通过 MCP 直接驱动
> PixelForge 的转换引擎，实现对话式批量处理与 **AI 视觉调参闭环**。
> 前置：引擎服务（FastAPI :8700）已就绪，MCP 是薄封装层，不重复实现任何算法。

---

## 1. 架构

```
AI 客户端 ──MCP(stdio)──> pixelforge-mcp ──HTTP──> 引擎 FastAPI :8700 ──> 管线/模型
                            （薄代理层）              （唯一事实源）
```

- **独立 stdio 进程**（FastMCP，`mcp` Python SDK）：兼容一切 MCP 客户端，
  配置即一条 command；引擎不在线时工具返回明确错误而不是崩溃。
- 引擎地址为**显式配置**的环境变量（默认 `PIXELFORGE_URL=http://127.0.0.1:8700`），
  属用户本机自有服务白名单。
- 预览图落盘到约定目录并返回路径（配合 AI 的视觉能力形成反馈回路），
  支持的客户端同时返回 MCP image 内容块。

## 2. 工具清单

### Phase 1（只读+转换，与浏览器编辑器零冲突）

| 工具 | 参数 | 返回 |
|---|---|---|
| `pixelforge_health` | — | 引擎状态/预设/模型在位 |
| `pixelforge_convert` | image_path, preset?, size?, mode?, edge_w/dark_w/contrast_w?, palette?, k?, lineart?, ink? | job_id、网格尺寸、用色数、耗时、预览文件路径(+图) |
| `pixelforge_extract_lineart` | image_path, mode=onnx\|xdog, out_path? | 黑线白纸 PNG 路径(+图) |
| `pixelforge_extract_palette` | image_path, k | 颜色列表+占比 |
| `pixelforge_remove_background` | image_path | 前景 PNG 路径（需补 /api/matting 端点） |
| `pixelforge_export_stage` | job_id, stage=p0\|edge\|lineart\|fill\|ink\|preview, scale?, out_path | 中间产物 PNG 路径 |
| `pixelforge_result_info` | job_id | 尺寸、调色板使用统计、Top 颜色 |
| `pixelforge_get_pixel` | job_id, x, y | 格子颜色 hex + 调色板索引 |

### Phase 2（写入操作，待编辑器多文档会话就绪后）

`pixelforge_draw_pixels` / `fill_region` / `palette_transform`（OKLab 整板变换）/
`rerun_region`（v1.5 局部重转换）——作用于**服务端 job 文档**，经 WS 广播同步到
浏览器打开的同源标签页（编辑器订阅 job 更新），避免双端状态分叉。

## 3. 杀手级工作流：AI 视觉调参闭环

MCP 之前这套循环只能由我在开发会话里手工跑（convert → 读图 → analyze_image →
调参 → 重跑）；MCP 之后成为任何 AI 的原生能力：

```
用户：「把这张照片转成 64 格像素画，轮廓要清楚但天空别出噪点」
AI：  pixelforge_convert(edge_w=2.0) → 看预览图
      → 「天空有色带」 → pixelforge_convert(edge_w=2.5, soft_ratio=1.3) → 看图
      → 满意 → 保存配方 pixelforge_save_recipe("portrait-v1")
```

以及对话式批量：「把 D:\arts 里所有图用 Game Boy 调色板转 48 格导出到 out\」。

## 4. 实现清单

```
pixelforge/engine/mcp_server.py     # FastMCP stdio 服务，~300 行
客户端配置示例（ZCode）：
  {"command": "python", "args": ["-m", "engine.mcp_server"], "cwd": "D:\\pixelforge\\pixelforge"}
```

依赖：`pip install "mcp[cli]"`（官方 SDK，含 FastMCP）。
需补后端：`/api/matting`（抠图独立端点，Provider 已有）；convert 响应加 preview
落盘路径约定（MCP 端自己保存亦可，零后端改动起步）。

## 5. 里程碑

- **MCP-1**：Phase 1 八个工具 + health；在 ZCode 挂载实测「转换→看图→调参」闭环
- **MCP-2**：批量场景打磨（并发转换、失败清单）、image 内容块、配方存取
- **MCP-3**（跟随编辑器 M3/v1.5）：Phase 2 写入工具 + 浏览器 WS 同步

## 6. 边界与风险

- 只读+转换阶段无状态冲突；写入阶段必须以服务端 job 文档为准 + WS 同步。
- 大图预览落盘目录可配（默认 `.cache/mcp_out/`），避免污染工作目录。
- 引擎未启动：所有工具返回「引擎离线，请先启动 uvicorn」的引导信息。
