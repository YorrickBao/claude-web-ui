import { useCallback, useRef, useState } from "react";
import {
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { createSession, sendMessage, respondToPermission, approvePlan, abortSession, resolveSessionByClient } from "@/lib/api";
import { parseSSE } from "@/lib/sse";
import type { SSEEvent } from "@/lib/types";

export type { ThreadMessageLike };

/**
 * 接 Claude Code SDK 后端 SSE 流到 assistant-ui 的 hook。
 *
 * 关键点（核实 @assistant-ui/react@0.14.27）：
 * - T = ThreadMessageLike，省掉 convertMessage
 * - isRunning 必须显式传，否则流式刷新不可靠
 * - ThreadMessageLike 的 tool-call 是单 part：result/isError 是它自己的字段，
 *   不存在独立的 tool-result part
 *
 * 注意：不传 setMessages 给 runtime —— assistant-ui 的 setMessages 签名是
 * (messages: readonly T[]) => void，和 React 的 SetStateAction 不兼容，
 * 而且第一版我们不需要 edit/reload，让它内部自管即可。
 */

type ChatMessage = ThreadMessageLike;

// Part 操作时用宽类型断言（SDK 来的 args 是动态 JSON，没法静态精确）
type AnyPart = { type: string; [k: string]: unknown };

export interface UseChatSSEOptions {
  sessionId: string | null;
  cwd: string | null;
  /** 新建会话时使用的 profile id */
  profileId?: string | null;
  /** 新建会话时使用的权限模式 */
  permissionMode?: string;
  /** 新建会话时使用的思考级别 */
  effortLevel?: string;
  onSessionCreated?: (sessionId: string) => void;
  /** 收到权限请求时的回调（前端弹出审批对话框） */
  onPermissionRequest?: (evt: {
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
  }) => void;
  /** 权限请求已解决（超时/中止/已被响应）：前端清除对应横幅 */
  onPermissionResolved?: (requestId: string, reason: string) => void;
  /** 收到计划提案时的回调（前端渲染审批卡片） */
  onPlanProposed?: (evt: {
    planContent: string;
    approve: (opts?: { editedPlan?: string; prompt?: string }) => Promise<void>;
    reject: () => void;
  }) => void;
  /** 权限模式变更回调 */
  onModeChanged?: (mode: string) => void;
}

export function useChatSSE({
  sessionId,
  cwd,
  profileId,
  permissionMode,
  effortLevel,
  onSessionCreated,
  onPermissionRequest,
  onPermissionResolved,
  onPlanProposed,
  onModeChanged,
}: UseChatSSEOptions) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<{
    inputTokens: number;
    outputTokens: number;
    durationMs: number;
  } | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  /** 用户是否主动点击了停止按钮：用于抑制后续所有 error 事件 */
  const stoppedByUserRef = useRef(false);
  const sessionIdRef = useRef<string | null>(sessionId);
  const onCreatedRef = useRef(onSessionCreated);
  onCreatedRef.current = onSessionCreated;
  const onPermissionRef = useRef(onPermissionRequest);
  onPermissionRef.current = onPermissionRequest;
  const onPermissionResolvedRef = useRef(onPermissionResolved);
  onPermissionResolvedRef.current = onPermissionResolved;
  const onPlanRef = useRef(onPlanProposed);
  onPlanRef.current = onPlanProposed;
  const onModeRef = useRef(onModeChanged);
  onModeRef.current = onModeChanged;
  const profileIdRef = useRef<string | null>(profileId ?? null);
  profileIdRef.current = profileId ?? null;
  const permissionModeRef = useRef<string>(permissionMode ?? "default");
  permissionModeRef.current = permissionMode ?? "default";
  const effortLevelRef = useRef<string>(effortLevel ?? "default");
  effortLevelRef.current = effortLevel ?? "default";
  const [activeSessionId, setActiveSessionId] = useState<string | null>(
    sessionId,
  );

  const stop = useCallback(() => {
    stoppedByUserRef.current = true;
    // 先通知后端中止正在运行的查询（subscribe 续流模式下本地
    // abortRef 只控制只读 GET stream，必须靠 /abort 才能停掉
    // 真正跑查询的 SDK 进程），再中断本地 SSE 连接。
    const sid = sessionIdRef.current;
    if (sid) {
      void abortSession(sid).catch(() => {
        // 会话不在 inflight（404）等不是错误，静默忽略
      });
    }
    abortRef.current?.abort();
  }, []);

  const loadHistory = useCallback((history: ChatMessage[]) => {
    setMessages(history);
    setStats(null);
    setError(null);
  }, []);

  /**
   * 订阅模式：用 GET SSE 连接到一个正在运行的会话，
   * 先接收完整历史（history 事件），再转到实时事件流。
   * 用于切回 inflight 会话时续上流式输出。
   */
  const subscribe = useCallback(async (targetSessionId: string) => {
    setError(null);
    setIsRunning(true);
    sessionIdRef.current = targetSessionId;
    setActiveSessionId(targetSessionId);
    window.dispatchEvent(new CustomEvent("session-list-changed"));

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const res = await fetch(
        `/api/sessions/${encodeURIComponent(targetSessionId)}/stream`,
        { signal: ctrl.signal },
      );

      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status} ${errText}`.trim());
      }

      for await (const evt of parseSSE(res.body, ctrl.signal)) {
        handleSSEEvent(evt, targetSessionId);
      }
    } catch (err) {
      const e = err as Error;
      if (e.name === "AbortError") {
        setMessages((prev) => completeLast(prev));
      } else {
        setError(e.message);
        setMessages((prev) => completeLast(prev));
      }
    } finally {
      setIsRunning(false);
      abortRef.current = null;
      window.dispatchEvent(new CustomEvent("session-list-changed"));
    }
  }, []);

  /**
   * 共享的 SSE 事件处理。供 subscribe 和 plan approval 续流复用。
   *
   * 此函数是组件内的普通函数（非 hook），在每次 render 中重新创建闭包。
   * 它依赖的 setMessages / setError / setStats 是 React useState 的 setter，
   * React 保证其引用稳定，因此闭包重新创建不会导致 stale state 问题。
   * 同理，onPermissionRef / onPlanRef / onModeRef 通过 ref.current 读取最新值。
   */
  function handleSSEEvent(evt: SSEEvent, targetSessionId: string) {
    switch (evt.type) {
      case "history":
        setMessages(evt.messages as ChatMessage[]);
        break;
      case "text":
        setMessages((prev) => appendTextToLast(prev, evt.text));
        break;
      case "tool_use":
        setMessages((prev) =>
          appendToolCall(prev, evt.id, evt.name, evt.input),
        );
        break;
      case "tool_result":
        setMessages((prev) =>
          fillToolResult(prev, evt.id, evt.result, evt.isError),
        );
        break;
      case "error":
        // 用户主动中止后的所有 error 事件都不显示
        if (stoppedByUserRef.current) break;
        setError(evt.message);
        setMessages((prev) =>
          appendTextToLast(prev, `\n\n⚠️ ${evt.message}`),
        );
        break;
      case "done":
        setStats({
          inputTokens: evt.inputTokens,
          outputTokens: evt.outputTokens,
          durationMs: evt.durationMs,
        });
        setMessages((prev) => completeLast(prev));
        break;
      case "waiting_for_user":
        break;
      case "session_created":
        sessionIdRef.current = evt.sessionId;
        setActiveSessionId(evt.sessionId);
        onCreatedRef.current?.(evt.sessionId);
        break;
      case "permission_request":
        if (onPermissionRef.current) {
          onPermissionRef.current({
            requestId: evt.requestId,
            toolName: evt.toolName,
            toolInput: evt.toolInput,
            decisionReason: evt.decisionReason,
            respond: async (behavior, message, updatedPermissions) => {
              await respondToPermission(
                targetSessionId,
                evt.requestId,
                behavior,
                message,
                updatedPermissions,
              );
            },
          });
        }
        break;
      case "permission_resolved":
        // 权限请求已解决（超时/中止/已被响应）：通知前端清除横幅
        onPermissionResolvedRef.current?.(evt.requestId, evt.reason);
        break;
      case "plan_proposed":
        if (onPlanRef.current) {
          onPlanRef.current({
            planContent: evt.planContent,
            approve: async (opts) => {
              const sid = targetSessionId;
              setIsRunning(true);
              const ctrl2 = new AbortController();
              abortRef.current = ctrl2;
              /** 是否已把生命周期交给 subscribe（断线重连）。 */
              let handedOff2 = false;
              try {
                const res2 = await approvePlan(sid, "approve", opts, ctrl2.signal);
                if (!res2.ok || !res2.body) throw new Error(`approvePlan: ${res2.status}`);
                for await (const evt2 of parseSSE(res2.body, ctrl2.signal)) {
                  handleSSEEvent(evt2 as SSEEvent, sid);
                }
              } catch (err2) {
                const e2 = err2 as Error;
                const isUserStop = e2.name === "AbortError" || stoppedByUserRef.current;
                if (isUserStop) {
                  // 用户停止，保持现状
                } else if (!stoppedByUserRef.current) {
                  // 意外断线：approvePlan 查询仍在后端跑，经 stream 续流
                  handedOff2 = true;
                  void subscribe(sid);
                }
              } finally {
                if (!handedOff2) {
                  setIsRunning(false);
                  abortRef.current = null;
                  window.dispatchEvent(new CustomEvent("session-list-changed"));
                }
              }
            },
            reject: () => {
              setMessages((prev) =>
                appendTextToLast(prev, "\n\n⏹ 计划已拒绝。"),
              );
              setMessages((prev) => completeLast(prev));
            },
          });
        }
        break;
      case "mode_changed":
        onModeRef.current?.(evt.mode);
        break;
    }
  }

  const runtime = useExternalStoreRuntime<ChatMessage>({
    messages,
    isRunning,
    // T = ThreadMessageLike，直通即可（0.14.27 要求必传）
    convertMessage: (m) => m,
    onNew: async (message: AppendMessage) => {
      const text = extractText(message);
      if (!text.trim()) return;

      setError(null);
      stoppedByUserRef.current = false;
      setStats(null);
      setIsRunning(true);
      // 通知侧栏：当前会话进入 inflight 状态
      window.dispatchEvent(new CustomEvent("session-list-changed"));

      // 乐观写入：用户消息 + assistant 占位（status running）
      const placeholder: ChatMessage = {
        role: "assistant",
        content: [{ type: "text", text: "" }],
        status: { type: "running" },
      };
      const userMsg: ChatMessage = {
        role: "user",
        content: [{ type: "text", text }],
      };
      setMessages((prev) => [...prev, userMsg, placeholder]);

      // 新建会话时生成 clientId，用于 session_created 未送达即断线时反查 sessionId
      const clientId = crypto.randomUUID();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      /** 是否已把生命周期交给 subscribe（断线重连）。true 时 finally 不清理。 */
      let handedOff = false;

      try {
        const res = sessionIdRef.current
          ? await sendMessage(sessionIdRef.current, text, ctrl.signal)
          : await createSession(
              cwd ?? "",
              text,
              {
                profileId: profileIdRef.current,
                permissionMode: permissionModeRef.current,
                effortLevel: effortLevelRef.current,
                clientId,
              },
              ctrl.signal,
            );

        if (!res.ok || !res.body) {
          const errText = await res.text().catch(() => "");
          throw new Error(`HTTP ${res.status} ${errText}`.trim());
        }

        for await (const evt of parseSSE(res.body, ctrl.signal)) {
          // 用共享的 handleSSEEvent 处理，targetSessionId 用 sessionIdRef.current
          handleSSEEvent(evt, sessionIdRef.current ?? "");
        }
      } catch (err) {
        const e = err as Error;
        const isUserStop = e.name === "AbortError" || stoppedByUserRef.current;
        if (isUserStop) {
          setMessages((prev) => completeLast(prev));
        } else {
          // 意外断线（网络抖动等，非页面销毁）：查询仍在后端跑，
          // 尝试经 GET /stream 续流重新接上。
          let targetSid: string | undefined = sessionIdRef.current ?? undefined;
          if (!targetSid) {
            // 新建会话且 session_created 未到达：凭 clientId 反查
            targetSid = await resolveSessionByClient(clientId);
          }
          // 重连窗口期用户点了停止，则不再续流
          if (stoppedByUserRef.current) {
            setMessages((prev) => completeLast(prev));
          } else if (targetSid) {
            handedOff = true;
            // subscribe 自管 isRunning / abortRef / 事件处理
            void subscribe(targetSid);
          } else {
            setError("连接已断开，任务仍在后台运行，可在侧栏重新进入该会话查看。");
            setMessages((prev) => completeLast(prev));
          }
        }
      } finally {
        if (!handedOff) {
          setIsRunning(false);
          abortRef.current = null;
          // 通知侧栏：会话已完成，退出 inflight
          window.dispatchEvent(new CustomEvent("session-list-changed"));
        }
      }
    },
    onCancel: async () => {
      stoppedByUserRef.current = true;
      const sid = sessionIdRef.current;
      if (sid) {
        await abortSession(sid).catch(() => {
          // 会话不在 inflight（404）等不是错误，静默忽略
        });
      }
      abortRef.current?.abort();
    },
  });

  return {
    runtime: runtime,
    messages,
    isRunning,
    error,
    stats,
    stop,
    loadHistory,
    subscribe,
    sessionId: activeSessionId,
  };
}

function extractText(message: AppendMessage): string {
  const content = message.content as unknown;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as { type: string; text?: string }[])
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("");
}

/** 把 text 追加到最后一条 assistant 消息的末尾 text part */
function appendTextToLast(msgs: ChatMessage[], delta: string): ChatMessage[] {
  if (msgs.length === 0) return msgs;
  const lastIdx = msgs.length - 1;
  const last = msgs[lastIdx];
  if (last.role !== "assistant") return msgs;
  const content = [...((last.content as unknown) as AnyPart[])];
  const lp = content[content.length - 1];
  if (lp && lp.type === "text" && typeof lp.text === "string") {
    content[content.length - 1] = { ...lp, text: lp.text + delta };
  } else {
    content.push({ type: "text", text: delta });
  }
  return [...msgs.slice(0, lastIdx), { ...last, content: content as never }];
}

function appendToolCall(
  msgs: ChatMessage[],
  toolCallId: string,
  toolName: string,
  args: unknown,
): ChatMessage[] {
  if (msgs.length === 0) return msgs;
  const lastIdx = msgs.length - 1;
  const last = msgs[lastIdx];
  if (last.role !== "assistant") return msgs;
  const content = [
    ...((last.content as unknown) as AnyPart[]),
    {
      type: "tool-call",
      toolCallId,
      toolName,
      args: (args ?? {}) as Record<string, unknown>,
      argsText: safeStringify(args),
    },
  ];
  return [...msgs.slice(0, lastIdx), { ...last, content: content as never }];
}

/** 把 result 回填到匹配 toolCallId 的 tool-call part（同一 part 上） */
function fillToolResult(
  msgs: ChatMessage[],
  toolCallId: string,
  result: unknown,
  isError: boolean,
): ChatMessage[] {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== "assistant") continue;
    const content = [...((m.content as unknown) as AnyPart[])];
    const idx = content.findIndex(
      (p) => p.type === "tool-call" && p.toolCallId === toolCallId,
    );
    if (idx < 0) break;
    content[idx] = { ...content[idx], result, isError };
    const copy = [...msgs];
    copy[i] = { ...m, content: content as never };
    return copy;
  }
  return msgs;
}

/** 把最后一条 assistant 消息标记为 complete */
function completeLast(msgs: ChatMessage[]): ChatMessage[] {
  if (msgs.length === 0) return msgs;
  const lastIdx = msgs.length - 1;
  const last = msgs[lastIdx];
  if (last.role !== "assistant") return msgs;
  return [
    ...msgs.slice(0, lastIdx),
    { ...last, status: { type: "complete", reason: "stop" } },
  ];
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
