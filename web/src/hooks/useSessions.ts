import { useCallback, useEffect, useState } from "react";
import { listSessions } from "@/lib/api";
import type { SessionView } from "@/lib/types";

export function useSessions() {
  const [sessions, setSessions] = useState<SessionView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const data = await listSessions();
      setSessions(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // 订阅 sessions-changed SSE 推送：后端在新建/删除/状态流转/结束时发信号，
  // 收到后自行 GET /api/sessions 拉最新列表。EventSource 自动重连。
  // 替代原先的 2 秒短轮询。
  useEffect(() => {
    const es = new EventSource("api/sessions/stream");
    es.addEventListener("sessions_changed", () => void refresh());
    return () => es.close();
  }, [refresh]);

  // 监听其它组件发出的"会话列表变更"通知（兼容旧路径）
  useEffect(() => {
    const handler = () => void refresh();
    window.addEventListener("session-list-changed", handler);
    return () => window.removeEventListener("session-list-changed", handler);
  }, [refresh]);

  // 页面重新获得焦点时自动刷新，同步 CLI 侧可能的新增/删除
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refresh]);

  return { sessions, loading, error, refresh };
}
