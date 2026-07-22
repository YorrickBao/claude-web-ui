/**
 * 进行中的 query 集中管理：sessionId → { ctrl, status }
 * 用于 abort 路由能找到并取消正在跑的会话，
 * 以及 /api/sessions 返回运行状态（idle / running / waiting）。
 */

export type InflightStatus = "running" | "waiting";

interface InflightEntry {
  ctrl: AbortController;
  status: InflightStatus;
}

const inflight = new Map<string, InflightEntry>();

export function setInflight(sessionId: string, ctrl: AbortController): void {
  // 如果之前有挂着的，先 abort（理论上不应该）
  const old = inflight.get(sessionId);
  if (old && !old.ctrl.signal.aborted) old.ctrl.abort();
  inflight.set(sessionId, { ctrl, status: "running" });
}

export function setInflightWaiting(sessionId: string): void {
  const entry = inflight.get(sessionId);
  if (entry) {
    entry.status = "waiting";
  }
}

export function setInflightRunning(sessionId: string): void {
  const entry = inflight.get(sessionId);
  if (entry) {
    entry.status = "running";
  }
}

export function clearInflight(sessionId: string): void {
  inflight.delete(sessionId);
}

export function getInflight(sessionId: string): AbortController | undefined {
  return inflight.get(sessionId)?.ctrl;
}

export function getInflightStatus(sessionId: string): InflightStatus | undefined {
  return inflight.get(sessionId)?.status;
}
