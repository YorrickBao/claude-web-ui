import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useChatSSE, type ThreadMessageLike } from "@/hooks/useChatSSE";
import { ChatThread } from "@/components/ChatThread";
import { ProfileSelect } from "@/components/ProfileSelect";
import { Badge } from "@/components/ui/badge";
import { setSessionProfile as setSessionProfileApi } from "@/lib/api";
import { useEffect, useState } from "react";

export interface ChatViewProps {
  sessionId: string | null;
  cwd: string | null;
  title?: string;
  subtitle?: string;
  initialMessages?: ThreadMessageLike[];
  /** 会话初始绑定的 profile id（新建会话从 location.state 来；已有会话从后端来） */
  initialProfileId?: string | null;
}

export function ChatView({
  sessionId,
  cwd,
  title,
  subtitle,
  initialMessages,
  initialProfileId,
}: ChatViewProps) {
  const { runtime, error, stats, loadHistory, sessionId: activeSessionId } =
    useChatSSE({
      sessionId,
      cwd,
      profileId: initialProfileId ?? null,
      onSessionCreated: (id) => {
        // 静默替换 URL（不触发组件重挂，对话状态不丢）
        window.history.replaceState(null, "", `/c/${id}`);
        window.dispatchEvent(new CustomEvent("session-list-changed"));
      },
    });

  // 当前生效的 profileId：初始值来自 prop；切换时本地更新
  const [profileId, setProfileId] = useState<string | null>(
    initialProfileId ?? null,
  );
  useEffect(() => {
    setProfileId(initialProfileId ?? null);
  }, [initialProfileId]);

  // 已有会话：挂载时载入历史
  useEffect(() => {
    if (sessionId && initialMessages) {
      loadHistory(initialMessages);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, initialMessages]);

  // 切换 profile：调后端绑定接口，成功后刷新本地
  async function handleChangeProfile(newId: string | null) {
    if (!activeSessionId) {
      // pending 态（会话还没建）：只更新本地，等首条消息发送时带给后端
      setProfileId(newId);
      return;
    }
    setProfileId(newId);
    try {
      await setSessionProfileApi(activeSessionId, newId);
      window.dispatchEvent(new CustomEvent("session-list-changed"));
    } catch {
      // 失败回滚
      setProfileId(profileId);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <Header
        title={title}
        subtitle={subtitle}
        stats={stats}
        error={error}
        canEditSessionEnv={!!activeSessionId}
        profileId={profileId}
        onProfileChange={handleChangeProfile}
      />
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
  canEditSessionEnv,
  profileId,
  onProfileChange,
}: {
  title?: string;
  subtitle?: string;
  stats: { costUsd: number; numTurns: number; durationMs: number } | null;
  error: string | null;
  canEditSessionEnv: boolean;
  profileId: string | null;
  onProfileChange: (id: string | null) => void;
}) {
  return (
    <div className="flex shrink-0 flex-col gap-1 border-b border-neutral-800 px-4 py-2">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-neutral-100">
            {title ?? "新会话"}
          </div>
          {subtitle && (
            <div
              className="truncate text-xs text-neutral-500"
              title={subtitle}
            >
              {subtitle}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-3 text-xs text-neutral-500">
          {error && <Badge variant="destructive">⚠ {error}</Badge>}
          {stats && (
            <>
              <Badge variant="secondary">{stats.numTurns} 轮</Badge>
              <Badge variant="secondary">${stats.costUsd.toFixed(4)}</Badge>
              <Badge variant="secondary">{(stats.durationMs / 1000).toFixed(1)}s</Badge>
            </>
          )}
        </div>
      </div>
      {canEditSessionEnv && (
        <div className="flex items-center gap-2">
          <span className="shrink-0 text-[10px] uppercase tracking-wide text-neutral-600">
            profile
          </span>
          <ProfileSelect
            value={profileId}
            onChange={onProfileChange}
            noneLabel="不绑定 · CLI 默认"
          />
        </div>
      )}
    </div>
  );
}
