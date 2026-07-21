/**
 * 进行中的 query 集中管理：sessionId → AbortController
 * 用于 abort 路由能找到并取消正在跑的会话
 */
const inflight = new Map<string, AbortController>();

export function setInflight(sessionId: string, ctrl: AbortController): void {
  // 如果之前有挂着的，先 abort（理论上不应该）
  const old = inflight.get(sessionId);
  if (old && !old.signal.aborted) old.abort();
  inflight.set(sessionId, ctrl);
}

export function clearInflight(sessionId: string): void {
  inflight.delete(sessionId);
}

export function getInflight(sessionId: string): AbortController | undefined {
  return inflight.get(sessionId);
}
