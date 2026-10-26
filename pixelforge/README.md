# PixelForge — 图片转像素画引擎（个人工具）

把任意图片（照片/插画/AI 生成图）转换为**分层、可编辑、索引色**的像素画。
设计文档见 `../conversion-engine-design.md`（v0.2 修订：AI 仅保留接口，后续接入）。

## 总体架构

```
源图 ──► S0 预处理 ──► S1 结构分析 ──► [S6 AI重绘·仅接口] ──► S2 网格下采样
         (去噪/电平)    (边缘图/线稿XDoG)                        (均值|加权众数)
                                                              │
        索引PNG ◄─ S5 后处理 ◄─ S4 墨线合成 ◄─ S3 调色板量化 ◄──┘
        +配方JSON              (selective      (OKLab ΔE)
                               outline)            │
                                                   ▼
                                     Fill层 + Ink层 + 调色板 ──► 编辑器(后续)
```

核心思想：**转换 = 纯函数(源图, 配方) → 分层结果**。全管线确定性、毫秒级（网格阶段），
配方可存档、可局部重跑（`rerun_region`），手改优先于算法（非破坏原则）。

## 目录结构与职责

```
pixelforge/
├── engine/
│   ├── types.py          # 全部数据模型：RGBImage/GrayMap/IndexGrid/Palette/转换结果
│   ├── recipe.py         # 配方(Recipe)加载、校验、预设
│   ├── pipeline.py       # ★ 管线组装：阶段调度、缓存、增量重跑 —— 全貌入口
│   ├── core/             # 无状态的底层算法
│   │   ├── oklab.py      #   sRGB↔OKLab 色彩转换 + ΔE        [已实现]
│   │   ├── grid.py       #   源图→目标网格的格子映射           [接口]
│   │   ├── palette.py    #   调色板加载/从图提取/最近色映射     [接口]
│   │   └── importance.py #   重要度图合成(显著性+用户笔刷)      [接口]
│   ├── stages/           # 管线的 6 个阶段，每个文件=一个阶段
│   │   ├── s0_preprocess.py   # 双边滤波、电平/饱和度、抠图占位
│   │   ├── s1_structure.py    # 边缘强度图(DoG+Sobel)、XDoG线稿
│   │   ├── s2_sampling.py     # 均值采样 | 加权众数采样(核心)
│   │   ├── s3_quantize.py     # OKLab 调色板量化、Bayer抖动(可选)
│   │   ├── s4_ink.py          # 墨线层: 1格宽膨胀+selective outline
│   │   └── s5_post.py         # 孤立像素清理、导出
│   ├── ai/               # ★ AI 能力全部走这里，本期仅接口
│   │   ├── base.py       #   三个 Provider 协议(线稿/抠图/ComfyUI重绘)
│   │   └── stub.py       #   默认不可用实现(报错并提示后续接入)
│   └── server/
│       └── api.py        # FastAPI: convert / rerun_region / stage / preview(WS)
├── recipes/              # 预设配方：photo.json / illustration.json
└── tests/
    ├── test_oklab.py     # OKLab 单元测试                     [已实现]
    └── golden/           # 固定测试图 + 期望输出(验证阶段填入)
```

## 数据流（一次转换）

1. `types.RGBImage`（源图，任意分辨率）
2. S0 → `P0`（预处理图）｜S1 → `E`（边缘图）+ `L`（线稿，可选）——**按图缓存，只算一次**
3. S2 → 低分辨率 RGB → S3 → `IndexGrid`（底色层 Fill，调色板索引）
4. S4 → `IndexGrid`（墨线层 Ink，可选）
5. S5 → 清理 + 合成导出；编辑器拿到 `Fill + Ink + Palette` 三件套

## 当前进度

| 模块 | 状态 |
|---|---|
| types / recipe / oklab / AI 接口定义 | ✅ 已完成 |
| core（grid / palette / 内置调色板）| ✅ 已完成 |
| S0 预处理 / S1 边缘图+XDoG 线稿 / S2 采样 / S3 量化 / S4 墨线 / S5 导出 | ✅ 已完成（视觉核验通过） |
| S2 主引擎 v1.1（桶合并 + 软赢家 + 局部稀有色带权重） | ✅ 已完成（均值模式降级为对照；illustration 预设已切至 weighted_mode；雨伞女孩对比核验 9/10） |
| 已知调参项 | 浅色/远景区墨线对比偏弱（白云、山体），考虑按亮度自适应加深 |
| pipeline 打通 + CLI（`python -m engine.cli`）| ✅ 已完成 |
| golden 验证（均值 vs 加权众数，视觉核验通过）| ✅ 已完成 |
| ONNX Provider（lineart / matting）+ 模型 | ✅ 已完成（模型已下载验证，ONNX 线稿视觉核验 9/10） |
| FastAPI 服务（convert/convert_file/stage/extract_palette/health/WS） | ✅ 已完成并实测通过 |
| 独立线稿提取（CLI `--lineart-out` / API `POST /api/lineart`，xdog\|onnx） | ✅ 已完成 |
| MCP 服务器（AI 接入，8 工具） | ✅ 已完成（`python -m engine.mcp_server`，端到端测试 tools/check_mcp.py 全过） |
| AI 接入（ComfyUI img2img） | ⏸ 后续版本，入口在 `engine/ai/` |
| 编辑器前端 M1（骨架+多文档：标签/缩放/网格/对比/图层/调色板/导航器） | ✅ 已完成（浏览器自动化冒烟全过，`cd web && npm run dev` → http://localhost:5173/?demo=1） |
| 编辑器 M2 编辑闭环（工具/手改层/撤销/导出） | ⏭ 下一批 |

## 路线图

- **v1**：确定性管线跑通 + golden 测试图验证（对比 Aseprite 基线）
- **v1.5**：分区参数 + 局部重转换（`rerun_region`）
- **v2**：AI 档接入（ComfyUI）、分层采样模式、自适应网格

## 开发

```bash
cd pixelforge
pip install -e ".[dev]"        # 服务另需: fastapi uvicorn[standard] python-multipart（已装于全局）
pytest                          # 22 个测试
python -m uvicorn engine.server.api:app --port 8700   # 本地服务（GET /api/health 查状态）
```
