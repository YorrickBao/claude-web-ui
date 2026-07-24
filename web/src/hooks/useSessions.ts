import { useCallback, useEffect, useState } from "react";
import { listSessions } from "@/lib/api";
import { subscribeSessionsChanged } from "@/lib/sessionsChannel";
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

  // 订阅 sessions_changed（全局单例 SSE 频道，跨组件共享一条连接）。
  // 收到信号后自行 GET /api/sessions 拉最新列表。替代原先的 2 秒短轮询。
  useEffect(() => {
    return subscribeSessionsChanged(() => void refresh());
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
