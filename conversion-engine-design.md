# 像素画转换引擎设计方案 v0.1

> 目标：将任意图片（照片/插画/AI 生成图）转换为可编辑的像素画。
> 定位：个人工具，本地运行，复用已部署的 ComfyUI，不考虑商业化。
> 前置调研结论见对话记录；本文档只写设计决策。
>
> **修订 v0.2（2026-10-24）**：AI 相关（ComfyUI img2img、ONNX 线稿、rembg 抠图）
> 本期仅保留接口（`engine/ai/base.py` 三个 Provider 协议 + 默认不可用实现），
> 实现推迟到 v2 接入；S1 线稿默认档为经典 XDoG。§3/§6 的 AI 描述按此理解。
> 项目骨架已落地：`pixelforge/`（README 含目录说明与进度表）。

---

## 1. 设计原则

1. **非破坏性参数管线**：转换是「源图 + 参数配方（recipe）→ 结果」的纯函数，任何参数改动可随时重渲染。配方可存档、可复制。这是 Pixelmash 验证过的工作流价值。
2. **分层表示**：结果不是一张平面图，而是「底色层 + 墨线层 + 重要度图」三个可独立编辑的数据层。轮廓与填充分离处理（AOP 论文验证的路线）。
3. **确定性核心，AI 增强**：默认管线全部是确定性算法（可复现、毫秒级）；AI 模型只作为可选档位（线稿提取 ONNX、ComfyUI img2img）插在特定位置。
4. **中间产物全部可导出**：每个阶段的输出都能单独查看/导出，服务后续验证与调参。

## 2. 数据模型

```python
ConversionJob:
  source:    Image            # 原始输入，任意分辨率
  recipe:    RecipeParams     # JSON，见 §5 参数总表

  # —— 中间产物（全分辨率，float32）——
  P0:  Image                  # 预处理后的图（去噪/电平/可选已抠主体）
  E:   Map<f32>               # 边缘强度图 0..1
  L:   Map<f32> (可选)         # 线稿图 0..1
  I:   Map<f32>               # 重要度图 0..1（显著性 + 用户笔刷合成）

  # —— 输出（目标网格分辨率 W×H，索引色）——
  Fill:    IndexGrid<W,H>     # 底色层：调色板索引
  Ink:     IndexGrid<W,H>     # 墨线层（可选）：调色板索引
  palette: Palette            # 使用的调色板（来源 + 颜色）
  Alpha:   Array<u8> (W×H)    # M5-0 与 Fill 正交的网格 alpha：0=透明 1=不透明
  Result:  合成结果           # Fill ⊕ Ink，导出为索引 PNG
```

关键点：**输出层用索引色（palette index）而非 RGBA**。这使引擎与像素编辑器共享同一数据结构——转换结果直接进编辑器，编辑器里的手改也可以回注（见 §6 增量转换）。

> **实现现状（2026-10-26）**：`ConversionResult.alpha` 为 `(h,w) uint8` 0/1（源区 alpha 均值 ≥ 0.35 记不透明；放大时无源像素落入的空档记不透明）。
> `convert/convert_file` 响应在**存在透明格**时附 `alpha_png`（网格分辨率灰度 PNG base64），否则为 `null`；`rerun_region` 不改 alpha。
> **放大网格的空档（M5.1）**：源图边长 < 目标格数时源像素数少于格数，按"源像素→格"归属必然有空档格。`build_mapping` 为此额外给出
> `covered`（格是否有源像素）与 `cell_src`（每格代表源像素 = 格中心 floor）；`s2_sampling.fill_empty_cells` 用代表源像素回填空档，
> 否则空档格采样落成 0（黑）→ 渲染为"黑色发丝线"。缩小/等尺寸时回填是空操作（输出与修复前一致）。

## 3. 管线设计

```
输入图
  │
  ▼
S0 预处理 ──────── 双边去噪 → 色阶/饱和度补偿 → [可选] rembg 抠主体
  │                  （全分辨率，CPU，一次）
  ▼
S1 结构分析 ────── 边缘强度图 E（DoG+Sobel）
  │                [插画/AI档] 线稿 L：XDoG（快）| Informative Drawings ONNX（好）
  ▼
S6 [AI 可选档] ── ComfyUI img2img 重绘 → 替换 P0，回到主流线
  │
  ▼
S2 网格下采样 ──── 三种采样模式（可切换/可分区）：
  │                A 均值：线性空间 area average
  │                B 加权众数（默认）：边缘/暗色加权的赢家通吃
  │                C 分层采样（进阶）：K 色分层 → 各层众数 → 按覆盖率合成
  ▼
S3 调色板量化 ──── OKLab 色距；内置 Lospec / 从图提取 / 自定义
  │                抖动：默认关；大图可选 Bayer（不用误差扩散）
  ▼
S4 墨线合成 ────── [可选] 线稿 L → 网格化 → 膨胀至恰 1 格宽
  │                → 叠加为 Ink 层；轮廓重着色（相邻底色加深，非纯黑）
  ▼
S5 后处理 ──────── 孤立像素清理 → 色簇平滑（可选）→ 索引 PNG + 元数据
```

### S0 预处理（用户问题 3 的第一半）
- **双边滤波**：半径/强度可调。照片必开（噪点量化后变彩色雪花）；插画/AI 图可关。
- **饱和度/对比度预提升**：预先补偿量化损失，比事后拉饱和干净。
- **主体分割**：rembg（U2Net ONNX，CPU 推理秒级）→ alpha 通道。做精灵图的刚需开关。

### S1 结构分析
- **边缘强度图 E**：`E = normalize( |DoG| + λ·|Sobel| )`。用途有二：S2 的采样权重、重要度图的分量。
- **线稿 L（可选）**：
  - XDoG：纯算法，毫秒级，参数 4 个，做默认档；
  - Informative Drawings（ONNX, CPU）：照片域线条质量更好，做高质量档。
  - 两者输出统一为 0..1 灰度线稿图。

### S6 AI 档（复用你的 ComfyUI）
- 引擎通过 ComfyUI HTTP API（`http://127.0.0.1:8188`）提交 img2img workflow。
- workflow JSON 作为模板存在 recipe 里，引擎只填参数槽：模型、denoise 强度、seed、prompt（如 "pixel art style"）。
- **AI 输出不直接算结果**：它替换 P0，然后照样走 S2–S5（网格对齐 + 量化收尾）。这解决 AI 生成图的网格不齐、颜色溢出问题——AI 负责「画得像像素画」，经典管线负责「真的是像素画」。
- ComfyUI 不在线时该档灰显，其余功能不受影响。

### S2 网格下采样（用户问题 1、2.1 的主战场）
- **模式 A（均值）**：sRGB→线性→area average→回 sRGB。修 gamma 错误导致的发灰，适合本身平整的插画。
- **模式 B（加权众数，默认）**：每个目标格内统计颜色直方图（颜色先粗分桶），每个源像素权重
  `w = 1 + wE·E(p) + wD·Dark(p)`（E 为边缘强度，Dark 为暗度项），
  格子取加权和最大的桶的代表色。效果：黑线和高饱和小特征不被均值稀释（问题 1），暗轮廓天然加粗（问题 2.1）。
  - 已知副作用：参数过激时格子级锯齿、动画闪烁——本工具不做视频，前者靠 wE/wD 上限控制。
- **模式 C（分层采样，进阶）**：先把 P0 聚成 K 个代表色层（OKLab k-means），每层独立做众数采样得到「该层在每格的覆盖率」，最后按覆盖率竞争出格色。最接近人工画法（平涂色块），实现最重，v2 再做。
- **平局与空格**：覆盖率并列时取边缘强度更高者；格子无样本（极端长宽比）取最近邻。

### S3 调色板量化
- 色距一律 **OKLab ΔE**（实现约 50 行，比 LAB 均匀）。
- 调色板来源三选：内置 Lospec 全库 / **从图提取**（在 OKLab 空间 k-means，输出即合法调色板）/ 编辑器中自定义。
- **抖动默认关**：小尺寸像素画抖动=脏。仅当目标 ≥128 且用户开启时提供 Bayer 有序抖动（2×2/4×4）。不做误差扩散（Floyd-Steinberg 在低分辨率下灾难）。
- 量化后再跑一次「孤儿检查」：某颜色全图覆盖 < N 格时并入最近邻色（可选）。

### S4 墨线合成（用户问题 2.2 的正式答案）
- 输入：线稿 L（S1 产物）。
- **宽度自适应膨胀**：目标格宽 = 1 格。做法：L 先按缩放比 s 下采样到网格分辨率，再对每条线段做形态学闭合，保证连通且恰好 1 格宽。缩放比越大，源图上允许的线越细也能保住。
- **轮廓重着色**（selective outline）：Ink 格默认不取纯黑，取「该格相邻 Fill 色在 OKLab 中 darken(25%)」的颜色；纯黑作为可选。这是像素画惯例，观感立刻专业一档。
- Ink 是独立索引层，用户可在编辑器里整体开关、改色、擦除。

### S5 后处理
- 孤立像素清理：3×3 邻域内同色数 ≤1 的格子并入多数邻色（强度可调，0=关）。
- 导出：索引 PNG（带 PLTE）+ recipe JSON + 调色板文件（.hex/.gpl）。

## 4. 局部细节处理策略（用户问题 3，分三个版本落地）

| 版本 | 机制 | 说明 |
|---|---|---|
| v1 | **权重保护** | 重要度图 I 直接进 S2 的采样权重：重要区域的高对比特征不被稀释。网格仍均匀，编辑器无额外复杂度 |
| v1.5 | **分区参数** | 用户在编辑器里圈选区域（或接显著性/分割自动生成），每个区域独立设采样模式/量化强度/抖动开关。区域蒙版存进 recipe |
| v2 | **自适应网格** | Gerstner 路线：I 决定格子大小（重要区域小格、背景大格）。非均匀网格对编辑器数据结构侵入大，放最后 |

重要度图 I 的合成：`I = clamp( a·显著性 + b·E + 用户笔刷 )`。
- 显著性 v1 用轻量近似（中心先验 + 颜色对比度），不跑模型；
- 用户笔刷是最高优先级来源——这是产品交互上超越现有工具的点（「这里保细节」刷一下）。

## 5. 参数总表（Recipe JSON 结构）

```jsonc
{
  "target": { "width": 64, "height": 64 },       // 目标网格
  "preprocess": {
    "bilateral": { "enable": true, "radius": 3, "strength": 0.6 },
    "levels":    { "saturation": 1.15, "contrast": 1.05,
                   "bright_contrast": 0.0, "bright_start": 0.6 },  // M5.3 亮部对比增强（0=关；只动亮区）
    "matting":   { "enable": false }              // rembg
  },
  "structure": {
    "edge":      { "dog_sigma": 1.2, "sobel_weight": 0.5 },
    "lineart":   { "mode": "off | xdog | onnx", "xdog": { "p": 20, "e": 0.6 } }
  },
  "ai": {                                         // 可选档
    "enable": false,
    "comfy_url": "http://127.0.0.1:8188",
    "workflow": "workflows/pixel_img2img.json",   // 模板，参数槽由引擎填
    "denoise": 0.55, "seed": -1
  },
  "sampling": {
    "mode": "weighted_mode | mean | layered",
    "weights": { "edge": 2.0, "dark": 1.5 },
    "regions": [ { "mask": "...", "override": { ... } } ]   // v1.5
  },
  "quantize": {
    "palette": { "source": "builtin | extract | custom", "ref": "AAP-64", "max_colors": 64,
                 "seed_colors": [] },   // M5-4 色板锁定：≤32 色强制保留（从 max_colors 扣减预算、ΔE<0.03 去重、追加尾部）
    "dither":  { "mode": "off | bayer", "matrix": 4 }
  },
  "ink": {
    "enable": true, "opacity": 1.0,
    "recolor": { "mode": "selective | black | off", "darken": 0.25 }
  },
  "post": { "despeckle": 1 }
}
```

内置三套预设配方：**照片模式**（双边开 + 加权众数 + 无墨线 + 不抖动）、**插画模式**（均值或 C + XDoG 墨线 + selective outline）、**AI 模式**（S6 开 + S2 均值弱化 + 量化收尾）。

## 6. 引擎 ↔ 编辑器接口

```
POST /api/convert        {image, recipe} → {fill, ink, palette, alpha_png?, preview}
POST /api/rerun_region   {jobId, regionMask, paramDelta} → {fill(仅区域内), ...}
POST /api/export_indexed {palette, indices, width, height} → 带 PLTE(+tRNS) 的索引 PNG（M5）
GET  /api/stage/{jobId}/{stage}   → 任一中间产物（P0/E/L/I/…），验证与调参用
WS   /api/preview        参数变更推送实时预览
POST /api/extract_palette {image, k} → 调色板
GET  /api/jobs/{id}/grid          → 完整 fill/ink/alpha/调色板/revision（MCP-3A）
POST /api/jobs/{id}/pixels        → 批量写格（fill/ink/alpha）
POST /api/jobs/{id}/fill          → 区域泛洪填充
POST /api/jobs/{id}/palette       → 整板 OKLab 变换（索引不动）
POST /api/jobs/{id}/rerun         → 局部重算（rect/cells）
POST /api/jobs/{id}/export        → composite RGBA / indexed PLTE+tRNS
GET  /api/jobs                    → job 列表（MCP-3B）
WS   /api/jobs/{id}               → 快照 + 编辑广播（MCP-3B）
GET/POST /api/agents              → Agent 注册/控制/功能权限（MCP-3B）
```

- **增量转换**（`rerun_region`）是编辑器核心交互：用户圈一块不满意的地方 → 改该区参数 → 引擎只重算 S2–S3 的该区域写回。全图级参数改动则全量重跑（64² 网格全量也只需毫秒级，压力只在 S0/S1，而它们按图缓存）。
- 转换结果 = 编辑器文档的初始状态；用户手改产生 override 层，重渲染时 override 保留（非破坏原则的延伸：手改优先于算法）。

## 7. 技术栈与部署

| 组件 | 选型 | 理由 |
|---|---|---|
| 引擎核心 | Python 3.11 + numpy/scipy/opencv/Pillow | 与 ComfyUI 同生态；图像算法库齐；个人工具无分发负担 |
| 小模型推理 | onnxruntime（CPU EP） | Informative Drawings / rembg，秒级，不占显存 |
| AI 档 | 已部署的 ComfyUI（HTTP API 调用） | 零新增部署；RTX 5070 12GB 由 ComfyUI 自己管理 |
| 服务 | FastAPI + WebSocket，localhost | 本地单用户 |
| 编辑器 | Web 前端（Vite + TS + Canvas），后续另设 | 先引擎后编辑器 |
| GPU 依赖 | 引擎本身不需要 CUDA | 所有确定性阶段 CPU 毫秒~百毫秒级；唯一 GPU 用户是 ComfyUI |

性能预估（285H / 16 核）：2048² 图 S0+S1 一次约 0.2–0.5s（按图缓存）；S2–S5 在 64² 网格上 <20ms，256² <100ms——实时预览成立。

## 8. 代码结构（实现时）

```
pixelforge/
  engine/
    core/    oklab.py  grid.py  palette.py  importance.py
    stages/  s0_preprocess.py  s1_structure.py  s2_sampling.py
             s3_quantize.py    s4_ink.py         s5_post.py
    ai/      comfy_client.py   onnx_lineart.py   rembg_matting.py
    pipeline.py              # 组装 + 缓存 + 增量
    server/  api.py
  recipes/  photo.json  illustration.json  ai-assist.json
  tests/    golden/    # 验证用的固定测试图 + 期望输出快照
```

## 9. 验证计划（下一步，设计已为其留好接口）

1. **基线对比**：固定 5–10 张测试图（照片/插画/AI 图各若干），同一图跑「Aseprite 直接导入缩放」vs 本引擎照片模式，并排对比。`GET /api/stage/*` 导出中间产物定位差异来源。
2. **单元验证**：OKLab 量化、加权众数采样各配合成用例（纯色块+细线测试图，断言细线保留/颜色饱和度）。
3. **AI 档验证**：ComfyUI img2img 前后对比，确认「AI 出图 → S2–S5 收尾」对齐了网格。
4. 每项验证结果回写本设计文档的参数默认值。

## 10. 已知风险与开放问题

- 加权众数的权重上限需要实验标定（过强→格子锯齿）；先用 golden 测试图扫参数。
- 线稿膨胀到「恰 1 格宽」在缩放比极大（>16×）时形态学闭合可能断线，需要保连通的膨胀算法（骨架化 + 网格重描是后备方案）。
- 从图提取调色板在暗图上会聚出全灰系，需要最小色相覆盖约束。
- ComfyUI workflow 模板的参数槽注入格式取决于你现有 workflow 的节点结构，实现时对着你的 workflow JSON 定。
