import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    port: 25173,
    strictPort: true,
    // 监听所有网卡，方便局域网/容器内访问
    host: "0.0.0.0",
    proxy: {
      // dev 模式下 /api 反代到后端
      "/api": {
        target: "http://127.0.0.1:23456",
        changeOrigin: true,
      },
    },
  },
  // 后端生产模式托管 web/dist，构建产物用相对路径
  base: "./",
});
