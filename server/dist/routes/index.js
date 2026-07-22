import fsp from "node:fs/promises";
import path from "node:path";
import { getSession, syncAndListSessions, upsertSession, touchSession, deleteSessionRecord, listProfiles, createProfile, updateProfile, deleteProfile, resolveSessionEnv, resolveProfileEnv, setSessionProfile, accumulateTokens, } from "../lib/store.js";
import { runQuery, renameSession, getSessionInfo, listSessions as sdkListSessions } from "../lib/sdk.js";
import { deleteSession } from "@anthropic-ai/claude-agent-sdk";
import { initSSE, sendSSE, endSSE } from "../lib/sse.js";
import { setInflight, setInflightWaiting, setInflightRunning, clearInflight, getInflight, getInflightStatus, } from "../lib/inflight.js";
import { replaySession } from "../lib/replay.js";
import { emitSessionEvent, emitSessionEnd, onSessionEvent, onSessionEnd } from "../lib/eventBus.js";
/** 从 SDK 的 SDKSessionInfo 中解析出显示标题 */
function resolveSdkTitle(sdk) {
    return sdk.customTitle || sdk.summary || "（无标题）";
}
export async function apiRoutes(app) {
    // ───────────────────────────────────────────────────────────
    // GET /api/sessions —— 列出所有会话（实时同步 CLI 磁盘，标题来自 SDK）
    // ───────────────────────────────────────────────────────────
    app.get("/api/sessions", async (_req, reply) => {
        const records = await syncAndListSessions();
        // 取 SDK 标题映射（一次 SDK 调用，O(1) 查询）
        const sdkAll = await sdkListSessions();
        const sdkMap = new Map(sdkAll.map((s) => [s.sessionId, s]));
        const views = records.map((r) => {
            const sdk = sdkMap.get(r.sessionId);
            return {
                sessionId: r.sessionId,
                cwd: r.cwd,
                title: sdk ? resolveSdkTitle(sdk) : "（无标题）",
                createdAt: r.createdAt,
                lastModified: r.lastModified,
                profileId: r.profileId ?? null,
                runningStatus: getInflightStatus(r.sessionId) ?? "idle",
                permissionMode: r.permissionMode ?? "bypassPermissions",
                effortLevel: r.effortLevel ?? "high",
                inputTokens: r.inputTokens ?? 0,
                outputTokens: r.outputTokens ?? 0,
            };
        });
        return reply.send({ sessions: views });
    });
    // ───────────────────────────────────────────────────────────
    // GET /api/sessions/:id —— 单会话详情（标题来自 SDK）
    // ───────────────────────────────────────────────────────────
    app.get("/api/sessions/:id", async (req, reply) => {
        const rec = await getSession(req.params.id);
        if (!rec) {
            return reply.code(404).send({ error: "session not found" });
        }
        // SDK 标题
        const sdkInfo = await getSessionInfo(rec.sessionId, { dir: rec.cwd });
        const title = sdkInfo ? resolveSdkTitle(sdkInfo) : "（无标题）";
        // 拉历史消息（SDK 转录）。失败不致命 —— 返回空数组，前端照常能用
        let history = [];
        try {
            history = await replaySession(rec.sessionId, rec.cwd);
        }
        catch (err) {
            app.log.warn({ err }, `replaySession failed for ${rec.sessionId}`);
        }
        return reply.send({
            sessionId: rec.sessionId,
            cwd: rec.cwd,
            title,
            createdAt: rec.createdAt,
            lastModified: rec.lastModified,
            profileId: rec.profileId ?? null,
            permissionMode: rec.permissionMode ?? "bypassPermissions",
            effortLevel: rec.effortLevel ?? "high",
            runningStatus: getInflightStatus(rec.sessionId) ?? "idle",
            inputTokens: rec.inputTokens ?? 0,
            outputTokens: rec.outputTokens ?? 0,
            messages: history,
        });
    });
    // ───────────────────────────────────────────────────────────
    // GET /api/sessions/:id/stream —— 订阅会话实时 SSE 流
    //
    // 先 replay 全部历史消息（history 事件），如果会话正在运行则
    // 通过 EventBus 订阅后续实时事件，实现"切回正在运行的会话时续流"。
    //
    // 关键：必须在 replay 之前订阅 bus，否则 replay 期间的
    // 新事件会丢失。订阅后用 historySent 标记过滤掉早于
    // history 的事件（它们已包含在 history 里）。
    // ───────────────────────────────────────────────────────────
    app.get("/api/sessions/:id/stream", async (req, reply) => {
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
            try {
                endSSE(reply);
            }
            catch { /* 可能已经 close */ }
        }, TIMEOUT_MS);
        // 订阅 bus（在 replay 之前！），用标记过滤早期事件
        let historySent = false;
        const unsubEvent = onSessionEvent(sessionId, (evt) => {
            if (historySent) {
                sendSSE(reply, evt);
            }
            // historySent === false 时的事件已在 history 中包含，跳过
        });
        let unsubEnd;
        const cleanup = () => {
            clearTimeout(timeout);
            unsubEvent();
            unsubEnd();
        };
        unsubEnd = onSessionEnd(sessionId, () => {
            cleanup();
            try {
                endSSE(reply);
            }
            catch { /* 可能已经 close */ }
        });
        // 客户端正常断开时清理（仅注册一次）
        req.raw.on("close", cleanup);
        // 发送当前全部历史消息
        try {
            const history = await replaySession(sessionId, rec.cwd);
            // 如果在 replay 期间已超时关闭，不再发后续事件
            if (timedOut)
                return;
            sendSSE(reply, { type: "history", messages: history });
            historySent = true;
        }
        catch (err) {
            app.log.warn({ err }, `replaySession failed in stream for ${sessionId}`);
            if (!timedOut)
                sendSSE(reply, { type: "error", message: `replay failed: ${err}` });
            cleanup();
            try {
                endSSE(reply);
            }
            catch { /* 可能已经 close */ }
            return;
        }
        // 如果会话没在运行（竞态：刚好在 replay 期间结束），关闭
        if (!getInflight(sessionId)) {
            cleanup();
            try {
                endSSE(reply);
            }
            catch { /* 可能已经 close */ }
            return;
        }
    });
    // ───────────────────────────────────────────────────────────
    // POST /api/sessions —— 新建会话并跑首条消息（SSE）
    // ───────────────────────────────────────────────────────────
    app.post("/api/sessions", {
        // 关掉 fastify 默认的 body 大小 / 类型限制对 SSE 的影响
        config: { rawBody: false },
    }, async (req, reply) => {
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
        }
        catch {
            return reply.code(400).send({ error: "cwd does not exist" });
        }
        initSSE(reply);
        const ctrl = new AbortController();
        let sessionId;
        const profileId = body.profileId ?? null;
        const permissionMode = body.permissionMode ?? "bypassPermissions";
        const effortLevel = body.effortLevel ?? "high";
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
            const register = async (id) => {
                sessionId = id;
                setInflight(id, ctrl);
                // 标题：用户指定的优先，其次用首条消息截断
                const initialTitle = body.title?.trim() || body.message.trim().slice(0, 200) || null;
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
                    }
                    catch (err) {
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
                }
                // 跟踪 inflight 状态：HITL 等待 ↔ 运行中
                if (sessionId) {
                    if (evt.type === "waiting_for_user") {
                        setInflightWaiting(sessionId);
                    }
                    else {
                        setInflightRunning(sessionId);
                    }
                }
                // done 事件：先累加 token 到持久化存储，再发送新的累计值
                if (evt.type === "done" && sessionId) {
                    await accumulateTokens(sessionId, evt.inputTokens, evt.outputTokens).catch((err) => app.log.warn({ err }, `accumulateTokens failed for ${sessionId}`));
                    // 读取累加后的最新累计值，发送给前端
                    const updated = await getSession(sessionId);
                    const doneEvt = {
                        type: "done",
                        inputTokens: updated?.inputTokens ?? evt.inputTokens,
                        outputTokens: updated?.outputTokens ?? evt.outputTokens,
                        durationMs: evt.durationMs,
                    };
                    sendSSE(reply, doneEvt);
                    emitSessionEvent(sessionId, doneEvt);
                }
                else {
                    sendSSE(reply, evt);
                    if (sessionId) {
                        emitSessionEvent(sessionId, evt);
                    }
                }
            }
        }
        catch (err) {
            const message = err instanceof Error ? err.message : "unknown error";
            // 如果 abort，message 通常是 "This operation was aborted"
            const errorEvent = {
                type: "error",
                message: err instanceof Error && err.name === "AbortError"
                    ? "aborted"
                    : message,
            };
            sendSSE(reply, errorEvent);
            if (sessionId)
                emitSessionEvent(sessionId, errorEvent);
        }
        finally {
            if (sessionId) {
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
    app.post("/api/sessions/:id/messages", async (req, reply) => {
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
                permissionMode: rec.permissionMode ?? "bypassPermissions",
                effortLevel: rec.effortLevel ?? "high",
                // 已有会话：env = 全局默认 + 会话级 override
                env: await resolveSessionEnv(sessionId),
            });
            for await (const evt of stream) {
                // 跟踪 inflight 状态：HITL 等待 ↔ 运行中
                if (evt.type === "waiting_for_user") {
                    setInflightWaiting(sessionId);
                }
                else {
                    setInflightRunning(sessionId);
                }
                // done 事件：先累加 token 到持久化存储，再发送新的累计值
                if (evt.type === "done") {
                    await accumulateTokens(sessionId, evt.inputTokens, evt.outputTokens).catch((err) => app.log.warn({ err }, `accumulateTokens failed for ${sessionId}`));
                    const updated = await getSession(sessionId);
                    const doneEvt = {
                        type: "done",
                        inputTokens: updated?.inputTokens ?? evt.inputTokens,
                        outputTokens: updated?.outputTokens ?? evt.outputTokens,
                        durationMs: evt.durationMs,
                    };
                    sendSSE(reply, doneEvt);
                    emitSessionEvent(sessionId, doneEvt);
                }
                else {
                    sendSSE(reply, evt);
                    emitSessionEvent(sessionId, evt);
                }
            }
        }
        catch (err) {
            const message = err instanceof Error ? err.message : "unknown error";
            const errorEvent = {
                type: "error",
                message: err instanceof Error && err.name === "AbortError"
                    ? "aborted"
                    : message,
            };
            sendSSE(reply, errorEvent);
            emitSessionEvent(sessionId, errorEvent);
        }
        finally {
            emitSessionEnd(sessionId);
            clearInflight(sessionId);
            await touchSession(sessionId);
            endSSE(reply);
        }
    });
    // ───────────────────────────────────────────────────────────
    // POST /api/sessions/:id/abort —— 中止进行中的会话
    // ───────────────────────────────────────────────────────────
    app.post("/api/sessions/:id/abort", async (req, reply) => {
        const ctrl = getInflight(req.params.id);
        if (!ctrl) {
            return reply.code(404).send({ error: "no inflight query" });
        }
        ctrl.abort();
        return reply.send({ ok: true });
    });
    // ───────────────────────────────────────────────────────────
    // DELETE /api/sessions/:id —— 删除会话
    // ① 中止进行中的 query ② 删 ~/.claude/projects/ 转录
    // ③ 删 sessions.json 记录
    // ───────────────────────────────────────────────────────────
    app.delete("/api/sessions/:id", async (req, reply) => {
        const sessionId = req.params.id;
        // 先拿记录（需要 cwd 给 SDK deleteSession）
        const rec = await getSession(sessionId);
        // 中止进行中的（如果有）
        const ctrl = getInflight(sessionId);
        if (ctrl && !ctrl.signal.aborted)
            ctrl.abort();
        clearInflight(sessionId);
        // 真删 CLI 转录文件
        if (rec?.cwd) {
            try {
                await deleteSession(sessionId, { dir: rec.cwd });
            }
            catch (err) {
                // 文件可能已不存在，不阻塞
                const code = err?.code;
                if (code !== "ENOENT") {
                    app.log.warn({ err }, `SDK deleteSession failed for ${sessionId}`);
                }
            }
        }
        const removed = await deleteSessionRecord(sessionId);
        if (!removed) {
            return reply.code(404).send({ error: "session not found" });
        }
        return reply.send({ ok: true });
    });
    // ───────────────────────────────────────────────────────────
    // PUT /api/sessions/:id/title —— 更新会话标题（通过 SDK renameSession）
    // ───────────────────────────────────────────────────────────
    app.put("/api/sessions/:id/title", async (req, reply) => {
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
        }
        catch (err) {
            app.log.warn({ err }, `renameSession failed for ${id}`);
            // renameSession 失败不阻塞，标题下次列表刷新会回退到 summary
        }
        return reply.send({ ok: true, title: newTitle });
    });
    // ───────────────────────────────────────────────────────────
    // Profiles CRUD: /api/profiles
    // ───────────────────────────────────────────────────────────
    app.get("/api/profiles", async (_req, reply) => {
        return reply.send({ profiles: await listProfiles() });
    });
    app.post("/api/profiles", async (req, reply) => {
        const profile = await createProfile(req.body?.name ?? "新配置", req.body?.env);
        return reply.send({ profile });
    });
    app.put("/api/profiles/:id", async (req, reply) => {
        const profile = await updateProfile(req.params.id, {
            name: req.body?.name,
            env: req.body?.env,
        });
        if (!profile)
            return reply.code(404).send({ error: "profile not found" });
        return reply.send({ profile });
    });
    app.delete("/api/profiles/:id", async (req, reply) => {
        const ok = await deleteProfile(req.params.id);
        if (!ok)
            return reply.code(404).send({ error: "profile not found" });
        return reply.send({ ok: true });
    });
    // ───────────────────────────────────────────────────────────
    // PUT /api/sessions/:id/profile —— 切换会话绑定的 profile
    // body: { profileId: string | null }
    // ───────────────────────────────────────────────────────────
    app.put("/api/sessions/:id/profile", async (req, reply) => {
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
    app.put("/api/sessions/:id/permission-mode", async (req, reply) => {
        const rec = await getSession(req.params.id);
        if (!rec) {
            return reply.code(404).send({ error: "session not found" });
        }
        const mode = req.body?.permissionMode;
        const validModes = ["bypassPermissions", "default", "acceptEdits", "plan", "dontAsk", "auto"];
        if (!validModes.includes(mode)) {
            return reply.code(400).send({ error: "invalid permissionMode" });
        }
        await touchSession(req.params.id, { permissionMode: mode });
        return reply.send({ ok: true, permissionMode: mode });
    });
    // ───────────────────────────────────────────────────────────
    // PUT /api/sessions/:id/thinking-level —— 切换思考级别
    // body: { effortLevel: EffortLevel }
    // ───────────────────────────────────────────────────────────
    app.put("/api/sessions/:id/thinking-level", async (req, reply) => {
        const rec = await getSession(req.params.id);
        if (!rec) {
            return reply.code(404).send({ error: "session not found" });
        }
        const level = req.body?.effortLevel;
        const validLevels = ["low", "medium", "high", "xhigh", "max", "disabled"];
        if (!validLevels.includes(level)) {
            return reply.code(400).send({ error: "invalid effortLevel" });
        }
        await touchSession(req.params.id, { effortLevel: level });
        return reply.send({ ok: true, effortLevel: level });
    });
    // ───────────────────────────────────────────────────────────
    // GET /api/browse?path=xxx —— 列目录（供前端选 cwd）
    // ───────────────────────────────────────────────────────────
    app.get("/api/browse", async (req, reply) => {
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
                .filter((e) => !e.name.startsWith(".") && // 隐藏文件跳过
                !["node_modules", "dist", "build", ".git"].includes(e.name))
                .map((e) => ({
                name: e.name,
                isDir: e.isDirectory(),
                path: path.join(target, e.name),
            }))
                .sort((a, b) => {
                // 目录在前，名字字母序
                if (a.isDir !== b.isDir)
                    return a.isDir ? -1 : 1;
                return a.name.localeCompare(b.name);
            });
            return reply.send({ path: target, entries: filtered });
        }
        catch {
            return reply.code(404).send({ error: "cannot read directory" });
        }
    });
}
