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

  // 监听其它组件发出的"会话列表变更"通知（新会话创建后）
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
