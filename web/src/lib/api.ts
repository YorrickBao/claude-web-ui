import type { BrowseResult, SessionView } from "@/lib/types";

/** 列出所有会话 */
export async function listSessions(): Promise<SessionView[]> {
  const res = await fetch("/api/sessions");
  if (!res.ok) throw new Error(`listSessions: ${res.status}`);
  const data = (await res.json()) as { sessions: SessionView[] };
  return data.sessions;
}

/** 单个会话详情（含元信息） */
export async function getSession(
  id: string,
): Promise<SessionView & { messages: unknown[] }> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`getSession: ${res.status}`);
  return res.json() as Promise<SessionView & { messages: unknown[] }>;
}

/** 中止进行中的会话 */
export async function abortSession(id: string): Promise<void> {
  await fetch(`/api/sessions/${encodeURIComponent(id)}/abort`, {
    method: "POST",
  });
}

/** 删除会话（CLI 转录文件 + sessions.json 记录 + 中止进行中的） */
export async function deleteSessionApi(id: string): Promise<void> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`deleteSession: ${res.status}`);
  }
}

/** 更新会话标题 */
export async function updateSessionTitle(
  sessionId: string,
  title: string | null,
): Promise<void> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/title`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) throw new Error(`updateSessionTitle: ${res.status}`);
  await res.json();
}

import type { SlashCommand } from "@/lib/types";

/** 获取当前项目可用的斜杠命令列表（前端缓存，5 分钟内不重复请求） */
export async function fetchSlashCommands(cwd: string): Promise<SlashCommand[]> {
  const res = await fetch(`/api/slash-commands?cwd=${encodeURIComponent(cwd)}`);
  if (!res.ok) return [];
  const data = (await res.json()) as { commands: SlashCommand[] };
  return data.commands;
}

/** 列目录 */
export async function browse(path: string): Promise<BrowseResult> {
  const res = await fetch(
    `/api/browse?path=${encodeURIComponent(path)}`,
  );
  if (!res.ok) throw new Error(`browse: ${res.status}`);
  return res.json() as Promise<BrowseResult>;
}

/**
 * 发消息到已有会话。返回 SSE Response（已建好流），
 * 调用方用 parseSSE 解析。
 */
export function sendMessage(
  sessionId: string,
  message: string,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(`/api/sessions/${encodeURIComponent(id(sessionId))}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
    signal,
  });
}

/**
 * 新建会话并发首条消息。返回 SSE Response。
 * 后端会在 session_created 事件里给出真正的 sessionId。
 */
export function createSession(
  cwd: string,
  message: string,
  opts: { title?: string; profileId?: string | null; permissionMode?: string; effortLevel?: string; clientId?: string } = {},
  signal?: AbortSignal,
): Promise<Response> {
  return fetch("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      cwd,
      message,
      title: opts.title,
      profileId: opts.profileId ?? null,
      permissionMode: opts.permissionMode ?? "default",
      effortLevel: opts.effortLevel ?? "default",
      clientId: opts.clientId,
    }),
    signal,
  });
}

/**
 * 凭 clientId 反查 sessionId（带重试退避）。
 *
 * 用于「新建会话」时 session_created 事件尚未送达前端连接就断开的竞态：
 * 后端可能还在 register 中（sessionId 尚未登记），此处每 500ms 重试，
 * 最多 ~8 秒。返回 sessionId 或 undefined（彻底找不到）。
 */
export async function resolveSessionByClient(
  clientId: string,
  opts: { intervalMs?: number; maxAttempts?: number } = {},
): Promise<string | undefined> {
  const intervalMs = opts.intervalMs ?? 500;
  const maxAttempts = opts.maxAttempts ?? 16; // 16 * 500ms = 8s
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(
        `/api/sessions/by-client/${encodeURIComponent(clientId)}`,
      );
      if (res.ok) {
        const data = (await res.json()) as { sessionId: string };
        return data.sessionId;
      }
      // 404 表示后端尚未登记，继续重试
    } catch {
      // 网络抖动，继续重试
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return undefined;
}

// encode URI component 一次的轻包装，避免重复编码
function id(s: string): string {
  return encodeURIComponent(s);
}

// ─────────────────────────────────────────────────────────────
// profiles（环境变量配置）+ 会话绑定
// ─────────────────────────────────────────────────────────────

import type { EnvProfile } from "@/lib/types";

export async function listProfiles(): Promise<EnvProfile[]> {
  const res = await fetch("/api/profiles");
  if (!res.ok) throw new Error(`listProfiles: ${res.status}`);
  const data = (await res.json()) as { profiles: EnvProfile[] };
  return data.profiles;
}

export async function createProfile(
  name: string,
  env: Record<string, string>,
): Promise<EnvProfile> {
  const res = await fetch("/api/profiles", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, env }),
  });
  if (!res.ok) throw new Error(`createProfile: ${res.status}`);
  const data = (await res.json()) as { profile: EnvProfile };
  return data.profile;
}

export async function updateProfile(
  profileId: string,
  patch: { name?: string; env?: Record<string, string> },
): Promise<EnvProfile> {
  const res = await fetch(`/api/profiles/${id(profileId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`updateProfile: ${res.status}`);
  const data = (await res.json()) as { profile: EnvProfile };
  return data.profile;
}

export async function deleteProfile(profileId: string): Promise<void> {
  const res = await fetch(`/api/profiles/${id(profileId)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`deleteProfile: ${res.status}`);
}

/** 切换会话绑定的 profile（null = 解绑，纯 CLI 默认） */
export async function setSessionProfile(
  sessionId: string,
  profileId: string | null,
): Promise<void> {
  const res = await fetch(`/api/sessions/${id(sessionId)}/profile`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profileId }),
  });
  if (!res.ok) throw new Error(`setSessionProfile: ${res.status}`);
}

/** 切换会话的权限模式 */
export async function setSessionPermissionMode(
  sessionId: string,
  permissionMode: string,
): Promise<void> {
  const res = await fetch(`/api/sessions/${id(sessionId)}/permission-mode`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ permissionMode }),
  });
  if (!res.ok) throw new Error(`setSessionPermissionMode: ${res.status}`);
}

/** 切换会话的思考级别 */
export async function setSessionThinkingLevel(
  sessionId: string,
  effortLevel: string,
): Promise<void> {
  const res = await fetch(`/api/sessions/${id(sessionId)}/thinking-level`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ effortLevel }),
  });
  if (!res.ok) throw new Error(`setSessionThinkingLevel: ${res.status}`);
}

/** 响应权限请求：批准或拒绝某个工具调用 */
export async function respondToPermission(
  sessionId: string,
  requestId: string,
  behavior: "allow" | "deny",
  message?: string,
  /** allow 时若 remember=true，则附带 updatedPermissions 让 SDK 记住决定 */
  updatedPermissions?: Array<{
    type: "add";
    toolName: string;
    permission: "allow";
    destination: "session";
  }>,
): Promise<void> {
  const res = await fetch(
    `/api/sessions/${id(sessionId)}/permission-response`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId, behavior, message, updatedPermissions }),
    },
  );
  if (!res.ok) throw new Error(`respondToPermission: ${res.status}`);
}

/**
 * 审批计划：批准后返回新的 SSE Response。
 * 调用方用 parseSSE 解析，延续当前消息流。
 */
export function approvePlan(
  sessionId: string,
  action: "approve" | "reject",
  opts: { editedPlan?: string; prompt?: string } = {},
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(`/api/sessions/${id(sessionId)}/approve-plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action,
      editedPlan: opts.editedPlan,
      prompt: opts.prompt,
    }),
    signal,
  });
}
