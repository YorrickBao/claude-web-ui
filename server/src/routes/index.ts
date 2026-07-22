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
  resolveSessionEnv,
  resolveProfileEnv,
  setSessionProfile,
  accumulateTokens,
} from "../lib/store.js";
import { runQuery, renameSession, getSessionInfo, listSessions as sdkListSessions } from "../lib/sdk.js";
import { deleteSession } from "@anthropic-ai/claude-agent-sdk";
import { initSSE, sendSSE, endSSE } from "../lib/sse.js";
import {
  setInflight,
  setInflightWaiting,
  setInflightRunning,
  clearInflight,
  getInflight,
  getInflightStatus,
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
import { connectViaQRCode, validateFeishuCredentials, type FeishuConfig } from "../channels/feishu.js";
import { DATA_DIR } from "../env.js";
import { emitSessionEvent, emitSessionEnd, onSessionEvent, onSessionEnd } from "../lib/eventBus.js";
import { getSessionStats, startZombieScanner, finalizeSession, cleanupSession } from "../lib/agentRegistry.js";

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
      const stats = getSessionStats(r.sessionId);
      return {
        sessionId: r.sessionId,
        cwd: r.cwd,
        title: sdk ? resolveSdkTitle(sdk) : "（无标题）",
        createdAt: r.createdAt,
        lastModified: r.lastModified,
        profileId: r.profileId ?? null,
        runningStatus: getInflightStatus(r.sessionId) ?? "idle",
        permissionMode: r.permissionMode ?? "bypassPermissions",
        effortLevel: r.effortLevel ?? "default",
        inputTokens: r.inputTokens ?? 0,
        outputTokens: r.outputTokens ?? 0,
        subagentCount: stats.total,
      };
    });
    return reply.send({ sessions: views });
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
      const stats = getSessionStats(rec.sessionId);
      return reply.send({
        sessionId: rec.sessionId,
        cwd: rec.cwd,
        title,
        createdAt: rec.createdAt,
        lastModified: rec.lastModified,
        profileId: rec.profileId ?? null,
        permissionMode: rec.permissionMode ?? "bypassPermissions",
        effortLevel: rec.effortLevel ?? "default",
        runningStatus: getInflightStatus(rec.sessionId) ?? "idle",
        inputTokens: rec.inputTokens ?? 0,
        outputTokens: rec.outputTokens ?? 0,
        subagentCount: stats.total,
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

      const onEvent = (evt: SSEEvent) => {
        if (buffering) {
          buffer.push(evt);
        } else {
          sendSSE(reply, evt);
        }
      };
      const unsubEvent = onSessionEvent(sessionId, onEvent);

      let unsubEnd: () => void;
      const cleanup = () => {
        clearTimeout(timeout);
        unsubEvent();
        unsubEnd();
      };

      unsubEnd = onSessionEnd(sessionId, () => {
        cleanup();
        try { endSSE(reply); } catch { /* 可能已经 close */ }
      });

      // 客户端正常断开时清理（仅注册一次）
      req.raw.on("close", cleanup);

      // 阶段2：回放历史，收集去重依据
      try {
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

        // 阶段3：去重转发缓冲区事件，然后切到实时模式
        buffering = false;
        let textAccum = 0;
        for (const evt of buffer) {
          // 工具事件：按 ID 去重
          if (
            (evt.type === "tool_use" || evt.type === "tool_result") &&
            historyToolIds.has(evt.id)
          ) {
            continue;
          }
          // 文本增量：累计长度 ≤ lastTextLen 说明已包含在 history 中
          if (evt.type === "text") {
            textAccum += evt.text.length;
            if (textAccum <= lastTextLen) continue;
            // 跨边界 delta：截掉已在 history 中的前缀部分
            if (textAccum - evt.text.length < lastTextLen) {
              const overlap = lastTextLen - (textAccum - evt.text.length);
              const newPart = evt.text.slice(overlap);
              if (newPart) sendSSE(reply, { type: "text", text: newPart });
              continue;
            }
          }
          sendSSE(reply, evt);
        }

        // 如果会话没在运行（竞态：刚好在 replay 期间结束），关闭
        if (!getInflight(sessionId)) {
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
    const permissionMode = body.permissionMode ?? "bypassPermissions";
    const effortLevel = body.effortLevel ?? "default";
    /** 子代理事件的 eventBus 取消订阅函数（session_created 后赋值，finally 中清理） */
    let unsubSubagentEvents: (() => void) | null = null;

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
        setInflight(id, ctrl);
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
        });
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
        // 避免侧栏刷新时 syncAndListSessions 发现
        // 会话不在 CLI 磁盘上而被误删
        if (evt.type === "session_created" && !registered) {
          await register(evt.sessionId);
          // 注册完成后立即订阅子代理事件（钩子异步触发 → eventBus → SSE 客户端）
          if (sessionId && !unsubSubagentEvents) {
            unsubSubagentEvents = onSessionEvent(sessionId, (subEvt) => {
              if (subEvt.type === "subagent_started" || subEvt.type === "subagent_stopped") {
                sendSSE(reply, subEvt);
              }
            });
          }
        }
        // 跟踪 inflight 状态：HITL 等待 ↔ 运行中
        if (sessionId) {
          if (evt.type === "waiting_for_user") {
            setInflightWaiting(sessionId);
          } else {
            setInflightRunning(sessionId);
          }
        }
        // done 事件：先累加 token 到持久化存储，再发送新的累计值
        if (evt.type === "done" && sessionId) {
          await accumulateTokens(sessionId, evt.inputTokens, evt.outputTokens).catch(
            (err) => app.log.warn({ err }, `accumulateTokens failed for ${sessionId}`),
          );
          // 读取累加后的最新累计值，发送给前端
          const updated = await getSession(sessionId);
          const doneEvt = {
            type: "done" as const,
            inputTokens: updated?.inputTokens ?? evt.inputTokens,
            outputTokens: updated?.outputTokens ?? evt.outputTokens,
            durationMs: evt.durationMs,
          };
          sendSSE(reply, doneEvt);
          emitSessionEvent(sessionId, doneEvt);
        } else {
          sendSSE(reply, evt);
          if (sessionId) {
            emitSessionEvent(sessionId, evt);
          }
        }
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "unknown error";
      // 如果 abort，message 通常是 "This operation was aborted"
      const errorEvent: { type: "error"; message: string } = {
        type: "error",
        message: err instanceof Error && err.name === "AbortError"
          ? "aborted"
          : message,
      };
      sendSSE(reply, errorEvent);
      if (sessionId) emitSessionEvent(sessionId, errorEvent);
    } finally {
      if (unsubSubagentEvents) (unsubSubagentEvents as () => void)();
      if (sessionId) {
        finalizeSession(sessionId);
        emitSessionEnd(sessionId);
        clearInflight(sessionId);
        await touchSession(sessionId);
      }
      endSSE(reply);
    }
  });

  // ───────────────────────────────────────────────────────────
  // POST /api/sessions/:id/messages —— 已有会话发消息（SSE）
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
    setInflight(sessionId, ctrl);

    // 订阅子代理事件（钩子异步触发 → eventBus → 转发给当前 SSE 客户端）
    const unsubSubagentEvents = onSessionEvent(sessionId, (evt) => {
      if (evt.type === "subagent_started" || evt.type === "subagent_stopped") {
        sendSSE(reply, evt);
      }
    });

    try {
      const stream = runQuery({
        cwd: rec.cwd,
        prompt: body.message,
        resume: sessionId,
        abortController: ctrl,
        permissionMode: rec.permissionMode ?? "bypassPermissions",
        effortLevel: rec.effortLevel ?? "default",
        // 已有会话：env = 全局默认 + 会话级 override
        env: await resolveSessionEnv(sessionId),
      });
      for await (const evt of stream) {
        // 跟踪 inflight 状态：HITL 等待 ↔ 运行中
        if (evt.type === "waiting_for_user") {
          setInflightWaiting(sessionId);
        } else {
          setInflightRunning(sessionId);
        }
        // done 事件：先累加 token 到持久化存储，再发送新的累计值
        if (evt.type === "done") {
          await accumulateTokens(sessionId, evt.inputTokens, evt.outputTokens).catch(
            (err) => app.log.warn({ err }, `accumulateTokens failed for ${sessionId}`),
          );
          const updated = await getSession(sessionId);
          const doneEvt = {
            type: "done" as const,
            inputTokens: updated?.inputTokens ?? evt.inputTokens,
            outputTokens: updated?.outputTokens ?? evt.outputTokens,
            durationMs: evt.durationMs,
          };
          sendSSE(reply, doneEvt);
          emitSessionEvent(sessionId, doneEvt);
        } else {
          sendSSE(reply, evt);
          emitSessionEvent(sessionId, evt);
        }
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "unknown error";
      const errorEvent: { type: "error"; message: string } = {
        type: "error",
        message: err instanceof Error && err.name === "AbortError"
          ? "aborted"
          : message,
      };
      sendSSE(reply, errorEvent);
      emitSessionEvent(sessionId, errorEvent);
    } finally {
      unsubSubagentEvents();
      finalizeSession(sessionId);
      emitSessionEnd(sessionId);
      clearInflight(sessionId);
      await touchSession(sessionId);
      endSSE(reply);
    }
  });

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
  // ① 中止进行中的 query ② 删 ~/.claude/projects/ 转录
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
      clearInflight(sessionId);

      // 真删 CLI 转录文件
      if (rec?.cwd) {
        try {
          await deleteSession(sessionId, { dir: rec.cwd });
        } catch (err: unknown) {
          // 文件可能已不存在，不阻塞
          const code = (err as NodeJS.ErrnoException)?.code;
          if (code !== "ENOENT") {
            app.log.warn({ err }, `SDK deleteSession failed for ${sessionId}`);
          }
        }
      }

      const removed = await deleteSessionRecord(sessionId);
      if (!removed) {
        return reply.code(404).send({ error: "session not found" });
      }

      // 清理子代理注册记录
      cleanupSession(sessionId);

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
    const validModes = ["bypassPermissions", "default", "acceptEdits", "plan", "dontAsk", "auto"];
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
      } catch {
        return reply.code(404).send({ error: "cannot read directory" });
      }
    },
  );

  // ───────────────────────────────────────────────────────────
  // Feishu 渠道 API
  // ───────────────────────────────────────────────────────────

  const FEISHU_CONFIG_FILE = path.join(DATA_DIR, "feishu-config.json");

  async function saveFeishuConfig(config: { appId: string; appSecret: string; domain: "feishu" | "lark" }): Promise<void> {
    await fsp.writeFile(FEISHU_CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
  }

  async function loadFeishuConfig(): Promise<{ appId: string; appSecret: string; domain: "feishu" | "lark" } | null> {
    try {
      const content = await fsp.readFile(FEISHU_CONFIG_FILE, "utf-8");
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  app.get("/api/feishu/status", async (_req, reply) => {
    const config = await loadFeishuConfig();
    if (!config) {
      return reply.send({ connected: false });
    }
    const valid = await validateFeishuCredentials(config.appId, config.appSecret).catch(() => false);
    return reply.send({ connected: valid, appId: config.appId, domain: config.domain });
  });

  app.post("/api/feishu/connect", async (_req, reply) => {
    console.log("[feishu] connect request received");
    initSSE(reply);
    const ctrl = new AbortController();

    function sendFeishuEvent(type: string, data: Record<string, unknown>): void {
      reply.raw.write(`event: ${type}\n`);
      reply.raw.write(`data: ${JSON.stringify({ ...data, type })}\n\n`);
      const raw = reply.raw as { flush?: () => void };
      if (raw.flush) {
        raw.flush();
      }
    }

    try {
      const result = await connectViaQRCode({
        onQRCode: (url) => {
          sendFeishuEvent("qr_code", { url });
        },
        onStatus: (status) => {
          if (status.phase === "waiting_for_scan") {
            sendFeishuEvent("waiting_for_scan", { qrUrl: status.qrUrl, expiresIn: status.expiresIn });
          } else if (status.phase === "success") {
            sendFeishuEvent("connected", { appId: status.appId, domain: status.domain });
          } else if (status.phase === "expired") {
            sendFeishuEvent("error", { message: "二维码已过期" });
          } else if (status.phase === "denied") {
            sendFeishuEvent("error", { message: "用户拒绝授权" });
          } else if (status.phase === "error") {
            sendFeishuEvent("error", { message: status.message });
          }
        },
        signal: ctrl.signal,
      });

      await saveFeishuConfig({
        appId: result.appId,
        appSecret: result.appSecret,
        domain: result.domain,
      });

      sendFeishuEvent("success", { appId: result.appId, domain: result.domain });

      const channelConfig: FeishuConfig = {
        enabled: true,
        appId: result.appId,
        appSecret: result.appSecret,
        domain: result.domain,
      };
      await (globalThis as any).__feishuChannelStarter?.(channelConfig);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        sendFeishuEvent("error", { message: "已取消" });
      } else {
        sendFeishuEvent("error", { message: err instanceof Error ? err.message : "连接失败" });
      }
    } finally {
      endSSE(reply);
    }
  });

  app.post("/api/feishu/disconnect", async (_req, reply) => {
    try {
      await fsp.unlink(FEISHU_CONFIG_FILE);
      return reply.send({ ok: true });
    } catch {
      return reply.send({ ok: true });
    }
  });

  app.post<{
    Body: { appId: string; appSecret: string; domain?: "feishu" | "lark" };
  }>("/api/feishu/manual", async (req, reply) => {
    const { appId, appSecret, domain = "feishu" } = req.body;
    if (!appId || !appSecret) {
      return reply.code(400).send({ error: "appId 和 appSecret 不能为空" });
    }

    const valid = await validateFeishuCredentials(appId, appSecret).catch(() => false);
    if (!valid) {
      return reply.code(400).send({ error: "凭证无效，请检查 App ID 和 App Secret" });
    }

    await saveFeishuConfig({ appId, appSecret, domain });
    return reply.send({ ok: true, appId, domain });
  });
}
