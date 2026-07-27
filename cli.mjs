#!/usr/bin/env node
// Parse CLI args before modules read process.env
const args = process.argv.slice(2);

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--host" || args[i] === "-h") {
    process.env.HOST = args[++i];
  } else if (args[i] === "--port" || args[i] === "-p") {
    process.env.PORT = args[++i];
  } else if (args[i] === "--log") {
    process.env.CLAUDE_WEB_UI_LOG = "true";
  } else if (args[i] === "--help") {
    console.log(`
  claude-web-ui  v${process.env.npm_package_version || "0.1.0"}

  Usage:  npx github:YorrickBao/claude-web-ui [options]
          pnpm dlx github:YorrickBao/claude-web-ui [options]
          yarn dlx github:YorrickBao/claude-web-ui [options]

  Options:
    --host, -h              Bind address (default: 127.0.0.1)
    --port, -p              Start port, +1 if occupied (default: 23456)
    --log                   Enable log output (default: disabled)
    --help                  Show this help
`);
    process.exit(0);
  }
}

// When --log is NOT passed, silence all console output globally.
// This must run before any server module imports so their console calls are also silenced.
if (process.env.CLAUDE_WEB_UI_LOG !== "true") {
  const noop = () => {};
  console.log = noop;
  console.info = noop;
  console.warn = noop;
  console.error = noop;
}

// Dynamic imports: args must be parsed first so env.ts sees the overridden env vars
const { DATA_DIR } = await import("./server/dist/env.js");

if (process.env.CLAUDE_WEB_UI_LOG === "true") {
  console.log(`\n  claude-web-ui  v${process.env.npm_package_version || "0.1.0"}`);
  console.log(`  ─────────────────────────────────`);
  console.log(`  Data:  ${DATA_DIR}\n`);
}

import("./server/dist/index.js").catch((err) => {
  console.error("Failed to start server:", err.message);
  process.exit(1);
});
