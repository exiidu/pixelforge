import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8700",
        changeOrigin: true,
        ws: true, // WS /api/preview（M3 实时预览用）
      },
    },
  },
});
