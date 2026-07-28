import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  getSession,
  syncAndListSessions,
  upsertSession,
  touchSession,
  deleteSessionRecord,
  listProfiles,
  createProfile,
  updateProfile,
  deleteProfile,
  reorderProfiles,
  resolveSessionEnv,
  resolveProfileEnv,
  setSessionProfile,
} from "../lib/store.js";
import { runQuery, renameSession, forkSession, getSessionInfo, listSessions as sdkListSessions, listSubagents } from "../lib/sdk.js";
import { runQueryToBus, emitEventToBus } from "../lib/queryRunner.js";
import { deleteSession } from "@anthropic-ai/claude-agent-sdk";
import { initSSE, sendSSE, endSSE } from "../lib/sse.js";
import {
  setInflight,
  clearInflight,
  getInflight,
  getInflightStatus,
  getInflightStartedAt,
  takePendingPermission,
  getPendingPermissions,
  rememberClientSession,
  resolveClientSession,
} from "../lib/inflight.js";
import type {
  CreateSessionRequest,
  SendMessageRequest,
  SessionView,
  PermissionMode,
  EffortLevel,
  SSEEvent,
} from "../lib/types.js";
import { replaySession } from "../lib/replay.js";
import {
  startRelayTunnel,
  stopRelayTunnel,
  getRelayStatus,
  setLocalBase,
  mintToken,
  type RelayConfig,
} from "../channels/relay.js";
import { getDevices, recordDevice, removeDevice } from "../lib/relayDevices.js";
import { DATA_DIR } from "../env.js";
import { emitSessionEvent, emitSessionEnd, emitSessionsChanged, emitSessionStarted, emitSessionEnded, onSessionEvent, onSessionEnd, onRelayStatus, onSessionsChanged, onSessionLifecycle, onDeviceChanged, getSessionBuffer, clearSessionBuffer } from "../lib/eventBus.js";
import { startZombieScanner, finalizeSession, cleanupSession } from "../lib/agentRegistry.js";
import { getClaudeVersion } from "../lib/version.js";

// 启动僵尸子代理扫描器（全局单例）
startZombieScanner();

/** 从 SDK 的 SDKSessionInfo 中解析出显示标题 */
function resolveSdkTitle(sdk: { customTitle?: string; summary?: string }): string {
  return sdk.customTitle || sdk.summary || "（无标题）";
}

export async function apiRoutes(app: FastifyInstance): Promise<void> {
  // ───────────────────────────────────────────────────────────
  // GET /api/sessions —— 列出所有会话（实时同步 CLI 磁盘，标题来自 SDK）
  // ───────────────────────────────────────────────────────────
  app.get("/api/sessions", async (_req, reply) => {
    const records = await syncAndListSessions();
    // 取 SDK 标题映射（一次 SDK 调用，O(1) 查询）
    const sdkAll = await sdkListSessions();
    const sdkMap = new Map(sdkAll.map((s) => [s.sessionId, s]));

    const views: SessionView[] = records.map((r) => {
      const sdk = sdkMap.get(r.sessionId);
      return {
        sessionId: r.sessionId,
        cwd: r.cwd,
        title: sdk ? resolveSdkTitle(sdk) : "（无标题）",
        createdAt: r.createdAt,
        lastModified: r.lastModified,
        profileId: r.profileId ?? null,
        runningStatus:
          getInflightStatus(r.sessionId) ??
          ((r.inputTokens ?? 0) + (r.outputTokens ?? 0) > 0
            ? "completed"
            : "idle"),
        permissionMode: r.permissionMode ?? "default",
        effortLevel: r.effortLevel ?? "default",
        inputTokens: r.inputTokens ?? 0,
        outputTokens: r.outputTokens ?? 0,
        lastDurationMs: r.lastDurationMs ?? 0,
        currentTurnStartedAt: getInflightStartedAt(r.sessionId) ?? 0,
      };
    });
    return reply.send({ sessions: views });
  });

  // GET /api/events/stream —— 全局消息总线（SSE，单条长连接）
  // 收敛所有「全局低频控制面信号」到一条连接：
  //   - sessions_changed：会话列表/状态变更（无负载）
  //   - relay_status：远程控制隧道状态快照
  //   - session_started/session_ended：会话查询生命周期（带 sessionId），
  //     驱动观察方窗口接入 GET /:id/stream 实时流
  // 原则：新出现的全局信号一律复用本端点（追加事件类型 + bus 频道），不要再开新的 SSE
  // 长连接（见 AGENTS.md「SSE 端点纪律」）。会话级高频数据流走独立的
  // GET /api/sessions/:id/stream，不并入本端点。
  // 前端 eventsChannel.ts 把本端点收敛为模块级单例 EventSource，全应用共享一条连接。
  app.get("/api/events/stream", async (_req, reply) => {
    initSSE(reply);

    // 远程设备上下线：把设备在线状态绑定到这条 SSE 长连接的生命周期。
    // 仅经 relay 转发的请求（X-CWU-Via 头）才登记——本地连接不算"远程设备"。
    const isRemote = _req.headers["x-cwu-via"] === "relay";
    const ua = (_req.headers["user-agent"] as string) ?? "";
    const ip = (_req.headers["x-real-ip"] as string) || _req.ip;
    if (isRemote && (ua || ip)) {
      recordDevice(ua, ip);
    }

    // 订阅瞬间先各发一帧，覆盖订阅期间可能错过的变更
    sendSSE(reply, { type: "sessions_changed" });
    sendSSE(reply, { type: "relay_status", status: await getRelaySnapshot() });
    sendSSE(reply, { type: "device_changed", devices: getDevices() });

    const unsubSessions = onSessionsChanged(() => {
      try {
        sendSSE(reply, { type: "sessions_changed" });
      } catch (err) {
        console.warn("[events] sessions_changed sendSSE error:", err instanceof Error ? err.message : err);
      }
    });
    const unsubRelay = onRelayStatus((s) => {
      try {
        sendSSE(reply, { type: "relay_status", status: s });
      } catch (err) {
        console.warn("[events] relay_status sendSSE error:", err instanceof Error ? err.message : err);
      }
    });
    // 会话查询生命周期（开始/结束）：精确带 sessionId，驱动观察方接入实时流。
    // 不发订阅瞬间首帧——观察方挂载时若会话已在跑，由 GET :id 的 runningStatus 兜底。
    const unsubLifecycle = onSessionLifecycle((evt) => {
      try {
        sendSSE(reply, evt);
      } catch (err) {
        console.warn("[events] session-lifecycle sendSSE error:", err instanceof Error ? err.message : err);
      }
    });
    const unsubDevice = onDeviceChanged((d) => {
      try {
        sendSSE(reply, { type: "device_changed", devices: d });
      } catch (err) {
        console.warn("[events] device_changed sendSSE error:", err instanceof Error ? err.message : err);
      }
    });

    // 心跳防中间代理 idle 关闭
    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(": ping\n\n");
      } catch { /* 连接已断 */ }
    }, 15000);

    _req.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubSessions();
      unsubRelay();
      unsubLifecycle();
      unsubDevice();
      if (isRemote && (ua || ip)) {
        removeDevice(ua, ip);
      }
    });
  });

  // ───────────────────────────────────────────────────────────
  // GET /api/sessions/:id —— 单会话详情（标题来自 SDK）
  // ───────────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id",
    async (req, reply) => {
      const rec = await getSession(req.params.id);
      if (!rec) {
        return reply.code(404).send({ error: "session not found" });
      }
      // SDK 标题
      const sdkInfo = await getSessionInfo(rec.sessionId, { dir: rec.cwd });
      const title = sdkInfo ? resolveSdkTitle(sdkInfo) : "（无标题）";
      // 拉历史消息（SDK 转录）。失败不致命 —— 返回空数组，前端照常能用
      let history: Awaited<ReturnType<typeof replaySession>> = [];
      try {
        history = await replaySession(rec.sessionId, rec.cwd);
      } catch (err) {
        app.log.warn(
          { err },
          `replaySession failed for ${rec.sessionId}`,
        );
      }
      return reply.send({
        sessionId: rec.sessionId,
        cwd: rec.cwd,
        title,
        createdAt: rec.createdAt,
        lastModified: rec.lastModified,
        profileId: rec.profileId ?? null,
        permissionMode: rec.permissionMode ?? "default",
        effortLevel: rec.effortLevel ?? "default",
        runningStatus:
          getInflightStatus(rec.sessionId) ??
          ((rec.inputTokens ?? 0) + (rec.outputTokens ?? 0) > 0
            ? "completed"
            : "idle"),
        inputTokens: rec.inputTokens ?? 0,
        outputTokens: rec.outputTokens ?? 0,
        lastDurationMs: rec.lastDurationMs ?? 0,
        currentTurnStartedAt: getInflightStartedAt(rec.sessionId) ?? 0,
        messages: history,
      });
    },
  );

  // ───────────────────────────────────────────────────────────
  // GET /api/sessions/:id/stream —— 订阅会话实时 SSE 流
  //
  // 先 replay 全部历史消息，然后通过 EventBus 订阅后续实时事件。
  //
  // 为避免 replay 期间的事件丢失，订阅后先将事件暂存到缓冲区，
  // replay 完成后对缓冲区事件去重（工具事件按 ID，文本增量按累
  // 计长度），再切换到实时转发模式。
  // ───────────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id/stream",
    async (req, reply) => {
      const sessionId = req.params.id;
      const rec = await getSession(sessionId);
      if (!rec) {
        return reply.code(404).send({ error: "session not found" });
      }

      initSSE(reply);

      // 安全超时：防止 TCP 异常断开（无 FIN）导致监听器永不清理。
      // 10 分钟足够覆盖绝大多数 SDK 查询，超时后强制关闭。
      const TIMEOUT_MS = 10 * 60 * 1000;
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        app.log.warn(`stream timeout for session ${sessionId}, forcing close`);
        cleanup();
        try { endSSE(reply); } catch { /* 可能已经 close */ }
      }, TIMEOUT_MS);

      // 阶段1：订阅 bus，暂存所有事件到缓冲区（不丢弃）
      const buffer: SSEEvent[] = [];
      let buffering = true;
      // 会话在 replay 期间结束：不能立即关闭流，否则后续 sendSSE(history)
      // 会写已关闭的流（write-after-end）。先标记，待 replay 完成后由正常
      // 流程 flush buffer 并经 getInflight 检查兜底关闭。
      let endedDuringReplay = false;

      const onEvent = (evt: SSEEvent) => {
        if (buffering) {
          buffer.push(evt);
        } else {
          sendSSE(reply, evt);
        }
      };
      const unsubEvent = onSessionEvent(sessionId, onEvent);

      // 心跳防中间代理 idle 关闭：会话在等待权限/SDK 思考期间可能数十秒无事件，
      // 远程链路（nginx/relay）若无数据会被当作 idle 切断，触发前端秒级重连风暴。
      // 与全局总线 /api/events/stream 对齐，15s 发一行 SSE 注释。
      const heartbeat = setInterval(() => {
        try { reply.raw.write(": ping\n\n"); } catch { /* 连接已断 */ }
      }, 15000);

      let unsubEnd: () => void;
      const cleanup = () => {
        clearTimeout(timeout);
        clearInterval(heartbeat);
        unsubEvent();
        unsubEnd();
      };

      unsubEnd = onSessionEnd(sessionId, () => {
        if (buffering) {
          // replay 尚未完成：延后关闭，避免 write-after-end
          endedDuringReplay = true;
        } else {
          cleanup();
          try { endSSE(reply); } catch { /* 可能已经 close */ }
        }
      });

      // 客户端正常断开时清理（仅注册一次）
      req.raw.on("close", cleanup);

      // 阶段2+3：回放历史 + 切实时模式
      //
      // 两条路径（按 inflight 状态判定，不按缓冲是否存在——避免 setInflight 后、
      // 首个事件 emit 前的窗口里观察方走错到滞后的磁盘 replay 路径）：
      // - inflight（会话正在跑）：用内存事件缓冲（getSessionBuffer）重放。
      //   SDK 磁盘转录在 running 期间写入滞后/批量，不可靠；内存缓冲与 bus 事件
      //   实时同步。直接逐个发给前端，前端增量追加。不发 history——观察端可能已
      //   通过 GET :id 持有前几轮历史，发 history 会清空它们。
      // - 非 inflight（历史会话）：磁盘 replay 重建 ChatMessage[]，发 history 整体替换。
      try {
        const isInflight = !!getInflight(sessionId);
        if (isInflight) {
          // inflight 路径：直接逐个重放内存缓冲事件，前端增量追加。
          // 内存缓冲只含当前 inflight 轮次（上一轮结束时已 clearSessionBuffer），追加不重复。
          const memBuf = getSessionBuffer(sessionId);
          if (memBuf) {
            for (const evt of memBuf) {
              sendSSE(reply, evt);
            }
          }
        } else {
          // 非 inflight：走磁盘 replay
          const history = await replaySession(sessionId, rec.cwd);
          if (timedOut) return;

          // 从 history 提取：工具 ID 集合 + 最后一条 assistant 消息文本长度
          const historyToolIds = new Set<string>();
          let lastTextLen = 0;
          for (let i = history.length - 1; i >= 0; i--) {
            if (history[i].role === "assistant") {
              for (const part of history[i].content) {
                if (part.type === "tool-call") {
                  historyToolIds.add(part.toolCallId);
                } else if (part.type === "text") {
                  lastTextLen += part.text.length;
                }
              }
              break;
            }
          }

          sendSSE(reply, { type: "history", messages: history });

          // 去重转发缓冲区事件（仅磁盘路径需要——history 来自滞后转录，
          // buffer 里可能有与之重叠的事件）
          let textAccum = 0;
          for (const evt of buffer) {
            if (
              (evt.type === "tool_use" || evt.type === "tool_result") &&
              historyToolIds.has(evt.id)
            ) {
              continue;
            }
            if (evt.type === "text") {
              textAccum += evt.text.length;
              if (textAccum <= lastTextLen) continue;
              if (textAccum - evt.text.length < lastTextLen) {
                const overlap = lastTextLen - (textAccum - evt.text.length);
                const newPart = evt.text.slice(overlap);
                if (newPart) sendSSE(reply, { type: "text", text: newPart });
                continue;
              }
            }
            sendSSE(reply, evt);
          }
        }

        // 切到实时模式
        buffering = false;

        // 重连补播待审批权限请求（用户刷新/切回）。
        // 仅非 inflight 路径需要——inflight 路径的内存缓冲已包含 permission_request
        // 事件，再补播会重复，导致前端出现两个相同 requestId 的审批横幅。
        if (!isInflight) {
          for (const pending of getPendingPermissions(sessionId)) {
            sendSSE(reply, {
              type: "permission_request",
              requestId: pending.requestId,
              toolName: pending.toolName,
              toolInput: pending.toolInput,
              decisionReason: pending.decisionReason,
            });
          }
        }

        // 如果会话没在运行（竞态：刚好在 replay 期间结束），关闭。
        if (endedDuringReplay || !getInflight(sessionId)) {
          cleanup();
          try { endSSE(reply); } catch { /* 可能已经 close */ }
          return;
        }
      } catch (err) {
        app.log.warn({ err }, `replaySession failed in stream for ${sessionId}`);
        if (!timedOut) {
          sendSSE(reply, { type: "error", message: `replay failed: ${err}` });
        }
        cleanup();
        try { endSSE(reply); } catch { /* 可能已经 close */ }
        return;
      }
    },
  );

  // ───────────────────────────────────────────────────────────
  // POST /api/sessions —— 新建会话并跑首条消息（SSE）
  //
  // 事件处理通过 emitEventToBus 统一完成（inflight 跟踪、token 累加、
  // 总线发射）。session_created 之后订阅总线，后续事件由总线转发，
  // 不再直接 sendSSE，消除双写。
  // ───────────────────────────────────────────────────────────
  app.post<{
    Body: CreateSessionRequest;
  }>("/api/sessions", {
    // 关掉 fastify 默认的 body 大小 / 类型限制对 SSE 的影响
    config: { rawBody: false },
  }, async (req: FastifyRequest<{ Body: CreateSessionRequest }>, reply: FastifyReply) => {
    const body = req.body;
    if (!body?.cwd || typeof body.cwd !== "string") {
      return reply.code(400).send({ error: "cwd is required" });
    }
    if (!body?.message || typeof body.message !== "string") {
      return reply.code(400).send({ error: "message is required" });
    }

    // 校验 cwd 存在且是目录
    try {
      const stat = await fsp.stat(body.cwd);
      if (!stat.isDirectory()) {
        return reply.code(400).send({ error: "cwd is not a directory" });
      }
    } catch {
      return reply.code(400).send({ error: "cwd does not exist" });
    }

    initSSE(reply);
    const ctrl = new AbortController();
    let sessionId: string | undefined;
    const profileId = body.profileId ?? null;
    const permissionMode = body.permissionMode ?? "default";
    const effortLevel = body.effortLevel ?? "default";
    const clientId = body.clientId ?? null;
    /** 总线订阅取消函数（session_created 后赋值，finally 中清理） */
    let unsubBusEvents: (() => void) | null = null;
    /** HTTP 连接是否已关闭。关闭后不再向 reply 写：查询照常跑，事件继续进总线 + transcript，前端会自动重连续流。 */
    let closed = false;

    // 查询生命周期独立于 HTTP 连接：只有 POST /abort（用户点停止）或
    // DELETE（删会话）才取消查询。连接断开只停止向这条死连接转发事件，
    // SDK 继续跑到自然结束，事件经 emitEventToBus 写入总线 +
    // transcript，重连的客户端经 GET /stream 的 replaySession 补全。
    req.raw.on("close", () => {
      closed = true;
      unsubBusEvents?.();
    });
    try {
      const stream = runQuery({
        cwd: body.cwd,
        prompt: body.message,
        abortController: ctrl,
        permissionMode,
        effortLevel,
        // 新会话：env 来自用户选的 profile（可能为空）
        env: await resolveProfileEnv(profileId),
      });

      // 新会话要等拿到 session_created 才能登记 inflight + store
      let registered = false;

      const register = async (id: string) => {
        sessionId = id;
        if (setInflight(id, ctrl)) emitSessionStarted(id);
        // 记录 clientId→sessionId 映射，供断线重连时反查 sessionId 续流
        if (clientId) rememberClientSession(clientId, id);
        // 标题：用户指定的优先，其次用首条消息截断
        const initialTitle =
          body.title?.trim() || body.message.trim().slice(0, 200) || null;
        await upsertSession({
          sessionId: id,
          cwd: body.cwd,
          createdAt: Date.now(),
          lastModified: Date.now(),
          profileId,
          permissionMode,
          effortLevel,
          inputTokens: 0,
          outputTokens: 0,
          lastDurationMs: 0,
        });
        // 会话已落盘，通知 Sidebar 新增
        emitSessionsChanged();
        // 通过 SDK 设置标题（写入 jsonl 转录，CLI 也能看到）
        if (initialTitle) {
          try {
            await renameSession(id, initialTitle);
          } catch (err) {
            app.log.warn({ err }, `renameSession failed for new session ${id}`);
          }
        }
        registered = true;
      };

      for await (const evt of stream) {
        // session_created 必须先完成持久化再推给前端，
        // 避免侧栏刷新时 syncAndListSessions 发现会话不在 CLI 磁盘上而被误删
        if (evt.type === "session_created" && !registered) {
          await register(evt.sessionId);
          // 注册完成后订阅总线：所有事件（含查询事件、子代理事件）
          // 统一通过总线转发到客户端，不再直接 sendSSE
          if (sessionId && !unsubBusEvents) {
            unsubBusEvents = onSessionEvent(sessionId, (e) => {
              sendSSE(reply, e);
            });
            // 主动 emit user_message：SDK 消息流不含用户文本输入（实测确认 resume
            // 与新建模式均无 type=user 的 text block），观察方/续流方只能靠此事件
            // 看到首条用户消息。订阅建立后再 emit，确保它进入内存缓冲供后续观察方重放。
            emitSessionEvent(sessionId, { type: "user_message", text: body.message });
          }
        }

        if (sessionId) {
          // 统一事件处理 + 总线发射（inflight 跟踪、token 累加）
          await emitEventToBus(sessionId, evt);
          // 不直接 sendSSE —— 总线订阅负责转发
        } else if (!closed) {
          // session_created 之前的异常情况，直接发（连接已关则丢弃）
          sendSSE(reply, evt);
        }
      }
    } catch (err) {
      // 用户主动中止不是错误，不推 error 事件到前端
      if (!(err instanceof Error && err.name === "AbortError")) {
        const message =
          err instanceof Error ? err.message : "unknown error";
        const errorEvent: { type: "error"; message: string } = {
          type: "error",
          message,
        };
        if (sessionId) {
          emitSessionEvent(sessionId, errorEvent);
          // 如果总线订阅未建立（error 发生在 register 期间），
          // 需要直接发给 POST 客户端，否则 bus 订阅已负责转发
          if (!unsubBusEvents && !closed) {
            sendSSE(reply, errorEvent);
          }
        } else if (!closed) {
          sendSSE(reply, errorEvent);
        }
      }
    } finally {
      if (unsubBusEvents) unsubBusEvents();
      if (sessionId) {
        finalizeSession(sessionId);
        emitSessionEnd(sessionId);
        if (clearInflight(sessionId, ctrl)) emitSessionEnded(sessionId);
        clearSessionBuffer(sessionId);
        await touchSession(sessionId);
        // 会话结束（running→completed），通知 Sidebar 刷新。
        // 本路由不走 runQueryToBus（首条消息用独立 for-await），需手动补发。
        emitSessionsChanged();
      }
      try { endSSE(reply); } catch { /* 连接可能已关闭 */ }
    }
  });

  // ───────────────────────────────────────────────────────────
  // POST /api/sessions/:id/messages —— 已有会话发消息（SSE）
  //
  // 事件流统一经过 EventBus：runQueryToBus 将所有事件 emit 到总线，
  // handler 订阅总线转发到 HTTP 客户端。子代理事件也通过同一总线
  // 通道到达，无需单独订阅。
  // ───────────────────────────────────────────────────────────
  app.post<{
    Params: { id: string };
    Body: SendMessageRequest;
  }>("/api/sessions/:id/messages", async (req, reply) => {
    const sessionId = req.params.id;
    const body = req.body;
    const rec = await getSession(sessionId);
    if (!rec) {
      return reply.code(404).send({ error: "session not found" });
    }
    if (!body?.message || typeof body.message !== "string") {
      return reply.code(400).send({ error: "message is required" });
    }

    initSSE(reply);
    const ctrl = new AbortController();
    // setInflight 返回「无→有」状态变化时，广播 session_started，
    // 驱动观察方窗口（本地第二标签页 / 远程端）接入实时流。
    if (setInflight(sessionId, ctrl)) emitSessionStarted(sessionId);

    // 订阅总线：所有事件（含查询事件、子代理事件）统一转发到客户端
    let closed = false;
    const unsubEvent = onSessionEvent(sessionId, (evt) => {
      if (!closed) sendSSE(reply, evt);
    });

    // 主动 emit user_message：SDK 消息流不包含用户文本输入（只含 tool_result），
    // 观察方/续流方无法从流里得知用户说了什么。这里在查询启动前显式广播，
    // 让它进入总线 + 内存缓冲，观察方订阅 GET stream 时能完整看到对话。
    // 发消息方前端在 onNew 里已乐观写入 user 消息，appendUserMessage 会按文本去重。
    emitSessionEvent(sessionId, { type: "user_message", text: body.message });

    // 查询生命周期独立于连接：只有 POST /abort / DELETE 才取消。
    // 断开仅停止向死连接转发，runQueryToBus 继续把事件写到总线 + transcript。
    req.raw.on("close", () => {
      closed = true;
      unsubEvent();
    });

    try {
      await runQueryToBus(sessionId, {
        cwd: rec.cwd,
        prompt: body.message,
        resume: sessionId,
        abortController: ctrl,
        permissionMode: rec.permissionMode ?? "default",
        effortLevel: rec.effortLevel ?? "default",
        env: await resolveSessionEnv(sessionId),
      });
    } finally {
      unsubEvent();
      await touchSession(sessionId);
      try { endSSE(reply); } catch { /* 连接可能已关闭 */ }
    }
  });

  // ───────────────────────────────────────────────────────────
  // POST /api/sessions/:id/fork —— 分叉会话
  //
  // 调用 SDK forkSession 复制源会话 transcript 到一个全新 sessionId
  // （重映射所有 message UUID、保留 parentUuid 链）。返回新 sessionId，
  // 并 upsert 一张继承源会话 profile/权限/思考级别的名片。之后用户在新
  // 会话发消息走现有 `resume: sessionId` 路径，SDK 自动加载 fork 历史。
  // upToMessageId 预留给「从某条消息处分叉」的未来 UI。
  // ───────────────────────────────────────────────────────────
  app.post<{
    Params: { id: string };
    Body: { upToMessageId?: string; title?: string } | null;
  }>("/api/sessions/:id/fork", async (req, reply) => {
    const sourceId = req.params.id;
    const body = req.body ?? {};
    const rec = await getSession(sourceId);
    if (!rec) {
      return reply.code(404).send({ error: "session not found" });
    }
    // 进行中的会话 transcript 仍在写，分叉可能拷到半截状态——拒绝
    if (getInflight(sourceId)) {
      return reply.code(409).send({ error: "session is running, wait for it to finish before forking" });
    }

    try {
      const { sessionId: newId } = await forkSession(sourceId, {
        dir: rec.cwd,
        ...(body.upToMessageId ? { upToMessageId: body.upToMessageId } : {}),
        ...(body.title ? { title: body.title } : {}),
      });

      // 继承源会话的 profile/权限/思考级别，避免 fork 出来掉回默认值。
      // 必须 await：emitSessionsChanged 和前端跳转都依赖 sessions.json 已落盘，
      // 否则前端 GET /api/sessions/:newId 会 404（竞态）。
      try {
        await upsertSession({
          sessionId: newId,
          cwd: rec.cwd,
          profileId: rec.profileId,
          permissionMode: rec.permissionMode,
          effortLevel: rec.effortLevel,
          createdAt: Date.now(),
          lastModified: Date.now(),
          inputTokens: 0,
          outputTokens: 0,
          lastDurationMs: 0,
        });
      } catch (err) {
        // 记录写入失败不应让整个 fork 失败（transcript 已生成），
        // 但必须按 AGENTS.md 纪律打印 err.message，不能静默吞掉。
        console.warn(
          `[fork] upsertSession failed for ${newId} (source ${sourceId}):`,
          err instanceof Error ? err.message : err,
        );
      }

      emitSessionsChanged(); // 侧栏跨标签页即时刷新
      return reply.send({ sessionId: newId });
    } catch (err: any) {
      console.warn(`[fork] failed for ${sourceId}:`, err?.message);
      return reply.code(500).send({ error: err?.message ?? "fork failed" });
    }
  });

  // ───────────────────────────────────────────────────────────
  // GET /api/sessions/by-client/:clientId —— 凭 clientId 反查 sessionId
  // 新建会话时 session_created 未送达前端就断线的竞态下，前端凭此续流。
  // 与 /api/sessions/:id 路径段数不同，不会冲突。
  // ───────────────────────────────────────────────────────────
  app.get<{ Params: { clientId: string } }>(
    "/api/sessions/by-client/:clientId",
    async (req, reply) => {
      const sid = resolveClientSession(req.params.clientId);
      if (!sid) {
        return reply.code(404).send({ error: "no session for clientId" });
      }
      return reply.send({ sessionId: sid });
    },
  );

  // ───────────────────────────────────────────────────────────
  // POST /api/sessions/:id/abort —— 中止进行中的会话
  // ───────────────────────────────────────────────────────────
  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/abort",
    async (req, reply) => {
      const ctrl = getInflight(req.params.id);
      if (!ctrl) {
        return reply.code(404).send({ error: "no inflight query" });
      }
      ctrl.abort();
      return reply.send({ ok: true });
    },
  );

  // ───────────────────────────────────────────────────────────
  // DELETE /api/sessions/:id —— 删除会话
  // ① 中止进行中的 query ② 删 ~/.claude/projects/ 转录（含子代理）
  // ③ 删 sessions.json 记录
  // ───────────────────────────────────────────────────────────
  app.delete<{ Params: { id: string } }>(
    "/api/sessions/:id",
    async (req, reply) => {
      const sessionId = req.params.id;

      // 先拿记录（需要 cwd 给 SDK deleteSession）
      const rec = await getSession(sessionId);

      // 中止进行中的（如果有）
      const ctrl = getInflight(sessionId);
      if (ctrl && !ctrl.signal.aborted) ctrl.abort();
      // 强制清除 inflight；若有变化，通知观察方该会话流已结束
      if (clearInflight(sessionId)) emitSessionEnded(sessionId);
      clearSessionBuffer(sessionId);

      // 真删 CLI 转录文件（含子代理）。
      // 有 cwd 时传 dir 精确删除；无 cwd 时不传 dir，让 SDK 全局搜索。
      const dirOpt = rec?.cwd ? { dir: rec.cwd } : {};

      // 先查子代理列表，逐个删除子代理转录
      try {
        const childIds = await listSubagents(sessionId, dirOpt);
        await Promise.all(
          childIds.map((childId) =>
            deleteSession(childId, dirOpt).catch((err: unknown) => {
              const code = (err as NodeJS.ErrnoException)?.code;
              if (code !== "ENOENT") {
                app.log.warn({ err }, `failed to delete subagent session ${childId}`);
              }
            }),
          ),
        );
      } catch (err) {
        app.log.warn({ err }, `listSubagents failed during delete for ${sessionId}`);
      }

      // 再删主会话转录
      try {
        await deleteSession(sessionId, dirOpt);
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code !== "ENOENT") {
          app.log.warn({ err }, `SDK deleteSession failed for ${sessionId}`);
        }
      }

      // 删 sessions.json 记录（可能不存在，不阻塞）
      await deleteSessionRecord(sessionId);

      // 清理子代理注册记录
      cleanupSession(sessionId);

      // 通知 Sidebar 会话已删除
      emitSessionsChanged();

      return reply.send({ ok: true });
    },
  );

  // ───────────────────────────────────────────────────────────
  // PUT /api/sessions/:id/title —— 更新会话标题（通过 SDK renameSession）
  // ───────────────────────────────────────────────────────────
  app.put<{
    Params: { id: string };
    Body: { title: string | null };
  }>(
    "/api/sessions/:id/title",
    async (req, reply) => {
      const { id } = req.params;
      const { title } = req.body;

      const session = await getSession(id);
      if (!session) {
        return reply.code(404).send({ error: "session not found" });
      }

      const newTitle = title?.trim() || null;
      try {
        // SDK 写入 customTitle 到转录文件，CLI 也能看到
        await renameSession(id, newTitle ?? "");
      } catch (err) {
        app.log.warn({ err }, `renameSession failed for ${id}`);
        // renameSession 失败不阻塞，标题下次列表刷新会回退到 summary
      }

      return reply.send({ ok: true, title: newTitle });
    },
  );

  // ───────────────────────────────────────────────────────────
  // Profiles CRUD: /api/profiles
  // ───────────────────────────────────────────────────────────
  app.get("/api/profiles", async (_req, reply) => {
    return reply.send({ profiles: await listProfiles() });
  });

  app.post<{
    Body: { name?: string; env?: Record<string, unknown> };
  }>("/api/profiles", async (req, reply) => {
    const profile = await createProfile(req.body?.name ?? "新配置", req.body?.env);
    return reply.send({ profile });
  });

  app.put<{
    Params: { id: string };
    Body: { name?: string; env?: Record<string, unknown> };
  }>("/api/profiles/:id", async (req, reply) => {
    const profile = await updateProfile(req.params.id, {
      name: req.body?.name,
      env: req.body?.env,
    });
    if (!profile) return reply.code(404).send({ error: "profile not found" });
    return reply.send({ profile });
  });

  app.delete<{ Params: { id: string } }>(
    "/api/profiles/:id",
    async (req, reply) => {
      const ok = await deleteProfile(req.params.id);
      if (!ok) return reply.code(404).send({ error: "profile not found" });
      return reply.send({ ok: true });
    },
  );

  // ───────────────────────────────────────────────────────────
  // PUT /api/profiles/reorder —— 拖拽排序
  // body: { ids: string[] } 按目标顺序排列的 profile id 列表
  // ───────────────────────────────────────────────────────────
  app.put<{
    Body: { ids?: unknown };
  }>("/api/profiles/reorder", async (req, reply) => {
    const raw = req.body?.ids;
    if (!Array.isArray(raw) || !raw.every((x) => typeof x === "string")) {
      return reply.code(400).send({ error: "ids must be a string array" });
    }
    const profiles = await reorderProfiles(raw);
    return reply.send({ profiles });
  });

  // ───────────────────────────────────────────────────────────
  // PUT /api/sessions/:id/profile —— 切换会话绑定的 profile
  // body: { profileId: string | null }
  // ───────────────────────────────────────────────────────────
  app.put<{
    Params: { id: string };
    Body: { profileId?: string | null };
  }>("/api/sessions/:id/profile", async (req, reply) => {
    const rec = await getSession(req.params.id);
    if (!rec) {
      return reply.code(404).send({ error: "session not found" });
    }
    const profileId = req.body?.profileId ?? null;
    await setSessionProfile(req.params.id, profileId);
    return reply.send({ ok: true, profileId });
  });

  // ───────────────────────────────────────────────────────────
  // PUT /api/sessions/:id/permission-mode —— 切换权限模式
  // body: { permissionMode: PermissionMode }
  // ───────────────────────────────────────────────────────────
  app.put<{
    Params: { id: string };
    Body: { permissionMode?: string };
  }>("/api/sessions/:id/permission-mode", async (req, reply) => {
    const rec = await getSession(req.params.id);
    if (!rec) {
      return reply.code(404).send({ error: "session not found" });
    }
    const mode = req.body?.permissionMode;
    const validModes = ["default", "acceptEdits", "plan", "dontAsk", "auto", "bypassPermissions"];
    if (!validModes.includes(mode as string)) {
      return reply.code(400).send({ error: "invalid permissionMode" });
    }
    await touchSession(req.params.id, { permissionMode: mode as PermissionMode });
    return reply.send({ ok: true, permissionMode: mode });
  });

  // ───────────────────────────────────────────────────────────
  // PUT /api/sessions/:id/thinking-level —— 切换思考级别
  // body: { effortLevel: EffortLevel }
  // ───────────────────────────────────────────────────────────
  app.put<{
    Params: { id: string };
    Body: { effortLevel?: string };
  }>("/api/sessions/:id/thinking-level", async (req, reply) => {
    const rec = await getSession(req.params.id);
    if (!rec) {
      return reply.code(404).send({ error: "session not found" });
    }
    const level = req.body?.effortLevel;
    const validLevels = ["low", "medium", "high", "xhigh", "max", "disabled", "default"];
    if (!validLevels.includes(level as string)) {
      return reply.code(400).send({ error: "invalid effortLevel" });
    }
    await touchSession(req.params.id, { effortLevel: level as EffortLevel });
    return reply.send({ ok: true, effortLevel: level });
  });

  // ───────────────────────────────────────────────────────────
  // GET /api/browse?path=xxx —— 列目录（供前端选 cwd）
  // ───────────────────────────────────────────────────────────
  app.get<{ Querystring: { path?: string } }>(
    "/api/browse",
    async (req, reply) => {
      const input = req.query.path || path.resolve("/");
      // path traversal 防护：resolve 后再校验
      const target = path.resolve(input);
      try {
        const stat = await fsp.stat(target);
        if (!stat.isDirectory()) {
          return reply.code(400).send({ error: "not a directory" });
        }
        const entries = await fsp.readdir(target, {
          withFileTypes: true,
        });
        const filtered = entries
          .filter(
            (e) =>
              !e.name.startsWith(".") && // 隐藏文件跳过
              !["node_modules", "dist", "build", ".git"].includes(e.name),
          )
          .map((e) => ({
            name: e.name,
            isDir: e.isDirectory(),
            path: path.join(target, e.name),
          }))
          .sort((a, b) => {
            // 目录在前，名字字母序
            if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
            return a.name.localeCompare(b.name);
          });
        return reply.send({ path: target, entries: filtered });
      } catch (err) {
        app.log.warn({ err }, `browse failed for ${target}`);
        return reply.code(404).send({ error: "cannot read directory" });
      }
    },
  );

  // ───────────────────────────────────────────────────────────
  // GET /api/slash-commands —— 获取当前项目可用的斜杠命令
  // ───────────────────────────────────────────────────────────
  app.get<{ Querystring: { cwd?: string } }>(
    "/api/slash-commands",
    async (req, reply) => {
      const cwd = req.query.cwd || process.cwd();
      const { resolveSlashCommands } = await import("../lib/slashCommands.js");
      const commands = await resolveSlashCommands(cwd);
      return reply.send({ commands });
    },
  );

  // ───────────────────────────────────────────────────────────
  // 远程控制（Relay）渠道 API
  // ───────────────────────────────────────────────────────────

  const RELAY_CONFIG_FILE = path.join(DATA_DIR, "relay-config.json");

  async function saveRelayConfig(config: RelayConfig): Promise<void> {
    await fsp.writeFile(RELAY_CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
  }

  async function loadRelayConfig(): Promise<RelayConfig | null> {
    try {
      const content = await fsp.readFile(RELAY_CONFIG_FILE, "utf-8");
      const parsed = JSON.parse(content) as Partial<RelayConfig>;
      if (!parsed.relayUrl || !parsed.accessKey) return null;
      return { relayUrl: parsed.relayUrl, accessKey: parsed.accessKey };
    } catch (err) {
      // 配置文件不存在属正常情况，不告警；其他错误才告警
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn("[relay] load config failed:", err instanceof Error ? err.message : err);
      }
      return null;
    }
  }

  /**
   * 取 relay 状态快照：运行时状态优先，若 relayUrl/accessKey 缺失则回退到落盘配置
   * （此时尚无 token，remoteUrl 为空）。供 /api/relay/status 与全局总线首帧复用。
   */
  async function getRelaySnapshot() {
    const status = getRelayStatus();
    if (!status.relayUrl || !status.accessKey) {
      const saved = await loadRelayConfig();
      if (saved) {
        return { ...status, relayUrl: saved.relayUrl, accessKey: saved.accessKey };
      }
    }
    return status;
  }

  // GET /api/relay/status —— 当前隧道状态 + 已保存配置
  app.get("/api/relay/status", async (_req, reply) => {
    return reply.send(await getRelaySnapshot());
  });

  // GET /api/relay/devices —— 当前在线的远程设备列表（SSE 连接生命周期驱动）
  app.get("/api/relay/devices", async (_req, reply) => {
    return reply.send({ devices: getDevices() });
  });

  // GET /api/version —— Claude Code CLI 版本号（设置页"关于"展示）
  app.get("/api/version", async (_req, reply) => {
    return reply.send({ claudeCode: await getClaudeVersion() });
  });

  // relay 隧道状态的实时推送已并入全局总线 GET /api/events/stream（relay_status 事件），
  // 不再单独开 SSE 长连接。

  // POST /api/relay/start —— 启用隧道
  app.post<{
    Body: { relayUrl?: string; accessKey?: string };
  }>("/api/relay/start", async (req, reply) => {
    const saved = await loadRelayConfig();
    const relayUrl = (req.body?.relayUrl ?? saved?.relayUrl ?? "").trim();
    // accessKey 对用户无感：请求体/落盘都没有时自动生成（用户无需关心此凭证）
    let accessKey = (req.body?.accessKey ?? saved?.accessKey ?? "").trim();
    if (!accessKey) {
      const crypto = await import("node:crypto");
      accessKey = crypto.randomBytes(24).toString("base64url");
    }

    if (!relayUrl) {
      return reply.code(400).send({ error: "中转地址不能为空" });
    }
    if (!/^wss?:\/\//i.test(relayUrl)) {
      return reply.code(400).send({ error: "中转地址必须以 ws:// 或 wss:// 开头" });
    }

    const config: RelayConfig = { relayUrl, accessKey };
    try {
      await saveRelayConfig(config);
    } catch (err) {
      console.warn("[relay] save config failed:", err instanceof Error ? err.message : err);
    }
    startRelayTunnel(config);
    return reply.send({ ok: true });
  });

  // POST /api/relay/stop —— 停用隧道（保留配置）
  app.post("/api/relay/stop", async (_req, reply) => {
    stopRelayTunnel();
    return reply.send({ ok: true });
  });

  // POST /api/relay/regenerate-key —— 重新生成 accessKey（停用中的配置更新）
  app.post<{
    Body: { relayUrl?: string };
  }>("/api/relay/regenerate-key", async (req, reply) => {
    const crypto = await import("node:crypto");
    const newKey = crypto.randomBytes(24).toString("base64url");
    const saved = await loadRelayConfig();
    const relayUrl = (req.body?.relayUrl ?? saved?.relayUrl ?? "").trim();
    if (!relayUrl) {
      return reply.code(400).send({ error: "请先填写中转地址" });
    }
    const config: RelayConfig = { relayUrl, accessKey: newKey };
    try {
      await saveRelayConfig(config);
    } catch (err) {
      console.warn("[relay] save config failed:", err instanceof Error ? err.message : err);
    }
    // 若隧道正在运行，用新 key 重连
    if (getRelayStatus().enabled) {
      startRelayTunnel(config);
    }
    return reply.send({ ok: true, accessKey: newKey });
  });

  // POST /api/relay/refresh-token —— 生成一次性访问令牌（60s 有效）。
  // 令牌经隧道登记到中转，远程地址携带 ?t=token 首次换 cookie。
  // accessKey 不再出现在 URL，避免进 nginx 日志 / Referer / 浏览器历史。
  app.post("/api/relay/refresh-token", async (_req, reply) => {
    try {
      const { token, expiresAt } = await mintToken();
      return reply.send({ ok: true, token, expiresAt });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[relay] refresh-token failed:", msg);
      return reply.code(400).send({ error: msg });
    }
  });

  // 暴露给 index.ts：仅注入 localBase。远程控制不在启动时自动开启，
  // 必须由用户在界面上主动"启用"。loadRelayConfig 仍供上方 status 端点回退使用。
  (globalThis as any).__relayLoadConfig = loadRelayConfig;
  (globalThis as any).__relayStart = startRelayTunnel;
  (globalThis as any).__relaySetLocalBase = setLocalBase;

  // ───────────────────────────────────────────────────────────
  // POST /api/sessions/:id/permission-response
  // 前端对 permission_request 事件的响应：批准/拒绝某个工具调用
  // ───────────────────────────────────────────────────────────
  app.post<{
    Params: { id: string };
    Body: {
      requestId: string;
      behavior: "allow" | "deny";
      message?: string;
      /** allow 时是否记住此决定（始终允许此工具，destination: session） */
      updatedPermissions?: Array<{
        type: "add";
        toolName: string;
        permission: "allow";
        destination: "session";
      }>;
    };
  }>("/api/sessions/:id/permission-response", async (req, reply) => {
    const { requestId, behavior, message, updatedPermissions } = req.body;
    if (!requestId || !behavior) {
      return reply.code(400).send({ error: "requestId and behavior are required" });
    }
    if (!["allow", "deny"].includes(behavior)) {
      return reply.code(400).send({ error: "behavior must be 'allow' or 'deny'" });
    }

    const pending = takePendingPermission(requestId);
    if (!pending) {
      return reply.code(404).send({ error: "permission request not found or already resolved" });
    }

    // 检查 sessionId 匹配（防止跨会话操作）
    if (pending.sessionId !== req.params.id) {
      // 跨会话请求：拒绝它
      pending.resolve({ behavior: "deny", message: "Session mismatch" });
      return reply.code(403).send({ error: "session mismatch" });
    }

    // 解析决策并唤醒 PermissionRequest hook 中的 Promise
    pending.resolve({
      behavior,
      message: message ?? (behavior === "deny" ? "User denied the operation" : undefined),
      ...(behavior === "allow" && updatedPermissions?.length
        ? { updatedPermissions }
        : {}),
    });

    // 通知所有订阅者（含其他标签页）清除该横幅
    emitSessionEvent(req.params.id, {
      type: "permission_resolved",
      requestId,
      reason: "resolved",
    });

    return reply.send({ ok: true });
  });

  // ───────────────────────────────────────────────────────────
  // POST /api/sessions/:id/approve-plan
  // 前端对 plan_proposed 事件的审批：批准后自动切到执行模式继续
  // ───────────────────────────────────────────────────────────
  app.post<{
    Params: { id: string };
    Body: { action: "approve" | "reject"; editedPlan?: string; prompt?: string };
  }>("/api/sessions/:id/approve-plan", async (req, reply) => {
    const sessionId = req.params.id;
    const { action, editedPlan, prompt } = req.body;

    const rec = await getSession(sessionId);
    if (!rec) {
      return reply.code(404).send({ error: "session not found" });
    }

    if (action === "reject") {
      return reply.send({ ok: true, action: "rejected" });
    }

    // action === "approve"：更新权限模式并启动执行阶段
    const execMode: PermissionMode = "acceptEdits";
    await touchSession(sessionId, { permissionMode: execMode });

    // 构建执行提示词
    let execPrompt: string;
    if (prompt?.trim()) {
      execPrompt = prompt.trim();
    } else if (editedPlan?.trim()) {
      execPrompt = `The user has approved the following plan with edits:\n\n${editedPlan}\n\nProceed with implementation.`;
    } else {
      execPrompt = "The user has approved the plan. Proceed with implementation.";
    }

    initSSE(reply);
    const ctrl = new AbortController();
    if (setInflight(sessionId, ctrl)) emitSessionStarted(sessionId);

    // 订阅总线：统一转发所有事件，session_created 替换为 mode_changed
    let closed = false;
    const unsubEvent = onSessionEvent(sessionId, (evt) => {
      if (closed) return;
      if (evt.type === "session_created") {
        sendSSE(reply, { type: "mode_changed", mode: execMode });
      } else {
        sendSSE(reply, evt);
      }
    });

    // 主动 emit user_message：approve-plan 的 execPrompt 是合成的执行指令，
    // SDK 流不会回显它。emit 让观察方知道用户批准了什么计划。
    emitSessionEvent(sessionId, { type: "user_message", text: execPrompt });

    // 查询生命周期独立于连接：只有 POST /abort / DELETE 才取消。
    // 断开仅停止向死连接转发，runQueryToBus 继续把事件写到总线 + transcript。
    req.raw.on("close", () => {
      closed = true;
      unsubEvent();
    });

    try {
      await runQueryToBus(sessionId, {
        cwd: rec.cwd,
        prompt: execPrompt,
        resume: sessionId,
        abortController: ctrl,
        permissionMode: execMode,
        effortLevel: rec.effortLevel ?? "default",
        env: await resolveSessionEnv(sessionId),
      });
    } finally {
      unsubEvent();
      await touchSession(sessionId);
      try { endSSE(reply); } catch { /* 连接可能已关闭 */ }
    }
  });
}
