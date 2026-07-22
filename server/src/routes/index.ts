import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  getSession,
  listSessions,
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
} from "../lib/store.js";
import { runQuery } from "../lib/sdk.js";
import { deleteSession as sdkDeleteSession } from "@anthropic-ai/claude-agent-sdk";
import { initSSE, sendSSE, endSSE } from "../lib/sse.js";
import {
  setInflight,
  clearInflight,
  getInflight,
} from "../lib/inflight.js";
import type {
  CreateSessionRequest,
  SendMessageRequest,
  SessionView,
} from "../lib/types.js";
import { replaySession } from "../lib/replay.js";

async function resolveTitle(
  title: string | undefined,
  message: string,
): Promise<{ title: string | null; firstPrompt: string }> {
  const firstPrompt = message.trim().slice(0, 200);
  const t = title?.trim();
  return { title: t && t.length > 0 ? t : null, firstPrompt };
}

export async function apiRoutes(app: FastifyInstance): Promise<void> {
  // ───────────────────────────────────────────────────────────
  // GET /api/sessions —— 列出会话
  // ───────────────────────────────────────────────────────────
  app.get("/api/sessions", async (_req, reply) => {
    const records = await listSessions();
    const views: SessionView[] = records.map((r) => ({
      sessionId: r.sessionId,
      cwd: r.cwd,
      title: r.title ?? r.firstPrompt ?? "（无标题）",
      firstPrompt: r.firstPrompt,
      createdAt: r.createdAt,
      lastModified: r.lastModified,
      profileId: r.profileId ?? null,
    }));
    return reply.send({ sessions: views });
  });

  // ───────────────────────────────────────────────────────────
  // GET /api/sessions/:id —— 单会话历史（暂返回 store 元信息；
  // 历史消息的回放等 Phase 3 再接 SDK getSessionMessages）
  // ───────────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id",
    async (req, reply) => {
      const rec = await getSession(req.params.id);
      if (!rec) {
        return reply.code(404).send({ error: "session not found" });
      }
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
        title: rec.title ?? rec.firstPrompt ?? "（无标题）",
        firstPrompt: rec.firstPrompt,
        createdAt: rec.createdAt,
        lastModified: rec.lastModified,
        profileId: rec.profileId ?? null,
        messages: history,
      });
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

    try {
      const stream = runQuery({
        cwd: body.cwd,
        prompt: body.message,
        abortController: ctrl,
        // 新会话：env 来自用户选的 profile（可能为空）
        env: await resolveProfileEnv(profileId),
      });

      // 新会话要等拿到 session_created 才能登记 inflight + store
      let registered = false;
      const register = async (id: string) => {
        sessionId = id;
        setInflight(id, ctrl);
        const { title, firstPrompt } = await resolveTitle(
          body.title,
          body.message,
        );
        await upsertSession({
          sessionId: id,
          cwd: body.cwd,
          title,
          firstPrompt,
          createdAt: Date.now(),
          lastModified: Date.now(),
          profileId,
        });
        registered = true;
      };

      for await (const evt of stream) {
        sendSSE(reply, evt);
        if (evt.type === "session_created" && !registered) {
          await register(evt.sessionId);
        }
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "unknown error";
      // 如果 abort，message 通常是 "This operation was aborted"
      sendSSE(reply, {
        type: "error",
        message: err instanceof Error && err.name === "AbortError"
          ? "aborted"
          : message,
      });
    } finally {
      if (sessionId) {
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

    try {
      const stream = runQuery({
        cwd: rec.cwd,
        prompt: body.message,
        resume: sessionId,
        abortController: ctrl,
        // 已有会话：env = 全局默认 + 会话级 override
        env: await resolveSessionEnv(sessionId),
      });
      for await (const evt of stream) {
        sendSSE(reply, evt);
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "unknown error";
      sendSSE(reply, {
        type: "error",
        message: err instanceof Error && err.name === "AbortError"
          ? "aborted"
          : message,
      });
    } finally {
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
  // 清理：① sessions.json 记录 ② SDK transcript 文件 ③ 中止进行中的 query
  // ───────────────────────────────────────────────────────────
  app.delete<{ Params: { id: string } }>(
    "/api/sessions/:id",
    async (req, reply) => {
      const sessionId = req.params.id;
      // 先中止进行中的（如果有）
      const ctrl = getInflight(sessionId);
      if (ctrl && !ctrl.signal.aborted) ctrl.abort();
      clearInflight(sessionId);

      const removed = await deleteSessionRecord(sessionId);
      if (!removed) {
        return reply.code(404).send({ error: "session not found" });
      }

      // 删 SDK transcript（失败不致命 —— 记录已删，前端列表会刷新）
      try {
        await sdkDeleteSession(sessionId, { dir: removed.cwd });
      } catch (err) {
        app.log.warn({ err }, `sdkDeleteSession failed for ${sessionId}`);
      }

      return reply.send({ ok: true });
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
}
