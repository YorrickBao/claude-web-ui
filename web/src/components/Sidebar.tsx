import { clsx } from "clsx";
import { NavLink, useNavigate } from "react-router-dom";
import { Plus, MessageSquare, RefreshCw, Settings } from "lucide-react";
import { useState } from "react";
import { useSessions } from "@/hooks/useSessions";
import { EnvSettingsModal } from "@/components/EnvSettingsModal";

export function Sidebar() {
  const { sessions, loading, error, refresh } = useSessions();
  const navigate = useNavigate();
  const [envOpen, setEnvOpen] = useState(false);

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
                    "flex items-start gap-2 rounded-lg px-2 py-2 text-sm",
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
          环境变量
        </button>
        <div className="mt-1 px-2 text-[10px] text-neutral-600">
          bypassPermissions 模式 · 仅本地
        </div>
      </div>

      <EnvSettingsModal
        open={envOpen}
        onClose={() => setEnvOpen(false)}
        scope="global"
      />
    </aside>
  );
}
