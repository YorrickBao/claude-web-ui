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
  // 后端生产模式托管 web/dist。base 用相对路径（"./"），让同一份 dist 既能挂在
  // 根路径（/）下，也能挂在 nginx 子路径（如 /relay/）下：资源引用始终相对于
  // 当前文档 URL 解析。配合前端 HashRouter，子路径部署无需任何路径重写。
  base: "./",
});
