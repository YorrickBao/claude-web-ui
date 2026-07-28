import { useCallback, useEffect, useRef, useState } from "react";
import {
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { createSession, sendMessage, respondToPermission, approvePlan, abortSession, resolveSessionByClient, listSessions } from "@/lib/api";
import { parseSSE } from "@/lib/sse";
import { uuid } from "@/lib/utils";
import { subscribeSessionStarted } from "@/lib/eventsChannel";
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
  /** 进行中的瞬态状态（压缩 / API 重试 / 限流），Header 用脉冲徽章展示。
   *  null = 无状态。done/error 时清除。 */
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [stats, setStats] = useState<{
    inputTokens: number;
    outputTokens: number;
    durationMs: number;
  } | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  /** 组件卸载标记：subscribe 重连循环据此退出，避免"僵尸"循环泄漏。
   *  仅在组件真正卸载（key 变化切会话/导航离开）时置 true，
   *  不能用 stop() 替代——stop() 会调 abortSession 杀掉别窗口正在跑的会话。 */
  const disposedRef = useRef(false);
  useEffect(() => {
    // 重置卸载标记：React StrictMode 在 dev 下会 mount→unmount→remount，
    // unmount 阶段会把 disposedRef 置 true，若不在此重置，remount 后的实例
    // 会误以为自己已卸载，导致 session_started 等回调全部被跳过。
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      // 中断当前 fetch，让 subscribe 循环尽快退出
      abortRef.current?.abort();
    };
  }, []);
  /** 用户是否主动点击了停止按钮：用于抑制后续所有 error 事件 */
  const stoppedByUserRef = useRef(false);
  /** 主动重连请求（区别于用户停止）：visibilitychange 冻结补偿时置 true，
   *  中断当前 fetch 后让循环走重连路径（带"重连中"徽章）而非直接终结。 */
  const reconnectRequestedRef = useRef(false);
  /** 最近一次收到流事件的时间戳，用于 visibilitychange 冻结补偿判定
   *  流是否疑似被浏览器冻结（长时间无事件 = 可能卡死）。 */
  const lastEventAtRef = useRef<number>(Date.now());
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
  /** isRunning 的 ref 镜像，供 lifecycle effect 闭包读取最新值，
   *  避免 isRunning 进依赖导致订阅 effect 反复重建。 */
  const isRunningRef = useRef(false);
  isRunningRef.current = isRunning;

  /**
   * 后台冻结补偿：标签切入后台时浏览器会冻结/暂停 JS 与网络，切回前台后
   * 进行中的 fetch 可能卡死（既不报错也不恢复）。切回可见时若距上次事件
   * 已超过 3 个心跳周期（~45s），判定流疑似被冻结，主动中断当前 fetch
   * 触发重连（走"重连中"徽章路径），而非干等永远不会到来的报错。
   * 用 ref 读最新值，避免闭包陈旧；不依赖 isRunning state（可能滞后）。
   */
  useEffect(() => {
    const FROZEN_THRESHOLD_MS = 45_000; // 3 × 15s 心跳
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (disposedRef.current || stoppedByUserRef.current) return;
      const sid = sessionIdRef.current;
      if (!sid || !isRunningRef.current) return;
      const elapsed = Date.now() - lastEventAtRef.current;
      if (elapsed > FROZEN_THRESHOLD_MS) {
        // 标记"重连请求"，中断当前 fetch；循环 catch 会走重连路径
        reconnectRequestedRef.current = true;
        abortRef.current?.abort();
      } else {
        // 未冻结：刷新事件时间戳，避免短时间内多次切换反复触发
        lastEventAtRef.current = Date.now();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

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

  /**
   * 仅本地断流，回到草稿态（pending）。与 stop() 的区别：
   * - 不调 abortSession：不打断后端正在跑的 SDK 查询，旧会话仍可从侧栏
   *   重新进入续看实时输出；
   * - 不设 stoppedByUserRef：这不是"用户主动停止"，只是切换上下文。
   *
   * 用于"从运行中会话点新建"等需要丢弃当前实时流、但不该杀掉后端查询的场景。
   */
  const detach = useCallback(() => {
    // 先重置 sessionIdRef：subscribe 循环的下个检查点据此发现 mismatch 而退出，
    // 退避 delay 期间 abort 不生效，也能在 delay 结束后据此退出，不复活。
    sessionIdRef.current = null;
    setActiveSessionId(null);
    // 中断当前活跃 fetch（POST / subscribe / plan 流共用 abortRef）。
    // 各流的 catch 对 AbortError 的处理都是"视为停止、不 handoff 到 subscribe"，
    // 故不会触发 subscribe 复活。
    abortRef.current?.abort();
    // 兜底同步重置运行态：abort 的 catch/finally 是异步的，且 subscribe 退避
    // delay 期间 abort 不生效，这里同步兜底，避免 pending 残留 isRunning=true。
    // （subscribe 退出后的 finally 也会再设一遍，幂等。）
    setIsRunning(false);
    setStatusMessage(null);
  }, []);

  const loadHistory = useCallback((history: ChatMessage[]) => {
    setMessages(history);
    setStats(null);
    setError(null);
    setStatusMessage(null);
    // 切会话/静态加载时重置时间戳，防上一轮空闲期的陈旧值在下一次
    // visibilitychange 时误触发冻结重连。
    lastEventAtRef.current = Date.now();
  }, []);

  /**
   * 订阅模式：用 GET SSE 连接到一个正在运行的会话，
   * 先接收完整历史（history 事件），再转到实时事件流。
   * 用于切回 inflight 会话时续上流式输出，也用于其它窗口作为观察方
   * 接入同一会话的实时广播。
   *
   * 含重连：流意外断开（未收到 done、非用户主动停止）且会话仍在跑时，
   * 经指数退避延迟后重新订阅。覆盖服务端 10 分钟安全超时与 relay/网络抖动。
   * 组件卸载时 disposedRef 置 true 并 abort，循环随即退出，避免僵尸泄漏。
   */
  const subscribe = useCallback(async (targetSessionId: string) => {
    setError(null);
    setIsRunning(true);
    // 同步更新 ref：setIsRunning 是异步的（下次 render 才生效），但挂载 effect 的
    // session_started 监听与 querySessionStatus 兜底可能在此期间到达，若 ref 未同步
    // 会双双通过 !isRunningRef.current 闸门，触发两次 subscribe（双重消费）。
    isRunningRef.current = true;
    sessionIdRef.current = targetSessionId;
    setActiveSessionId(targetSessionId);
    lastEventAtRef.current = Date.now(); // 重置，防陈旧值触发误冻结重连
    window.dispatchEvent(new CustomEvent("session-list-changed"));

    let consecutiveFailures = 0;
    let reconnectDelay = SUBSCRIBE_RECONNECT_DELAY_MS;

    try {
      for (;;) {
        // 组件卸载，或会话已切走（sessionIdRef 被 detach/新 subscribe 重置）
        // → 静默退出，不触碰已卸载/已切换的状态
        if (disposedRef.current || sessionIdRef.current !== targetSessionId) break;

        const ctrl = new AbortController();
        abortRef.current = ctrl;
        let doneReceived = false;
        let streamError: string | null = null;

        try {
          const res = await fetch(
            `api/sessions/${encodeURIComponent(targetSessionId)}/stream`,
            { signal: ctrl.signal },
          );

          if (!res.ok || !res.body) {
            const errText = await res.text().catch(() => "");
            throw new Error(`HTTP ${res.status} ${errText}`.trim());
          }

          // 流成功建立：重置失败计数与退避
          consecutiveFailures = 0;
          reconnectDelay = SUBSCRIBE_RECONNECT_DELAY_MS;
          // 重连成功：清掉"重连中…"提示（若有）。SDK 的 status 事件
          // （压缩/重试）也会经此通道，这里只清重连标记，不影响它们。
          setStatusMessage(null);

          for await (const evt of parseSSE(res.body, ctrl.signal)) {
            // 标记正常结束，用于区分"意外断开"与"会话跑完"
            if (evt.type === "done") doneReceived = true;
            lastEventAtRef.current = Date.now();
            handleSSEEvent(evt, targetSessionId);
          }
        } catch (err) {
          const e = err as Error;
          if (e.name === "AbortError") {
            // 冻结补偿主动发起的重连请求：不当作"用户停止"终结，
            // 清掉标记后落到下面的 querySessionStatus 重连路径（带"重连中"徽章）。
            if (reconnectRequestedRef.current) {
              reconnectRequestedRef.current = false;
              // streamError 留空，重连判定不依赖具体错误文本
            } else {
              // 组件卸载（disposedRef）或用户主动停止：终结并退出
              if (!disposedRef.current) {
                setMessages((prev) => completeLast(prev));
              }
              break;
            }
          } else {
            // 非 abort 的网络/HTTP 错误：交给下面的重连判定
            streamError = e.message;
          }
        }

        if (disposedRef.current || sessionIdRef.current !== targetSessionId) break;
        if (doneReceived) break; // 会话正常结束

        // 意外断开（无 done）：查会话状态决定重连或终结。
        // 三态：running 仍在跑→重连；ended 确已结束→终结；
        //       unknown 查询本身失败（同一次网络抖动波及 listSessions）→
        //       不能贸然终结观察方，按重连处理。
        const status = await querySessionStatus(targetSessionId);
        if (disposedRef.current || sessionIdRef.current !== targetSessionId) break;

        if (status === "running" || status === "unknown") {
          consecutiveFailures++;
          // 进入重连：给用户可见反馈。复用 statusMessage 脉冲徽章通道，
          // 下次流成功建立时清除。重连期间流已断，不会和 SDK 的压缩/重试
          // status 信号冲突。
          setStatusMessage("连接已断开，正在重连…");
          if (consecutiveFailures > MAX_SUBSCRIBE_RECONNECTS) {
            // 连续失败超上限：放弃，避免对 stale/异常会话无限重连打服务器
            if (!stoppedByUserRef.current && streamError) {
              setError(streamError);
            }
            setMessages((prev) => completeLast(prev));
            break;
          }
          await delay(reconnectDelay);
          // 退避期间组件卸载 / 会话切走 / 用户停止 → 退出
          if (
            disposedRef.current ||
            sessionIdRef.current !== targetSessionId ||
            stoppedByUserRef.current
          )
            break;
          reconnectDelay = Math.min(
            reconnectDelay * SUBSCRIBE_BACKOFF_FACTOR,
            SUBSCRIBE_MAX_DELAY_MS,
          );
          continue;
        }
        // status === "ended"：会话确已结束（done 未送达的竞态等），终结
        setMessages((prev) => completeLast(prev));
        break;
      }
    } finally {
      setIsRunning(false);
      // 兜底清掉重连/压缩等任何残留瞬态提示（用户停止/会话终结/卸载都走这里）
      setStatusMessage(null);
      reconnectRequestedRef.current = false; // 防残留标记影响下次订阅
      abortRef.current = null;
      window.dispatchEvent(new CustomEvent("session-list-changed"));
    }
  }, []);

  // 观察方接入实时流的核心机制：订阅全局总线的 session_started 信号。
  // 当别的窗口（本地第二标签页 / 远程端）在该会话发了消息，后端广播
  // session_started，本窗口收到且 sessionId 匹配时，自动 subscribe 接入
  // GET /:id/stream 实时流。取代原先靠 sessions_changed 拉状态再翻转推断的脆弱链路。
  // !isRunningRef.current 闸门：发消息方自身（POST 期间 isRunning=true）不重复订阅。
  useEffect(() => {
    const unsub = subscribeSessionStarted((sid) => {
      // 不检查 disposedRef：StrictMode/HMR 下 disposedRef 状态不可靠。
      // subscribe 内部循环首句即检查 disposedRef.current 并退出，无副作用。
      if (sid && sid === sessionIdRef.current && !isRunningRef.current) {
        void subscribe(sid);
      }
    });
    // 竞态兜底：若本组件挂载时（ChatView 懒加载，尤其经 relay 有延迟）会话已经在跑，
    // session_started 信号可能在监听器注册前就已发出并被丢弃。注册后立即查一次状态，
    // running 则补订阅。与上面的监听器互斥（isRunningRef 闸门）不会重复。
    const sid = sessionIdRef.current;
    if (sid && !isRunningRef.current && !disposedRef.current) {
      void querySessionStatus(sid).then((status) => {
        if (
          !disposedRef.current &&
          !isRunningRef.current &&
          (status === "running" || status === "unknown")
        ) {
          void subscribe(sid);
        }
      });
    }
    return unsub;
  }, [subscribe]);

  /**
   * 共享的 SSE 事件处理。供 subscribe 和 plan approval 续流复用。
   *
   * 此函数是组件内的普通函数（非 hook），在每次 render 中重新创建闭包。
   * 它依赖的 setMessages / setError / setStats 是 React useState 的 setter，
   * React 保证其引用稳定，因此闭包重新创建不会导致 stale state 问题。
   * 同理，onPermissionRef / onPlanRef / onModeRef 通过 ref.current 读取最新值。
   */
  function handleSSEEvent(evt: SSEEvent, targetSessionId: string) {
    // 所有流（subscribe GET 流 + onNew POST 流 + plan 续流）的事件都经此，
    // 在此刷新时间戳，确保冻结补偿能正确感知活跃事件（POST 流期间 subscribe
    // 循环没跑，否则会误判冻结）。
    lastEventAtRef.current = Date.now();
    switch (evt.type) {
      case "history":
        setMessages(evt.messages as ChatMessage[]);
        break;
      case "user_message":
        setMessages((prev) => appendUserMessage(prev, evt.text));
        break;
      case "text":
        setMessages((prev) => appendTextToLast(prev, evt.text));
        break;
      case "thinking":
        setMessages((prev) => appendThinkingToLast(prev, evt.text));
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
        setStatusMessage(null); // 出错：清掉瞬态提示，error 自己会显示
        // 正式化错误状态：把最后一条 assistant 标为 error，而非文本拼接
        setMessages((prev) => errorLast(prev, evt.message));
        break;
      case "status":
        setStatusMessage(evt.kind === "idle" ? null : evt.message);
        break;
      case "done":
        setStats({
          inputTokens: evt.inputTokens,
          outputTokens: evt.outputTokens,
          durationMs: evt.durationMs,
        });
        setStatusMessage(null); // 终结：清掉压缩/重试等瞬态提示
        // 把本回合最终答案的 assistant uuid 盖到最后一条 assistant 消息上，
        // 供"从此处分叉"使用（forkSession 的 upToMessageId）。历史回放时
        // replay 已在 ReplayMessage 上带 assistantUuid，无需这里处理。
        if (evt.lastAssistantUuid) {
          const uuid = evt.lastAssistantUuid;
          setMessages((prev) => stampAssistantUuid(prev, uuid));
        }
        setMessages((prev) => completeLast(prev));
        break;
      case "step_start":
        // agentic 步骤开始标记。当前仅作协议层语义边界，不改 messages state：
        // 分组完全由 ChatThread 的 groupPartByType 按相邻 part 类型 coalesce 实现，
        // 不依赖 step 事件。保留 case 以通过 TS 联合穷尽性检查，并刷新 lastEventAtRef
        // （顶部已统一处理，冻结补偿依赖它感知活跃事件）。
        break;
      case "step_end":
        // agentic 步骤结束标记。语义同 step_start，前端不消费。
        break;
      case "waiting_for_user":
        break;
      case "session_created":
        // 仅在新建会话场景（之前无 sessionId）触发 onCreated 回调（navigate 到 /c/:id）。
        // 观察方/续聊场景下 sessionId 已知，SDK 的 system/init 也会产生本事件，
        // 此时触发 onCreated 会 navigate 到同一路径导致组件重载，把正在接收的实时流冲掉。
        {
          const wasNew = sessionIdRef.current !== evt.sessionId;
          sessionIdRef.current = evt.sessionId;
          setActiveSessionId(evt.sessionId);
          if (wasNew) onCreatedRef.current?.(evt.sessionId);
        }
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
                  handleSSEEvent(evt2, sid);
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
    setStatusMessage(null);
    setIsRunning(true);
    // 同步更新 ref：setIsRunning 是异步的（下次 render 才生效），但 session_started
    // 信号经 EventSource 宏任务到达时可能早于 re-render，导致 isRunningRef 仍为 false，
    // 误触发 subscribe 与 POST 流双重消费。这里手动同步 ref 堵住窗口。
    isRunningRef.current = true;
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
      const clientId = uuid();
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
        // 冻结补偿主动发起的重连请求：POST 流被中断，但查询仍在后端跑，
        // 不能当 user-stop 终结——清掉标记后走 handoff 续流（同网络断线）。
        const isReconnectRequest = reconnectRequestedRef.current && e.name === "AbortError";
        if (isReconnectRequest) reconnectRequestedRef.current = false;
        // user-stop = AbortError 但不是冻结重连，或显式 stoppedByUserRef
        const isUserStop = !isReconnectRequest && (e.name === "AbortError" || stoppedByUserRef.current);
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
          // 兜底收尾：若 POST 流异常结束（未收到 done 也没抛错，如后端提前 endSSE、
          // 中间代理截断），占位 assistant 会卡在 status:running。completeLast 把它
          // 标记为完成，避免 UI 上 isRunning=false 但气泡仍转圈的状态不一致。
          setMessages((prev) => completeLast(prev));
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
    statusMessage,
    stats,
    stop,
    detach,
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

/** subscribe() 意外断开后首次重连的等待时间 */
const SUBSCRIBE_RECONNECT_DELAY_MS = 500;
/** 退避上限 */
const SUBSCRIBE_MAX_DELAY_MS = 30_000;
/** 退避因子 */
const SUBSCRIBE_BACKOFF_FACTOR = 2;
/** 连续重连失败上限：超过则放弃，避免对 stale/异常会话无限打服务器 */
const MAX_SUBSCRIBE_RECONNECTS = 8;

/** 简单延时 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 查会话状态，用于重连判定。三态：
 * - "running"：会话仍在跑（running / waiting）→ 重连
 * - "ended"：查询成功且会话已结束（idle / completed）→ 终结
 * - "unknown"：查询本身失败（网络抖动）→ 不能贸然终结观察方，按重连处理
 */
async function querySessionStatus(
  sid: string,
): Promise<"running" | "ended" | "unknown"> {
  try {
    const list = await listSessions();
    const s = list.find((x) => x.sessionId === sid);
    if (!s) return "ended";
    if (s.runningStatus === "running" || s.runningStatus === "waiting") {
      return "running";
    }
    return "ended";
  } catch {
    return "unknown";
  }
}

/** 把 text 追加到最后一条 assistant 消息的末尾 text part */
function appendTextToLast(msgs: ChatMessage[], delta: string): ChatMessage[] {
  const withTail = ensureAssistantTail(msgs);
  const lastIdx = withTail.length - 1;
  const last = withTail[lastIdx];
  const content = [...((last.content as unknown) as AnyPart[])];
  const lp = content[content.length - 1];
  if (lp && lp.type === "text" && typeof lp.text === "string") {
    content[content.length - 1] = { ...lp, text: lp.text + delta };
  } else {
    content.push({ type: "text", text: delta });
  }
  return [...withTail.slice(0, lastIdx), { ...last, content: content as never }];
}

// 确保最后一条是处于 running 态的 assistant 消息，没有则补一个空占位。
// 观察方/续流场景：subscribe 时若转录尚未落盘，history 为空，后续 thinking/text
// 增量无 assistant 消息可追加。这里自动补占位，让流式输出有载体。
function ensureAssistantTail(msgs: ChatMessage[]): ChatMessage[] {
  const last = msgs[msgs.length - 1];
  if (last && last.role === "assistant") return msgs;
  return [
    ...msgs,
    {
      role: "assistant",
      content: [{ type: "text", text: "" }],
      status: { type: "running" },
    },
  ];
}

/**
 * 追加一条 user 消息。带去重：发消息方在 onNew 里已乐观写入 user 消息
 * （后跟 assistant placeholder），POST 流随后又 emit user_message 事件。
 * 此时该 user 消息不在末尾（被 placeholder 挤到前面），所以只查"末尾"会漏。
 * 这里检查最后两条：若已有相同文本的 user 消息（乐观写入紧贴当前轮）则跳过。
 * 只查最后两条而非全表——避免误删用户合法的重复输入（如连发两次"继续"）。
 */
function appendUserMessage(msgs: ChatMessage[], text: string): ChatMessage[] {
  const isSameUserText = (m: ChatMessage | undefined): boolean =>
    !!m &&
    m.role === "user" &&
    Array.isArray(m.content) &&
    (m.content as unknown[]).length === 1 &&
    ((m.content as unknown[])[0] as { type?: string; text?: string })?.type === "text" &&
    ((m.content as unknown[])[0] as { type?: string; text?: string })?.text === text;
  // 乐观写入的 user 消息可能在末尾，也可能被 placeholder 挤到倒数第二
  if (isSameUserText(msgs[msgs.length - 1]) || isSameUserText(msgs[msgs.length - 2])) {
    return msgs;
  }
  return [...msgs, { role: "user", content: [{ type: "text", text }] }];
}

/** 把 thinking 增量追加到最后一条 assistant 消息的末尾 reasoning part */
function appendThinkingToLast(msgs: ChatMessage[], delta: string): ChatMessage[] {
  const withTail = ensureAssistantTail(msgs);
  const lastIdx = withTail.length - 1;
  const last = withTail[lastIdx];
  const content = [...((last.content as unknown) as AnyPart[])];
  const lp = content[content.length - 1];
  if (lp && lp.type === "reasoning" && typeof lp.text === "string") {
    content[content.length - 1] = { ...lp, text: lp.text + delta };
  } else {
    content.push({ type: "reasoning", text: delta });
  }
  return [...withTail.slice(0, lastIdx), { ...last, content: content as never }];
}

function appendToolCall(
  msgs: ChatMessage[],
  toolCallId: string,
  toolName: string,
  args: unknown,
): ChatMessage[] {
  const withTail = ensureAssistantTail(msgs);
  const lastIdx = withTail.length - 1;
  const last = withTail[lastIdx];
  const existing = (last.content as unknown) as AnyPart[];
  // 幂等：内存缓冲重放或重连可能再次发来同一 tool_use。若该 toolCallId 已存在，
  // 替换（更新参数）而非追加，避免 assistant-ui 的 Duplicate key 报错白屏。
  const dupIdx = existing.findIndex(
    (p) => p.type === "tool-call" && (p as { toolCallId?: string }).toolCallId === toolCallId,
  );
  const newPart = {
    type: "tool-call",
    toolCallId,
    toolName,
    args: (args ?? {}) as Record<string, unknown>,
    argsText: safeStringify(args),
  };
  const content =
    dupIdx >= 0
      ? existing.map((p, i) => (i === dupIdx ? newPart : p))
      : [...existing, newPart];
  return [...withTail.slice(0, lastIdx), { ...last, content: content as never }];
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

/** 把本回合最终答案的 transcript uuid 盖到最后一条 assistant 消息的
 *  metadata.custom.assistantUuid 上（assistant-ui 的 fromThreadMessageLike
 *  只保留 metadata.custom 等已知字段，顶层自定义字段会被丢弃）。 */
function stampAssistantUuid(
  msgs: ChatMessage[],
  assistantUuid: string,
): ChatMessage[] {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role !== "assistant") continue;
    const last = msgs[i];
    const meta =
      (last as { metadata?: { custom?: Record<string, unknown> } }).metadata ??
      {};
    const custom = meta.custom ?? {};
    return [
      ...msgs.slice(0, i),
      {
        ...last,
        metadata: { ...meta, custom: { ...custom, assistantUuid } },
      },
      ...msgs.slice(i + 1),
    ];
  }
  return msgs;
}

/** 把最后一条 assistant 消息标记为错误（incomplete + error，保留已有 content） */
function errorLast(msgs: ChatMessage[], message: string): ChatMessage[] {
  if (msgs.length === 0) return msgs;
  const lastIdx = msgs.length - 1;
  const last = msgs[lastIdx];
  if (last.role !== "assistant") return msgs;
  return [
    ...msgs.slice(0, lastIdx),
    {
      ...last,
      status: { type: "incomplete", reason: "error", error: message },
    },
  ];
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
