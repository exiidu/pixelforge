# AI 模型清单（2026-10-24 全部就位 ✅）

引擎 AI 档共三个能力：两个 ONNX 模型已下载并验证（onnxruntime 加载 + 推理通过），
ComfyUI 复用本机部署无需下载。

## 目录结构与实测规格（Provider 实现按此对接）

```
pixelforge/models/
├── lineart/
│   └── model.onnx      # ~17MB  Informative Drawings 线稿
└── matting/
    ├── u2net.onnx      # ~176MB U2Net 主体抠图（默认）
    └── u2netp.onnx     # ~4.6MB 轻量版（快速档）
```

| 模型 | 输入 | 输出 | 备注 |
|---|---|---|---|
| lineart/model.onnx | `input`，动态 (batch,3,H,W)，RGB 归一化 | 1 个 (1,1,H,W) 灰度 | 任意分辨率，输出需按原图尺寸还原 |
| matting/u2net.onnx | `input.1`，固定 (1,3,320,320) | 7 个（深度监督），**取 out[0]** (1,1,320,320) 显著性 | 结果需上采样回原尺寸做 alpha |
| matting/u2netp.onnx | 同上 | 同上 | 轻量快速档 |

## 下载源备忘（huggingface.co 本机不可达；以下 2026-10-24 实测可达）

- hf-mirror.com（快，~3MB/s）：
  - `https://hf-mirror.com/rocca/informative-drawings-line-art-onnx/resolve/main/model.onnx`
  - `https://hf-mirror.com/Heliosoph/u2net-onnx/resolve/main/u2net.onnx`（字节数与
    GitHub danielgatis/rembg release 完全一致：175997641，同一文件）
  - `.../resolve/main/u2netp.onnx`
- GitHub 可直连但传输慢（~50KB/s），大文件优先 hf-mirror；也可设
  `HF_ENDPOINT=https://hf-mirror.com` 配合 huggingface-cli。

> 注：早期调研里 "anno/contour/manga 多文件" 有误，该 HF 仓库实际只有一个 model.onnx；
> 需要多风格线稿时后续从 carolineec/informative-drawings 的 PyTorch 权重自行转 ONNX。

- 依赖：onnxruntime 已安装（CPU EP）。
- ComfyUI（AI 重绘档）：无需下载，地址配置默认 `http://127.0.0.1:8188`，
  仅用户显式开启 AI 档时连接。
