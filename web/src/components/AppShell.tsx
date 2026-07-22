import { useLocation, useNavigate } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Sidebar } from "@/components/Sidebar";
import { NewSessionView } from "@/components/NewSessionView";
import { ChatView } from "@/components/ChatView";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import type { ThreadMessageLike } from "@/hooks/useChatSSE";
import type { SessionView } from "@/lib/types";

/**
 * 整个应用的布局壳：左 Sidebar + 右主内容区。
 * 主内容区根据 URL 决定渲染什么：
 *   /new          → 新建会话（选 cwd）
 *   /pending      → 新会话待创建（cwd 来自 location.state，首条消息触发后端创建）
 *   /c/:sessionId → 已有会话
 */
export function AppShell() {
  const location = useLocation();
  const navigate = useNavigate();

  const path = location.pathname;

  // ── /pending：新会话草稿态 ──
  if (path === "/pending") {
    const state = location.state as
      | { cwd?: string; profileId?: string | null; permissionMode?: string }
      | null;
    const cwd = state?.cwd ?? null;
    if (!cwd) {
      // 没有 cwd 就回 /new
      navigate("/new", { replace: true });
      return null;
    }
    return (
      <Shell>
        <ChatView
          key="pending"
          sessionId={null}
          cwd={cwd}
          title="新会话"
          subtitle={cwd}
          initialProfileId={state?.profileId ?? null}
          initialPermissionMode={state?.permissionMode}
        />
      </Shell>
    );
  }

  // ── /c/:sessionId：已有会话 ──
  const match = path.match(/^\/c\/(.+)$/);
  if (match) {
    const sessionId = decodeURIComponent(match[1]);
    return (
      <Shell>
        <ChatViewWithMeta key={sessionId} sessionId={sessionId} />
      </Shell>
    );
  }

  // ── /new 或其他：新建会话 ──
  return (
    <Shell>
      <NewSessionView />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const saved = localStorage.getItem("sidebarWidth");
      return saved ? Math.max(160, Math.min(parseInt(saved, 10), 600)) : 256;
    } catch {
      return 256;
    }
  });
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  // 移动端：默认收起，桌面端：默认展开
  useEffect(() => {
    setIsCollapsed(window.innerWidth < 768);
  }, []);

  // 持久化宽度
  useEffect(() => {
    if (!isCollapsed) {
      try {
        localStorage.setItem("sidebarWidth", String(sidebarWidth));
      } catch { /* noop */ }
    }
  }, [sidebarWidth, isCollapsed]);

  // ── 拖拽逻辑 ──
  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    dragRef.current = { startX: e.clientX, startWidth: sidebarWidth };
  };

  useEffect(() => {
    if (!isDragging || !dragRef.current) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!dragRef.current) return;
      const delta = e.clientX - dragRef.current.startX;
      const newWidth = Math.max(160, Math.min(dragRef.current.startWidth + delta, 600));
      setSidebarWidth(newWidth);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      dragRef.current = null;
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging]);

  function handleToggleCollapse() {
    if (isCollapsed) {
      // 展开
      setIsCollapsed(false);
    } else {
      // 收起
      setIsCollapsed(true);
    }
  }

  const effectiveWidth = isCollapsed ? 64 : sidebarWidth;

  return (
    <div
      className={cn(
        "flex h-screen w-screen overflow-hidden bg-background",
        isDragging && "select-none"
      )}
    >
      <Sidebar
        width={effectiveWidth}
        isCollapsed={isCollapsed}
        onToggleCollapse={handleToggleCollapse}
        noTransition={isDragging}
      />

      {/* 拖拽手柄 —— 与侧栏右边框重叠， hover/拖拽时可见 */}
      {!isCollapsed && (
        <div
          className={cn(
            "shrink-0 w-[3px] -ml-[3px] cursor-col-resize transition-colors",
            isDragging
              ? "bg-accent/40"
              : "bg-transparent hover:bg-accent/12"
          )}
          onMouseDown={handleMouseDown}
        />
      )}

      <main
        className={cn(
          "flex min-w-0 flex-1 flex-col",
          isDragging && "pointer-events-none"
        )}
      >
        {children}
      </main>
    </div>
  );
}

/** 已有会话：先拉元信息 + 历史，再渲染 ChatView */
function ChatViewWithMeta({ sessionId }: { sessionId: string }) {
  const [meta, setMeta] = useState<{
    title: string;
    cwd: string;
    messages: ThreadMessageLike[];
    profileId: string | null;
    permissionMode: string;
  } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setMeta(null);
    setErr(null);

    async function load() {
      try {
        const res = await fetch(
          `/api/sessions/${encodeURIComponent(sessionId)}`,
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as SessionView & {
          messages: ThreadMessageLike[];
        };
        if (cancelled) return;
        setMeta({
          title: data.title ?? sessionId,
          cwd: data.cwd ?? "",
          messages: data.messages ?? [],
          profileId: data.profileId ?? null,
          permissionMode: data.permissionMode ?? "bypassPermissions",
        });
      } catch (e) {
        if (!cancelled) setErr((e as Error).message);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  if (err) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <Alert variant="destructive">
          <AlertDescription>会话加载失败：{err}</AlertDescription>
        </Alert>
      </div>
    );
  }
  if (!meta) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8">
        <Skeleton className="h-6 w-64" />
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-4 w-56" />
      </div>
    );
  }

  return (
    <ChatView
      sessionId={sessionId}
      cwd={meta.cwd}
      title={meta.title}
      subtitle={meta.cwd}
      initialMessages={meta.messages}
      initialProfileId={meta.profileId}
      initialPermissionMode={meta.permissionMode}
    />
  );
}
