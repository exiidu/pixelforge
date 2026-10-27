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

### MCP-2 新增（2026-10-26 已落地）

| 工具 | 参数 | 返回 |
|---|---|---|
| `pixelforge_convert_batch` | input_path / image_paths, preset, size, recipe, recursive/pattern, max_workers, out_dir, include_previews | 总数/成功/失败、逐文件结果、失败清单、预览文件 |
| `pixelforge_list_recipes` | — | 全部配方（内置 + 用户保存） |
| `pixelforge_save_recipe` | name, job_id / recipe / preset+overrides, overwrite | 写入 `recipes/<name>.json`，返回路径 |
| `pixelforge_get_recipe` | job_id / name | 完整或已保存的配方 JSON |

- 所有产出图片的工具（convert / batch / lineart / matting / stage）默认附带 **MCP image 内容块**；
  不需要时传 `include_image=false`，batch 用 `include_previews` 控制（最多回传 4 张）。
- 批量转换在 MCP 进程内用线程池并发调用现有 `/api/convert`，不新增后端接口；
  单文件失败只记入 `failures`，不中断整批。
- 配方缓存只覆盖**当前 MCP 进程内创建**的 job；跨进程请用 `recipe` 或 `preset+overrides` 保存。

### MCP-3A 新增（2026-10-26 已落地）

| 工具 | 参数 | 对应接口 |
|---|---|---|
| `pixelforge_get_grid` | job_id | `GET /api/jobs/{id}/grid` |
| `pixelforge_draw_pixels` | job_id, pixels[{x,y,fill?,ink?,alpha?}], revision? | `POST /api/jobs/{id}/pixels` |
| `pixelforge_fill_region` | job_id, x, y, fill, target?, contiguous?, revision? | `POST /api/jobs/{id}/fill` |
| `pixelforge_palette_transform` | job_id, lightness, hue, saturation, revision? | `POST /api/jobs/{id}/palette` |
| `pixelforge_rerun_region` | job_id, rect / cells, param_delta, expand_colors, revision? | `POST /api/jobs/{id}/rerun` |
| `pixelforge_export` | job_id, content=composite\|indexed, scale, transparent, out_path? | `POST /api/jobs/{id}/export` |

- 所有写操作返回 `revision` 与预览图；`revision` 传入即做乐观锁，不匹配返回 409。
- `pixels` 的 `alpha` 与 fill/ink 正交：0=透明、1=不透明；`ink=-1` 清除墨线。
- `palette_transform` 与前端同一 OKLab 公式：索引不动，只重生成颜色。
- `export` 的 composite 输出 RGBA 真透明；indexed 输出 PLTE+tRNS（透明格记 -1）。
- 3A 编辑的是**服务端扁平网格**，不包含浏览器里的逻辑图层/手改层。

### MCP-3B（浏览器实时同步，2026-10-26 已落地）

- `GET /api/jobs`：列出当前 job（名称/尺寸/revision/WS 订阅数）。
- `WS /api/jobs/{id}`：连接即发快照；像素/填充/调板/局部重算后广播 `job_update`。
- 编辑器 `job-sync.ts`：按文档 jobId 建立 WS、断线重连；`applyJobUpdate` 应用服务端 base，
  保留本地手改层，刷新背景层与位图缓存；状态栏显示 `Agent · 文档 · rev N` 徽章与临时 toast。
- Agent 发现/控制：MCP 端心跳登记到 `/api/agents`；写操作申请控制蒙版；前端轮询
  `/api/agents` 显示真实 Agent 列表与遮罩；`解除控制` 会回写服务端。
- 功能权限：管理窗的勾选写入 `/api/agents/features`，MCP 端按工具映射校验并拒绝被禁用功能。
- 已知限制：Agent 对 base 的外部更新目前只刷新画面，不进编辑器撤销栈。

## 3. 杀手级工作流：AI 视觉调参闭环

MCP 之前这套循环只能由我在开发会话里手工跑（convert → 读图 → analyze_image →
调参 → 重跑）；MCP 之后成为任何 AI 的原生能力：

```
用户：「把这张照片转成 64 格像素画，轮廓要清楚但天空别出噪点」
AI：  pixelforge_convert(edge_w=2.0) → 看预览图
      → 「天空有色带」 → pixelforge_convert(edge_w=2.5, soft_ratio=1.3) → 看图
      → 满意 → 保存配方 pixelforge_save_recipe("portrait-v1")
```

以及对话式批量：「把 <图片目录> 里所有图用 Game Boy 调色板转 48 格导出到 <输出目录>」。

## 4. 实现清单

```
pixelforge/engine/mcp_server.py     # MCPServer stdio 服务（19 工具）
客户端配置示例（ZCode）：
  {"command": "python", "args": ["<仓库>/pixelforge/mcp_launcher.py"]}
```

依赖：`pip install "mcp>=2.3"`（或仓库内 `pip install -e ".[mcp]"`；SDK 2.x 的类名为 `MCPServer`）。
后端依赖：`/api/matting`、`/api/lineart`、`/api/convert` 等均已落地；MCP 只做落盘与汇总，
预览默认写入 `.cache/mcp_out/`（`PIXELFORGE_MCP_OUT` 可覆盖）。

## 5. 里程碑

- **MCP-1** ✅ 2026-10-25：Phase 1 八个工具 + health；ZCode 挂载实测「转换→看图→调参」闭环
- **MCP-2** ✅ 2026-10-26：批量并发转换（失败清单）、配方保存/读取/列表、工具返回 MCP image 内容块；
  工具总数 8 → 12，`tools/check_mcp.py` 全过
- **MCP-3A** ✅ 2026-10-26：服务端像素编辑 6 工具（get_grid/draw/fill/palette/rerun/export）+ revision 乐观锁；
  工具总数 12 → 18，`pytest` 90 通过、`tools/check_mcp.py` 全过
- **MCP-3B** ✅ 2026-10-26：`GET /api/jobs` + `WS /api/jobs/{id}` + 编辑器 job 订阅；
  Agent 心跳/控制/功能权限接入真实前端；工具总数 18 → 19（新增 `list_jobs`）；
  `pytest` 94 通过、`check_mcp` 全过。

## 6. 边界与风险

- 只读+转换阶段无状态冲突；写入阶段必须以服务端 job 文档为准 + WS 同步。
- 大图预览落盘目录可配（默认 `.cache/mcp_out/`），避免污染工作目录。
- 引擎未启动：所有工具返回「引擎离线，请先启动 uvicorn」的引导信息。
