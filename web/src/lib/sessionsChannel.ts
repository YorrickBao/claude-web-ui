/**
 * sessions_changed 全局 SSE 频道（单例）。
 *
 * 后端 GET /api/sessions/stream 是一个无状态的全局通知频道：只推
 * "sessions_changed" 信号（无负载），客户端收到后自行拉取最新数据。
 *
 * 多个组件（Sidebar 的 useSessions、AppShell 的当前会话状态翻转）都要消费
 * 这个信号。若各自 new EventSource 会在每打开一个 /c/:id 页面时多建一条到
 * 后端的 SSE 连接，叠加远程链路（relay）放大抖动。
 *
 * 这里把频道收敛为模块级单例：全应用共享一条 EventSource，内部用 Set 维护
 * 订阅者。EventSource 自带断线重连，无需手动处理。
 */

type Listener = () => void;

let listeners: Set<Listener> | null = null;
let es: EventSource | null = null;

function ensureChannel(): Set<Listener> {
  if (!listeners) {
    listeners = new Set();
  }
  if (!es) {
    es = new EventSource("api/sessions/stream");
    es.addEventListener("sessions_changed", () => {
      // 复制一份再遍历：回调里可能 unsubscribe 改动集合
      for (const fn of [...listeners!]) {
        try {
          fn();
        } catch {
          // 单个订阅者出错不影响其他订阅者与频道本身
        }
      }
    });
  }
  return listeners;
}

/**
 * 订阅 sessions_changed 信号。返回取消订阅函数。
 * 首次订阅时建立 EventSource；最后一个订阅者退出时关闭并释放连接。
 */
export function subscribeSessionsChanged(fn: Listener): () => void {
  const set = ensureChannel();
  set.add(fn);
  return () => {
    set.delete(fn);
    // 无订阅者时关闭连接，避免空转（重新订阅会自动重建）
    if (set.size === 0 && es) {
      es.close();
      es = null;
    }
  };
}
