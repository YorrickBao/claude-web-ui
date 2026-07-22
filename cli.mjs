#!/usr/bin/env node
// Parse CLI args before modules read process.env
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--host" || args[i] === "-h") {
    process.env.HOST = args[++i];
  } else if (args[i] === "--port" || args[i] === "-p") {
    process.env.PORT = args[++i];
  } else if (args[i] === "--feishu-enabled") {
    process.env.FEISHU_ENABLED = "true";
  } else if (args[i] === "--feishu-app-id") {
    process.env.FEISHU_APP_ID = args[++i];
  } else if (args[i] === "--feishu-app-secret") {
    process.env.FEISHU_APP_SECRET = args[++i];
  } else if (args[i] === "--feishu-domain") {
    process.env.FEISHU_DOMAIN = args[++i];
  } else if (args[i] === "--feishu-cwd") {
    process.env.FEISHU_DEFAULT_CWD = args[++i];
  } else if (args[i] === "--feishu-profile-id") {
    process.env.FEISHU_DEFAULT_PROFILE_ID = args[++i];
  } else if (args[i] === "--help") {
    console.log(`
  claude-web-ui  v${process.env.npm_package_version || "0.1.0"}

  Usage:  npx github:YorrickBao/claude-web-ui [options]

  Options:
    --host, -h              Bind address (default: 127.0.0.1)
    --port, -p              Start port, +1 if occupied (default: 23456)
    --help                  Show this help

  Feishu Options:
    --feishu-enabled        Enable Feishu channel (default: disabled)
    --feishu-app-id         Feishu App ID
    --feishu-app-secret     Feishu App Secret
    --feishu-domain         Feishu domain: "feishu" or "lark" (default: feishu)
    --feishu-cwd            Default working directory for Feishu sessions
    --feishu-profile-id     Default profile ID for Feishu sessions
`);
    process.exit(0);
  }
}

// Dynamic imports: args must be parsed first so env.ts sees the overridden env vars
const { DATA_DIR } = await import("./server/dist/env.js");

console.log(`\n  claude-web-ui  v${process.env.npm_package_version || "0.1.0"}`);
console.log(`  ─────────────────────────────────`);
console.log(`  Data:  ${DATA_DIR}\n`);

import("./server/dist/index.js").catch((err) => {
  console.error("Failed to start server:", err.message);
  process.exit(1);
});
