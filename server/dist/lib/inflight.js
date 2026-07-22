/**
 * 进行中的 query 集中管理：sessionId → { ctrl, status }
 * 用于 abort 路由能找到并取消正在跑的会话，
 * 以及 /api/sessions 返回运行状态（idle / running / waiting）。
 *
 * 同时管理待审批的权限请求：requestId → { resolve, ... }
 * 让 PermissionRequest hook 能等待前端用户响应。
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
    // 清理该会话所有 pending permissions
    clearPendingPermissions(sessionId);
    inflight.delete(sessionId);
}
export function getInflight(sessionId) {
    return inflight.get(sessionId)?.ctrl;
}
export function getInflightStatus(sessionId) {
    return inflight.get(sessionId)?.status;
}
const pendingPermissions = new Map();
/**
 * 创建一个待审批的权限请求。
 * 返回 requestId（用于 EventBus 通知前端）和 promise（hook 内部 await）。
 */
export function createPendingPermission(sessionId, toolName, toolInput) {
    let resolveRef;
    const promise = new Promise((resolve) => {
        resolveRef = resolve;
    });
    const requestId = `perm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    pendingPermissions.set(requestId, {
        resolve: resolveRef,
        sessionId,
        toolName,
        toolInput,
    });
    return { requestId, promise };
}
/** 按 requestId 查找并移除 pending permission */
export function takePendingPermission(requestId) {
    const entry = pendingPermissions.get(requestId);
    if (entry)
        pendingPermissions.delete(requestId);
    return entry;
}
/** 清理某个会话的所有 pending permissions（abort / 会话结束） */
export function clearPendingPermissions(sessionId) {
    for (const [id, entry] of pendingPermissions) {
        if (entry.sessionId === sessionId) {
            // 拒绝所有 pending 请求
            entry.resolve({ behavior: "deny", message: "Session aborted or ended" });
            pendingPermissions.delete(id);
        }
    }
}
