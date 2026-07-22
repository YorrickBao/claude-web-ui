import { cn } from "@/lib/utils";
import { NavLink, useNavigate, useLocation } from "react-router-dom";
import {
  Plus,
  MessageSquare,
  Settings,
  Trash2,
  PanelLeftClose,
  PanelLeftOpen,
  FoldHorizontal,
  Folder,
  FolderOpen,
  Sun,
  Moon,
} from "lucide-react";
import { useState, useEffect } from "react";
import { useTheme } from "next-themes";
import { useSessions } from "@/hooks/useSessions";
import { ProfileManagerModal } from "@/components/ProfileManagerModal";
import { listProfiles } from "@/lib/api";
import { deleteSessionApi } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import type { SessionView } from "@/lib/types";

/** 取路径的最后一个组件（目录名） */
function getDirName(path: string): string {
  return path.replace(/\/$/, "").split("/").pop() || path;
}

/** 按 cwd 分组，每组内按 lastModified 降序，组间按最新会话排序 */
function groupByCwd(sessions: SessionView[]): { cwd: string; sessions: SessionView[] }[] {
  const groups = new Map<string, SessionView[]>();
  for (const s of sessions) {
    const list = groups.get(s.cwd);
    if (list) {
      list.push(s);
    } else {
      groups.set(s.cwd, [s]);
    }
  }
  return Array.from(groups.entries())
    .map(([cwd, sessions]) => ({ cwd, sessions }))
    .sort((a, b) => {
      const aLatest = Math.max(...a.sessions.map((s) => s.lastModified));
      const bLatest = Math.max(...b.sessions.map((s) => s.lastModified));
      return bLatest - aLatest;
    });
}

interface SidebarProps {
  /** 侧栏宽度（px）。不传时使用 Tailwind 默认宽度 w-64 / w-16 */
  width?: number;
  /** 是否收起（受控）。不传时使用内部状态 */
  isCollapsed?: boolean;
  /** 切换收起回调 */
  onToggleCollapse?: () => void;
  /** 禁用过渡动画（拖拽中） */
  noTransition?: boolean;
}

export function Sidebar({ width, isCollapsed: controlledCollapsed, onToggleCollapse, noTransition }: SidebarProps = {}) {
  const { sessions, loading, error, refresh } = useSessions();
  const { theme, setTheme } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();
  const [envOpen, setEnvOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [internalCollapsed, setInternalCollapsed] = useState(false);
  const isCollapsed = controlledCollapsed !== undefined ? controlledCollapsed : internalCollapsed;
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [firstProfileId, setFirstProfileId] = useState<string | null>(null);

  function toggleGroup(cwd: string) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(cwd)) {
        next.delete(cwd);
      } else {
        next.add(cwd);
      }
      return next;
    });
  }

  function collapseAllGroups() {
    const groups = groupByCwd(sessions);
    if (groups.length === 0) return;
    setCollapsedGroups(new Set(groups.map((g) => g.cwd)));
  }

  // 移动端：默认收起，桌面端：默认展开（仅非受控模式生效）
  useEffect(() => {
    if (controlledCollapsed === undefined) {
      setInternalCollapsed(window.innerWidth < 768);
    }
  }, [controlledCollapsed]);

  // 加载第一个 profile 作为分组新建会话的默认选择
  useEffect(() => {
    listProfiles()
      .then((p) => setFirstProfileId(p[0]?.id ?? null))
      .catch(() => setFirstProfileId(null));
  }, []);

  async function handleDelete(s: SessionView, e: React.MouseEvent) {
    // 阻止 NavLink 跳转
    e.preventDefault();
    e.stopPropagation();
    if (!confirm(`确定删除会话「${s.title}」？\n\n此操作将同时删除 CLI 历史记录，不可恢复。`)) {
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
      toast.error(`删除失败：${(err as Error).message}`);
    } finally {
      setDeletingId(null);
    }
  }

  async function handleBatchDelete(sessions: SessionView[], groupDir: string) {
    if (!confirm(`确定删除目录「${getDirName(groupDir)}」下的所有会话（共 ${sessions.length} 个）？\n\n此操作将同时删除 CLI 历史记录，不可恢复。`)) {
      return;
    }
    for (const s of sessions) {
      try {
        await deleteSessionApi(s.sessionId);
        if (location.pathname === `/c/${s.sessionId}`) {
          navigate("/new");
        }
      } catch (err) {
        console.error(`删除会话 ${s.sessionId} 失败：`, err);
      }
    }
    await refresh();
  }

  return (
    <aside
      className={cn(
        "flex flex-col border-r border-border bg-background",
        width === undefined &&
          "transition-all duration-300",
        width === undefined && (isCollapsed ? "w-16" : "w-64")
      )}
      style={width !== undefined ? { width: `${width}px`, transition: noTransition ? "none" : undefined } : undefined}
    >
      <div className="flex items-center justify-between px-3 py-3">
        <span
          className={cn(
            "text-sm font-semibold text-foreground transition-opacity",
            isCollapsed ? "opacity-0 w-0 overflow-hidden" : "opacity-100"
          )}
        >
          Claude WebUI
        </span>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => {
              if (onToggleCollapse) onToggleCollapse();
              else setInternalCollapsed(!internalCollapsed);
            }}
            title={isCollapsed ? "展开菜单" : "收起菜单"}
          >
            {isCollapsed ? <PanelLeftOpen className="h-3.5 w-3.5" /> : <PanelLeftClose className="h-3.5 w-3.5" />}
          </Button>
        </div>
      </div>

      <div className="px-2">
        <Button
          variant="outline"
          onClick={() => navigate("/new")}
          className={cn(
            "flex w-full items-center gap-2 border-dashed hover:border-accent/50 hover:text-accent",
            isCollapsed && "justify-center px-2"
          )}
        >
          {!isCollapsed && <Plus className="h-4 w-4" />}
          {!isCollapsed && "新建会话"}
        </Button>
      </div>

      <div className="mt-3 flex-1 overflow-y-auto px-2 pb-2">
        <div className={cn(
          "mb-1 flex items-center justify-between px-2",
          isCollapsed && "hidden"
        )}>
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            历史
          </span>
          <Button
            variant="ghost"
            size="icon"
            onClick={collapseAllGroups}
            title="全部折叠"
          >
            <FoldHorizontal className="h-3 w-3" />
          </Button>
        </div>
        {loading && (
          <div className="flex flex-col gap-1 px-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full rounded-lg" />
            ))}
          </div>
        )}
        {error && (
          <div className="px-2 py-2 text-sm text-red-400">⚠ {error}</div>
        )}
        {!loading && sessions.length === 0 && (
          <div className="px-2 py-2 text-sm text-muted-foreground">暂无会话</div>
        )}
        {isCollapsed ? (
          /* 收起状态：平铺，只显示图标 */
          <ul className="space-y-0.5">
            {sessions.map((s) => (
              <li key={s.sessionId}>
                <NavLink
                  to={`/c/${s.sessionId}`}
                  className={({ isActive }) =>
                    cn(
                      "group flex items-start justify-center gap-2 rounded-lg px-2 py-2 text-sm transition-colors",
                      isActive
                        ? "bg-accent/10 text-foreground"
                        : "text-muted-foreground hover:bg-card"
                    )
                  }
                >
                  <MessageSquare className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                </NavLink>
              </li>
            ))}
          </ul>
        ) : (
          /* 展开状态：按 cwd 分组 */
          <div className="space-y-3">
            {groupByCwd(sessions).map((group) => {
              const isCollapsedGroup = collapsedGroups.has(group.cwd);
              return (
                  <div key={group.cwd} className="group/grp">
                  <div className="flex items-center gap-1.5 px-2">
                    <button
                      onClick={() => toggleGroup(group.cwd)}
                      className="flex min-w-0 flex-1 items-center gap-1.5 truncate rounded text-xs font-medium text-muted-foreground"
                      title={group.cwd}
                    >
                      {isCollapsedGroup ? (
                        <Folder className="h-3 w-3 shrink-0 text-muted-foreground" />
                      ) : (
                        <FolderOpen className="h-3 w-3 shrink-0 text-muted-foreground" />
                      )}
                      <span className="truncate">{getDirName(group.cwd)}</span>
                    </button>
                    <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                      {group.sessions.length}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => navigate("/pending", { state: { cwd: group.cwd, profileId: firstProfileId } })}
                      title="在此目录新建会话"
                      className="shrink-0 opacity-0 transition-opacity hover:text-accent group-hover/grp:opacity-100"
                    >
                      <Plus className="h-3 w-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleBatchDelete(group.sessions, group.cwd)}
                      title="批量删除"
                      className="shrink-0 opacity-0 transition-opacity hover:text-red-400 group-hover/grp:opacity-100"
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                  {!isCollapsedGroup && (
                    <ul className="mt-0.5 space-y-0.5 pl-5">
                      {group.sessions.map((s) => (
                        <li key={s.sessionId}>
                          <NavLink
                            to={`/c/${s.sessionId}`}
                            className={({ isActive }) =>
                              cn(
                                "group/item flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors",
                                isActive
                                  ? "bg-accent/10 text-foreground"
                                  : "text-foreground hover:bg-card"
                              )
                            }
                          >
                            <MessageSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                            <div className="min-w-0 flex-1">
                              <div className="truncate">{s.title}</div>
                            </div>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={(e) => void handleDelete(s, e)}
                              disabled={deletingId === s.sessionId}
                              title="删除会话"
                              className="shrink-0 opacity-0 transition-opacity hover:text-red-400 group-hover/item:opacity-100 disabled:opacity-50"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </NavLink>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className={cn(
        "border-t border-border px-2 py-2",
        isCollapsed && "px-1"
      )}>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            onClick={() => setEnvOpen(true)}
            className={cn(
              "flex flex-1 items-center gap-2",
              isCollapsed && "justify-center px-1"
            )}
          >
            <Settings className="h-3.5 w-3.5" />
            {!isCollapsed && "配置管理"}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            title={theme === "dark" ? "切换亮色模式" : "切换暗色模式"}
          >
            {theme === "dark" ? (
              <Sun className="h-3.5 w-3.5" />
            ) : (
              <Moon className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
        {!isCollapsed && (
          <div className="mt-1 px-2 text-[10px] text-muted-foreground">
            bypassPermissions 模式 · 仅本地
          </div>
        )}
      </div>

      <ProfileManagerModal
        open={envOpen}
        onClose={() => setEnvOpen(false)}
        onChanged={refresh}
      />

    </aside>
  );
}
