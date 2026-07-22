/**
 * 进行中的 query 集中管理：sessionId → { ctrl, status }
 * 用于 abort 路由能找到并取消正在跑的会话，
 * 以及 /api/sessions 返回运行状态（idle / running / waiting）。
 */
const inflight = new Map();
export function setInflight(sessionId, ctrl) {
    // 如果之前有挂着的，先 abort（理论上不应该）
    const old = inflight.get(sessionId);
    if (old && !old.ctrl.signal.aborted)
        old.ctrl.abort();
    inflight.set(sessionId, { ctrl, status: "running" });
}
export function setInflightWaiting(sessionId) {
    const entry = inflight.get(sessionId);
    if (entry) {
        entry.status = "waiting";
    }
}
export function setInflightRunning(sessionId) {
    const entry = inflight.get(sessionId);
    if (entry) {
        entry.status = "running";
    }
}
export function clearInflight(sessionId) {
    inflight.delete(sessionId);
}
export function getInflight(sessionId) {
    return inflight.get(sessionId)?.ctrl;
}
export function getInflightStatus(sessionId) {
    return inflight.get(sessionId)?.status;
}
