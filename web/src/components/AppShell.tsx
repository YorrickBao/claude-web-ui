import { useLocation, useNavigate } from "react-router-dom";
import { useEffect, useRef, useState, useCallback } from "react";
import { Menu } from "lucide-react";
import { cn } from "@/lib/utils";
import { Sidebar } from "@/components/Sidebar";
import { NewSessionView } from "@/components/NewSessionView";
import { ChatView } from "@/components/ChatView";
import { SettingsPage } from "@/components/SettingsPage";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import type { ThreadMessageLike } from "@/hooks/useChatSSE";
import type { SessionView } from "@/lib/types";

/**
 * 整个应用的布局壳：左 Sidebar + 右主内容区。
 * 主内容区根据 URL 决定渲染什么：
 *   /new          → 新建会话（选 cwd）
 *   /pending      → 新会话待创建（cwd 来自 location.state，首条消息触发后端创建）
 *   /settings     → 设置页（飞书绑定 + 环境变量配置）
 *   /c/:sessionId → 已有会话
 *
 * 移动端（<768px）：侧栏变成叠加抽屉，通过汉堡菜单按钮打开，带背景遮罩。
 * 桌面端（≥768px）：保持可拖拽调整宽度的侧栏。
 */
export function AppShell() {
  const location = useLocation();
  const navigate = useNavigate();

  const path = location.pathname;

  // ── /pending：新会话草稿态 ──
  if (path === "/pending") {
    const state = location.state as
      | { cwd?: string; profileId?: string | null; permissionMode?: string; effortLevel?: string }
      | null;
    const cwd = state?.cwd ?? null;
    if (!cwd) {
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
          initialEffortLevel={state?.effortLevel}
        />
      </Shell>
    );
  }

  // ── /settings：设置页 ──
  if (path === "/settings") {
    return (
      <Shell>
        <SettingsPage />
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

  // ── 移动端检测 ──
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window !== "undefined") {
      return window.matchMedia("(max-width: 767px)").matches;
    }
    return false;
  });
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia("(max-width: 767px)");
    setIsMobile(mql.matches);
    if (mql.matches) setIsCollapsed(false); // 移动端不走 collapsed 模式

    const handler = (e: MediaQueryListEvent) => {
      setIsMobile(e.matches);
      if (e.matches) {
        setIsCollapsed(false);
        setMobileSidebarOpen(false);
      }
    };
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  // 桌面端：初始化时判断是否默认收起
  useEffect(() => {
    if (!isMobile) {
      setIsCollapsed(window.innerWidth < 768);
    }
  }, [isMobile]);

  // 走新路由时自动关闭移动端侧栏
  const location = useLocation();
  useEffect(() => {
    setMobileSidebarOpen(false);
  }, [location.pathname]);

  // 持久化宽度（仅桌面端）
  useEffect(() => {
    if (!isMobile && !isCollapsed) {
      try {
        localStorage.setItem("sidebarWidth", String(sidebarWidth));
      } catch { /* noop */ }
    }
  }, [sidebarWidth, isCollapsed, isMobile]);

  // ── 拖拽逻辑（仅桌面端） ──
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (isMobile) return;
    e.preventDefault();
    setIsDragging(true);
    dragRef.current = { startX: e.clientX, startWidth: sidebarWidth };
  }, [isMobile, sidebarWidth]);

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
    if (isMobile) {
      setMobileSidebarOpen(!mobileSidebarOpen);
      return;
    }
    if (isCollapsed) {
      setIsCollapsed(false);
    } else {
      setIsCollapsed(true);
    }
  }

  const openSidebar = () => setMobileSidebarOpen(true);
  const closeSidebar = () => setMobileSidebarOpen(false);

  const effectiveWidth = isMobile ? undefined : (isCollapsed ? 64 : sidebarWidth);

  return (
    <div
      className={cn(
        "flex h-full w-screen overflow-hidden bg-background",
        isDragging && "select-none"
      )}
    >
      {/* ── 移动端背景遮罩 ── */}
      {isMobile && mobileSidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 backdrop-blur-sm animate-in fade-in-0 duration-200"
          onClick={closeSidebar}
          aria-hidden="true"
        />
      )}

      {/* ── 侧栏 ── */}
      <Sidebar
        width={effectiveWidth}
        isCollapsed={isMobile ? false : isCollapsed}
        onToggleCollapse={handleToggleCollapse}
        noTransition={isDragging}
        isMobile={isMobile}
        isOverlayOpen={mobileSidebarOpen}
        onOverlayClose={closeSidebar}
      />

      {/* ── 桌面端拖拽手柄 ── */}
      {!isMobile && !isCollapsed && (
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

      {/* ── 主内容区 ── */}
      <main
        className={cn(
          "relative flex min-w-0 flex-1 flex-col",
          isDragging && "pointer-events-none"
        )}
      >
        {/* ── 移动端汉堡菜单按钮 ── */}
        {isMobile && (
          <div className="absolute top-0 left-0 z-20 p-2" style={{ paddingTop: "max(0.5rem, env(safe-area-inset-top, 0px))", paddingLeft: "max(0.5rem, env(safe-area-inset-left, 0px))" }}>
            <Button
              variant="ghost"
              size="icon"
              onClick={openSidebar}
              className="h-9 w-9 rounded-lg bg-background/60 backdrop-blur shadow-sm ring-1 ring-border/40"
              aria-label="打开菜单"
            >
              <Menu className="h-4 w-4" />
            </Button>
          </div>
        )}

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
    effortLevel: string;
    runningStatus: "idle" | "running" | "waiting";
    inputTokens: number;
    outputTokens: number;
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
          effortLevel: data.effortLevel ?? "default",
          runningStatus: data.runningStatus ?? "idle",
          inputTokens: data.inputTokens ?? 0,
          outputTokens: data.outputTokens ?? 0,
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
      initialEffortLevel={meta.effortLevel}
      initialRunningStatus={meta.runningStatus}
      initialInputTokens={meta.inputTokens}
      initialOutputTokens={meta.outputTokens}
    />
  );
}
