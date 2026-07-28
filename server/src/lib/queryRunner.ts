/**
 * 查询运行器 —— EventBus 的唯一事件生产者。
 *
 * 替代 routes 中直接 for-await + sendSSE + emitSessionEvent 的双写模式。
 * 所有事件统一 emit 到 EventBus，路由层只负责订阅并转发到 HTTP 客户端。
 */

import { runQuery, type RunQueryParams } from "./sdk.js";
import { emitSessionEvent, emitSessionEnd, emitSessionsChanged, emitSessionEnded, clearSessionBuffer } from "./eventBus.js";
import { setInflightWaiting, setInflightRunning, clearInflight } from "./inflight.js";
import { recordLastDuration } from "./store.js";
import { finalizeSession } from "./agentRegistry.js";
import type { SSEEvent } from "./types.js";

/**
 * 处理单个事件并 emit 到总线。
 * 包含：inflight 状态跟踪、done 事件的 token 累加。
 *
 * @returns 实际 emit 的事件（done 事件会替换为累加后的版本）
 */
export async function emitEventToBus(
  sessionId: string,
  evt: SSEEvent,
): Promise<SSEEvent> {
  // Inflight 状态跟踪（跳过终结事件和子代理事件）。
  // 仅在状态实际变化时广播 sessions-changed，避免每个 token 增量都通知。
  if (evt.type === "waiting_for_user") {
    if (setInflightWaiting(sessionId)) emitSessionsChanged();
  } else if (
    evt.type !== "done" &&
    evt.type !== "error"
  ) {
    if (setInflightRunning(sessionId)) emitSessionsChanged();
  }

  // done 事件：记录本轮 duration 后原样透传当轮 token 用量。
  // 会话级累计由 transcriptTokens 读 jsonl 计算（GET /:id），不在此累加。
  if (evt.type === "done") {
    await recordLastDuration(sessionId, evt.durationMs).catch(
      (err: unknown) => {
        console.warn(`[queryRunner] recordLastDuration failed for ${sessionId}:`, err instanceof Error ? err.message : err);
      },
    );
    emitSessionEvent(sessionId, evt);
    return evt;
  }

  emitSessionEvent(sessionId, evt);
  return evt;
}

/**
 * 运行查询，所有事件通过 EventBus 广播。
 *
 * @returns Promise，resolve 时查询已结束（事件已全部 emit，end 信号已发出）
 */
export async function runQueryToBus(
  sessionId: string,
  params: RunQueryParams,
): Promise<void> {
  const stream = runQuery(params);

  try {
    for await (const evt of stream) {
      await emitEventToBus(sessionId, evt);
    }
  } catch (err) {
    // 用户主动中止不是错误，不推 error 事件到前端
    if (err instanceof Error && err.name === "AbortError") {
      // 什么都不做，直接进入 finally
    } else {
      const message = err instanceof Error ? err.message : "unknown error";
      emitSessionEvent(sessionId, {
        type: "error",
        message,
      });
    }
  } finally {
    finalizeSession(sessionId);
    // 传入当前查询的 AbortController，防止旧请求的 finally
    // 误删已被新请求 setInflight 覆盖的 inflight 记录
    // clearInflight 返回「有→无」状态变化时，广播 session_ended，
    // 通知观察方窗口该会话的实时流已结束。
    if (clearInflight(sessionId, params.abortController)) emitSessionEnded(sessionId);
    clearSessionBuffer(sessionId);
    emitSessionEnd(sessionId);
    // 会话结束（running→completed），通知 Sidebar 刷新
    emitSessionsChanged();
  }
}
