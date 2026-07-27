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
 *
 * 另有一条全局频道：
 *   relay               —— 远程控制隧道状态变更（非会话级）
 *   sessions-changed    —— 会话列表/状态变更通知（驱动 Sidebar 刷新）
 *   session-lifecycle   —— 会话查询开始/结束的精确信号（带 sessionId），
 *                          驱动观察方窗口接入实时流，取代靠 sessions-changed
 *                          拉取状态再翻转推断的脆弱链路
 */

import { EventEmitter } from "node:events";
import type { SSEEvent } from "./types.js";
import type { RelayStatus } from "../channels/relay.js";
import type { DeviceEntry } from "./relayDevices.js";

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

/** 广播远程控制隧道状态变更（全局频道） */
export function emitRelayStatus(status: RelayStatus): void {
  bus.emit("relay", status);
}

/**
 * 订阅远程控制隧道状态变更。
 * @returns 取消订阅的函数
 */
export function onRelayStatus(listener: (status: RelayStatus) => void): () => void {
  bus.on("relay", listener);
  return () => {
    bus.off("relay", listener);
  };
}

// ─────────────────────────────────────────────────────────────
// 远程设备列表变更（全局频道）
// 设备上下线由 GET /api/events/stream 连接生命周期驱动，低频，走全局总线。
// ─────────────────────────────────────────────────────────────

/** 广播远程设备列表变更（设备上线/下线/清空） */
export function emitDeviceChanged(devices: DeviceEntry[]): void {
  bus.emit("device_changed", devices);
}

/**
 * 订阅远程设备列表变更。
 * @returns 取消订阅的函数
 */
export function onDeviceChanged(listener: (devices: DeviceEntry[]) => void): () => void {
  bus.on("device_changed", listener);
  return () => {
    bus.off("device_changed", listener);
  };
}

/**
 * 广播会话列表/状态变更通知（全局频道）。
 * 只发信号不带数据：前端收到后自行 GET /api/sessions 拉最新列表。
 * 触发点：新建会话、删除会话、inflight 状态流转、会话结束。
 */
export function emitSessionsChanged(): void {
  bus.emit("sessions-changed");
}

/**
 * 订阅会话列表/状态变更通知。
 * @returns 取消订阅的函数
 */
export function onSessionsChanged(listener: () => void): () => void {
  bus.on("sessions-changed", listener);
  return () => {
    bus.off("sessions-changed", listener);
  };
}

// ─────────────────────────────────────────────────────────────
// 会话查询生命周期（全局频道）
// 每次查询开始/结束各发一帧，带 sessionId。低频，走全局总线
// /api/events/stream。观察方窗口据此接入 GET /:id/stream 实时流。
// ─────────────────────────────────────────────────────────────

/** 会话查询开始/结束的精确信号 */
export type SessionLifecycleEvent =
  | { type: "session_started"; sessionId: string }
  | { type: "session_ended"; sessionId: string };

/** 广播：某会话查询开始（仅当 inflight 状态真正从无→有时发） */
export function emitSessionStarted(sessionId: string): void {
  bus.emit("session-lifecycle", { type: "session_started", sessionId });
}

/** 广播：某会话查询结束（仅当 inflight 状态真正从有→无时发） */
export function emitSessionEnded(sessionId: string): void {
  bus.emit("session-lifecycle", { type: "session_ended", sessionId });
}

/**
 * 订阅会话查询生命周期信号。
 * @returns 取消订阅的函数
 */
export function onSessionLifecycle(
  listener: (event: SessionLifecycleEvent) => void,
): () => void {
  bus.on("session-lifecycle", listener);
  return () => {
    bus.off("session-lifecycle", listener);
  };
}
