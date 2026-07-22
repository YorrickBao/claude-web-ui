import { clsx } from "clsx";
import { NavLink, useNavigate, useLocation } from "react-router-dom";
import {
  Plus,
  MessageSquare,
  RefreshCw,
  Settings,
  Trash2,
  Menu,
  X,
  Import,
} from "lucide-react";
import { useState, useEffect } from "react";
import { useSessions } from "@/hooks/useSessions";
import { ProfileManagerModal } from "@/components/ProfileManagerModal";
import { ImportClaudeSessionsDialog } from "@/components/ImportClaudeSessionsDialog";
import { deleteSessionApi, scanClaudeSessions } from "@/lib/api";
import type { SessionView } from "@/lib/types";

export function Sidebar() {
  const { sessions, loading, error, refresh } = useSessions();
  const navigate = useNavigate();
  const location = useLocation();
  const [envOpen, setEnvOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  // 移动端：默认收起，桌面端：默认展开
  useEffect(() => {
    const isMobile = window.innerWidth < 768;
    setIsCollapsed(isMobile);
  }, []);

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

  async function handleImportClaudeSessions() {
    setImporting(true);
    setImportError(null);
    try {
      const imported = await scanClaudeSessions();
      if (imported.length === 0) {
        alert("未找到历史会话");
      } else {
        alert(`成功导入 ${imported.length} 个会话`);
        setImportOpen(false);
        await refresh();
      }
    } catch (err) {
      setImportError((err as Error).message);
      alert(`导入失败：${(err as Error).message}`);
    } finally {
      setImporting(false);
    }
  }

  return (
    <aside
      className={clsx(
        "flex flex-col border-r border-neutral-800 bg-neutral-950 transition-all duration-300",
        isCollapsed ? "w-16" : "w-64"
      )}
    >
      <div className="flex items-center justify-between px-3 py-3">
        <span
          className={clsx(
            "text-sm font-semibold text-neutral-200 transition-opacity",
            isCollapsed ? "opacity-0 w-0 overflow-hidden" : "opacity-100"
          )}
        >
          Claude WebUI
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={refresh}
            className="rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300"
            title="刷新"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => setIsCollapsed(!isCollapsed)}
            className="rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300"
            title={isCollapsed ? "展开菜单" : "收起菜单"}
          >
            {isCollapsed ? <Menu className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>

      <div className="px-2">
        <button
          onClick={() => navigate("/new")}
          className={clsx(
            "flex w-full items-center gap-2 rounded-lg border border-neutral-700 px-3 py-2 text-sm text-neutral-200 hover:bg-neutral-800",
            isCollapsed && "justify-center px-2"
          )}
        >
          {!isCollapsed && <Plus className="h-4 w-4" />}
          {!isCollapsed && "新建会话"}
        </button>
        <button
          onClick={() => setImportOpen(true)}
          className={clsx(
            "mt-2 flex w-full items-center gap-2 rounded-lg border border-neutral-700 px-3 py-2 text-sm text-neutral-200 hover:bg-neutral-800",
            isCollapsed && "justify-center px-2"
          )}
        >
          {!isCollapsed && <Import className="h-4 w-4" />}
          {!isCollapsed && "导入历史会话"}
        </button>
      </div>

      <div className="mt-3 flex-1 overflow-y-auto px-2 pb-2">
        <div className={clsx(
          "mb-1 px-2 text-xs font-medium uppercase tracking-wide text-neutral-600",
          isCollapsed && "hidden"
        )}>
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
                    isCollapsed && "justify-center px-2"
                  )
                }
              >
                <MessageSquare className={clsx(
                  "mt-0.5 h-3.5 w-3.5 shrink-0 text-neutral-500",
                  isCollapsed && "hidden"
                )} />
                <div className={clsx(
                  "min-w-0 flex-1",
                  isCollapsed && "hidden"
                )}>
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
                  className={clsx(
                    "shrink-0 rounded p-0.5 text-neutral-600 opacity-0 transition-opacity hover:bg-neutral-700 hover:text-red-400 group-hover:opacity-100 disabled:opacity-50",
                    isCollapsed && "hidden"
                  )}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </NavLink>
            </li>
          ))}
        </ul>
      </div>

      <div className={clsx(
        "border-t border-neutral-800 px-2 py-2",
        isCollapsed && "px-1"
      )}>
        <button
          onClick={() => setEnvOpen(true)}
          className={clsx(
            "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-neutral-300 hover:bg-neutral-800",
            isCollapsed && "justify-center px-1"
          )}
        >
          <Settings className="h-3.5 w-3.5" />
          {!isCollapsed && "配置管理"}
        </button>
        {!isCollapsed && (
          <div className="mt-1 px-2 text-[10px] text-neutral-600">
            bypassPermissions 模式 · 仅本地
          </div>
        )}
      </div>

      <ProfileManagerModal
        open={envOpen}
        onClose={() => setEnvOpen(false)}
        onChanged={refresh}
      />

      {/* 导入历史会话对话框 */}
      {importOpen && (
        <ImportClaudeSessionsDialog
          open={importOpen}
          onClose={() => setImportOpen(false)}
          onImport={handleImportClaudeSessions}
          importing={importing}
          importError={importError}
        />
      )}
    </aside>
  );
}
