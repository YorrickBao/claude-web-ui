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

  return { sessions, loading, error, refresh };
}
