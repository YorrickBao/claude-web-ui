/**
 * 进行中的 query 集中管理：sessionId → { ctrl, status }
 * 用于 abort 路由能找到并取消正在跑的会话，
 * 以及 /api/sessions 返回运行状态（idle / running / waiting）。
 *
 * 同时管理待审批的权限请求：requestId → { resolve, ... }
 * 让 PermissionRequest hook 能等待前端用户响应。
 */

import { emitSessionEvent } from "./eventBus.js";

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

/**
 * 清理 inflight 记录。
 *
 * @param sessionId 会话 ID
 * @param ctrl      可选：仅当 inflight 中存储的 AbortController === ctrl 时才清除。
 *                  不传则强制清除（DELETE 路由等场景）。
 */
export function clearInflight(sessionId: string, ctrl?: AbortController): void {
  if (ctrl) {
    const entry = inflight.get(sessionId);
    // 只有当控制器匹配时才清除 —— 防止旧请求的 finally 误删新请求的 inflight
    if (!entry || entry.ctrl !== ctrl) return;
  }
  // 清理该会话所有 pending permissions
  clearPendingPermissions(sessionId);
  inflight.delete(sessionId);
}

export function getInflight(sessionId: string): AbortController | undefined {
  return inflight.get(sessionId)?.ctrl;
}

export function getInflightStatus(sessionId: string): InflightStatus | undefined {
  return inflight.get(sessionId)?.status;
}

// ─────────────────────────────────────────────────────────────
// Pending Permission Request Registry
// ─────────────────────────────────────────────────────────────

export interface PermissionDecision {
  behavior: "allow" | "deny";
  message?: string;
  updatedInput?: Record<string, unknown>;
  updatedPermissions?: Array<{
    type: "add";
    toolName: string;
    permission: "allow";
    destination: "session";
  }>;
}

interface PendingPermissionEntry {
  resolve: (result: PermissionDecision) => void;
  sessionId: string;
  toolName: string;
  toolInput: unknown;
  decisionReason?: string;
}

/** 返回给重连客户端的待审批请求快照（不含 resolve 回调） */
export interface PendingPermissionSnapshot {
  requestId: string;
  toolName: string;
  toolInput: unknown;
  decisionReason?: string;
}

const pendingPermissions = new Map<string, PendingPermissionEntry>();

/**
 * 创建一个待审批的权限请求。
 * 返回 requestId（用于 EventBus 通知前端）和 promise（hook 内部 await）。
 */
export function createPendingPermission(
  sessionId: string,
  toolName: string,
  toolInput: unknown,
  decisionReason?: string,
): { requestId: string; promise: Promise<PermissionDecision> } {
  const requestId = `perm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  let resolveRef: ((result: PermissionDecision) => void) | undefined;
  let settled = false;

  // 5 分钟超时：防止前端断连或 bug 导致 hook 永久阻塞
  const TIMEOUT_MS = 5 * 60 * 1000;
  const timeoutId = setTimeout(() => {
    if (settled) return;
    settled = true;
    // 通知前端清除横幅（reason=timeout），再 resolve 让 hook 解除阻塞
    emitSessionEvent(sessionId, {
      type: "permission_resolved",
      requestId,
      reason: "timeout",
    });
    resolveRef?.({ behavior: "deny", message: "Permission request timed out" });
    pendingPermissions.delete(requestId);
  }, TIMEOUT_MS);

  const promise = new Promise<PermissionDecision>((resolve) => {
    resolveRef = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      resolve(result);
    };
  });

  pendingPermissions.set(requestId, {
    resolve: resolveRef!,
    sessionId,
    toolName,
    toolInput,
    decisionReason,
  });
  return { requestId, promise };
}

/** 按 requestId 查找并移除 pending permission */
export function takePendingPermission(requestId: string): PendingPermissionEntry | undefined {
  const entry = pendingPermissions.get(requestId);
  if (entry) pendingPermissions.delete(requestId);
  return entry;
}

/** 查询某个会话当前所有待审批请求（只读快照，供重连补播） */
export function getPendingPermissions(sessionId: string): PendingPermissionSnapshot[] {
  const result: PendingPermissionSnapshot[] = [];
  for (const [requestId, entry] of pendingPermissions) {
    if (entry.sessionId === sessionId) {
      result.push({
        requestId,
        toolName: entry.toolName,
        toolInput: entry.toolInput,
        decisionReason: entry.decisionReason,
      });
    }
  }
  return result;
}

/** 清理某个会话的所有 pending permissions（abort / 会话结束） */
export function clearPendingPermissions(sessionId: string): void {
  for (const [id, entry] of pendingPermissions) {
    if (entry.sessionId === sessionId) {
      // 通知前端清除横幅（reason=aborted），再拒绝 pending 请求
      emitSessionEvent(sessionId, {
        type: "permission_resolved",
        requestId: id,
        reason: "aborted",
      });
      entry.resolve({ behavior: "deny", message: "Session aborted or ended" });
      pendingPermissions.delete(id);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Client → Session 瞬态映射
// 用于「新建会话」路由在 session_created 尚未送达前端时连接断开的竞态：
// 前端凭 clientId 反查真实 sessionId，重新 subscribe 续流。
// 纯内存：服务器重启则查询本就消亡，无需持久化。
// ─────────────────────────────────────────────────────────────

const CLIENT_SESSION_TTL_MS = 10 * 60 * 1000; // 10 分钟，覆盖查询生命周期

interface ClientSessionEntry {
  sessionId: string;
  expires: number;
}

const clientSessionMap = new Map<string, ClientSessionEntry>();

/** 记录 clientId → sessionId 映射（可重复调用覆盖，刷新 expires） */
export function rememberClientSession(clientId: string, sessionId: string): void {
  if (!clientId) return;
  clientSessionMap.set(clientId, {
    sessionId,
    expires: Date.now() + CLIENT_SESSION_TTL_MS,
  });
}

/** 按 clientId 查询 sessionId。过期返回 undefined 并清理。 */
export function resolveClientSession(clientId: string): string | undefined {
  const entry = clientSessionMap.get(clientId);
  if (!entry) return undefined;
  if (entry.expires < Date.now()) {
    clientSessionMap.delete(clientId);
    return undefined;
  }
  return entry.sessionId;
}
