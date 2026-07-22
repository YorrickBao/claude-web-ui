import { useLocation, useNavigate } from "react-router-dom";
import { Sidebar } from "@/components/Sidebar";
import { NewSessionView } from "@/components/NewSessionView";
import { ChatView } from "@/components/ChatView";
import type { ThreadMessageLike } from "@/hooks/useChatSSE";
import { useEffect, useState } from "react";

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
      | { cwd?: string; firstMessage?: string; profileId?: string | null }
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
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-neutral-950">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col">{children}</main>
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
  } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setMeta(null);
    setErr(null);
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        if (cancelled) return;
        setMeta({
          title: data.title ?? sessionId,
          cwd: data.cwd ?? "",
          messages: (data.messages ?? []) as ThreadMessageLike[],
          profileId: data.profileId ?? null,
        });
      })
      .catch((e) => {
        if (!cancelled) setErr((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  if (err) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-red-400">
        会话加载失败：{err}
      </div>
    );
  }
  if (!meta) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-neutral-500">
        加载中…
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
    />
  );
}
