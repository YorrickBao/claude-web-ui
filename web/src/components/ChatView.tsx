import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useChatSSE, type ThreadMessageLike } from "@/hooks/useChatSSE";
import { ChatThread } from "@/components/ChatThread";
import { ProfileSelect } from "@/components/ProfileSelect";
import { Badge } from "@/components/ui/badge";
import { setSessionProfile as setSessionProfileApi, setSessionPermissionMode, updateSessionTitle } from "@/lib/api";
import { useEffect, useRef, useState } from "react";
import { Pencil } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface ChatViewProps {
  sessionId: string | null;
  cwd: string | null;
  title?: string;
  subtitle?: string;
  initialMessages?: ThreadMessageLike[];
  /** 会话初始绑定的 profile id（新建会话从 location.state 来；已有会话从后端来） */
  initialProfileId?: string | null;
  /** 会话初始权限模式 */
  initialPermissionMode?: string;
}

export function ChatView({
  sessionId,
  cwd,
  title,
  subtitle,
  initialMessages,
  initialProfileId,
  initialPermissionMode,
}: ChatViewProps) {
  const { runtime, error, stats, loadHistory, sessionId: activeSessionId } =
    useChatSSE({
      sessionId,
      cwd,
      profileId: initialProfileId ?? null,
      permissionMode: initialPermissionMode,
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

  // 当前生效的权限模式：初始值来自 prop；切换时本地更新
  const [permissionMode, setPermissionMode] = useState<string>(
    initialPermissionMode ?? "bypassPermissions",
  );
  useEffect(() => {
    setPermissionMode(initialPermissionMode ?? "bypassPermissions");
  }, [initialPermissionMode]);

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

  // 切换权限模式
  async function handleChangePermissionMode(mode: string) {
    setPermissionMode(mode);
    if (!activeSessionId) return; // pending 态只更新本地
    try {
      await setSessionPermissionMode(activeSessionId, mode);
      window.dispatchEvent(new CustomEvent("session-list-changed"));
    } catch {
      setPermissionMode(permissionMode);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <Header
        sessionId={sessionId}
        title={title}
        subtitle={subtitle}
        stats={stats}
        error={error}
        profileId={profileId}
        permissionMode={permissionMode}
        onProfileChange={handleChangeProfile}
        onPermissionModeChange={handleChangePermissionMode}
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
  sessionId,
  title,
  subtitle,
  stats,
  error,
  profileId,
  permissionMode,
  onProfileChange,
  onPermissionModeChange,
}: {
  sessionId: string | null;
  title?: string;
  subtitle?: string;
  stats: { costUsd: number; numTurns: number; durationMs: number } | null;
  error: string | null;
  profileId: string | null;
  permissionMode: string;
  onProfileChange: (id: string | null) => void;
  onPermissionModeChange: (mode: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [currentTitle, setCurrentTitle] = useState(title ?? "");

  // 进入编辑态时自动聚焦并全选
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  function startEdit() {
    if (!sessionId) return; // pending 新会话不可编辑
    setEditValue(currentTitle);
    setIsEditing(true);
  }

  function cancelEdit() {
    setIsEditing(false);
    setEditValue("");
  }

  async function saveEdit() {
    const newTitle = editValue.trim();
    setIsEditing(false);
    setEditValue("");

    if (!sessionId) return;
    if (newTitle === currentTitle) return; // 未变化

    // 乐观更新本地标题
    setCurrentTitle(newTitle);

    try {
      await updateSessionTitle(sessionId, newTitle || null);
      window.dispatchEvent(new CustomEvent("session-list-changed"));
    } catch {
      // 回滚
      setCurrentTitle(currentTitle);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      void saveEdit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelEdit();
    }
  }

  const canEdit = sessionId !== null;

  return (
    <div className="flex shrink-0 flex-col gap-1 border-b border-border/60 bg-background/60 px-4 py-2.5 backdrop-blur">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          {isEditing ? (
            <input
              ref={inputRef}
              type="text"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={handleKeyDown}
              onBlur={() => void saveEdit()}
              className="w-full truncate text-sm font-medium bg-transparent text-foreground outline-none border-b border-accent px-0.5 -mx-0.5"
              placeholder="输入标题"
            />
          ) : (
            <div
              className={cn(
                "group/title flex items-center gap-1.5 min-w-0",
                canEdit && "cursor-pointer"
              )}
              onClick={canEdit ? startEdit : undefined}
              title={canEdit ? "点击编辑标题" : undefined}
            >
              <span className="truncate text-sm font-medium text-foreground group-hover/title:text-accent transition-colors">
                {currentTitle || "新会话"}
              </span>
              {canEdit && (
                <Pencil className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 group-hover/title:opacity-100 transition-opacity" />
              )}
            </div>
          )}
          {subtitle && (
            <div
              className="truncate text-xs text-muted-foreground"
              title={subtitle}
            >
              {subtitle}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
          {error && <Badge variant="destructive">⚠ {error}</Badge>}
          {stats && (
            <>
              <Badge variant="secondary" className="text-[10px] h-4">{stats.numTurns} 轮</Badge>
              <Badge variant="secondary" className="text-[10px] h-4">${stats.costUsd.toFixed(4)}</Badge>
              <Badge variant="secondary" className="text-[10px] h-4">{(stats.durationMs / 1000).toFixed(1)}s</Badge>
            </>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
          profile
        </span>
        <ProfileSelect
          value={profileId}
          onChange={onProfileChange}
          noneLabel="不绑定 · CLI 默认"
        />
      </div>
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
          权限
        </span>
        <Select value={permissionMode} onValueChange={(v) => v && onPermissionModeChange(v)}>
          <SelectTrigger className="h-7 min-w-0 flex-1 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="bypassPermissions">完全访问</SelectItem>
            <SelectItem value="default">标准模式</SelectItem>
            <SelectItem value="acceptEdits">自动编辑</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

