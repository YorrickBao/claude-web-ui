#!/usr/bin/env node
// Parse CLI args before modules read process.env
const args = process.argv.slice(2);
let feishuBind = false;

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
  } else if (args[i] === "--feishu-bind") {
    feishuBind = true;
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

  Feishu Options:
    --feishu-enabled        Enable Feishu channel (default: disabled)
    --feishu-app-id         Feishu App ID
    --feishu-app-secret     Feishu App Secret
    --feishu-domain         Feishu domain: "feishu" or "lark" (default: feishu)
    --feishu-cwd            Default working directory for Feishu sessions
    --feishu-profile-id     Default profile ID for Feishu sessions
    --feishu-bind           Bind Feishu bot via QR code (interactive)
`);
    process.exit(0);
  }
}

if (feishuBind) {
  const { connectFeishuBot } = await import("connect-feishu-bot");
  const { DATA_DIR } = await import("./server/dist/env.js");
  const fs = await import("node:fs/promises");
  const path = await import("node:path");

  console.log("\n  Feishu Bot Binding");
  console.log("  ─────────────────────────────────");
  console.log("\n  Scan with Feishu to create your bot:\n");

  try {
    const result = await connectFeishuBot({
      onQRCode: (url) => {
        console.log(`  QR URL: ${url}`);
        console.log();
      },
      onStatus: (status) => {
        if (status.phase === "waiting_for_scan") {
          console.log("  Waiting for scan...");
        } else if (status.phase === "success") {
          console.log("  ✓ Bot created!");
        } else if (status.phase === "expired") {
          console.log("  ✗ QR code expired");
        } else if (status.phase === "denied") {
          console.log("  ✗ User denied");
        }
      },
    });

    const configPath = path.join(DATA_DIR, "feishu-config.json");
    await fs.writeFile(configPath, JSON.stringify({
      appId: result.appId,
      appSecret: result.appSecret,
      domain: result.domain,
    }, null, 2), "utf-8");

    console.log(`\n  App ID: ${result.appId}`);
    console.log(`  Domain: ${result.domain}`);
    console.log(`  Config saved to: ${configPath}`);
    console.log(`\n  You can now start the server and Feishu channel will be enabled.`);
    process.exit(0);
  } catch (err) {
    console.error("\n  Error:", err.message);
    process.exit(1);
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
