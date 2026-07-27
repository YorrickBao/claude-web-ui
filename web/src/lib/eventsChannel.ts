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
 * 断线重连，但默认无任何可观测性——这里额外监听 onerror/onopen，把连接健康状态
 * 暴露出去（订阅者可据此显示"实时连接已断开"提示），并在重连成功时重发一帧
 * sessions_changed 以补齐断线期间错过的列表变更。
 */

import type { RelayStatusSnapshot, DeviceEntry } from "./types";

type SessionsListener = () => void;
type RelayListener = (status: RelayStatusSnapshot) => void;
type LifecycleListener = (sessionId: string) => void;
type DevicesListener = (devices: DeviceEntry[]) => void;
/** 总线连接健康状态：connected 正常 / reconnecting 自动重连中 */
type BusHealth = "connected" | "reconnecting";
type BusHealthListener = (health: BusHealth) => void;

let sessionsListeners: Set<SessionsListener> | null = null;
let relayListeners: Set<RelayListener> | null = null;
let lifecycleStartedListeners: Set<LifecycleListener> | null = null;
let lifecycleEndedListeners: Set<LifecycleListener> | null = null;
let devicesListeners: Set<DevicesListener> | null = null;
let busHealthListeners: Set<BusHealthListener> | null = null;
let es: EventSource | null = null;
/** 最近一帧 relay 状态，新订阅者立即可用，避免等下一次变更 */
let lastRelayStatus: RelayStatusSnapshot | null = null;
/** 最近一帧设备列表，新订阅者立即可用 */
let lastDevices: DeviceEntry[] | null = null;
/** 当前总线健康状态，新订阅者立即可用 */
let busHealth: BusHealth = "connected";

function hasSubscribers(): boolean {
  return (
    !!sessionsListeners?.size ||
    !!relayListeners?.size ||
    !!lifecycleStartedListeners?.size ||
    !!lifecycleEndedListeners?.size ||
    !!devicesListeners?.size ||
    !!busHealthListeners?.size
  );
}

function notifyBusHealth(health: BusHealth): void {
  if (busHealth === health) return; // 仅在状态变化时通知，避免 onerror 抖动反复刷
  busHealth = health;
  if (!busHealthListeners) return;
  for (const fn of [...busHealthListeners]) {
    try {
      fn(health);
    } catch {
      // 忽略单个订阅者错误
    }
  }
}

function ensureChannel(): void {
  if (es) return;
  busHealth = "connected";
  es = new EventSource("api/events/stream");
  es.addEventListener("open", () => {
    // 重连成功：补齐断线期间可能错过的 sessions_changed（拉一次最新列表），
    // 并把健康状态切回 connected（订阅者据此隐藏"实时连接已断开"提示）。
    notifyBusHealth("connected");
    if (sessionsListeners) {
      for (const fn of [...sessionsListeners]) {
        try {
          fn();
        } catch {
          // 忽略
        }
      }
    }
  });
  es.addEventListener("error", () => {
    // EventSource 进入 CONNECTING 态自动重连，readyState===0 即重连中。
    // 通知订阅者显示"重连中"提示；真正恢复由 open 事件处理。
    if (es && es.readyState === EventSource.CONNECTING) {
      notifyBusHealth("reconnecting");
    } else if (es && es.readyState === EventSource.CLOSED) {
      // CLOSED 不会自动恢复（理论上不该发生，maybeClose 之外没人 close）。
      // 兜底：清掉 es 以便下次 ensureChannel 重建。
      es = null;
      notifyBusHealth("reconnecting");
    }
  });
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
  // 会话查询开始：通知观察方窗口接入实时流
  es.addEventListener("session_started", (ev) => {
    let sid: string | null = null;
    try {
      sid = (JSON.parse((ev as MessageEvent).data) as { sessionId: string }).sessionId;
    } catch {
      return;
    }
    if (!lifecycleStartedListeners) return;
    for (const fn of [...lifecycleStartedListeners]) {
      try {
        fn(sid);
      } catch {
        // 忽略单个订阅者错误
      }
    }
  });
  // 会话查询结束
  es.addEventListener("session_ended", (ev) => {
    let sid: string | null = null;
    try {
      sid = (JSON.parse((ev as MessageEvent).data) as { sessionId: string }).sessionId;
    } catch {
      return;
    }
    if (!lifecycleEndedListeners) return;
    for (const fn of [...lifecycleEndedListeners]) {
      try {
        fn(sid);
      } catch {
        // 忽略单个订阅者错误
      }
    }
  });
  // 远程设备列表变更
  es.addEventListener("device_changed", (ev) => {
    let devices: DeviceEntry[] | null = null;
    try {
      devices = (JSON.parse((ev as MessageEvent).data) as { devices: DeviceEntry[] }).devices;
      lastDevices = devices;
    } catch {
      return;
    }
    if (!devicesListeners) return;
    for (const fn of [...devicesListeners]) {
      try {
        fn(devices);
      } catch {
        // 忽略单个订阅者错误
      }
    }
  });
}

function maybeClose(): void {
  if (!hasSubscribers() && es) {
    es.close();
    es = null;
    busHealth = "connected"; // 下次建立即视为正常
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

/**
 * 订阅 session_started 信号（某会话查询开始）。返回取消订阅函数。
 * 用于驱动观察方窗口接入实时流。
 */
export function subscribeSessionStarted(fn: LifecycleListener): () => void {
  if (!lifecycleStartedListeners) lifecycleStartedListeners = new Set();
  lifecycleStartedListeners.add(fn);
  ensureChannel();
  return () => {
    lifecycleStartedListeners?.delete(fn);
    maybeClose();
  };
}

/**
 * 订阅 session_ended 信号（某会话查询结束）。返回取消订阅函数。
 */
export function subscribeSessionEnded(fn: LifecycleListener): () => void {
  if (!lifecycleEndedListeners) lifecycleEndedListeners = new Set();
  lifecycleEndedListeners.add(fn);
  ensureChannel();
  return () => {
    lifecycleEndedListeners?.delete(fn);
    maybeClose();
  };
}

/**
 * 订阅远程设备列表变更（设备上下线）。返回取消订阅函数。
 * 订阅瞬间若有缓存帧会立即回调一次（无需等下一次变更）。
 */
export function subscribeDeviceChanged(fn: DevicesListener): () => void {
  if (!devicesListeners) devicesListeners = new Set();
  devicesListeners.add(fn);
  ensureChannel();
  // 立即回放最近一帧，让新订阅者拿到当前列表
  if (lastDevices) {
    try {
      fn(lastDevices);
    } catch {
      // 忽略
    }
  }
  return () => {
    devicesListeners?.delete(fn);
    maybeClose();
  };
}

/**
 * 订阅全局总线的连接健康状态。返回取消订阅函数。
 * 订阅瞬间立即回调一次当前状态（connected / reconnecting），
 * 便于订阅者初始化 UI。状态仅在实际变化时再次回调。
 */
export function subscribeBusHealth(fn: BusHealthListener): () => void {
  if (!busHealthListeners) busHealthListeners = new Set();
  busHealthListeners.add(fn);
  ensureChannel();
  // 立即回放当前状态
  try {
    fn(busHealth);
  } catch {
    // 忽略
  }
  return () => {
    busHealthListeners?.delete(fn);
    maybeClose();
  };
}
