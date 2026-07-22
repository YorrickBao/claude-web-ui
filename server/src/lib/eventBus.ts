/**
 * 全局 SSE 事件总线。
 *
 * 目的：让 GET /api/sessions/:id/stream 能订阅到正在进行的
 * POST /api/sessions/:id/messages 发出的实时事件，
 * 支持前端切回正在运行的会话时续上流式输出。
 *
 * 每个 sessionId 有两条频道：
 *   s:<sessionId>       —— SSE 事件
 *   s:<sessionId>:end   —— 流结束信号
 */

import { EventEmitter } from "node:events";
import type { SSEEvent } from "./types.js";

const bus = new EventEmitter();
bus.setMaxListeners(500);

/** 向某个会话的所有订阅者广播一个 SSE 事件 */
export function emitSessionEvent(sessionId: string, event: SSEEvent): void {
  bus.emit(`s:${sessionId}`, event);
}

/** 通知订阅者：该会话的 SSE 流已结束 */
export function emitSessionEnd(sessionId: string): void {
  bus.emit(`s:${sessionId}:end`);
}

/**
 * 订阅某个会话的实时 SSE 事件。
 * @returns 取消订阅的函数
 */
export function onSessionEvent(
  sessionId: string,
  listener: (event: SSEEvent) => void,
): () => void {
  bus.on(`s:${sessionId}`, listener);
  return () => {
    bus.off(`s:${sessionId}`, listener);
  };
}

/**
 * 订阅某个会话的流结束通知。
 * @returns 取消订阅的函数
 */
export function onSessionEnd(
  sessionId: string,
  listener: () => void,
): () => void {
  bus.on(`s:${sessionId}:end`, listener);
  return () => {
    bus.off(`s:${sessionId}:end`, listener);
  };
}
