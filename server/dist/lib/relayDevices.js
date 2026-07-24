/**
 * 远程设备追踪（Relay Devices）
 *
 * 远程浏览器经 relay 转发到本地的请求带有 X-CWU-Via: relay 标识头，
 * 本模块据此解析 User-Agent / 真实 IP，维护一张「活跃设备」表，
 * 供本地 WebUI 的「远程控制」面板展示已接入设备。
 *
 * 纯内存，不持久化：设备重新活动即恢复记录，重启不影响。
 * 按设备去重：UA + IP 相同视为同一设备，刷新 lastSeen 不新增。
 */
// 内存设备表：id → entry
const devices = new Map();
// 空闲多久后移除设备（1 天）。远程控制是低频长尾场景，10 分钟过短（切个应用回来就空了）；
// 1 天符合「今天用过的设备」心智模型。去重基于 UA+IP，移动网络切换会让同一设备累积多条，可接受。
const IDLE_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * 记录一次远程请求对应的设备。
 * 按 UA + IP 去重：命中则刷新 lastSeen，未命中则新增。
 */
export function recordDevice(ua, ip) {
    const id = deviceId(ua, ip);
    const now = Date.now();
    const existing = devices.get(id);
    if (existing) {
        existing.lastSeen = now;
        return;
    }
    const { browser, deviceType, os } = parseUA(ua);
    devices.set(id, { id, browser, deviceType, os, ip, firstSeen: now, lastSeen: now });
}
/** 返回当前活跃设备列表（已剔除过期），按最近活跃倒序 */
export function getDevices() {
    const now = Date.now();
    const list = [];
    for (const [id, d] of devices) {
        if (now - d.lastSeen > IDLE_TTL_MS) {
            devices.delete(id);
            continue;
        }
        list.push(d);
    }
    list.sort((a, b) => b.lastSeen - a.lastSeen);
    return list;
}
/** 清空所有设备记录（隧道断开时调用，与 token 会话绑定一致） */
export function clearDevices() {
    devices.clear();
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
