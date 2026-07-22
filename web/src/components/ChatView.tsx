import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useChatSSE, type ThreadMessageLike } from "@/hooks/useChatSSE";
import { ChatThread } from "@/components/ChatThread";
import { PermissionRequestBanner, type PendingPermission } from "@/components/PermissionRequestBanner";
import { PlanApprovalBanner, type PendingPlanApproval } from "@/components/PlanApprovalBanner";
import { Badge } from "@/components/ui/badge";
import { setSessionProfile as setSessionProfileApi, setSessionPermissionMode, setSessionThinkingLevel, updateSessionTitle } from "@/lib/api";
import { useEffect, useRef, useState, useCallback } from "react";
import { Pencil } from "lucide-react";
import { cn } from "@/lib/utils";

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
  /** 会话初始思考级别 */
  initialEffortLevel?: string;
  /** 会话当前运行状态：running 时用 subscribe 续流，而非静态 loadHistory */
  initialRunningStatus?: "idle" | "running" | "waiting";
  /** 会话累计 input tokens（用于首次渲染；后续由 SSE done 事件更新） */
  initialInputTokens?: number;
  /** 会话累计 output tokens */
  initialOutputTokens?: number;
}

export function ChatView({
  sessionId,
  cwd,
  title,
  subtitle,
  initialMessages,
  initialProfileId,
  initialPermissionMode,
  initialEffortLevel,
  initialRunningStatus,
  initialInputTokens,
  initialOutputTokens,
}: ChatViewProps) {
  // 待处理的权限请求和计划审批
  const [pendingPermission, setPendingPermission] = useState<PendingPermission | null>(null);
  const [pendingPlan, setPendingPlan] = useState<PendingPlanApproval | null>(null);

  // 用 Map 保存每个权限请求的 respond 回调，支持多个并发请求互不覆盖
  const permissionRespondMapRef = useRef(
    new Map<string, (behavior: "allow" | "deny", message?: string) => Promise<void>>()
  );
  // 计划审批的 approve/reject 回调（单槽，同一时刻只有一个计划）
  const planCallbacksRef = useRef<{
    approve?: (opts?: { editedPlan?: string; prompt?: string }) => Promise<void>;
    reject?: () => void;
  }>({});

  const handlePermissionRequest = useCallback(
    (evt: {
      requestId: string;
      toolName: string;
      toolInput: unknown;
      decisionReason?: string;
      respond: (behavior: "allow" | "deny", message?: string) => Promise<void>;
    }) => {
      permissionRespondMapRef.current.set(evt.requestId, evt.respond);
      setPendingPermission({
        requestId: evt.requestId,
        toolName: evt.toolName,
        toolInput: evt.toolInput,
        decisionReason: evt.decisionReason,
      });
    },
    [],
  );

  const handlePlanProposed = useCallback(
    (evt: {
      planContent: string;
      approve: (opts?: { editedPlan?: string; prompt?: string }) => Promise<void>;
      reject: () => void;
    }) => {
      setPendingPlan({ planContent: evt.planContent });
      planCallbacksRef.current = { approve: evt.approve, reject: evt.reject };
    },
    [],
  );

  const handleModeChanged = useCallback(
    (_mode: string) => {
      // mode_changed 事件中的 mode 由后端推送，先不做本地切换以避免竞态；
      // 仅刷新侧栏。
      window.dispatchEvent(new CustomEvent("session-list-changed"));
    },
    [],
  );

  const { runtime, error, stats, isRunning, loadHistory, subscribe, sessionId: activeSessionId } =
    useChatSSE({
      sessionId,
      cwd,
      profileId: initialProfileId ?? null,
      permissionMode: initialPermissionMode,
      effortLevel: initialEffortLevel,
      onSessionCreated: (id) => {
        window.history.replaceState(null, "", `/c/${id}`);
        window.dispatchEvent(new CustomEvent("session-list-changed"));
      },
      onPermissionRequest: handlePermissionRequest,
      onPlanProposed: handlePlanProposed,
      onModeChanged: handleModeChanged,
    });

  // 权限审批操作函数（从 Map 中取出 respond 调用）
  async function handlePermissionAllow(requestId: string) {
    const respond = permissionRespondMapRef.current.get(requestId);
    permissionRespondMapRef.current.delete(requestId);
    if (respond) await respond("allow");
    setPendingPermission(null);
  }

  async function handlePermissionDeny(requestId: string) {
    const respond = permissionRespondMapRef.current.get(requestId);
    permissionRespondMapRef.current.delete(requestId);
    if (respond) await respond("deny", "User denied via UI");
    setPendingPermission(null);
  }

  // 计划审批操作函数（从 ref 中取出回调调用）
  async function handlePlanApprove(opts?: { editedPlan?: string; prompt?: string }) {
    const { approve } = planCallbacksRef.current;
    planCallbacksRef.current = {};
    setPendingPlan(null);
    if (approve) await approve(opts);
  }

  function handlePlanReject() {
    const { reject } = planCallbacksRef.current;
    planCallbacksRef.current = {};
    setPendingPlan(null);
    if (reject) reject();
  }

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

  // 当前生效的思考级别：初始值来自 prop；切换时本地更新
  const [effortLevel, setEffortLevel] = useState<string>(
    initialEffortLevel ?? "default",
  );
  useEffect(() => {
    setEffortLevel(initialEffortLevel ?? "default");
  }, [initialEffortLevel]);

  // 已有会话：挂载时载入历史（静止会话）或续流（运行中会话）
  useEffect(() => {
    if (!sessionId) return;
    if (initialRunningStatus === "running") {
      // 会话正在运行 → 订阅实时流，续上输出
      void subscribe(sessionId);
    } else if (initialMessages) {
      // 静止会话 → 直接加载静态历史
      loadHistory(initialMessages);
    }
    // 仅在 sessionId 变化（切换会话）时触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

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
    if (!activeSessionId) return;
    try {
      await setSessionPermissionMode(activeSessionId, mode);
      window.dispatchEvent(new CustomEvent("session-list-changed"));
    } catch {
      setPermissionMode(permissionMode);
    }
  }

  // 切换思考级别
  async function handleChangeEffortLevel(level: string) {
    setEffortLevel(level);
    if (!activeSessionId) return;
    try {
      await setSessionThinkingLevel(activeSessionId, level);
      window.dispatchEvent(new CustomEvent("session-list-changed"));
    } catch {
      setEffortLevel(effortLevel);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <Header
        sessionId={sessionId}
        title={title}
        subtitle={subtitle}
        stats={stats}
        initialInputTokens={initialInputTokens}
        initialOutputTokens={initialOutputTokens}
        error={error}
      />
      <div className="min-h-0 flex-1">
        <AssistantRuntimeProvider runtime={runtime}>
          {/* 权限审批和计划审批横幅 */}
          {pendingPermission && (
            <PermissionRequestBanner
              pending={pendingPermission}
              onAllow={handlePermissionAllow}
              onDeny={handlePermissionDeny}
            />
          )}
          {pendingPlan && (
            <PlanApprovalBanner
              pending={pendingPlan}
              onApprove={handlePlanApprove}
              onReject={handlePlanReject}
            />
          )}
          <ChatThread
            cwd={cwd}
            profileId={profileId}
            permissionMode={permissionMode}
            effortLevel={effortLevel}
            isRunning={isRunning}
            onProfileChange={handleChangeProfile}
            onPermissionModeChange={handleChangePermissionMode}
            onEffortLevelChange={handleChangeEffortLevel}
          />
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
  initialInputTokens,
  initialOutputTokens,
  error,
}: {
  sessionId: string | null;
  title?: string;
  subtitle?: string;
  stats: { inputTokens: number; outputTokens: number; durationMs: number } | null;
  initialInputTokens?: number;
  initialOutputTokens?: number;
  error: string | null;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [currentTitle, setCurrentTitle] = useState(title ?? "");
  const [subtitlePopup, setSubtitlePopup] = useState(false);

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
    <div className="sticky top-0 z-10 flex shrink-0 flex-col gap-1 border-b border-border/60 bg-background/60 px-3 py-2 pl-14 md:pl-4 md:py-2.5 backdrop-blur">
      <div className="flex flex-wrap items-center justify-between gap-2">
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
            <div className="relative">
              <div
                className="truncate text-xs text-muted-foreground cursor-pointer"
                title={subtitle}
                onClick={() => setSubtitlePopup(!subtitlePopup)}
              >
                {subtitle}
              </div>
              {subtitlePopup && (
                <div className="absolute left-0 top-full z-50 mt-0.5 max-w-[320px] rounded-lg border border-border bg-popover px-2.5 py-1.5 text-xs text-foreground shadow-lg break-all">
                  {subtitle}
                  <div
                    className="fixed inset-0 z-[-1]"
                    onClick={() => setSubtitlePopup(false)}
                  />
                </div>
              )}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
          {error && <Badge variant="destructive">⚠ {error}</Badge>}
          {stats && (
            <>
              <Badge variant="secondary" className="text-[10px] h-4">
                入 {formatTokens(stats.inputTokens)} · 出 {formatTokens(stats.outputTokens)}
              </Badge>
              <Badge variant="secondary" className="text-[10px] h-4">{(stats.durationMs / 1000).toFixed(1)}s</Badge>
            </>
          )}
          {!stats && (initialInputTokens !== undefined || initialOutputTokens !== undefined) && (
            <Badge variant="secondary" className="text-[10px] h-4">
              入 {formatTokens(initialInputTokens ?? 0)} · 出 {formatTokens(initialOutputTokens ?? 0)}
            </Badge>
          )}
        </div>
      </div>
    </div>
  );
}

/** 格式化 token 数：>=1000 用 k 简写 */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

