# AI 模型清单

引擎的 AI 档使用两个 ONNX 模型。**权重不随仓库分发**（`*.onnx` 已在 `.gitignore` 中），
可用 `python tools/download_models.py` 下载并校验。

## 目录结构与规格

```
pixelforge/models/
├── lineart/
│   └── model.onnx      # ~17 MB   Informative Drawings 线稿
└── matting/
    ├── u2net.onnx      # ~176 MB  U²-Net 主体抠图（默认）
    └── u2netp.onnx     # ~4.6 MB  U²-NetP 轻量版（快速档）
```

| 模型 | 输入 | 输出 | 备注 |
|---|---|---|---|
| `lineart/model.onnx` | `input`，动态 `(batch,3,H,W)`，RGB 归一化 | `(1,1,H,W)` 灰度 | 任意分辨率，输出按原图尺寸还原 |
| `matting/u2net.onnx` | `input.1`，固定 `(1,3,320,320)` | 7 个输出，取 `out[0]` | 结果上采样回原尺寸做 alpha |
| `matting/u2netp.onnx` | 同上 | 同上 | 轻量快速档 |

## 校验值（SHA-256）

| 文件 | SHA-256 |
|---|---|
| `lineart/model.onnx` | `1fef40b8f7126d827e30fbebccf95ae9b0b391795df926bf9366a821bad4f498` |
| `matting/u2net.onnx` | `8d10d2f3bb75ae3b6d527c77944fc5e7dcd94b29809d47a739a7a728a912b491` |
| `matting/u2netp.onnx` | `309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8` |

## 下载源

- `https://hf-mirror.com/rocca/informative-drawings-line-art-onnx/resolve/main/model.onnx`
- `https://hf-mirror.com/Heliosoph/u2net-onnx/resolve/main/u2net.onnx`
- `https://hf-mirror.com/Heliosoph/u2net-onnx/resolve/main/u2netp.onnx`

> huggingface.co 在部分网络环境不可达时，`hf-mirror.com` 可作为镜像；也可设置
> `HF_ENDPOINT=https://hf-mirror.com` 配合 `huggingface-cli`。GitHub 可直连但大文件较慢。

## 许可

- Informative Drawings — MIT（https://github.com/carolineec/informative-drawings）
- U²-Net / U²-NetP — Apache-2.0（https://github.com/xuebinqin/U-2-Net）

详见根目录 `THIRD_PARTY_NOTICES.md`。

## 运行依赖

- `onnxruntime`（CPU EP）：`pip install onnxruntime`
- ComfyUI 重绘档：仓库仅保留 Provider 接口占位，默认不连接。
