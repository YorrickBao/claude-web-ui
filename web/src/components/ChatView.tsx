import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useChatSSE, type ThreadMessageLike } from "@/hooks/useChatSSE";
import { ChatThread, TurnTimerProvider } from "@/components/ChatThread";
import { PermissionRequestBanner, type PendingPermission } from "@/components/PermissionRequestBanner";
import { PlanApprovalBanner, type PendingPlanApproval } from "@/components/PlanApprovalBanner";
import { Badge } from "@/components/ui/badge";
import { setSessionProfile as setSessionProfileApi, setSessionPermissionMode, setSessionThinkingLevel, updateSessionTitle, forkSessionApi } from "@/lib/api";
import { useEffect, useRef, useState, useCallback } from "react";
import { GitFork, Pencil } from "lucide-react";
import { toast } from "sonner";
import { useNavigate } from "react-router-dom";
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
  initialRunningStatus?: "idle" | "running" | "waiting" | "completed";
  /** 会话累计 input tokens（用于首次渲染；后续由 SSE done 事件更新） */
  initialInputTokens?: number;
  /** 会话累计 output tokens */
  initialOutputTokens?: number;
  /** 最近一轮耗时 ms（用于首次渲染；后续由 SSE done 事件更新） */
  initialDurationMs?: number;
  /** 当前进行中轮次的开始时刻（ms）；刷新后续流时用来恢复计时，不从 0 重来 */
  initialCurrentTurnStartedAt?: number;
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
  initialDurationMs,
  initialCurrentTurnStartedAt,
}: ChatViewProps) {
  const navigate = useNavigate();
  // 待处理的权限请求和计划审批
  // pendingPermissions 用数组：支持多个并发请求同时显示各自横幅
  const [pendingPermissions, setPendingPermissions] = useState<PendingPermission[]>([]);
  const [pendingPlan, setPendingPlan] = useState<PendingPlanApproval | null>(null);

  // 用 Map 保存每个权限请求的 respond 回调，支持多个并发请求互不覆盖
  const permissionRespondMapRef = useRef(
    new Map<
      string,
      (
        behavior: "allow" | "deny",
        message?: string,
        updatedPermissions?: Array<{
          type: "add";
          toolName: string;
          permission: "allow";
          destination: "session";
        }>,
      ) => Promise<void>
    >(),
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
      respond: (
        behavior: "allow" | "deny",
        message?: string,
        updatedPermissions?: Array<{
          type: "add";
          toolName: string;
          permission: "allow";
          destination: "session";
        }>,
      ) => Promise<void>;
    }) => {
      permissionRespondMapRef.current.set(evt.requestId, evt.respond);
      setPendingPermissions((prev) => [
        ...prev,
        {
          requestId: evt.requestId,
          toolName: evt.toolName,
          toolInput: evt.toolInput,
          decisionReason: evt.decisionReason,
        },
      ]);
    },
    [],
  );

  // 权限请求已解决（超时/中止/已被响应）：清除对应横幅和回调
  const handlePermissionResolved = useCallback((requestId: string) => {
    permissionRespondMapRef.current.delete(requestId);
    setPendingPermissions((prev) => prev.filter((p) => p.requestId !== requestId));
  }, []);

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

  const { runtime, error, statusMessage, stats, isRunning, loadHistory, subscribe, detach, sessionId: activeSessionId } =
    useChatSSE({
      sessionId,
      cwd,
      profileId: initialProfileId ?? null,
      permissionMode: initialPermissionMode,
      effortLevel: initialEffortLevel,
      onSessionCreated: (id) => {
        // 立即 navigate 更新 URL 到 /c/:id。AppShell 用固定 key 的
        // ChatViewWithMeta，路由切换不会 remount ChatView，因此 POST 流不中断、
        // messages state 保留、无骨架屏闪动。
        navigate(`/c/${id}`, { replace: true });
        window.dispatchEvent(new CustomEvent("session-list-changed"));
      },
      onPermissionRequest: handlePermissionRequest,
      onPermissionResolved: handlePermissionResolved,
      onPlanProposed: handlePlanProposed,
      onModeChanged: handleModeChanged,
    });

  // 权限审批操作函数（从 Map 中取出 respond 调用）
  async function handlePermissionAllow(
    requestId: string,
    opts?: { remember?: boolean; toolName?: string },
  ) {
    const respond = permissionRespondMapRef.current.get(requestId);
    permissionRespondMapRef.current.delete(requestId);
    if (respond) {
      // 勾选"始终允许"时附带 updatedPermissions，让 SDK 记住决定
      const updatedPermissions =
        opts?.remember && opts.toolName
          ? [
              {
                type: "add" as const,
                toolName: opts.toolName,
                permission: "allow" as const,
                destination: "session" as const,
              },
            ]
          : undefined;
      await respond("allow", undefined, updatedPermissions);
    }
    setPendingPermissions((prev) => prev.filter((p) => p.requestId !== requestId));
  }

  async function handlePermissionDeny(requestId: string) {
    const respond = permissionRespondMapRef.current.get(requestId);
    permissionRespondMapRef.current.delete(requestId);
    if (respond) await respond("deny", "User denied via UI");
    setPendingPermissions((prev) => prev.filter((p) => p.requestId !== requestId));
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
    initialPermissionMode ?? "default",
  );
  useEffect(() => {
    setPermissionMode(initialPermissionMode ?? "default");
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
    if (!sessionId) {
      // 回到 pending 态（从运行中会话 A 点新建）：本地断开 A 的实时流，
      // 避免残留 running 光标/状态。detach 不打断后端查询，A 仍可在侧栏
      // 重新进入续看实时输出。
      detach();
      loadHistory([]);
      return;
    }
    if (initialRunningStatus === "running" || initialRunningStatus === "waiting") {
      // 会话正在运行 / 等待权限审批 → 都是 inflight，订阅实时流续上输出
      // （waiting 也是 inflight，权限批准后会话恢复，需订阅才能收到后续事件）
      void subscribe(sessionId);
    } else if (initialMessages) {
      // 静止会话 → 直接加载静态历史
      loadHistory(initialMessages);
    }
    // 仅在 sessionId 变化（切换会话）时触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // 跨窗口实时流接入已下放到 useChatSSE 内部：它订阅全局总线的
  // session_started 信号，匹配当前 sessionId 时自动 subscribe。不再需要
  // 这里靠 sessions_changed 拉状态 + 翻转推断（旧机制脆弱且易断信号）。

  // 分叉当前会话：复制历史到新 sessionId 并跳转，原会话不动
  async function handleFork() {
    if (!activeSessionId || isRunning) return;
    try {
      const { sessionId: newId } = await forkSessionApi(activeSessionId);
      window.dispatchEvent(new CustomEvent("session-list-changed"));
      navigate(`/c/${newId}`); // 跳进 fork，历史由 ChatViewWithMeta 自动加载
    } catch (err) {
      toast.error(`分叉失败：${(err as Error).message}`);
    }
  }

  // 从某条 assistant 答处分叉：用该消息的 transcript uuid 作为 upToMessageId，
  // forkSession 会切到该消息为止的历史。运行中禁用（避免拷到半截状态）。
  async function handleForkFromMessage(upToMessageId: string) {
    if (!activeSessionId || isRunning) return;
    try {
      const { sessionId: newId } = await forkSessionApi(activeSessionId, {
        upToMessageId,
      });
      window.dispatchEvent(new CustomEvent("session-list-changed"));
      navigate(`/c/${newId}`);
    } catch (err) {
      toast.error(`分叉失败：${(err as Error).message}`);
    }
  }

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
        statusMessage={statusMessage}
        isRunning={isRunning}
        onFork={handleFork}
      />
      <div className="min-h-0 flex-1">
        <AssistantRuntimeProvider runtime={runtime}>
          {/* 权限审批和计划审批横幅（支持多个并发权限请求同时展示） */}
          {pendingPermissions.map((p) => (
            <PermissionRequestBanner
              key={p.requestId}
              pending={p}
              onAllow={handlePermissionAllow}
              onDeny={handlePermissionDeny}
            />
          ))}
          {pendingPlan && (
            <PlanApprovalBanner
              pending={pendingPlan}
              onApprove={handlePlanApprove}
              onReject={handlePlanReject}
            />
          )}
          <TurnTimerProvider
            isRunning={isRunning}
            startedAt={initialCurrentTurnStartedAt}
            lastDurationMs={stats?.durationMs ?? initialDurationMs}
          >
            <ChatThread
              cwd={cwd}
              profileId={profileId}
              permissionMode={permissionMode}
              effortLevel={effortLevel}
              isRunning={isRunning}
              inputTokens={stats?.inputTokens ?? initialInputTokens ?? 0}
              onProfileChange={handleChangeProfile}
              onPermissionModeChange={handleChangePermissionMode}
              onEffortLevelChange={handleChangeEffortLevel}
              onForkFromMessage={handleForkFromMessage}
            />
          </TurnTimerProvider>
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
  statusMessage,
  isRunning,
  onFork,
}: {
  sessionId: string | null;
  title?: string;
  subtitle?: string;
  stats: { inputTokens: number; outputTokens: number; durationMs: number } | null;
  initialInputTokens?: number;
  initialOutputTokens?: number;
  error: string | null;
  statusMessage: string | null;
  isRunning: boolean;
  onFork: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [currentTitle, setCurrentTitle] = useState(title ?? "");
  const [subtitlePopup, setSubtitlePopup] = useState(false);
  const subtitleAnchorRef = useRef<HTMLDivElement>(null);
  // popover 最大宽度：按锚点左边到视口右边的可用空间计算，既不随锚点宽度，又保证不溢出视口
  const [subtitleMaxWidth, setSubtitleMaxWidth] = useState<number | undefined>(undefined);

  // 进入编辑态时自动聚焦并全选
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  // 按锚点左边到视口右边的距离计算 popover 可用宽度（不随锚点宽度，且不溢出视口右侧）
  const measureSubtitleWidth = useCallback(() => {
    const el = subtitleAnchorRef.current;
    if (!el) return;
    const left = el.getBoundingClientRect().left;
    setSubtitleMaxWidth(Math.max(window.innerWidth - left - 16, 160));
  }, []);

  // 打开期间监听窗口尺寸变化，保持宽度不溢出视口
  useEffect(() => {
    if (!subtitlePopup) return;
    measureSubtitleWidth();
    window.addEventListener("resize", measureSubtitleWidth);
    return () => window.removeEventListener("resize", measureSubtitleWidth);
  }, [subtitlePopup, measureSubtitleWidth]);

  const toggleSubtitlePopup = useCallback(() => {
    measureSubtitleWidth();
    setSubtitlePopup((p) => !p);
  }, [measureSubtitleWidth]);

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
  const canFork = sessionId !== null && !isRunning;

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
            <div className="relative" ref={subtitleAnchorRef}>
              <div
                className="truncate text-xs text-muted-foreground cursor-pointer"
                title={subtitle}
                onClick={toggleSubtitlePopup}
              >
                {subtitle}
              </div>
              {subtitlePopup && (
                <div
                  className="absolute left-0 top-full z-50 mt-0.5 w-max rounded-lg border border-border bg-popover px-2.5 py-1.5 text-xs text-foreground shadow-lg"
                  style={subtitleMaxWidth !== undefined ? { maxWidth: subtitleMaxWidth } : undefined}
                >
                  <span className="break-all">{subtitle}</span>
                  <div
                    className="fixed inset-0 z-[-1]"
                    onClick={() => setSubtitlePopup(false)}
                  />
                </div>
              )}
            </div>
          )}
        </div>
        {sessionId && (
          <button
            type="button"
            onClick={onFork}
            disabled={!canFork}
            title={isRunning ? "会话运行中，结束后再分叉" : "分叉此会话"}
            className={cn(
              "flex shrink-0 items-center justify-center rounded p-1 text-muted-foreground transition-colors",
              canFork
                ? "hover:bg-accent hover:text-foreground cursor-pointer"
                : "opacity-40 cursor-not-allowed",
            )}
          >
            <GitFork className="h-3.5 w-3.5" />
          </button>
        )}
        <div className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
          {error && <Badge variant="destructive">⚠ {error}</Badge>}
          {statusMessage && (
            <Badge variant="secondary" className="h-4 animate-pulse text-[10px]">
              {statusMessage}
            </Badge>
          )}
          {stats && (
            <Badge variant="secondary" className="h-4 font-mono text-[10px] tabular-nums">
              入 {formatTokens(stats.inputTokens)} · 出 {formatTokens(stats.outputTokens)}
            </Badge>
          )}
          {!stats && (initialInputTokens !== undefined || initialOutputTokens !== undefined) && (
            <Badge variant="secondary" className="h-4 font-mono text-[10px] tabular-nums">
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

