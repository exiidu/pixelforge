"""下载并校验 PixelForge 的可选 AI 模型（权重不随仓库分发）。

用法：
    python tools/download_models.py           # 缺失的才下载
    python tools/download_models.py --check   # 只校验已有文件
    python tools/download_models.py --force   # 重新下载全部
"""
from __future__ import annotations

import argparse
import hashlib
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODELS = ROOT / "models"

MODELS_SPEC = {
    "lineart/model.onnx": {
        "sha256": "1fef40b8f7126d827e30fbebccf95ae9b0b391795df926bf9366a821bad4f498",
        "size": 17193338,
        "urls": [
            "https://hf-mirror.com/rocca/informative-drawings-line-art-onnx/resolve/main/model.onnx",
            "https://huggingface.co/rocca/informative-drawings-line-art-onnx/resolve/main/model.onnx",
        ],
    },
    "matting/u2net.onnx": {
        "sha256": "8d10d2f3bb75ae3b6d527c77944fc5e7dcd94b29809d47a739a7a728a912b491",
        "size": 175997641,
        "urls": [
            "https://hf-mirror.com/Heliosoph/u2net-onnx/resolve/main/u2net.onnx",
            "https://huggingface.co/Heliosoph/u2net-onnx/resolve/main/u2net.onnx",
        ],
    },
    "matting/u2netp.onnx": {
        "sha256": "309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8",
        "size": 4574861,
        "urls": [
            "https://hf-mirror.com/Heliosoph/u2net-onnx/resolve/main/u2netp.onnx",
            "https://huggingface.co/Heliosoph/u2net-onnx/resolve/main/u2netp.onnx",
        ],
    },
}


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify(path: Path, spec: dict) -> bool:
    if not path.exists() or path.stat().st_size != spec["size"]:
        return False
    return sha256_of(path) == spec["sha256"]


def download(url: str, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.with_suffix(target.suffix + ".part")
    print(f"  downloading {url}")
    request = urllib.request.Request(url, headers={"User-Agent": "PixelForge/0.2"})
    with urllib.request.urlopen(request, timeout=60) as response, temp.open("wb") as out:
        total = int(response.headers.get("Content-Length") or 0)
        done = 0
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            out.write(chunk)
            done += len(chunk)
            if total:
                sys.stdout.write(f"\r  {done / total * 100:6.2f}%  {done // (1024 * 1024)} MiB")
                sys.stdout.flush()
    sys.stdout.write("\n")
    temp.replace(target)


def main() -> int:
    parser = argparse.ArgumentParser(description="Download PixelForge ONNX models")
    parser.add_argument("--check", action="store_true", help="only verify existing files")
    parser.add_argument("--force", action="store_true", help="re-download even if valid")
    args = parser.parse_args()

    failures = 0
    for relative, spec in MODELS_SPEC.items():
        target = MODELS / relative
        good = verify(target, spec)
        print(f"{relative}: {'OK' if good else 'missing or invalid'}")
        if args.check or (good and not args.force):
            continue
        if target.exists() and not good:
            print("  existing file does not match the expected SHA-256; re-downloading")
        ok = False
        for url in spec["urls"]:
            try:
                download(url, target)
            except Exception as err:  # noqa: BLE001
                print(f"  failed: {err}")
                continue
            if verify(target, spec):
                print("  verified OK")
                ok = True
                break
            print("  checksum mismatch after download")
        if not ok:
            failures += 1

    if failures:
        print(f"\n{failures} model(s) failed. See models/README.md for mirror options.")
        return 1
    print("\nAll models are ready.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
