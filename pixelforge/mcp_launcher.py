"""PixelForge MCP 启动器（供 MCP 客户端直接调用，不依赖 cwd）。

客户端配置示例：
  command: "python"
  args: ["<仓库>/pixelforge/mcp_launcher.py"]
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from engine.mcp_server import OUT_DIR, mcp  # noqa: E402

if __name__ == "__main__":
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    mcp.run()
