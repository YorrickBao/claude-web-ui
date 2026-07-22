import { clsx } from "clsx";
import { NavLink, useNavigate, useLocation } from "react-router-dom";
import {
  Plus,
  MessageSquare,
  RefreshCw,
  Settings,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { useSessions } from "@/hooks/useSessions";
import { ProfileManagerModal } from "@/components/ProfileManagerModal";
import { deleteSessionApi } from "@/lib/api";
import type { SessionView } from "@/lib/types";

export function Sidebar() {
  const { sessions, loading, error, refresh } = useSessions();
  const navigate = useNavigate();
  const location = useLocation();
  const [envOpen, setEnvOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function handleDelete(s: SessionView, e: React.MouseEvent) {
    // 阻止 NavLink 跳转
    e.preventDefault();
    e.stopPropagation();
    if (!confirm(`确定删除会话「${s.title}」？\n\n此操作会同时删除 SDK 历史记录，不可恢复。`)) {
      return;
    }
    setDeletingId(s.sessionId);
    try {
      await deleteSessionApi(s.sessionId);
      // 如果删的是当前正在看的会话，跳回 /new
      if (location.pathname === `/c/${s.sessionId}`) {
        navigate("/new");
      }
      await refresh();
    } catch (err) {
      alert(`删除失败：${(err as Error).message}`);
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-neutral-800 bg-neutral-950">
      <div className="flex items-center justify-between px-3 py-3">
        <span className="text-sm font-semibold text-neutral-200">
          Claude WebUI
        </span>
        <button
          onClick={refresh}
          className="rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300"
          title="刷新"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="px-2">
        <button
          onClick={() => navigate("/new")}
          className="flex w-full items-center gap-2 rounded-lg border border-neutral-700 px-3 py-2 text-sm text-neutral-200 hover:bg-neutral-800"
        >
          <Plus className="h-4 w-4" />
          新建会话
        </button>
      </div>

      <div className="mt-3 flex-1 overflow-y-auto px-2 pb-2">
        <div className="mb-1 px-2 text-xs font-medium uppercase tracking-wide text-neutral-600">
          历史
        </div>
        {loading && (
          <div className="px-2 py-2 text-sm text-neutral-500">加载中…</div>
        )}
        {error && (
          <div className="px-2 py-2 text-sm text-red-400">⚠ {error}</div>
        )}
        {!loading && sessions.length === 0 && (
          <div className="px-2 py-2 text-sm text-neutral-600">暂无会话</div>
        )}
        <ul className="space-y-0.5">
          {sessions.map((s) => (
            <li key={s.sessionId}>
              <NavLink
                to={`/c/${s.sessionId}`}
                className={({ isActive }) =>
                  clsx(
                    "group flex items-start gap-2 rounded-lg px-2 py-2 text-sm",
                    isActive
                      ? "bg-neutral-800 text-neutral-100"
                      : "text-neutral-300 hover:bg-neutral-900",
                  )
                }
              >
                <MessageSquare className="mt-0.5 h-3.5 w-3.5 shrink-0 text-neutral-500" />
                <div className="min-w-0 flex-1">
                  <div className="truncate">{s.title}</div>
                  <div
                    className="truncate text-xs text-neutral-600"
                    title={s.cwd}
                  >
                    {s.cwd}
                  </div>
                </div>
                <button
                  onClick={(e) => void handleDelete(s, e)}
                  disabled={deletingId === s.sessionId}
                  title="删除会话"
                  className="shrink-0 rounded p-0.5 text-neutral-600 opacity-0 transition-opacity hover:bg-neutral-700 hover:text-red-400 group-hover:opacity-100 disabled:opacity-50"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </NavLink>
            </li>
          ))}
        </ul>
      </div>

      <div className="border-t border-neutral-800 px-2 py-2">
        <button
          onClick={() => setEnvOpen(true)}
          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-neutral-300 hover:bg-neutral-800"
        >
          <Settings className="h-3.5 w-3.5" />
          配置管理
        </button>
        <div className="mt-1 px-2 text-[10px] text-neutral-600">
          bypassPermissions 模式 · 仅本地
        </div>
      </div>

      <ProfileManagerModal
        open={envOpen}
        onClose={() => setEnvOpen(false)}
        onChanged={refresh}
      />
    </aside>
  );
}
