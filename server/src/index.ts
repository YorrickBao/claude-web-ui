import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { HOST, START_PORT, WEB_DIST_DIR, DATA_DIR, LOG_ENABLED } from "./env.js";
import { apiRoutes } from "./routes/index.js";
import { startFeishuChannel, type FeishuConfig } from "./channels/feishu.js";

/** 尝试监听端口，占用则 +1 重试（最多试 100 个） */
async function tryListen(
  app: FastifyInstance,
  host: string,
  startPort: number,
): Promise<number> {
  for (let port = startPort; port < startPort + 100; port++) {
    try {
      await app.listen({ host, port });
      return port;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "EADDRINUSE") throw err;
    }
  }
  throw new Error(`no available port in range ${startPort}-${startPort + 99}`);
}

/** 在交互终端下打开浏览器 */
function openBrowser(url: string): void {
  if (!process.stdout.isTTY) return;
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true }).unref();
  } else {
    const cmd = process.platform === "darwin" ? "open" : "xdg-open";
    spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
  }
}

async function main(): Promise<void> {
  const app = Fastify({
    logger: LOG_ENABLED
      ? process.env.NODE_ENV === "production"
        ? true
        : {
            transport: {
              target: "pino-pretty",
              options: { colorize: true, translateTime: "HH:MM:ss" },
            },
          }
      : false,
  });

  // 业务路由
  await app.register(apiRoutes);

  // 生产模式下托管前端构建产物（dev 模式下 vite 自己起服务）
  const hasWebDist = await fsp
    .access(WEB_DIST_DIR)
    .then(() => true)
    .catch(() => false);
  if (hasWebDist) {
    await app.register(fastifyStatic, {
      root: WEB_DIST_DIR,
      prefix: "/",
      decorateReply: true,
      wildcard: false, // 不拦截 /*，让 SPA 路由落到 setNotFoundHandler
    });

    // ── 缓存策略 ────────────────────────────────────────────────
    // @fastify/static 底层 send 库会固定写 Cache-Control: public, max-age=0，
    // 且在 setHeaders 回调之后用 reply.headers(headers) 覆盖，因此 setHeaders
    // 无法改写 Cache-Control。这里用 onSend 钩子在最终发送前改写：
    //   - index.html（含根路径 / 与 SPA fallback）：禁缓存
    //     避免旧 index 指向已被覆盖的 hash 资源（表现为 JS/CSS 全部返回 HTML）
    //   - /assets/*（内容 hash 文件）：永久不可变缓存
    //   - /api/*：不干预，保持默认（无显式缓存头）
    app.addHook("onSend", async (req, reply, payload) => {
      if (req.method !== "GET" && req.method !== "HEAD") return payload;
      const url = req.url.split("?", 2)[0];
      if (url.startsWith("/api/")) return payload; // API 响应不干预缓存
      if (url.startsWith("/assets/")) {
        // hash 资源：内容变化即换文件名，可永久缓存
        reply.header("Cache-Control", "public, max-age=31536000, immutable");
      } else {
        // 根路径 / 、index.html、SPA fallback 路由等 HTML 文档：每次拉取最新
        reply.header("Cache-Control", "no-cache, no-store, must-revalidate");
        reply.header("Pragma", "no-cache");
        reply.header("Expires", "0");
      }
      return payload;
    });

    // SPA fallback：未匹配的 GET（非 /api）返回 index.html
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !req.url.startsWith("/api")) {
        return reply.sendFile("index.html");
      }
      return reply.code(404).send({ error: "not found" });
    });
    app.log.info(`serving web dist from ${WEB_DIST_DIR}`);
  } else {
    app.log.warn(
      "web/dist not found — run `pnpm --filter ./web build` or run vite dev",
    );
  }

  try {
    const port = await tryListen(app, HOST, START_PORT);
    const url = `http://${HOST}:${port}`;
    // 访问地址必须始终打印，不受 --log 控制（cli.mjs 会全局静默 console）
    process.stdout.write(`\n  ▶  ${url}\n\n`);
    openBrowser(url);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  const FEISHU_CONFIG_FILE = path.join(DATA_DIR, "feishu-config.json");

  let savedFeishuConfig: { appId: string; appSecret: string; domain: "feishu" | "lark" } | null = null;
  try {
    const content = await fsp.readFile(FEISHU_CONFIG_FILE, "utf-8");
    savedFeishuConfig = JSON.parse(content);
    app.log.info("[feishu] loaded saved config");
  } catch (err) {
    app.log.warn(`[feishu] failed to load saved config: ${err instanceof Error ? err.message : err}`);
    savedFeishuConfig = null;
  }

  const feishuConfig: FeishuConfig = {
    enabled: process.env.FEISHU_ENABLED === "true" || !!savedFeishuConfig,
    appId: process.env.FEISHU_APP_ID || savedFeishuConfig?.appId || "",
    appSecret: process.env.FEISHU_APP_SECRET || savedFeishuConfig?.appSecret || "",
    domain: process.env.FEISHU_DOMAIN === "lark" ? "lark" : savedFeishuConfig?.domain || "feishu",
    defaultCwd: process.env.FEISHU_DEFAULT_CWD || process.cwd(),
    defaultProfileId: process.env.FEISHU_DEFAULT_PROFILE_ID || null,
  };

  let feishuChannelStarted = false;

  async function startFeishuChannelIfNeeded(config: FeishuConfig): Promise<void> {
    if (feishuChannelStarted) {
      if (LOG_ENABLED) console.info("[feishu] channel already started, skipping");
      return;
    }
    if (!config.enabled || !config.appId || !config.appSecret) {
      if (LOG_ENABLED) console.info("[feishu] channel disabled or missing credentials");
      return;
    }
    try {
      await startFeishuChannel(config);
      feishuChannelStarted = true;
      if (LOG_ENABLED) console.info("[feishu] channel started");
    } catch (err) {
      if (LOG_ENABLED) console.error("[feishu] channel startup failed:", err);
    }
  }

  startFeishuChannelIfNeeded(feishuConfig).catch((err: unknown) => {
    app.log.error({ err: err instanceof Error ? err.message : err }, "[feishu] channel startup failed");
  });

  (globalThis as any).__feishuChannelStarter = startFeishuChannelIfNeeded;
}

main().catch((err) => {
  if (LOG_ENABLED) console.error("fatal:", err);
  process.exit(1);
});
