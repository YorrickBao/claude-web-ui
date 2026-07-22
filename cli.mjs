#!/usr/bin/env node
import { DATA_DIR } from "./server/dist/env.js";

console.log(`\n  claude-web-ui  v${process.env.npm_package_version || "0.1.0"}`);
console.log(`  ─────────────────────────────────`);
console.log(`  Data:  ${DATA_DIR}\n`);

// 启动 Fastify 服务（端口会由 index.js 自动选择并打印）
import("./server/dist/index.js").catch((err) => {
  console.error("Failed to start server:", err.message);
  process.exit(1);
});
