import fsp from "node:fs/promises";
import path from "node:path";
import { getSession, syncAndListSessions, upsertSession, touchSession, deleteSessionRecord, listProfiles, createProfile, updateProfile, deleteProfile, resolveSessionEnv, resolveProfileEnv, setSessionProfile, } from "../lib/store.js";
import { runQuery, renameSession, getSessionInfo, listSessions as sdkListSessions, listSubagents } from "../lib/sdk.js";
import { runQueryToBus, emitEventToBus } from "../lib/queryRunner.js";
import { deleteSession } from "@anthropic-ai/claude-agent-sdk";
import { initSSE, sendSSE, endSSE } from "../lib/sse.js";
import { setInflight, clearInflight, getInflight, getInflightStatus, takePendingPermission, getPendingPermissions, rememberClientSession, resolveClientSession, } from "../lib/inflight.js";
import { replaySession } from "../lib/replay.js";
import { connectViaQRCode, validateFeishuCredentials } from "../channels/feishu.js";
import { startRelayTunnel, stopRelayTunnel, getRelayStatus, setLocalBase, mintToken, } from "../channels/relay.js";
import { getDevices } from "../lib/relayDevices.js";
import { DATA_DIR } from "../env.js";
import { emitSessionEvent, emitSessionEnd, emitSessionsChanged, onSessionEvent, onSessionEnd, onRelayStatus, onSessionsChanged } from "../lib/eventBus.js";
import { startZombieScanner, finalizeSession, cleanupSession } from "../lib/agentRegistry.js";
// 启动僵尸子代理扫描器（全局单例）
startZombieScanner();
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
                runningStatus: getInflightStatus(r.sessionId) ??
                    ((r.inputTokens ?? 0) + (r.outputTokens ?? 0) > 0
                        ? "completed"
                        : "idle"),
                permissionMode: r.permissionMode ?? "default",
                effortLevel: r.effortLevel ?? "default",
                inputTokens: r.inputTokens ?? 0,
                outputTokens: r.outputTokens ?? 0,
            };
        });
        return reply.send({ sessions: views });
    });
    // GET /api/sessions/stream —— 会话列表/状态变更通知（SSE，全局频道）
    // 前端 useSessions 订阅本端点，收到变更信号后自行 GET /api/sessions 拉最新列表，
    // 替代原先的 2 秒短轮询。
    app.get("/api/sessions/stream", async (_req, reply) => {
        initSSE(reply);
        // 订阅成功即通知前端拉一次（覆盖订阅期间可能错过的变更）
        sendSSE(reply, { type: "sessions_changed" });
        // 转发后续变更信号
        const unsub = onSessionsChanged(() => {
            try {
                sendSSE(reply, { type: "sessions_changed" });
            }
            catch (err) {
                console.warn("[sessions] stream sendSSE error:", err instanceof Error ? err.message : err);
            }
        });
        // 心跳防中间代理 idle 关闭
        const heartbeat = setInterval(() => {
            try {
                reply.raw.write(": ping\n\n");
            }
            catch { /* 连接已断 */ }
        }, 15000);
        _req.raw.on("close", () => {
            clearInterval(heartbeat);
            unsub();
        });
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
            permissionMode: rec.permissionMode ?? "default",
            effortLevel: rec.effortLevel ?? "default",
            runningStatus: getInflightStatus(rec.sessionId) ??
                ((rec.inputTokens ?? 0) + (rec.outputTokens ?? 0) > 0
                    ? "completed"
                    : "idle"),
            inputTokens: rec.inputTokens ?? 0,
            outputTokens: rec.outputTokens ?? 0,
            messages: history,
        });
    });
    // ───────────────────────────────────────────────────────────
    // GET /api/sessions/:id/stream —— 订阅会话实时 SSE 流
    //
    // 先 replay 全部历史消息，然后通过 EventBus 订阅后续实时事件。
    //
    // 为避免 replay 期间的事件丢失，订阅后先将事件暂存到缓冲区，
    // replay 完成后对缓冲区事件去重（工具事件按 ID，文本增量按累
    // 计长度），再切换到实时转发模式。
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
        // 阶段1：订阅 bus，暂存所有事件到缓冲区（不丢弃）
        const buffer = [];
        let buffering = true;
        // 会话在 replay 期间结束：不能立即关闭流，否则后续 sendSSE(history)
        // 会写已关闭的流（write-after-end）。先标记，待 replay 完成后由正常
        // 流程 flush buffer 并经 getInflight 检查兜底关闭。
        let endedDuringReplay = false;
        const onEvent = (evt) => {
            if (buffering) {
                buffer.push(evt);
            }
            else {
                sendSSE(reply, evt);
            }
        };
        const unsubEvent = onSessionEvent(sessionId, onEvent);
        // 心跳防中间代理 idle 关闭：会话在等待权限/SDK 思考期间可能数十秒无事件，
        // 远程链路（nginx/relay）若无数据会被当作 idle 切断，触发前端秒级重连风暴。
        // 与 /api/sessions/stream、/api/relay/stream 对齐，15s 发一行 SSE 注释。
        const heartbeat = setInterval(() => {
            try {
                reply.raw.write(": ping\n\n");
            }
            catch { /* 连接已断 */ }
        }, 15000);
        let unsubEnd;
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
            }
            else {
                cleanup();
                try {
                    endSSE(reply);
                }
                catch { /* 可能已经 close */ }
            }
        });
        // 客户端正常断开时清理（仅注册一次）
        req.raw.on("close", cleanup);
        // 阶段2：回放历史，收集去重依据
        try {
            const history = await replaySession(sessionId, rec.cwd);
            if (timedOut)
                return;
            // 从 history 提取：工具 ID 集合 + 最后一条 assistant 消息文本长度
            const historyToolIds = new Set();
            let lastTextLen = 0;
            for (let i = history.length - 1; i >= 0; i--) {
                if (history[i].role === "assistant") {
                    for (const part of history[i].content) {
                        if (part.type === "tool-call") {
                            historyToolIds.add(part.toolCallId);
                        }
                        else if (part.type === "text") {
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
                if ((evt.type === "tool_use" || evt.type === "tool_result") &&
                    historyToolIds.has(evt.id)) {
                    continue;
                }
                // 文本增量：累计长度 ≤ lastTextLen 说明已包含在 history 中
                if (evt.type === "text") {
                    textAccum += evt.text.length;
                    if (textAccum <= lastTextLen)
                        continue;
                    // 跨边界 delta：截掉已在 history 中的前缀部分
                    if (textAccum - evt.text.length < lastTextLen) {
                        const overlap = lastTextLen - (textAccum - evt.text.length);
                        const newPart = evt.text.slice(overlap);
                        if (newPart)
                            sendSSE(reply, { type: "text", text: newPart });
                        continue;
                    }
                }
                sendSSE(reply, evt);
            }
            // 重连补播：如果会话有待审批的权限请求（用户刷新/切回），
            // 重新推送给当前重连客户端。这些 permission_request 事件之前
            // 已经 emit 到 bus（首次请求时），重连客户端没收到，这里直接补发。
            // 不走 bus —— 避免其他订阅者重复收到。
            for (const pending of getPendingPermissions(sessionId)) {
                sendSSE(reply, {
                    type: "permission_request",
                    requestId: pending.requestId,
                    toolName: pending.toolName,
                    toolInput: pending.toolInput,
                    decisionReason: pending.decisionReason,
                });
            }
            // 如果会话没在运行（竞态：刚好在 replay 期间结束），关闭。
            // endedDuringReplay 表示 onSessionEnd 在 buffering 阶段触发过，
            // 此时 inflight 必已清除（emitSessionEnd 在 clearInflight 之后调用），
            // 两个条件等价，合并表达更清晰。
            if (endedDuringReplay || !getInflight(sessionId)) {
                cleanup();
                try {
                    endSSE(reply);
                }
                catch { /* 可能已经 close */ }
                return;
            }
        }
        catch (err) {
            app.log.warn({ err }, `replaySession failed in stream for ${sessionId}`);
            if (!timedOut) {
                sendSSE(reply, { type: "error", message: `replay failed: ${err}` });
            }
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
    //
    // 事件处理通过 emitEventToBus 统一完成（inflight 跟踪、token 累加、
    // 总线发射）。session_created 之后订阅总线，后续事件由总线转发，
    // 不再直接 sendSSE，消除双写。
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
        const permissionMode = body.permissionMode ?? "default";
        const effortLevel = body.effortLevel ?? "default";
        const clientId = body.clientId ?? null;
        /** 总线订阅取消函数（session_created 后赋值，finally 中清理） */
        let unsubBusEvents = null;
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
            const register = async (id) => {
                sessionId = id;
                setInflight(id, ctrl);
                // 记录 clientId→sessionId 映射，供断线重连时反查 sessionId 续流
                if (clientId)
                    rememberClientSession(clientId, id);
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
                // 会话已落盘，通知 Sidebar 新增
                emitSessionsChanged();
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
                // 避免侧栏刷新时 syncAndListSessions 发现会话不在 CLI 磁盘上而被误删
                if (evt.type === "session_created" && !registered) {
                    await register(evt.sessionId);
                    // 注册完成后订阅总线：所有事件（含查询事件、子代理事件）
                    // 统一通过总线转发到客户端，不再直接 sendSSE
                    if (sessionId && !unsubBusEvents) {
                        unsubBusEvents = onSessionEvent(sessionId, (e) => {
                            sendSSE(reply, e);
                        });
                    }
                }
                if (sessionId) {
                    // 统一事件处理 + 总线发射（inflight 跟踪、token 累加）
                    await emitEventToBus(sessionId, evt);
                    // 不直接 sendSSE —— 总线订阅负责转发
                }
                else if (!closed) {
                    // session_created 之前的异常情况，直接发（连接已关则丢弃）
                    sendSSE(reply, evt);
                }
            }
        }
        catch (err) {
            // 用户主动中止不是错误，不推 error 事件到前端
            if (!(err instanceof Error && err.name === "AbortError")) {
                const message = err instanceof Error ? err.message : "unknown error";
                const errorEvent = {
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
                }
                else if (!closed) {
                    sendSSE(reply, errorEvent);
                }
            }
        }
        finally {
            if (unsubBusEvents)
                unsubBusEvents();
            if (sessionId) {
                finalizeSession(sessionId);
                emitSessionEnd(sessionId);
                clearInflight(sessionId, ctrl);
                await touchSession(sessionId);
                // 会话结束（running→completed），通知 Sidebar 刷新。
                // 本路由不走 runQueryToBus（首条消息用独立 for-await），需手动补发。
                emitSessionsChanged();
            }
            try {
                endSSE(reply);
            }
            catch { /* 连接可能已关闭 */ }
        }
    });
    // ───────────────────────────────────────────────────────────
    // POST /api/sessions/:id/messages —— 已有会话发消息（SSE）
    //
    // 事件流统一经过 EventBus：runQueryToBus 将所有事件 emit 到总线，
    // handler 订阅总线转发到 HTTP 客户端。子代理事件也通过同一总线
    // 通道到达，无需单独订阅。
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
        // 订阅总线：所有事件（含查询事件、子代理事件）统一转发到客户端
        let closed = false;
        const unsubEvent = onSessionEvent(sessionId, (evt) => {
            if (!closed)
                sendSSE(reply, evt);
        });
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
        }
        finally {
            unsubEvent();
            await touchSession(sessionId);
            try {
                endSSE(reply);
            }
            catch { /* 连接可能已关闭 */ }
        }
    });
    // ───────────────────────────────────────────────────────────
    // GET /api/sessions/by-client/:clientId —— 凭 clientId 反查 sessionId
    // 新建会话时 session_created 未送达前端就断线的竞态下，前端凭此续流。
    // 与 /api/sessions/:id 路径段数不同，不会冲突。
    // ───────────────────────────────────────────────────────────
    app.get("/api/sessions/by-client/:clientId", async (req, reply) => {
        const sid = resolveClientSession(req.params.clientId);
        if (!sid) {
            return reply.code(404).send({ error: "no session for clientId" });
        }
        return reply.send({ sessionId: sid });
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
    // ① 中止进行中的 query ② 删 ~/.claude/projects/ 转录（含子代理）
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
        // 真删 CLI 转录文件（含子代理）。
        // 有 cwd 时传 dir 精确删除；无 cwd 时不传 dir，让 SDK 全局搜索。
        const dirOpt = rec?.cwd ? { dir: rec.cwd } : {};
        // 先查子代理列表，逐个删除子代理转录
        try {
            const childIds = await listSubagents(sessionId, dirOpt);
            await Promise.all(childIds.map((childId) => deleteSession(childId, dirOpt).catch((err) => {
                const code = err?.code;
                if (code !== "ENOENT") {
                    app.log.warn({ err }, `failed to delete subagent session ${childId}`);
                }
            })));
        }
        catch (err) {
            app.log.warn({ err }, `listSubagents failed during delete for ${sessionId}`);
        }
        // 再删主会话转录
        try {
            await deleteSession(sessionId, dirOpt);
        }
        catch (err) {
            const code = err?.code;
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
        const validModes = ["default", "acceptEdits", "plan", "dontAsk", "auto", "bypassPermissions"];
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
        const validLevels = ["low", "medium", "high", "xhigh", "max", "disabled", "default"];
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
        catch (err) {
            app.log.warn({ err }, `browse failed for ${target}`);
            return reply.code(404).send({ error: "cannot read directory" });
        }
    });
    // ───────────────────────────────────────────────────────────
    // GET /api/slash-commands —— 获取当前项目可用的斜杠命令
    // ───────────────────────────────────────────────────────────
    app.get("/api/slash-commands", async (req, reply) => {
        const cwd = req.query.cwd || process.cwd();
        const { resolveSlashCommands } = await import("../lib/slashCommands.js");
        const commands = await resolveSlashCommands(cwd);
        return reply.send({ commands });
    });
    // ───────────────────────────────────────────────────────────
    // Feishu 渠道 API
    // ───────────────────────────────────────────────────────────
    const FEISHU_CONFIG_FILE = path.join(DATA_DIR, "feishu-config.json");
    async function saveFeishuConfig(config) {
        await fsp.writeFile(FEISHU_CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
    }
    async function loadFeishuConfig() {
        try {
            const content = await fsp.readFile(FEISHU_CONFIG_FILE, "utf-8");
            return JSON.parse(content);
        }
        catch {
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
    app.post("/api/feishu/connect", async (req, reply) => {
        console.log("[feishu] connect request received");
        initSSE(reply);
        const ctrl = new AbortController();
        // 客户端断开（关对话框/切页）时中止二维码轮询，避免继续写死 socket
        req.raw.on("close", () => {
            if (!ctrl.signal.aborted)
                ctrl.abort();
        });
        function sendFeishuEvent(type, data) {
            reply.raw.write(`event: ${type}\n`);
            reply.raw.write(`data: ${JSON.stringify({ ...data, type })}\n\n`);
            const raw = reply.raw;
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
                    }
                    else if (status.phase === "success") {
                        sendFeishuEvent("connected", { appId: status.appId, domain: status.domain });
                    }
                    else if (status.phase === "expired") {
                        sendFeishuEvent("error", { message: "二维码已过期" });
                    }
                    else if (status.phase === "denied") {
                        sendFeishuEvent("error", { message: "用户拒绝授权" });
                    }
                    else if (status.phase === "error") {
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
            const channelConfig = {
                enabled: true,
                appId: result.appId,
                appSecret: result.appSecret,
                domain: result.domain,
            };
            await globalThis.__feishuChannelStarter?.(channelConfig);
        }
        catch (err) {
            if (err instanceof Error && err.name === "AbortError") {
                sendFeishuEvent("error", { message: "已取消" });
            }
            else {
                sendFeishuEvent("error", { message: err instanceof Error ? err.message : "连接失败" });
            }
        }
        finally {
            endSSE(reply);
        }
    });
    app.post("/api/feishu/disconnect", async (_req, reply) => {
        try {
            await fsp.unlink(FEISHU_CONFIG_FILE);
            return reply.send({ ok: true });
        }
        catch {
            return reply.send({ ok: true });
        }
    });
    app.post("/api/feishu/manual", async (req, reply) => {
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
    // ───────────────────────────────────────────────────────────
    // 远程控制（Relay）渠道 API
    // ───────────────────────────────────────────────────────────
    const RELAY_CONFIG_FILE = path.join(DATA_DIR, "relay-config.json");
    async function saveRelayConfig(config) {
        await fsp.writeFile(RELAY_CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
    }
    async function loadRelayConfig() {
        try {
            const content = await fsp.readFile(RELAY_CONFIG_FILE, "utf-8");
            const parsed = JSON.parse(content);
            if (!parsed.relayUrl || !parsed.accessKey)
                return null;
            return { relayUrl: parsed.relayUrl, accessKey: parsed.accessKey };
        }
        catch (err) {
            // 配置文件不存在属正常情况，不告警；其他错误才告警
            if (err.code !== "ENOENT") {
                console.warn("[relay] load config failed:", err instanceof Error ? err.message : err);
            }
            return null;
        }
    }
    // GET /api/relay/status —— 当前隧道状态 + 已保存配置
    app.get("/api/relay/status", async (_req, reply) => {
        const status = getRelayStatus();
        // 若运行时未启用，回退到落盘配置供前端展示（此时尚无 token，remoteUrl 为空）
        if (!status.relayUrl || !status.accessKey) {
            const saved = await loadRelayConfig();
            if (saved) {
                return reply.send({
                    ...status,
                    relayUrl: saved.relayUrl,
                    accessKey: saved.accessKey,
                });
            }
        }
        return reply.send(status);
    });
    // GET /api/relay/devices —— 当前接入的远程设备列表（按设备去重，1 天无活动移除）
    app.get("/api/relay/devices", async (_req, reply) => {
        return reply.send({ devices: getDevices() });
    });
    // GET /api/relay/stream —— 隧道状态实时推送（SSE，全局频道）
    // 前端 RemoteControlDialog 的左下角图标订阅本端点，状态变化即时变色，无需轮询。
    app.get("/api/relay/stream", async (_req, reply) => {
        initSSE(reply);
        // 先发当前快照，保证订阅瞬间就能反映正确状态
        const status = getRelayStatus();
        // 运行时没配置时回退到落盘配置，与 /status 行为一致
        let snapshot = status;
        if (!status.relayUrl || !status.accessKey) {
            const saved = await loadRelayConfig();
            if (saved) {
                snapshot = {
                    ...status,
                    relayUrl: saved.relayUrl,
                    accessKey: saved.accessKey,
                };
            }
        }
        sendSSE(reply, { type: "relay_status", status: snapshot });
        // 之后转发 bus 上的状态变更
        const unsub = onRelayStatus((s) => {
            try {
                sendSSE(reply, { type: "relay_status", status: s });
            }
            catch (err) {
                console.warn("[relay] stream sendSSE error:", err instanceof Error ? err.message : err);
            }
        });
        // 周期性心跳防止中间代理 idle 超时关闭连接（: 结尾行会被 SSE 解析为注释）
        const heartbeat = setInterval(() => {
            try {
                reply.raw.write(": ping\n\n");
            }
            catch { /* 连接已断 */ }
        }, 15000);
        const cleanup = () => {
            clearInterval(heartbeat);
            unsub();
        };
        _req.raw.on("close", cleanup);
    });
    // POST /api/relay/start —— 启用隧道
    app.post("/api/relay/start", async (req, reply) => {
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
        const config = { relayUrl, accessKey };
        try {
            await saveRelayConfig(config);
        }
        catch (err) {
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
    app.post("/api/relay/regenerate-key", async (req, reply) => {
        const crypto = await import("node:crypto");
        const newKey = crypto.randomBytes(24).toString("base64url");
        const saved = await loadRelayConfig();
        const relayUrl = (req.body?.relayUrl ?? saved?.relayUrl ?? "").trim();
        if (!relayUrl) {
            return reply.code(400).send({ error: "请先填写中转地址" });
        }
        const config = { relayUrl, accessKey: newKey };
        try {
            await saveRelayConfig(config);
        }
        catch (err) {
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
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn("[relay] refresh-token failed:", msg);
            return reply.code(400).send({ error: msg });
        }
    });
    // 暴露给 index.ts：仅注入 localBase。远程控制不在启动时自动开启，
    // 必须由用户在界面上主动"启用"。loadRelayConfig 仍供上方 status 端点回退使用。
    globalThis.__relayLoadConfig = loadRelayConfig;
    globalThis.__relayStart = startRelayTunnel;
    globalThis.__relaySetLocalBase = setLocalBase;
    // ───────────────────────────────────────────────────────────
    // POST /api/sessions/:id/permission-response
    // 前端对 permission_request 事件的响应：批准/拒绝某个工具调用
    // ───────────────────────────────────────────────────────────
    app.post("/api/sessions/:id/permission-response", async (req, reply) => {
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
    app.post("/api/sessions/:id/approve-plan", async (req, reply) => {
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
        const execMode = "acceptEdits";
        await touchSession(sessionId, { permissionMode: execMode });
        // 构建执行提示词
        let execPrompt;
        if (prompt?.trim()) {
            execPrompt = prompt.trim();
        }
        else if (editedPlan?.trim()) {
            execPrompt = `The user has approved the following plan with edits:\n\n${editedPlan}\n\nProceed with implementation.`;
        }
        else {
            execPrompt = "The user has approved the plan. Proceed with implementation.";
        }
        initSSE(reply);
        const ctrl = new AbortController();
        setInflight(sessionId, ctrl);
        // 订阅总线：统一转发所有事件，session_created 替换为 mode_changed
        let closed = false;
        const unsubEvent = onSessionEvent(sessionId, (evt) => {
            if (closed)
                return;
            if (evt.type === "session_created") {
                sendSSE(reply, { type: "mode_changed", mode: execMode });
            }
            else {
                sendSSE(reply, evt);
            }
        });
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
        }
        finally {
            unsubEvent();
            await touchSession(sessionId);
            try {
                endSSE(reply);
            }
            catch { /* 连接可能已关闭 */ }
        }
    });
}
