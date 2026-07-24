import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

/**
 * 从模块 id 中解析出顶层 npm 包名。
 * 兼容 pnpm 的 `.pnpm/<pkg>@<ver>/node_modules/<pkg>/` 结构：取最后一个
 * `node_modules/` 之后的段，支持 @scope/name 两段式包名。
 */
function pkgOf(id: string): string | null {
  const idx = id.lastIndexOf("node_modules/");
  if (idx < 0) return null;
  const rest = id.slice(idx + "node_modules/".length);
  const parts = rest.split("/");
  return rest.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
}

/** 判断是否属于 markdown / 代码高亮渲染栈（react-markdown 全家桶 + highlight.js）。 */
function isMarkdownPkg(pkg: string): boolean {
  if (pkg === "highlight.js" || pkg === "lowlight" || pkg === "react-markdown")
    return true;
  return (
    [
      "remark-",
      "rehype-",
      "micromark",
      "mdast-",
      "hast-",
      "unist-",
      "character-reference",
      "vfile",
      "html-url-",
      "comma-separated-tokens",
      "space-separated-tokens",
      "property-information",
      "trim-lines",
      "estree-",
      "decode-named-character-reference",
    ].some((p) => pkg.startsWith(p)) ||
    ["unified", "bail", "trough", "is-plain-obj", "fault", "zwitch"].includes(pkg)
  );
}

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
  build: {
    // 分包：把稳定的第三方依赖拆成独立 chunk，配合 AppShell 的路由懒加载，
    // 既缩小首屏 JS，也让业务代码改动不会让 vendor 缓存失效。
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          const pkg = pkgOf(id);
          if (!pkg) return undefined;
          if (
            pkg === "react" ||
            pkg === "react-dom" ||
            pkg === "scheduler" ||
            pkg === "react-router" ||
            pkg === "react-router-dom"
          )
            return "react-vendor";
          if (pkg.startsWith("@assistant-ui/") || pkg === "assistant-stream")
            return "assistant-ui";
          if (pkg.startsWith("@base-ui/") || pkg.startsWith("@floating-ui/"))
            return "base-ui";
          if (isMarkdownPkg(pkg)) return "markdown";
          return undefined;
        },
      },
    },
  },
});
