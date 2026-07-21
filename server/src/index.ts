import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fsp from "node:fs/promises";
import { HOST, PORT, WEB_DIST_DIR } from "./env.js";
import { apiRoutes } from "./routes/index.js";

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
    await app.listen({ host: HOST, port: PORT });
    app.log.info(`▶ http://${HOST}:${PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
