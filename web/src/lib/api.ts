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
  return res.json();
}

/** 中止进行中的会话 */
export async function abortSession(id: string): Promise<void> {
  await fetch(`/api/sessions/${encodeURIComponent(id)}/abort`, {
    method: "POST",
  });
}

/** 列目录 */
export async function browse(path: string): Promise<BrowseResult> {
  const res = await fetch(
    `/api/browse?path=${encodeURIComponent(path)}`,
  );
  if (!res.ok) throw new Error(`browse: ${res.status}`);
  return res.json();
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
  opts: { title?: string } = {},
  signal?: AbortSignal,
): Promise<Response> {
  return fetch("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, message, title: opts.title }),
    signal,
  });
}

// encode URI component 一次的轻包装，避免重复编码
function id(s: string): string {
  return encodeURIComponent(s);
}
