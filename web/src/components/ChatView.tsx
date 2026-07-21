import {
  AssistantRuntimeProvider,
} from "@assistant-ui/react";
import { useChatSSE, type ThreadMessageLike } from "@/hooks/useChatSSE";
import { ChatThread } from "@/components/ChatThread";
import { useEffect } from "react";

export interface ChatViewProps {
  sessionId: string | null;
  cwd: string | null;
  title?: string;
  subtitle?: string;
  initialMessages?: ThreadMessageLike[];
}

export function ChatView({
  sessionId,
  cwd,
  title,
  subtitle,
  initialMessages,
}: ChatViewProps) {
  const { runtime, error, stats, loadHistory } = useChatSSE({
    sessionId,
    cwd,
    onSessionCreated: (id) => {
      // 静默替换 URL（不触发组件重挂，对话状态不丢）
      window.history.replaceState(null, "", `/c/${id}`);
      window.dispatchEvent(new CustomEvent("session-list-changed"));
    },
  });

  // 已有会话：挂载时载入历史
  useEffect(() => {
    if (sessionId && initialMessages) {
      loadHistory(initialMessages);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, initialMessages]);

  return (
    <div className="flex h-full flex-col">
      <Header title={title} subtitle={subtitle} stats={stats} error={error} />
      <div className="min-h-0 flex-1">
        <AssistantRuntimeProvider runtime={runtime}>
          <ChatThread />
        </AssistantRuntimeProvider>
      </div>
    </div>
  );
}

function Header({
  title,
  subtitle,
  stats,
  error,
}: {
  title?: string;
  subtitle?: string;
  stats: { costUsd: number; numTurns: number; durationMs: number } | null;
  error: string | null;
}) {
  return (
    <div className="flex shrink-0 items-center justify-between border-b border-neutral-800 px-4 py-2">
      <div className="min-w-0">
        <div className="truncate text-sm font-medium text-neutral-100">
          {title ?? "新会话"}
        </div>
        {subtitle && (
          <div className="truncate text-xs text-neutral-500" title={subtitle}>
            {subtitle}
          </div>
        )}
      </div>
      <div className="flex items-center gap-3 text-xs text-neutral-500">
        {error && <span className="text-red-400">⚠ {error}</span>}
        {stats && (
          <>
            <span>{stats.numTurns} 轮</span>
            <span>${stats.costUsd.toFixed(4)}</span>
            <span>{(stats.durationMs / 1000).toFixed(1)}s</span>
          </>
        )}
      </div>
    </div>
  );
}
