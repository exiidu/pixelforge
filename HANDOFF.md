# PixelForge 交接文档（HANDOFF）

> 更新：2026-10-25。写给下一个接手的 AI 会话或开发者：读这一份 + 三份设计文档即可接管全部工作。
> 项目记忆（跨会话自动加载）：`C:\Users\AZAKA\.zcode\cli\memories\projects\draft-af9c58c9-...\memory\pixelforge-project.md`

---

## 1. 项目是什么

**PixelForge**：个人使用的图片→像素画转换 + 像素编辑器。仅本人服务，无商业化约束。
根目录 **`D:\pixelforge\pixelforge`**（一切操作用 D 盘绝对路径）。

两大模块：
1. **转换引擎**（Python，已完成 v1）：确定性管线把照片/插画转成分层像素画（底色层 Fill + 墨线层 Ink + 调色板），配 ONNX AI 增强（线稿/抠图）与 FastAPI 服务。
2. **像素编辑器**（Web 前端，M1–M3 已完成）：多文档、工具集、逻辑图层、手改层、调色板体系、参数面板、批量导入导出、会话恢复。

另有 **MCP 服务器**（已挂载 ZCode，8 个工具）让 AI 直接调用引擎做视觉调参闭环。

## 2. 一键运行

- **`D:\pixelforge\start_all.bat`**：双击 = 引擎(:8700) + 前端(:5173) + 就绪后自动开浏览器。
- 手动：`cd D:\pixelforge\pixelforge && python -m uvicorn engine.server.api:app --host 127.0.0.1 --port 8700`；`cd web && npm run dev`。
- 编辑器：http://localhost:5173（`?demo=1` 自动开 3 张测试图，供自动化验收）。
- 引擎单独启动脚本：`D:\pixelforge\start_engine.bat`。
- 测试：`cd D:\pixelforge\pixelforge && python -m pytest -q`（31 个单测）。
- 前端构建：`cd web && npx tsc --noEmit && npm run build`（dev 模式 HMR 即时生效，构建产物 dist/ 仅备查）。

## 3. 文档索引（按需读）

| 文档 | 内容 |
|---|---|
| `D:\pixelforge\conversion-engine-design.md` (v0.2) | 转换引擎设计（管线/采样/墨线/配方） |
| `D:\pixelforge\editor-design.md` (**v1.3**) | 编辑器设计 + 实施状态（M1–M3 ✓，M4 待做） |
| `D:\pixelforge\mcp-design.md` | MCP 服务器设计（Phase 1 已落地） |
| `models/README.md` | ONNX 模型来源与规格 |

## 4. 当前进度总览

| 模块 | 状态 |
|---|---|
| 转换管线 S0–S5 + 主引擎 v1.1（加权众数：贪心簇合并/软赢家/稀有色带权重） | ✅ |
| io_utils 统一加载（RGBA 白底合成 + ICC→sRGB）+ 31 单测 | ✅ |
| FastAPI :8700（convert/convert_file/stage/lineart/lineart_file/matting/palette/result_info/get_pixel/health/session/WS） | ✅ |
| 独立线稿提取（ONNX/XDoG，CLI `--lineart-out`） | ✅ |
| MCP 服务器（stdio 启动器 mcp_launcher.py，ZCode 已挂载名 `pixelforge`） | ✅ Phase 1 |
| 编辑器 M1（多文档/标签/缩放/网格/对比/图层/调色板/导航器） | ✅ |
| 编辑器 M2（手改层/工具/撤销重做/历史面板/选区/手改重转换保留） | ✅ |
| 编辑器 M2.5（11 工具 PS 图标/磁力套索/形状/笔刷粗细/调色板排序/颜色库） | ✅ |
| 编辑器 M2.6（移动手感/手掌+空格/进度弹窗/透明导出/导出大对话框/拖色动效/色相立方体） | ✅ |
| 编辑器 M2.7（逻辑图层栈：画布层/文件层+选区剪切复制到新图层；移动只动活动层；墨线并入文件层留「线」开关与导出线稿；砍导航器与自定义色拖动排序；修色相立方体取色） | ✅ 2026-10-25 |
| 编辑器 M2.8（铅笔实时笔迹：脏格补丁+位图缓存显式失效；导出窗内容三选：合成/引擎线稿/像素墨线层） | ✅ 2026-10-25 |
| 编辑器 M2.9（导出窗「线稿（引擎提取）」接引擎 onnx；新增 `POST /api/lineart_file` 上传版；异步预览+按文档缓存） | ✅ 2026-10-25 |
| 编辑器 M3（参数面板接真后端+应用到全部；批量导入文件夹/进度/坏文件跳过；导命名模板+精灵图集；色板 OKLab 变换；描图底图；自动保存+会话恢复 GET/POST `/api/session`） | ✅ 2026-10-25 |
| 编辑器 M3.1（线稿预设改为源分辨率连续图像文档：非像素网格/无尺寸与像素参数/平滑缩放/只读；导出默认引擎线稿；参数面板默认折叠；`/api/lineart*` 增回源图缩略） | ✅ 2026-10-25 |
| M4（rerun_region 保细节笔刷）、引擎 v1.5（alpha 投票真透明输出）、MCP-2/3、ComfyUI img2img | ⬜ |

## 5. 架构关键决策（改代码前必读）

1. **非破坏管线**：转换 = 纯函数(源图, 配方)；引擎不动，一切编辑在前端覆盖层。
2. **手改层 Override 是灵魂**：每文档一条逻辑图层栈（`PFLayer.data: Map<格号, {fill?, ink?}>`，index0=画布层，文件层承载引擎 fill/ink），手改优先于算法输出；重转换后**索引重绑**（`doc._palBefore` 快照 → 加权 RGB 最近色重映射，链式前移）+ 跨尺寸格号最近格映射——「手改→重转换→手改保留」已验收。**例外：线稿文档**（`doc.lineart`）是源分辨率连续图像，无网格/图层/调色板，只读显示与导出。
3. **两级渲染**：离屏 ImageData（网格分辨率，缓存于 `doc._bitmaps`）→ 最近邻拉伸；绝不允许 CSS 压缩画布（非整数缩放=丢行丢列假象）。实时笔迹用 `patchBitmapCells` 脏格补丁。
4. **色距统一 OKLab**（引擎侧）；前端排序用伽马校正线性亮度；色板变换（M3）用 OKLab 整板重生成，**格子索引不动**（`paletteBase` 原始板 + `paletteFx` → `palette`）。
5. **导出前端合成**：`composeDocCanvas(doc, transparent)` → ImageData alpha → 可选边缘泛洪去底；索引 PNG（PLTE）走后端仍未实现（M4/后续）。
6. **配方与会话都是每文档**：`EditorDoc.recipe/presetName` 独立；「应用到全部标签」广播后逐个重转换；`GET/POST /api/session` 落盘 `web/session.json`（localStorage 为轻量副本）。
7. **MCP 是薄代理**：AI 客户端 ──stdio──> `engine/mcp_server.py` ──HTTP(回环白名单)──> :8700 唯一事实源。

## 6. 代码地图（前端 `web/src/`，构建产物 ~50KB）

| 文件 | 职责 |
|---|---|
| `main.ts` | 装配入口；指针绘制状态机（11 工具分支）；快捷键；参数面板+防抖重转换；批量导入/导出（命名模板/图集/引擎线稿）；色板变换；描图底图；会话自动保存/恢复；`__pf` 调试句柄（DEV） |
| `store.ts` | AppState（docs/activeIndex/zoom/tool/selection/brushSize/customColors/paletteSort/applyAll/underlay）+ pub/sub；EditorDoc 含 layers/recipe/presetName/paletteBase/paletteFx；Selection = 矩形∥多边形 |
| `tools.ts` | 笔画缓冲（一笔一条历史）、pixel-perfect 线、形状三件套+实时预览、泛洪、磁力套索吸附/多边形填充、移动（选区/当前层）、翻转、撤销重做、scopeHas/scopeCells、ensureDocColor |
| `render.ts` | renderView（图层栈合成/墨线叠加/网格线/选区蚂蚁线/描图底图）、patchBitmapCells 补丁、位图缓存失效 |
| `panels/index.ts` | mountTabs/Layers（可见性/线开关/删除）/Palette（排序+自定义色架+右删）/History/Tools/ColorLib（5 模式拾色器） |
| `color.ts` | rgb2hsl/gammaLum/hsv2rgb/hex 互转 + OKLab 互转与 transformPalette（色板变换） |
| `icons.ts` | PS 风格单色线性 SVG 图标集 |

引擎侧：`engine/stages/s1_structure|s2_sampling|s3_palette|s4_ink|s5_render.py`、`io_utils.py`、`pipeline.py`、`ai/onnx_lineart|rembg_matting`、`server/api.py`、`mcp_server.py`、`cli.py`。

## 7. 工程教训与坑（血泪合集，务必看）

- **Mimosa 安全钩子**：Bash 写源码/配置文件会被拦——**一律用 Write/Edit 工具**；Edit 的 file_path 用**正斜杠**（`D:/pixelforge/...`），反斜杠路径易抽风。
- **MCP SDK 是 2.x**：`from mcp.server.mcpserver import MCPServer`（FastMCP 已改名），结果字段 `is_error`；挂载必须带 cwd 或用 `mcp_launcher.py`（自插 sys.path，cwd 无关）。
- **CSS 陷阱**：显式 `display` 会压过 `[hidden]` 的 UA `display:none`（空状态曾常驻占半屏）——顶部已有 `[hidden]{display:none!important}` 兜底；**设计变量必须在 `:root`**（body 直属的 dialog/菜单取不到 .pf-app 上的变量 → 弹窗透明"只剩文字"）。
- **`<dialog>`**：程序化 `requestSubmit()` 不写 returnValue——按钮交互用显式 click + close，别靠 form。
- **Pointer capture**：对合成/非活跃 pointerId `setPointerCapture` 会抛 NotFoundError——用 try/catch 包装；拖拽类交互建议 document 级 pointermove/up 监听（重渲染重建元素也不怕）。
- **空格键**：keydown 的 `e.repeat` 必须在 preventDefault **之后**判断，否则按住空格浏览器照滚。
- **移动工具位移**：必须从按下点屏幕像素算（downX/z），用 cellFromEvent 反推会被画布自身 transform 反噬（"拽着不走"）。
- **颜色库滑块**：input 只刷预览、change（松手）才入库，否则拖一次产生几十个中间色。
- **验证方法论**：UI 显隐必须查 `getComputedStyle().display`/`offsetParent`，不能只查属性位；像素断言前先 Esc 清选区（选区有 .14 白色高亮叠层会污染采样）；伽马明度排序的验证公式要线性化。
- **浏览器自动化（ZCode IAB）**：playwright locator click 会超时——用 `tab.playwright.evaluate()` 驱动事件；**模拟拖拽必须用固定屏幕 client 坐标**（初始 rect 一次算定，每事件重取 rect 会复利放大位移）；截图偶发 "surface timed out / capture failed"（重试或跳过）；用户可能同时在页面里操作——"幽灵状态变化"先怀疑用户；页签丢失时 `browser.tabs.new()` + `goto`；dev 模式动态 `import('/src/store.ts')` 拿到的是 HMR 新实例，要用页面实际加载的带 `?t=` URL。
- **网络**：huggingface.co 不可达，用 hf-mirror.com（~3MB/s）；GitHub 直连但大文件慢。
- **GPU**：RTX 5070 Laptop 12GB Blackwell sm_120 需 PyTorch 2.7+ cu128；引擎走 CPU 不抢 ComfyUI 的卡。

## 8. 下一步路线（按优先级）

M3 已完成（2026-10-25，验收：10 张图批量入 → 调参广播 → 批量出图集）。M3 未纳入验收的遗留项：
- `POST /api/export_indexed`（PLTE 索引 PNG）与「配方 JSON」导出
- 标签拖拽排序 / 右键菜单（复制配方到全部、导出此文档、关闭其他）
- 色板：锁定常用色、点击编辑单色、导入 .hex/.gpl
- 后端 `POST /api/convert_batch` 并行转换 + 进度查询（量大时）

1. **M4**：选区/保细节笔刷 → 引擎 v1.5 rerun_region（解 128 格脸部糊）
2. **引擎 v1.5**：S2 alpha 投票真透明输出（当前透明导出是前端边缘泛洪近似）
3. **MCP-2/3**：批量打磨、写入工具（待编辑器多文档写路径 + WS 同步）
4. **v2**：ComfyUI img2img 再生成、Bayer 抖动、分层采样、自适应网格

## 9. 已知瑕疵（低优先级）

- 浅色/远景区墨线对比偏弱；跨格 2px 线偶发双宽
- 重转换缩小网格时多个手改格塌到同一目标格（最近格映射，后写覆盖前写）
- IAB 视口 <780px 侧栏隐藏（@media），窄窗口下左右面板不可见
- 自定义色架删除无撤销（色架不入文档历史栈）
- 会话恢复不保存上传的 `File` 源（浏览器安全限制）：上传来源文档恢复后不能重转换/引擎线稿，但手改与画面完整；`src.path` 来源（demo/服务器路径）可重转换
- localStorage 约 5MB：大网格/多文档超限时自动丢弃源图缩略，仍超限则跳过轻量备份；重会话依赖引擎 `web/session.json`
- 会话恢复不恢复撤销历史（设计如此）；色板变换下从颜色库新增的任意色也会被整板变换（索引一致）
- 线稿文档只读（仅缩放/平移/对比/导出）：像素工具与调色板不适用；切回照片/插画会重建网格并清空线稿历史（线稿没有手改可重放）
