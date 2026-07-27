/**
 * 远程设备追踪（Relay Devices）
 *
 * 设备在线状态绑定在 GET /api/events/stream 这条 SSE 长连接的生命周期上：
 *   - 远程浏览器建立 SSE 连接 → recordDevice（设备上线）
 *   - SSE 连接关闭 → removeDevice（设备下线，带宽限期）
 *
 * 这是"边缘触发"语义：同一设备开多个 tab，关任意一个即视为下线，
 * 直到下一个请求到来重新上线。配合 REMOVE_GRACE_MS 宽限期过滤
 * EventSource 断线重连抖动（单 tab 短暂断网不会假下线）。
 *
 * 不再使用 24h TTL + 请求推断：那条路无法得到 close 事件，设备永不消失。
 * 纯内存，不持久化。
 */
import { emitDeviceChanged } from "./eventBus.js";
// 内存设备表：id → entry
const devices = new Map();
// 下线宽限期：removeDevice 不立即删除，而是延后 N ms。
// 若期间 recordDevice 再次命中同一 id（EventSource 重连），取消删除。
// 用于过滤单 tab 断网→重连的抖动，避免假下线闪烁。
const REMOVE_GRACE_MS = 1500;
const pendingRemovals = new Map();
/**
 * 记录一次远程设备活动（SSE 连接建立时调用）。
 * 按 UA + IP 去重：命中则刷新 lastSeen 并取消待删除；未命中则新增。
 */
export function recordDevice(ua, ip) {
    const id = deviceId(ua, ip);
    const now = Date.now();
    // 取消可能存在的下线宽限定时器（重连抖动过滤）
    const pending = pendingRemovals.get(id);
    if (pending) {
        clearTimeout(pending);
        pendingRemovals.delete(id);
    }
    const existing = devices.get(id);
    if (existing) {
        existing.lastSeen = now;
        return;
    }
    const { browser, deviceType, os } = parseUA(ua);
    devices.set(id, { id, browser, deviceType, os, ip, firstSeen: now, lastSeen: now });
    emitDeviceChanged(getDevices());
}
/**
 * 标记设备下线（SSE 连接关闭时调用）。
 * 不立即删除：延迟 REMOVE_GRACE_MS，期间若有新活动（recordDevice）则取消。
 */
export function removeDevice(ua, ip) {
    const id = deviceId(ua, ip);
    if (!devices.has(id))
        return;
    if (pendingRemovals.has(id))
        return; // 已在待删除队列
    const timer = setTimeout(() => {
        pendingRemovals.delete(id);
        if (devices.delete(id)) {
            emitDeviceChanged(getDevices());
        }
    }, REMOVE_GRACE_MS);
    pendingRemovals.set(id, timer);
}
/** 返回当前在线设备列表，按最近活跃倒序 */
export function getDevices() {
    const list = [...devices.values()];
    list.sort((a, b) => b.lastSeen - a.lastSeen);
    return list;
}
/** 清空所有设备记录（隧道断开时调用，与 token 会话绑定一致） */
export function clearDevices() {
    // 取消所有待删除定时器
    for (const timer of pendingRemovals.values()) {
        clearTimeout(timer);
    }
    pendingRemovals.clear();
    if (devices.size === 0)
        return;
    devices.clear();
    emitDeviceChanged(getDevices());
}
// ── 工具函数 ──
function deviceId(ua, ip) {
    // 简单哈希：UA + IP 拼接后取长度+前后片段，足够去重，无需加密强度
    const s = `${ua}::${ip}`;
    return `${s.length.toString(36)}-${s.slice(0, 4)}-${s.slice(-4)}`;
}
/**
 * 手写 UA 解析（不引入依赖）。
 * 识别主流浏览器 + 设备类型 + 操作系统，未知返回 "未知" / "unknown"。
 */
function parseUA(ua) {
    const u = ua || "";
    // ── 浏览器（按识别优先级，避免误判：Edge/Opera 基于 Chromium）──
    let browser = "未知";
    let browserVer = "";
    // Edg/ 或 Edge/（Chromium Edge）
    let m = /Edg(?:e|A|iOS)?\/(\d+)/.exec(u);
    if (m) {
        browser = "Edge";
        browserVer = m[1];
    }
    else if ((m = /OPR\/(\d+)/.exec(u)) || (m = /Opera\/?\s*(\d+)/.exec(u))) {
        browser = "Opera";
        browserVer = m[1];
    }
    else if ((m = /Firefox\/(\d+)/.exec(u))) {
        browser = "Firefox";
        browserVer = m[1];
    }
    else if ((m = /Chrome\/(\d+)/.exec(u))) {
        browser = "Chrome";
        browserVer = m[1];
    }
    else if ((m = /Version\/(\d+).*Safari/.exec(u))) {
        browser = "Safari";
        browserVer = m[1];
    }
    if (browserVer)
        browser = `${browser} ${browserVer}`;
    // ── 操作系统 ──
    let os = "未知";
    if (/Windows NT 10/.test(u))
        os = "Windows";
    else if (/Windows/.test(u))
        os = "Windows";
    else if (/iPhone|iPad|iPod/.test(u))
        os = "iOS";
    else if (/Mac OS X|Macintosh/.test(u))
        os = "macOS";
    else if (/Android/.test(u))
        os = "Android";
    else if (/Linux/.test(u))
        os = "Linux";
    // ── 设备类型 ──
    let deviceType = "desktop";
    if (/iPad|Tablet/.test(u) || (/Android/.test(u) && !/Mobile/.test(u))) {
        deviceType = "tablet";
    }
    else if (/iPhone|Android.*Mobile|Mobile/.test(u)) {
        deviceType = "mobile";
    }
    return { browser, deviceType, os };
}
