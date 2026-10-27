# PixelForge 交接文档（HANDOFF）

> 更新：2026-10-27。写给下一个接手的 AI 会话或开发者：读这一份 + 三份设计文档即可接管全部工作。

---

## 1. 项目是什么

**PixelForge**：图片→像素画转换引擎 + 像素编辑器，准备以 MIT 协议开源。
仓库根目录为当前工作目录；下文路径均为相对路径。

两大模块：
1. **转换引擎**（Python，已完成 v1）：确定性管线把照片/插画转成分层像素画（底色层 Fill + 墨线层 Ink + 调色板），配 ONNX AI 增强（线稿/抠图）与 FastAPI 服务。
2. **像素编辑器**（Web 前端，M1–M5 已完成）：多文档、工具集、逻辑图层、手改层、调色板体系（含导入导出/锁定/单色编辑）、参数面板、批量导入导出（含索引 PNG/配方 JSON）、局部细节重算、真透明与主体分离、会话恢复。

另有 **MCP 服务器**（已挂载 ZCode，19 个工具）让 AI 直接调用引擎做视觉调参闭环；MCP-2 已补批量转换、配方存取与 image 内容块，MCP-3A 已补服务端像素编辑，MCP-3B 已接通 Agent 注册/控制/功能权限与编辑器 job WS 实时同步。

## 2. 一键运行

- **`start_all.bat`**（仓库根）：双击 = 引擎(:8700) + 前端(:5173) + 就绪后自动开浏览器；路径相对脚本，仓库可移动。
- 手动：`cd pixelforge && python -m uvicorn engine.server.api:app --host 127.0.0.1 --port 8700`；`cd pixelforge/web && npm run dev`。
- 编辑器：http://localhost:5173（`?demo=1` 自动开 3 张仓库内合成测试图，供自动化验收）。
- 引擎单独启动脚本：`start_engine.bat`；macOS/Linux 可用 `start_all.sh`。
- 测试：`cd pixelforge && python -m pytest -q`（113 个单测）。
- 前端构建：`cd pixelforge/web && npx tsc --noEmit && npm run build`（dev 模式 HMR 即时生效，构建产物 dist/ 仅备查）。

## 3. 文档索引（按需读）

| 文档 | 内容 |
|---|---|
| `conversion-engine-design.md` (v0.2) | 转换引擎设计（管线/采样/墨线/配方） |
| `editor-design.md` (**v1.12**) | 编辑器设计 + 实施状态（M1–M5、MCP-UI、MCP-3B、设置中心、双语化、帮助/引导 ✓） |
| `mcp-design.md` | MCP 服务器设计（MCP-1/2/3A/3B 已落地） |
| `productization-roadmap.md` | 产品化 / 发行版改进路线（A–H，v1.0 门槛） |
| `pixelforge/models/README.md` | ONNX 模型来源、许可与 SHA-256 |
| `README.md` / `THIRD_PARTY_NOTICES.md` / `LICENSE` | 开源门面与许可 |

## 4. 当前进度总览

| 模块 | 状态 |
|---|---|
| 转换管线 S0–S5 + 主引擎 v1.1（加权众数：贪心簇合并/软赢家/稀有色带权重） | ✅ |
| io_utils 统一加载（RGBA 白底合成 + ICC→sRGB；M5-0 增 `load_rgb_with_alpha`）+ 单元测试（全仓 94） | ✅ |
| FastAPI :8700（convert/convert_file/stage/rerun_region/lineart/lineart_file/matting/palette/result_info/get_pixel/health/session/WS/export_indexed/jobs/**jobs grid|pixels|fill|palette|rerun|export**/**GET jobs**/**WS jobs/{id}**/**agents**） | ✅ |
| 独立线稿提取（ONNX/XDoG，CLI `--lineart-out`） | ✅ |
| MCP 服务器（stdio 启动器 mcp_launcher.py，ZCode 已挂载名 `pixelforge`） | ✅ MCP-1 + MCP-2 + MCP-3A + **MCP-3B（19 工具；job WS + Agent 控制/权限）** |
| 编辑器 M1（多文档/标签/缩放/网格/对比/图层/调色板/导航器） | ✅ |
| 编辑器 M2（手改层/工具/撤销重做/历史面板/选区/手改重转换保留） | ✅ |
| 编辑器 M2.5（11 工具 PS 图标/磁力套索/形状/笔刷粗细/调色板排序/颜色库） | ✅ |
| 编辑器 M2.6（移动手感/手掌+空格/进度弹窗/透明导出/导出大对话框/拖色动效/色相立方体） | ✅ |
| 编辑器 M2.7（逻辑图层栈：画布层/文件层+选区剪切复制到新图层；移动只动活动层；墨线并入文件层留「线」开关与导出线稿；砍导航器与自定义色拖动排序；修色相立方体取色） | ✅ 2026-10-25 |
| 编辑器 M2.8（铅笔实时笔迹：脏格补丁+位图缓存显式失效；导出窗内容三选：合成/引擎线稿/像素墨线层） | ✅ 2026-10-25 |
| 编辑器 M2.9（导出窗「线稿（引擎提取）」接引擎 onnx；新增 `POST /api/lineart_file` 上传版；异步预览+按文档缓存） | ✅ 2026-10-25 |
| 编辑器 M3（参数面板接真后端+应用到全部；批量导入文件夹/进度/坏文件跳过；导命名模板+精灵图集；色板 OKLab 变换；描图底图；自动保存+会话恢复 GET/POST `/api/session`） | ✅ 2026-10-25 |
| 编辑器 M3.1（线稿预设改为源分辨率连续图像文档：非像素网格/无尺寸与像素参数/平滑缩放/只读；导出默认引擎线稿；参数面板默认折叠；`/api/lineart*` 增回源图缩略） | ✅ 2026-10-25 |
| 编辑器 M4（细节笔刷+三档强度+`rerun_region` 局部重算；`BasePatch` 撤销/重做含色板回滚；掩码会话恢复） | ✅ 2026-10-25 |
| 引擎 M5-0（`load_rgb_with_alpha`；与 fill 正交的网格 alpha + `alpha_png` 响应；`rerun_region` 不改 alpha） | ✅ 2026-10-26 |
| 编辑器 M5（真透明合成/棋盘格/导入自动拆「背景层」/抠背景工具 W；索引 PNG 导出；色板 .hex/.gpl 导入导出+单色编辑+锁定；配方 JSON；标签拖拽排序+右键菜单） | ✅ 2026-10-26 |
| 编辑器 M5.2（B1 上传源文件存 IndexedDB→会话恢复后可重转换；B2 色架删除可撤销；B3 色板导入按 OKLab 最近色重映射索引） | ✅ 2026-10-26 |
| 引擎 M5.2（**非正方形素材保宽高比**：`target.preserve_aspect`，尺寸=长边） | ✅ 2026-10-26 |
| 引擎 M5.3（`preprocess.levels.bright_contrast` 亮部对比 = **可选参数，默认 0=关**；修复 S 曲线增量 bug（曾致全局过曝/偏色）；回退无效的 E 自适应归一化与墨线密度衰减） | ✅ 2026-10-26 |
| 引擎 v1.5（alpha 投票真透明输出） | ✅ 合并进 M5-0 |
| MCP-3A（服务端像素编辑 6 接口 + 6 工具：get_grid/draw/fill/palette/rerun/export；revision 乐观锁） | ✅ 2026-10-26 |
| MCP-UI（Agent 控制蒙版 + 左下角 MCP 管理窗 + Agent/功能权限；`?agentDemo=1`） | ✅ 2026-10-26 |
| MCP-3B（`GET /api/jobs` + `WS /api/jobs/{id}` + 编辑器 job-sync；Agent 心跳/控制/权限真实接入；UI 徽章 + toast） | ✅ 2026-10-26 |
| 设置中心 A1（主题/强调色/减少动效、默认预设/尺寸/网格、Agent 通知、MCP 管理迁入、搜索/导入导出/重置） | ✅ 2026-10-26 |
| 双语化 A3（`web/src/i18n.ts` + `i18n-dict.ts`：410 条静态词表 + 动态文案规则；语言即时切换、持久化、切回中文还原原文） | ✅ 2026-10-26 |
| 帮助中心 A2（`help.ts` 10 分类、F1/状态栏入口、中英双语；主界面常驻指导文案迁入）+ 首次引导 `onboarding.ts`（4 步：语言优先；`?onboarding=1` 重看）+ 示例项目 `sample.ts`（程序化 32×32 像素风景） | ✅ 2026-10-26 |
| 开源基线 P0（MIT LICENSE / THIRD_PARTY_NOTICES / 根 README 中英 / CHANGELOG / CI / CORS + 图片路径白名单 / 可移植启动脚本 / 模型下载与校验） | ✅ 2026-10-27 |
| 项目文件 0.3.0（`.pixelforge` 单文档快照 + 内嵌源图；原位保存/下载回退；最近项目；`Ctrl+S`/`Ctrl+Shift+S`/`Ctrl+O`；缺失源图重定位；关闭与离开确认） | ✅ 2026-10-27 |
| GPU 与性能 0.4.0（AI 推理 CUDA/DirectML 自动选择与回退；`/api/health` 设备状态；S2 稀疏直方图、S3 BLAS + 分块；512 格整条管线约 7.4s → 1.8s） | ✅ 2026-10-27 |
| 可访问性 0.5.0（高对比度、全局焦点环、标签方向键/Shift+F10、调色板/图层键盘操作、状态 live region、对话框 aria-labelledby、帮助新增「可访问性」） | ✅ 2026-10-27 |
| 后续产品化 A4–H（色盲辅助、多文档工程、安装包、安全、CI 等）见 `productization-roadmap.md` | ⬜ |

## 5. 架构关键决策（改代码前必读）

1. **非破坏管线**：转换 = 纯函数(源图, 配方)；引擎不动，一切编辑在前端覆盖层。
2. **手改层 Override 是灵魂**：每文档一条逻辑图层栈（`PFLayer.data: Map<格号, {fill?, ink?, alpha?}>`，index0=画布层，文件层承载引擎 fill/ink），手改优先于算法输出；重转换后**索引重绑**（`doc._palBefore` 快照 → 加权 RGB 最近色重映射，链式前移）+ 跨尺寸格号最近格映射——「手改→重转换→手改保留」已验收。**例外：线稿文档**（`doc.lineart`）是源分辨率连续图像，无网格/图层/调色板，只读显示与导出。
3. **两级渲染**：离屏 ImageData（网格分辨率，缓存于 `doc._bitmaps`）→ 最近邻拉伸；绝不允许 CSS 压缩画布（非整数缩放=丢行丢列假象）。实时笔迹用 `patchBitmapCells` 脏格补丁。
3.1 **网格归属（M5.1）**：`build_mapping` 仍是"源像素→格"，但额外给出 `covered` 与 `cell_src`（每格代表源像素=格中心 floor）。
   **放大网格**（源图边长 < 目标格数）时源像素数少于格数，必然有空档格——`s2_sampling.fill_empty_cells` 用 `cell_src` 回填，
   否则空档格落成 0（黑），渲染成"黑色发丝线"。缩小/等尺寸时 `covered` 全 True，回填是空操作（输出与修复前逐位一致）。
4. **色距统一 OKLab**（引擎侧）；前端排序用伽马校正线性亮度；色板变换（M3）用 OKLab 整板重生成，**格子索引不动**（`paletteBase` 原始板 + `paletteFx` → `palette`）。
4.1 **网格尺寸解析（M5.2）**：`Recipe.target_for(src_shape)` 统一算网格——`target.preserve_aspect=true` 时**长边 = target 的长边**、短边按源图宽高比取整（非正方形素材不再被拉方，编辑器导入固定传 true）；
   默认 false → 引擎行为与既有调用/测试完全一致。`rerun_region` 的掩码校验改为以 `base.fill` 形状为准（网格可能非正方形）。
5. **导出前端合成**：`composeDocCanvas(doc, transparent)` → ImageData；M5-0 起 `transparent=true` 时按**真 alpha**（`doc.alpha` 或层 `alpha` 覆盖）输出，无 alpha 素材才回退边缘泛洪；不勾透明则忽略 alpha（不透明）。索引 PNG（PLTE+tRNS）走 `POST /api/export_indexed`（前端先 `composeIndexGrid` 出索引网格）。
6. **配方与会话都是每文档**：`EditorDoc.recipe/presetName` 独立；「应用到全部标签」广播后逐个重转换；`GET/POST /api/session` 落盘 `web/session.json`（localStorage 为轻量副本）。
7. **MCP 是薄代理**：AI 客户端 ──stdio──> `engine/mcp_server.py` ──HTTP(回环白名单)──> :8700 唯一事实源。
8. **局部重算（M4）**：`/api/rerun_region` 只重跑 S2 采样并**固定沿用原色板**（索引语义不变），
   仅 `extract` 板可把区域新色追加到**尾部**；掩码只写回标记格、ink 原样保留；结果写回 job 支持链式。
   前端以 `BasePatch`（格号 + fill/ink 前后 + 色板前后）进统一历史栈，撤销/重做连色板追加一起回滚。
9. **真透明（M5-0）**：alpha 与 fill **正交**——引擎 `ConversionResult.alpha` 是**网格** 0/1（源区均值 ≥ 0.35 记不透明，无源像素落入的**空档记不透明**），
   响应 `alpha_png` **只在有透明格时才给**（否则 `null` → 前端回退边缘泛洪）；前端 `cellColor` 自顶向下取**第一个 alpha≠0 的格**并写入 ImageData（透明格露出 `.pf-canvaswrap` 的棋盘格 CSS 底），
   `CellOverride.alpha` 与 fill/ink 同栈可撤销；`load_rgb` 的白底合成行为**保持不变**。
10. **色板历史与锁定（M5）**：色板整体替换（导入/单色编辑）走 `HistEntry.palette`（paletteBase 前后快照，undo/redo 重建 `doc.palette`）；
    色板锁定 = `quantize.palette.seed_colors`（≤32，引擎扣减聚类预算 + ΔE<0.03 去重后**追加尾部**），前端勾选即以当前 `paletteBase` 为锁定色并在每次重转换前刷新。

## 6. 代码地图（前端 `web/src/`，构建产物 ~50KB）

| 文件 | 职责 |
|---|---|
| `main.ts` | 装配入口；指针绘制状态机（14 工具分支，含「细节」掩码与「抠背景」alpha 笔刷）；快捷键；参数面板+防抖重转换；细节重算（重试/前缀校验/BasePatch）；批量导入/导出（命名模板/图集/索引 PNG/引擎线稿）；色板 .hex/.gpl 导入导出；配方 JSON；色板变换；描图底图；会话自动保存/恢复；`.pixelforge` 项目保存/打开/最近项目（File System Access 原位写入 + 下载回退）、源图重定位、未保存离开确认；标签右键菜单事件；`__pf` 调试句柄（DEV：composeStats/alphaStats/layerSummary） |
| `dialogs.ts` | 0.3.0 通用 Promise 确认框（`confirmDialog` / `confirmDiscard`）：Esc、背景点击取消；未保存关闭确认复用 |
| `source-store.ts` | M5.2：上传源文件存 IndexedDB（SHA-256 key + LRU 淘汰 200）——会话恢复后仍可重转换/出引擎线稿 |
| `mcp-ui.ts` | MCP-UI：Agent 控制蒙版（全屏遮罩/快捷键锁/解除控制）、左下角 MCP 入口、Agent 列表与功能权限（localStorage + `/api/agents` 轮询 + `pf:agent-control` 事件；`?agentDemo=1` 验收） |
| `job-sync.ts` | MCP-3B：按文档 jobId 订阅 `WS /api/jobs/{id}`，断线重连；`main.ts::applyJobUpdate` 应用服务端 base（保留手改层、刷新背景层/缓存，显示 Agent 徽章与 toast） |
| `settings.ts` | A1 全局设置中心：主题/强调色/减少动效/高对比度、默认预设/尺寸/网格、Agent 通知、引擎状态、MCP 管理入口、搜索/导入导出/重置；localStorage `pf.settings.v1` |
| `i18n.ts` | A3 双语化：静态词表 + 动态文案正则，运行时遍历 DOM 翻译（含 title/placeholder/aria-label），WeakMap 记录原文支持切回中文；MutationObserver 补译运行期新增文本 |
| `i18n-dict.ts` | A3 静态文案中→英词表（410 条，键为 DOM 中的完整文本） |
| `help.ts` | A2 帮助中心：10 个分类的中英双语正文数据（含可访问性），F1/状态栏/空状态入口，语言切换时整体重渲染 |
| `onboarding.ts` | A2 首次启动四步引导（语言优先）：首次且无文档时自动弹出，完成/跳过写 `pf.onboarding.v1`，`?onboarding=1` 强制重看 |
| `sample.ts` | A2 示例项目：程序化绘制 32×32 像素风景（8 色板），空白画布文档，重复打开不新增标签 |
| `store.ts` | AppState（docs/activeIndex/zoom/tool/selection/brushSize/customColors/paletteSort/applyAll/underlay/detailLevel）+ pub/sub；EditorDoc 含 layers/recipe/presetName/paletteBase/paletteFx/alpha/detailMask；HistEntry = steps + layerFx + base + palette；moveDoc/closeDocsToRight/closeOtherDocs |
| `tools.ts` | 笔画缓冲（一笔一条历史）、pixel-perfect 线、形状三件套+实时预览、泛洪、磁力套索吸附/多边形填充、移动（选区/当前层）、翻转、撤销重做、scopeHas/scopeCells、ensureDocColor、抠背景（paintAlphaCells/magicAlphaErase）、色板历史（commitPalette/setPaletteColor/setPaletteBase） |
| `render.ts` | renderView（图层栈合成/墨线叠加/网格线/选区蚂蚁线/描图底图/细节掩码橙色覆盖）、patchBitmapCells 补丁、位图缓存失效、composeIndexGrid（索引 PNG 用）、真 alpha 合成与边缘泛洪回退 |
| `panels/index.ts` | mountTabs（拖拽重排 + 右键菜单 + 方向键/Shift+F10 键盘操作）/Layers（键盘激活/可见性/线开关/删除/背景层标记）/Palette（按钮化色块、排序+自定义色架+右删）/History/Tools/ColorLib（5 模式拾色器 + 替换当前色） |
| `color.ts` | rgb2hsl/gammaLum/hsv2rgb/hex 互转 + OKLab 互转与 transformPalette（色板变换） |
| `icons.ts` | PS 风格单色线性 SVG 图标集 |

引擎侧：`engine/stages/s0_preprocess|s1_structure|s2_sampling|s3_quantize|s4_ink|s5_post.py`、`core/grid|palette|oklab.py`、`io_utils.py`（`load_rgb` + `load_rgb_with_alpha`）、`pipeline.py`（`grid_alpha` / `run(image, recipe, alpha)`）、`ai/runtime.py`（`PIXELFORGE_DEVICE` → CUDA/DirectML/CPU 会话）、`ai/onnx_lineart|rembg_matting`、`server/api.py`（含 `POST /api/export_indexed`、`/api/health` 设备状态）、`mcp_server.py`、`cli.py`。

## 7. 工程教训与坑（血泪合集，务必看）

- **Mimosa 安全钩子**：Bash 写源码/配置文件会被拦——**一律用 Write/Edit 工具**；Edit 的 file_path 用**正斜杠**，反斜杠路径易抽风。
- **MCP SDK 是 2.x**：`from mcp.server.mcpserver import MCPServer`（FastMCP 已改名），结果字段 `is_error`；挂载必须带 cwd 或用 `mcp_launcher.py`（自插 sys.path，cwd 无关）。
- **CSS 陷阱**：显式 `display` 会压过 `[hidden]` 的 UA `display:none`（空状态曾常驻占半屏）——顶部已有 `[hidden]{display:none!important}` 兜底；**同一个坑也适用于 `<dialog>`**：作者样式里的 `display:flex` 会压过浏览器对关闭状态 dialog 的 `display:none`，关闭的设置窗因此留在文档流里、主界面下滑就能看到——需补 `.pf-settings:not([open]){display:none}`；**设计变量必须在 `:root`**（body 直属的 dialog/菜单取不到 .pf-app 上的变量 → 弹窗透明"只剩文字"）。
- **`<dialog>`**：程序化 `requestSubmit()` 不写 returnValue——按钮交互用显式 click + close，别靠 form。**Esc 会被 `type="search"` 输入框吞掉**（原生只清空输入、不触发 dialog 的 cancel）——弹窗内需自己监听 keydown 处理 Escape。
- **Pointer capture**：对合成/非活跃 pointerId `setPointerCapture` 会抛 NotFoundError——用 try/catch 包装；拖拽类交互建议 document 级 pointermove/up 监听（重渲染重建元素也不怕）。
- **空格键**：keydown 的 `e.repeat` 必须在 preventDefault **之后**判断，否则按住空格浏览器照滚。
- **移动工具位移**：必须从按下点屏幕像素算（downX/z），用 cellFromEvent 反推会被画布自身 transform 反噬（"拽着不走"）。
- **颜色库滑块**：input 只刷预览、change（松手）才入库，否则拖一次产生几十个中间色。
- **验证方法论**：UI 显隐必须查 `getComputedStyle().display`/`offsetParent`，不能只查属性位；像素断言前先 Esc 清选区（选区有 .14 白色高亮叠层会污染采样）；伽马明度排序的验证公式要线性化。
- **浏览器自动化（ZCode IAB）**：playwright locator click 会超时——用 `tab.playwright.evaluate()` 驱动事件；**模拟拖拽必须用固定屏幕 client 坐标**（初始 rect 一次算定，每事件重取 rect 会复利放大位移）；截图偶发 "surface timed out / capture failed"（重试或跳过）；用户可能同时在页面里操作——"幽灵状态变化"先怀疑用户；页签丢失时 `browser.tabs.new()` + `goto`；dev 模式动态 `import('/src/store.ts')` 拿到的是 HMR 新实例，要用页面实际加载的带 `?t=` URL。
- **旧页签假报错**：用户长期开着的编辑器页签可能停在 HMR 中途的构建上（表现为 `ReferenceError: xxx is not defined` 且功能不生效）；
  验收前必须**新开页签/加 cache-bust 参数**强制冷载，再对照 `http://localhost:5174/src/main.ts` 的实服内容确认，别直接改代码"修"幽灵错误。
- **网络**：huggingface.co 不可达，用 hf-mirror.com（~3MB/s）；GitHub 直连但大文件慢。
- **GPU**：RTX 5070 Laptop 12GB Blackwell sm_120 需 PyTorch 2.7+ cu128；引擎走 CPU 不抢 ComfyUI 的卡。

## 8. 下一步路线（按优先级）

M5 已完成（2026-10-26，验收见 `editor-design.md` §9 里程碑表 M5-0…M5-6 各行）。
M5.1 补丁（2026-10-26）：放大网格的**黑色发丝线**已修复（`build_mapping` 增 `covered`/`cell_src`，
`fill_empty_cells` 回填空档）；空白画布默认折叠「转换工具」与「细节增强」两张卡。
遗留项：
- 后端 `POST /api/convert_batch` 并行转换 + 进度查询（量大时）
- 细节重算：ink 层不参与（区域墨线不增强）；整幅重转换会丢弃区域微调结果
- 色板导入为整板替换（索引不动）：新板更短时超出索引显示为品红（未做最近色重映射）

1. ~~**M4**：保细节笔刷 + rerun_region~~ ✅
2. ~~**M5**：真透明/主体分离、索引 PNG、色板导入导出+锁定+单色编辑、配方 JSON、标签拖拽与右键菜单~~ ✅
3. ~~**引擎 v1.5**：S2 alpha 投票真透明输出~~ ✅（以 M5-0 形式落地）
4. ~~**MCP-2**：批量并发转换 + 失败清单、配方保存/读取/列表、image 内容块~~ ✅ 2026-10-26（12 工具，`tools/check_mcp.py` 全过）
5. ~~**MCP-3A**：服务端像素编辑（get_grid/draw_pixels/fill_region/palette_transform/rerun_region/export）~~ ✅ 2026-10-26（18 工具，pytest 90 通过）
6. ~~**MCP-3B**：job 列表 + 浏览器 WS 同步 + Agent 注册/控制/权限~~ ✅ 2026-10-26（19 工具，pytest 94 通过）
7. **v2**：ComfyUI img2img 再生成、Bayer 抖动、分层采样、自适应网格、`convert_batch`

## 9. 已知瑕疵（低优先级）

- 浅色/远景区墨线对比偏弱；跨格 2px 线偶发双宽
- MCP-3B：Agent 对 base 的外部更新只刷新画面，暂不进编辑器撤销栈；多 Agent 同时控制同一 job 未做冲突仲裁
- job 内存上限 128（`_MAX_JOBS`）：超出时优先淘汰无 WS 订阅的最老 job；被淘汰的 job 前端 WS 收到 1008 后停止重连
- 重转换缩小网格时多个手改格塌到同一目标格（最近格映射，后写覆盖前写）
- IAB 视口 <780px 侧栏隐藏（@media），窄窗口下左右面板不可见
- 自定义色架删除无撤销（色架不入文档历史栈）
- 会话恢复不保存上传的 `File` 源（浏览器安全限制）：上传来源文档恢复后不能重转换/引擎线稿，但手改与画面完整；`src.path` 来源（demo/服务器路径）可重转换
- localStorage 约 5MB：大网格/多文档超限时自动丢弃源图缩略，仍超限则跳过轻量备份；重会话依赖引擎 `web/session.json`
- 会话恢复不恢复撤销历史（设计如此）；色板变换下从颜色库新增的任意色也会被整板变换（索引一致）
- 线稿文档只读（仅缩放/平移/对比/导出）：像素工具与调色板不适用；切回照片/插画会重建网格并清空线稿历史（线稿没有手改可重放）
- 细节掩码本身不入历史（只有重算结果入历史）；换网格尺寸/整幅重转换会清空掩码，区域微调需重新标记
- （M5）色板导入为整板替换、索引不动：新板比原板短时超出索引渲染为品红（状态栏有提示）
- （M5）索引 PNG 上限 256 色（含透明占位），超出直接报错要求先降色数；不支持图集合并
- （M5）锁定色板最多 32 色且仅对「从源图提取」生效；`max_colors` 先被锁定色占满时提取预算为 0
