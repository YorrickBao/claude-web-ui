import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { HOST, START_PORT, WEB_DIST_DIR, DATA_DIR } from "./env.js";
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
    logger: process.env.NODE_ENV === "production"
      ? true
      : {
          transport: {
            target: "pino-pretty",
            options: { colorize: true, translateTime: "HH:MM:ss" },
          },
        },
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
    // SPA fallback：未匹配的 GET 返回 index.html
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
    app.log.info(`▶ ${url}`);
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
  } catch {
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

  startFeishuChannel(feishuConfig).catch((err: unknown) => {
    app.log.error({ err: err instanceof Error ? err.message : err }, "[feishu] channel startup failed");
  });
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
