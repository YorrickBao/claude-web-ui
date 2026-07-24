/**
 * 远程控制通道（Relay Channel）
 *
 * 作用：本地 WebUI（绑定 127.0.0.1）主动出站连接公网中转服务，把本地全部 API
 * 透传给远程浏览器，从而实现"远程操作等效于本地"。
 *
 * 链路：
 *   远程浏览器 ──wss──► 中转 ──ws出站隧道──► 本地WebUI(本模块)
 *
 * 本模块维护一条到中转的 WS 单例连接。中转把远程浏览器的 HTTP 请求包装成
 * req/req_body 帧转发进来，本模块在本地 fetch 自身 API，再把响应头/流式 body
 * 转成 res/res_body 帧回传。SSE（text/event-stream）会被逐 chunk 持续转发，
 * 远程浏览器获得与本地完全一致的流式体验。
 *
 * 与 channels/feishu.ts 同属"外部接入通道"，但方向不同：飞书是消息进来，
 * relay 是把本地服务暴露出去。二者都复用 runQuery 等核心能力（relay 经由
 * 本地 HTTP API 间接复用，无需直接调 SDK）。
 */
import { LOG_ENABLED } from "../env.js";
import { emitRelayStatus } from "../lib/eventBus.js";
import { clearDevices } from "../lib/relayDevices.js";
// ── 模块级单例状态 ──
let ws = null;
let currentConfig = null;
let connected = false;
let connecting = false;
let lastError = null;
let enabled = false;
// 重连退避
let reconnectTimer = null;
let reconnectAttempts = 0;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
// 心跳
let pingTimer = null;
const PING_INTERVAL_MS = 25000; // 略小于中转 30s，确保中转 readIdleTimeout 不触发
// 访问令牌：一次性、短命，远程地址携带 ?t=token 首次换 cookie。
// 不进 accessKey，杜绝长期密钥出现在 URL（日志/Referer/历史）。
const TOKEN_TTL_SEC = 60;
let currentToken = null;
let tokenExpiryTimer = null;
// 收集每个 connId 的请求体：req 帧到达后创建 resolver，req_body 分片累积，
// req_body:last 时 resolve 触发 fetch。避免轮询延迟。
const reqBodyBuffers = new Map();
const reqBodyResolvers = new Map();
/** 由 index.ts 在 server 监听成功后注入本地 base URL，如 http://127.0.0.1:23456 */
let localBase = null;
export function setLocalBase(base) {
    localBase = base;
}
/** 当前状态快照（供 /api/relay/status 读取） */
export function getRelayStatus() {
    const relayUrl = currentConfig?.relayUrl ?? "";
    const accessKey = currentConfig?.accessKey ?? "";
    // 惰式过期：取快照时若 token 已到期则视为无 token
    const token = currentToken && currentToken.expiresAt > Date.now() ? currentToken : null;
    return {
        enabled,
        connected,
        connecting,
        relayUrl,
        accessKey,
        remoteUrl: token ? buildRemoteUrl(relayUrl, token.token) : "",
        tokenExpiresAt: token ? token.expiresAt : null,
        error: lastError,
    };
}
/**
 * 生成一个一次性访问令牌（60s 有效），经隧道登记到中转，并广播状态。
 * 仅在隧道已连接时可用。返回令牌信息或抛出错误（调用方负责提示）。
 */
export async function mintToken() {
    if (!enabled || !connected || !ws || ws.readyState !== WebSocket.OPEN || !currentConfig) {
        throw new Error("隧道未连接，请先启用远程控制");
    }
    const crypto = await import("node:crypto");
    const token = crypto.randomBytes(24).toString("base64url");
    const expiresAt = Date.now() + TOKEN_TTL_SEC * 1000;
    // 清理上一个令牌的到期定时器
    if (tokenExpiryTimer) {
        clearTimeout(tokenExpiryTimer);
        tokenExpiryTimer = null;
    }
    currentToken = { token, expiresAt };
    // 经隧道登记到中转：中转据此建立 token→accessKey 映射
    send({ type: "register_token", token, ttlSec: TOKEN_TTL_SEC });
    // 到期自动清空（驱动前端显示「已失效」）
    tokenExpiryTimer = setTimeout(() => {
        tokenExpiryTimer = null;
        if (currentToken && currentToken.expiresAt <= Date.now()) {
            currentToken = null;
            notifyStatus();
        }
    }, TOKEN_TTL_SEC * 1000 + 200); // +200ms 余量，避免早于 expiresAt 触发
    notifyStatus();
    return { token, expiresAt };
}
/** 清除当前令牌（断开/停止时调用） */
function clearToken() {
    if (tokenExpiryTimer) {
        clearTimeout(tokenExpiryTimer);
        tokenExpiryTimer = null;
    }
    currentToken = null;
}
/** 取最新快照并广播到全局 relay 频道（驱动前端图标颜色实时变化） */
function notifyStatus() {
    emitRelayStatus(getRelayStatus());
}
/** 启动隧道。重复调用会先停止旧连接。 */
export function startRelayTunnel(config) {
    // 若已在运行，先停（但不清 enabled 意图）
    if (ws || reconnectTimer) {
        stopInternal(false);
    }
    currentConfig = config;
    enabled = true;
    lastError = null;
    reconnectAttempts = 0;
    connect();
    notifyStatus();
}
/** 停止隧道。保留 config 落盘，仅断开连接。 */
export function stopRelayTunnel() {
    stopInternal(true);
}
function stopInternal(clearEnabled) {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
    }
    if (ws) {
        try {
            ws.onclose = null; // 抑制 onclose 触发重连
            ws.close();
        }
        catch (err) {
            console.warn("[relay] ws close error:", err instanceof Error ? err.message : err);
        }
        ws = null;
    }
    connected = false;
    connecting = false;
    reqBodyBuffers.clear();
    reqBodyResolvers.clear();
    clearToken();
    clearDevices(); // 隧道停止：远程设备无法再访问，清空设备列表
    if (clearEnabled) {
        enabled = false;
    }
    notifyStatus();
}
/** 建立到中转的连接并发 register 帧 */
function connect() {
    if (!currentConfig) {
        console.warn("[relay] connect called without config");
        return;
    }
    const { relayUrl, accessKey } = currentConfig;
    // 构造隧道端点 URL：中转约定 /tunnel 路径
    const tunnelUrl = buildTunnelUrl(relayUrl);
    connecting = true;
    notifyStatus();
    let socket;
    try {
        socket = new WebSocket(tunnelUrl);
    }
    catch (err) {
        const msg = `construct ws failed: ${err instanceof Error ? err.message : err}`;
        console.warn(`[relay] ${msg}`);
        lastError = msg;
        connecting = false;
        notifyStatus();
        scheduleReconnect();
        return;
    }
    ws = socket;
    socket.onopen = () => {
        connecting = false;
        notifyStatus();
        // 立即发 register
        send({ type: "register", accessKey });
        // 启动心跳
        if (pingTimer)
            clearInterval(pingTimer);
        pingTimer = setInterval(() => send({ type: "ping" }), PING_INTERVAL_MS);
    };
    socket.onmessage = (ev) => {
        handleFrame(ev.data).catch((err) => {
            console.warn("[relay] handleFrame error:", err instanceof Error ? err.message : err);
        });
    };
    socket.onerror = (ev) => {
        // WebSocket error 事件不携带可读 message；具体错误会在 onclose 体现
        console.warn("[relay] ws error event:", ev);
    };
    socket.onclose = (ev) => {
        connected = false;
        connecting = false;
        if (pingTimer) {
            clearInterval(pingTimer);
            pingTimer = null;
        }
        // token 与隧道会话绑定：断开后 relay 侧映射可能已丢（如 relay 重启），
        // 清空本地 token，避免前端展示「有效却打不开」的链接。重连后需重新生成。
        clearToken();
        clearDevices(); // 隧道断开：远程设备列表与本次会话绑定，一并清空
        if (!enabled) {
            // 用户主动停止，不重连（状态已由 stopInternal 广播）
            return;
        }
        lastError = `closed (code=${ev.code}${ev.reason ? `, reason=${ev.reason}` : ""})`;
        notifyStatus();
        scheduleReconnect();
    };
}
function scheduleReconnect() {
    if (!enabled)
        return;
    if (reconnectTimer)
        return;
    reconnectAttempts++;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** (reconnectAttempts - 1), RECONNECT_MAX_MS);
    if (LOG_ENABLED)
        console.info(`[relay] reconnect in ${delay}ms (attempt ${reconnectAttempts})`);
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
    }, delay);
}
/** 发送一帧 */
function send(f) {
    if (!ws || ws.readyState !== WebSocket.OPEN)
        return;
    try {
        ws.send(JSON.stringify(f));
    }
    catch (err) {
        console.warn("[relay] send error:", err instanceof Error ? err.message : err);
    }
}
/** 处理从中转收到的帧 */
async function handleFrame(data) {
    let f;
    try {
        const text = typeof data === "string" ? data : await dataToString(data);
        f = JSON.parse(text);
    }
    catch (err) {
        console.warn("[relay] decode frame failed:", err instanceof Error ? err.message : err);
        return;
    }
    switch (f.type) {
        case "registered":
            if (f.ok) {
                connected = true;
                lastError = null;
                reconnectAttempts = 0;
                if (LOG_ENABLED)
                    console.info("[relay] tunnel registered");
            }
            else {
                lastError = f.message ?? "register rejected";
                console.warn(`[relay] register rejected: ${lastError}`);
            }
            notifyStatus();
            break;
        case "ping":
            send({ type: "pong" });
            break;
        case "pong":
            break;
        case "req":
            await handleReq(f);
            break;
        case "req_body": {
            const parts = reqBodyBuffers.get(f.connId);
            if (parts) {
                parts.push(f.body);
            }
            if (f.last) {
                // 请求体接收完毕，唤醒等待中的 handleReq
                const joined = parts ? parts.join("") : "";
                reqBodyBuffers.delete(f.connId);
                const resolver = reqBodyResolvers.get(f.connId);
                if (resolver) {
                    reqBodyResolvers.delete(f.connId);
                    // 空请求体用 undefined，避免 GET/HEAD 误带 body
                    resolver(joined || undefined);
                }
            }
            break;
        }
        case "end": {
            // 远程客户端取消请求（如浏览器关闭 SSE 连接）
            reqBodyBuffers.delete(f.connId);
            const resolver = reqBodyResolvers.get(f.connId);
            if (resolver) {
                reqBodyResolvers.delete(f.connId);
                resolver(undefined);
            }
            break;
        }
        case "error":
            console.warn(`[relay] relay error${f.connId ? ` (connId=${f.connId})` : ""}: ${f.message}`);
            break;
        default:
            if (LOG_ENABLED)
                console.warn("[relay] unknown frame type:", f.type);
    }
}
/** 处理一次 HTTP 请求转发 */
async function handleReq(f) {
    const { connId, method, path } = f;
    if (!localBase) {
        sendError(connId, "local server not ready");
        return;
    }
    // 等待请求体：中转在 req 帧后必发 req_body:last 标记结束。
    // 这里创建 buffer + resolver，由 req_body 帧处理逻辑填充并唤醒。
    reqBodyBuffers.set(connId, []);
    const body = await new Promise((resolve) => {
        reqBodyResolvers.set(connId, resolve);
    });
    // 构造转发 headers：剔除 hop-by-hop
    const headers = new Headers();
    if (f.headers) {
        for (const [k, v] of Object.entries(f.headers)) {
            const lk = k.toLowerCase();
            if (lk === "host" || lk === "connection" || lk === "content-length")
                continue;
            headers.set(k, v);
        }
    }
    // 注入标识头，让本地 preHandler hook 识别这是经 relay 转发的请求，
    // 据此解析 UA/IP 记录远程设备信息（功能：设备列表）。
    headers.set("X-CWU-Via", "relay");
    const url = `${localBase}${path}`;
    let resp;
    try {
        resp = await fetch(url, {
            method,
            headers,
            // GET/HEAD 不能带 body；空 body 也必须为 undefined，否则 Node fetch 报错
            body: body ? body : undefined,
        });
    }
    catch (err) {
        const msg = `local fetch failed: ${err instanceof Error ? err.message : err}`;
        console.warn(`[relay] ${msg} (${connId} ${method} ${path})`);
        sendError(connId, msg);
        return;
    }
    // 回传响应头
    const respHeaders = {};
    resp.headers.forEach((v, k) => {
        // 跳过会干扰浏览器帧处理的 hop-by-hop 头
        const lk = k.toLowerCase();
        if (lk === "transfer-encoding" || lk === "content-encoding")
            return;
        respHeaders[k] = v;
    });
    send({ type: "res", connId, status: resp.status, headers: respHeaders });
    // 流式回传响应体
    const isSse = (resp.headers.get("content-type") ?? "").includes("text/event-stream");
    if (!resp.body) {
        send({ type: "res_body", connId, body: "", last: true });
        return;
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) {
                send({ type: "res_body", connId, body: "", last: true });
                break;
            }
            const chunk = decoder.decode(value, { stream: true });
            if (chunk) {
                send({ type: "res_body", connId, body: chunk, last: false });
            }
        }
    }
    catch (err) {
        const msg = `stream read failed: ${err instanceof Error ? err.message : err}`;
        console.warn(`[relay] ${msg} (${connId})`);
        // 通知对端流异常终止
        send({ type: "error", connId, message: msg });
    }
    // SSE 标记仅用于日志
    void isSse;
}
function sendError(connId, message) {
    send({ type: "error", connId, message });
}
async function dataToString(data) {
    if (typeof data === "string")
        return data;
    if (data instanceof ArrayBuffer)
        return new TextDecoder().decode(data);
    if (ArrayBuffer.isView(data)) {
        return new TextDecoder().decode(data);
    }
    // Blob
    if (data && typeof data.text === "function") {
        return await data.text();
    }
    throw new Error("unsupported ws data type");
}
/** 把用户填的中转地址（wss://relay.example.com）转为隧道端点 URL */
function buildTunnelUrl(relayUrl) {
    const u = normalizeUrl(relayUrl);
    // wss→https→追加 /tunnel；ws→http 同理
    return `${u}/tunnel`;
}
/** 由中转地址 + 一次性 token 构造远程浏览器访问地址（HTTP，供浏览器/二维码使用） */
export function buildRemoteUrl(relayUrl, token) {
    if (!relayUrl || !token)
        return "";
    const u = toHttpScheme(normalizeUrl(relayUrl));
    return `${u}/?t=${encodeURIComponent(token)}`;
}
/** 规范化：去掉末尾斜杠。保留 scheme（wss/ws 或 https/http） */
function normalizeUrl(u) {
    return u.replace(/\/+$/, "");
}
/** wss→https、ws→http，供浏览器 HTTP 访问用（隧道端点保持 ws/wss） */
function toHttpScheme(u) {
    if (u.startsWith("wss://"))
        return "https://" + u.slice("wss://".length);
    if (u.startsWith("ws://"))
        return "http://" + u.slice("ws://".length);
    return u;
}
