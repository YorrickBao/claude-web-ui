import type { FastifyReply } from "fastify";
import type { SSEEvent } from "./types.js";

/** 初始化 SSE 响应头 */
export function initSSE(reply: FastifyReply): void {
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // 关闭 nginx 等中间代理的 buffering（本地用不上，留作好习惯）
    "X-Accel-Buffering": "no",
  });
}

/**
 * 向 SSE 流推一个事件。
 * 格式遵循 SSE 规范：
 *   event: <type>\n
 *   data: <json>\n\n
 */
export function sendSSE(reply: FastifyReply, event: SSEEvent): void {
  reply.raw.write(`event: ${event.type}\n`);
  reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
}

/** 结束 SSE 流 */
export function endSSE(reply: FastifyReply): void {
  reply.raw.end();
}
