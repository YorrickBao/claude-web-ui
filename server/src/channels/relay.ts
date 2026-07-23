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

/** 远程控制配置（落盘到 DATA_DIR/relay-config.json） */
export interface RelayConfig {
  /** 中转服务地址，如 wss://relay.example.com */
  relayUrl: string;
  /** 访问密钥，本地与远程配对用 */
  accessKey: string;
}

/** 隧道连接状态 */
export type RelayStatus = {
  /** 是否已启动（用户意图） */
  enabled: boolean;
  /** WS 连接是否活跃 */
  connected: boolean;
  /** 正在重连中 */
  connecting: boolean;
  relayUrl: string;
  accessKey: string;
  /** 远程访问地址（连接成功后才有意义） */
  remoteUrl: string;
  /** 最近一次错误信息 */
  error: string | null;
};

// ── 协议帧类型（与 relay/protocol.go 保持一致）──
type Frame =
  | { type: "register"; accessKey: string }
  | { type: "registered"; ok: boolean; message?: string }
  | { type: "req"; connId: string; method: string; path: string; headers?: Record<string, string> }
  | { type: "req_body"; connId: string; body: string; last: boolean }
  | { type: "res"; connId: string; status: number; headers?: Record<string, string> }
  | { type: "res_body"; connId: string; body: string; last: boolean }
  | { type: "end"; connId: string }
  | { type: "error"; connId?: string; message: string }
  | { type: "ping" }
  | { type: "pong" };

// ── 模块级单例状态 ──
let ws: WebSocket | null = null;
let currentConfig: RelayConfig | null = null;
let connected = false;
let connecting = false;
let lastError: string | null = null;
let enabled = false;

// 重连退避
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

// 心跳
let pingTimer: ReturnType<typeof setInterval> | null = null;
const PING_INTERVAL_MS = 25000; // 略小于中转 30s，确保中转 readIdleTimeout 不触发

// 收集每个 connId 的请求体分片
const reqBodyBuffers = new Map<string, string[]>();

/** 由 index.ts 在 server 监听成功后注入本地 base URL，如 http://127.0.0.1:23456 */
let localBase: string | null = null;
export function setLocalBase(base: string): void {
  localBase = base;
}

/** 当前状态快照（供 /api/relay/status 读取） */
export function getRelayStatus(): RelayStatus {
  const relayUrl = currentConfig?.relayUrl ?? "";
  const accessKey = currentConfig?.accessKey ?? "";
  return {
    enabled,
    connected,
    connecting,
    relayUrl,
    accessKey,
    remoteUrl: buildRemoteUrl(relayUrl, accessKey),
    error: lastError,
  };
}

/** 启动隧道。重复调用会先停止旧连接。 */
export function startRelayTunnel(config: RelayConfig): void {
  // 若已在运行，先停（但不清 enabled 意图）
  if (ws || reconnectTimer) {
    stopInternal(false);
  }
  currentConfig = config;
  enabled = true;
  lastError = null;
  reconnectAttempts = 0;
  connect();
}

/** 停止隧道。保留 config 落盘，仅断开连接。 */
export function stopRelayTunnel(): void {
  stopInternal(true);
}

function stopInternal(clearEnabled: boolean): void {
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
    } catch (err) {
      console.warn("[relay] ws close error:", err instanceof Error ? err.message : err);
    }
    ws = null;
  }
  connected = false;
  connecting = false;
  reqBodyBuffers.clear();
  if (clearEnabled) {
    enabled = false;
  }
}

/** 建立到中转的连接并发 register 帧 */
function connect(): void {
  if (!currentConfig) {
    console.warn("[relay] connect called without config");
    return;
  }
  const { relayUrl, accessKey } = currentConfig;

  // 构造隧道端点 URL：中转约定 /tunnel 路径
  const tunnelUrl = buildTunnelUrl(relayUrl);
  connecting = true;

  let socket: WebSocket;
  try {
    socket = new WebSocket(tunnelUrl);
  } catch (err) {
    const msg = `construct ws failed: ${err instanceof Error ? err.message : err}`;
    console.warn(`[relay] ${msg}`);
    lastError = msg;
    connecting = false;
    scheduleReconnect();
    return;
  }
  ws = socket;

  socket.onopen = () => {
    connecting = false;
    // 立即发 register
    send({ type: "register", accessKey });
    // 启动心跳
    if (pingTimer) clearInterval(pingTimer);
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
    if (!enabled) return; // 用户主动停止，不重连
    lastError = `closed (code=${ev.code}${ev.reason ? `, reason=${ev.reason}` : ""})`;
    scheduleReconnect();
  };
}

function scheduleReconnect(): void {
  if (!enabled) return;
  if (reconnectTimer) return;
  reconnectAttempts++;
  const delay = Math.min(RECONNECT_BASE_MS * 2 ** (reconnectAttempts - 1), RECONNECT_MAX_MS);
  if (LOG_ENABLED) console.info(`[relay] reconnect in ${delay}ms (attempt ${reconnectAttempts})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

/** 发送一帧 */
function send(f: Frame): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(f));
  } catch (err) {
    console.warn("[relay] send error:", err instanceof Error ? err.message : err);
  }
}

/** 处理从中转收到的帧 */
async function handleFrame(data: unknown): Promise<void> {
  let f: Frame;
  try {
    const text = typeof data === "string" ? data : await dataToString(data);
    f = JSON.parse(text) as Frame;
  } catch (err) {
    console.warn("[relay] decode frame failed:", err instanceof Error ? err.message : err);
    return;
  }

  switch (f.type) {
    case "registered":
      if (f.ok) {
        connected = true;
        lastError = null;
        reconnectAttempts = 0;
        if (LOG_ENABLED) console.info("[relay] tunnel registered");
      } else {
        lastError = f.message ?? "register rejected";
        console.warn(`[relay] register rejected: ${lastError}`);
      }
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
        if (f.last) {
          // 请求体接收完毕的事件由 handleReq 在收到首个 req 时已启动异步处理，
          // 这里仅负责累积；若 req 尚未记录则忽略（乱序）
        }
      }
      break;
    }

    case "end": {
      // 远程客户端取消请求（如 SSE 关闭），转发到本地 fetch 不可中途取消，
      // 记录即可；SSE 会在本地流结束时自然收尾
      reqBodyBuffers.delete(f.connId);
      break;
    }

    case "error":
      console.warn(`[relay] relay error${f.connId ? ` (connId=${f.connId})` : ""}: ${f.message}`);
      break;

    default:
      if (LOG_ENABLED) console.warn("[relay] unknown frame type:", (f as { type: string }).type);
  }
}

/** 处理一次 HTTP 请求转发 */
async function handleReq(
  f: { connId: string; method: string; path: string; headers?: Record<string, string> },
): Promise<void> {
  const { connId, method, path } = f;

  if (!localBase) {
    sendError(connId, "local server not ready");
    return;
  }

  // 等待可能的请求体分片（给 50ms 让后续 req_body 到达；绝大多数 POST 体很小，单帧完成）
  let body: string | undefined;
  const buffered = reqBodyBuffers.get(connId);
  if (buffered) {
    // 已有分片累积（某些实现首帧带 body）
    body = buffered.join("");
    reqBodyBuffers.delete(connId);
  } else {
    // 等一小段时间收集 req_body 帧
    body = await collectReqBody(connId);
  }

  // 构造转发 headers：剔除 hop-by-hop
  const headers = new Headers();
  if (f.headers) {
    for (const [k, v] of Object.entries(f.headers)) {
      const lk = k.toLowerCase();
      if (lk === "host" || lk === "connection" || lk === "content-length") continue;
      headers.set(k, v);
    }
  }

  const url = `${localBase}${path}`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      method,
      headers,
      body: body ?? undefined,
    });
  } catch (err) {
    const msg = `local fetch failed: ${err instanceof Error ? err.message : err}`;
    console.warn(`[relay] ${msg} (${connId} ${method} ${path})`);
    sendError(connId, msg);
    return;
  }

  // 回传响应头
  const respHeaders: Record<string, string> = {};
  resp.headers.forEach((v, k) => {
    // 跳过会干扰浏览器帧处理的 hop-by-hop 头
    const lk = k.toLowerCase();
    if (lk === "transfer-encoding" || lk === "content-encoding") return;
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
  } catch (err) {
    const msg = `stream read failed: ${err instanceof Error ? err.message : err}`;
    console.warn(`[relay] ${msg} (${connId})`);
    // 通知对端流异常终止
    send({ type: "error", connId, message: msg });
  }
  // SSE 标记仅用于日志
  void isSse;
}

/** 收集一个 connId 的请求体分片，最多等 200ms */
function collectReqBody(connId: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const buf: string[] = [];
    reqBodyBuffers.set(connId, buf);
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      reqBodyBuffers.delete(connId);
      resolve(buf.length ? buf.join("") : undefined);
    };
    // 轮询 20ms 一次，200ms 内收齐即返回
    const start = Date.now();
    const tick = () => {
      if (buf.length > 0) {
        // 收到首片后再给 30ms 看是否有后续分片
        setTimeout(finish, 30);
        return;
      }
      if (Date.now() - start > 200) {
        finish();
        return;
      }
      setTimeout(tick, 20);
    };
    // 先清空，让 req_body 累积到 buf
    reqBodyBuffers.set(connId, buf);
    setTimeout(tick, 5);
  });
}

function sendError(connId: string, message: string): void {
  send({ type: "error", connId, message });
}

async function dataToString(data: unknown): Promise<string> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data as Uint8Array);
  }
  // Blob
  if (data && typeof (data as { text?: unknown }).text === "function") {
    return await (data as { text: () => Promise<string> }).text();
  }
  throw new Error("unsupported ws data type");
}

/** 把用户填的中转地址（wss://relay.example.com）转为隧道端点 URL */
function buildTunnelUrl(relayUrl: string): string {
  const u = normalizeUrl(relayUrl);
  // wss→https→追加 /tunnel；ws→http 同理
  return `${u}/tunnel`;
}

/** 由中转地址 + accessKey 构造远程浏览器访问地址 */
function buildRemoteUrl(relayUrl: string, accessKey: string): string {
  if (!relayUrl || !accessKey) return "";
  const u = normalizeUrl(relayUrl);
  return `${u}/?k=${encodeURIComponent(accessKey)}`;
}

/** 规范化：去掉末尾斜杠。保留 scheme（wss/ws 或 https/http） */
function normalizeUrl(u: string): string {
  return u.replace(/\/+$/, "");
}
