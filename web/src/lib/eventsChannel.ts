/**
 * 全局消息总线（SSE 单例频道）。
 *
 * 后端 GET /api/events/stream 是一条无状态的全局控制面连接，收敛所有「全局低频信号」：
 *   - sessions_changed：会话列表/状态变更（无负载），客户端收到后自行拉取最新列表
 *   - relay_status：远程控制隧道状态快照
 * 原则：新出现的全局信号一律追加到这里，不要再为某个信号单独开 SSE 长连接
 * （见 AGENTS.md「SSE 端点纪律」）。
 *
 * 多个组件（Sidebar 的 useSessions、AppShell 的会话状态翻转、RemoteControlDialog 的
 * 隧道状态）都要消费这些信号。若各自 new EventSource 会在每打开一个页面时多建一条
 * 到后端的连接，叠加远程链路（relay）放大抖动。
 *
 * 这里把频道收敛为模块级单例：全应用共享一条 EventSource，内部用 Set 分事件类型
 * 维护订阅者，并缓存最近一帧 relay_status 供新订阅者立即取用。EventSource 自带
 * 断线重连，无需手动处理。
 */

import type { RelayStatusSnapshot } from "./types";

type SessionsListener = () => void;
type RelayListener = (status: RelayStatusSnapshot) => void;

let sessionsListeners: Set<SessionsListener> | null = null;
let relayListeners: Set<RelayListener> | null = null;
let es: EventSource | null = null;
/** 最近一帧 relay 状态，新订阅者立即可用，避免等下一次变更 */
let lastRelayStatus: RelayStatusSnapshot | null = null;

function hasSubscribers(): boolean {
  return !!sessionsListeners?.size || !!relayListeners?.size;
}

function ensureChannel(): void {
  if (es) return;
  es = new EventSource("api/events/stream");
  es.addEventListener("sessions_changed", () => {
    if (!sessionsListeners) return;
    // 复制一份再遍历：回调里可能 unsubscribe 改动集合
    for (const fn of [...sessionsListeners]) {
      try {
        fn();
      } catch {
        // 单个订阅者出错不影响其他订阅者与频道本身
      }
    }
  });
  es.addEventListener("relay_status", (ev) => {
    let status: RelayStatusSnapshot | null = null;
    try {
      status = (JSON.parse((ev as MessageEvent).data) as { status: RelayStatusSnapshot }).status;
      lastRelayStatus = status;
    } catch {
      return; // 忽略格式异常
    }
    if (!relayListeners) return;
    for (const fn of [...relayListeners]) {
      try {
        fn(status);
      } catch {
        // 单个订阅者出错不影响其他订阅者与频道本身
      }
    }
  });
}

function maybeClose(): void {
  if (!hasSubscribers() && es) {
    es.close();
    es = null;
  }
}

/**
 * 订阅 sessions_changed 信号。返回取消订阅函数。
 * 首次订阅时建立 EventSource；所有订阅者退出时关闭并释放连接。
 */
export function subscribeSessionsChanged(fn: SessionsListener): () => void {
  if (!sessionsListeners) sessionsListeners = new Set();
  sessionsListeners.add(fn);
  ensureChannel();
  return () => {
    sessionsListeners?.delete(fn);
    maybeClose();
  };
}

/**
 * 订阅 relay 状态。返回取消订阅函数。
 * 订阅瞬间若有缓存帧会立即回调一次（无需等下一次变更）。
 */
export function subscribeRelayStatus(fn: RelayListener): () => void {
  if (!relayListeners) relayListeners = new Set();
  relayListeners.add(fn);
  ensureChannel();
  // 立即回放最近一帧，让新订阅者拿到当前状态
  if (lastRelayStatus) {
    try {
      fn(lastRelayStatus);
    } catch {
      // 忽略
    }
  }
  return () => {
    relayListeners?.delete(fn);
    maybeClose();
  };
}
