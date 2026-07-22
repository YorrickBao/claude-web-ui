import fsp from "node:fs/promises";
import { DATA_DIR, PROFILES_FILE, SESSIONS_FILE } from "../env.js";
import { normalizeEnvValues, pruneEnvValues } from "./envFields.js";
import { getInflight } from "./inflight.js";
import { listSessions as sdkListSessions } from "./sdk.js";
const EMPTY_SESSIONS = { sessions: [] };
const EMPTY_PROFILES = { profiles: [] };
/** 确保数据目录 + 文件存在 */
async function ensureFiles() {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    await Promise.all([
        ensureFile(SESSIONS_FILE, JSON.stringify(EMPTY_SESSIONS)),
        ensureFile(PROFILES_FILE, JSON.stringify(EMPTY_PROFILES)),
    ]);
}
async function ensureFile(p, defaultContent) {
    try {
        await fsp.access(p);
    }
    catch {
        await fsp.writeFile(p, defaultContent, "utf8");
    }
}
/** 原子写 */
async function writeFile_atomic(p, content) {
    const tmp = p + ".tmp";
    await fsp.writeFile(tmp, content, "utf8");
    await fsp.rename(tmp, p);
}
// ─────────────────────────────────────────────────────────────
// sessions.json
// ─────────────────────────────────────────────────────────────
async function readAllSessions() {
    await ensureFiles();
    try {
        const raw = await fsp.readFile(SESSIONS_FILE, "utf8");
        return JSON.parse(raw);
    }
    catch {
        return EMPTY_SESSIONS;
    }
}
async function writeSessions(data) {
    await writeFile_atomic(SESSIONS_FILE, JSON.stringify(data, null, 2));
}
export async function listSessions() {
    const data = await readAllSessions();
    return [...data.sessions].sort((a, b) => b.lastModified - a.lastModified);
}
export async function getSession(sessionId) {
    const data = await readAllSessions();
    return data.sessions.find((s) => s.sessionId === sessionId);
}
export async function upsertSession(record) {
    const data = await readAllSessions();
    const idx = data.sessions.findIndex((s) => s.sessionId === record.sessionId);
    if (idx >= 0) {
        data.sessions[idx] = { ...data.sessions[idx], ...record };
    }
    else {
        data.sessions.push(record);
    }
    await writeSessions(data);
}
export async function touchSession(sessionId, patch = {}) {
    const data = await readAllSessions();
    const idx = data.sessions.findIndex((s) => s.sessionId === sessionId);
    if (idx < 0)
        return;
    data.sessions[idx] = {
        ...data.sessions[idx],
        ...patch,
        lastModified: Date.now(),
    };
    await writeSessions(data);
}
/** 删除会话记录（sessions.json）。返回被删的记录（找不到返回 undefined）。 */
export async function deleteSessionRecord(sessionId) {
    const data = await readAllSessions();
    const idx = data.sessions.findIndex((s) => s.sessionId === sessionId);
    if (idx < 0)
        return undefined;
    const [removed] = data.sessions.splice(idx, 1);
    await writeSessions(data);
    return removed;
}
// ─────────────────────────────────────────────────────────────
// profiles.json
// ─────────────────────────────────────────────────────────────
async function readAllProfiles() {
    await ensureFiles();
    try {
        const raw = await fsp.readFile(PROFILES_FILE, "utf8");
        return JSON.parse(raw);
    }
    catch {
        return EMPTY_PROFILES;
    }
}
async function writeProfiles(data) {
    await writeFile_atomic(PROFILES_FILE, JSON.stringify(data, null, 2));
}
export async function listProfiles() {
    const data = await readAllProfiles();
    return [...data.profiles].sort((a, b) => a.createdAt - b.createdAt);
}
export async function getProfile(id) {
    const data = await readAllProfiles();
    return data.profiles.find((p) => p.id === id);
}
export async function createProfile(name, envInput) {
    const data = await readAllProfiles();
    const profile = {
        id: crypto.randomUUID(),
        name: name.trim() || "未命名",
        env: normalizeEnvValues(envInput),
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
    data.profiles.push(profile);
    await writeProfiles(data);
    return profile;
}
export async function updateProfile(id, patch) {
    const data = await readAllProfiles();
    const idx = data.profiles.findIndex((p) => p.id === id);
    if (idx < 0)
        return undefined;
    const cur = data.profiles[idx];
    const updated = {
        ...cur,
        ...(patch.name !== undefined ? { name: patch.name.trim() || cur.name } : {}),
        ...(patch.env !== undefined ? { env: normalizeEnvValues(patch.env) } : {}),
        updatedAt: Date.now(),
    };
    data.profiles[idx] = updated;
    await writeProfiles(data);
    return updated;
}
export async function deleteProfile(id) {
    const data = await readAllProfiles();
    const before = data.profiles.length;
    data.profiles = data.profiles.filter((p) => p.id !== id);
    if (data.profiles.length === before)
        return false;
    await writeProfiles(data);
    // 同步清理引用了这个 profile 的会话（解绑）
    const sessions = await readAllSessions();
    let changed = false;
    for (const s of sessions.sessions) {
        if (s.profileId === id) {
            s.profileId = null;
            changed = true;
        }
    }
    if (changed)
        await writeSessions(sessions);
    return true;
}
// ─────────────────────────────────────────────────────────────
// 会话 ↔ profile 绑定
// ─────────────────────────────────────────────────────────────
/** 设置会话当前使用的 profile（null = 解绑，纯 CLI 默认） */
export async function setSessionProfile(sessionId, profileId) {
    await touchSession(sessionId, { profileId });
}
/**
 * 累加 token 计数到会话记录中。
 * 每次 query 完成后调用，将本轮用量累加到持久化的累计值上。
 */
export async function accumulateTokens(sessionId, inputTokens, outputTokens) {
    const data = await readAllSessions();
    const idx = data.sessions.findIndex((s) => s.sessionId === sessionId);
    if (idx < 0)
        return;
    data.sessions[idx] = {
        ...data.sessions[idx],
        inputTokens: (data.sessions[idx].inputTokens ?? 0) + inputTokens,
        outputTokens: (data.sessions[idx].outputTokens ?? 0) + outputTokens,
        lastModified: Date.now(),
    };
    await writeSessions(data);
}
// ─────────────────────────────────────────────────────────────
// 会话列表（用 SDK listSessions 替代手动扫盘）
// ─────────────────────────────────────────────────────────────
/**
 * 与 CLI 磁盘同步并返回所有会话。
 *
 * 同步规则：
 *  ① SDK 扫到的会话 → 自动导入到 sessions.json（补默认 profileId/permissionMode/effortLevel）
 *  ② sessions.json 有但 SDK 磁盘上已不存在 → 移除（除非 inflight 中）
 *  ③ 两边都有 → 保留 sessions.json 的 profileId/permissionMode/effortLevel，时间戳取最新
 */
export async function syncAndListSessions() {
    const local = await readAllSessions();
    const localMap = new Map(local.sessions.map((s) => [s.sessionId, s]));
    // SDK 扫描所有项目的会话转录
    const sdkSessions = await sdkListSessions();
    let changed = false;
    const merged = [];
    for (const sdk of sdkSessions) {
        const localRec = localMap.get(sdk.sessionId);
        const record = {
            sessionId: sdk.sessionId,
            cwd: sdk.cwd ?? "",
            createdAt: sdk.createdAt ?? sdk.lastModified ?? Date.now(),
            lastModified: sdk.lastModified,
            profileId: localRec?.profileId ?? null,
            permissionMode: localRec?.permissionMode ?? "bypassPermissions",
            effortLevel: localRec?.effortLevel ?? "default",
            inputTokens: localRec?.inputTokens ?? 0,
            outputTokens: localRec?.outputTokens ?? 0,
        };
        if (!localRec) {
            changed = true; // 新导入
        }
        else if (sdk.lastModified > localRec.lastModified) {
            changed = true; // 磁盘上有更新
        }
        merged.push(record);
        localMap.delete(sdk.sessionId);
    }
    // 保留 sessions.json 中有但 SDK 没扫到的（仅在 inflight 中的新会话）
    for (const [id, rec] of localMap) {
        if (getInflight(id)) {
            merged.push(rec);
        }
        else {
            changed = true; // 被 CLI 删除 → 移除
        }
    }
    if (changed) {
        await writeSessions({ sessions: merged });
    }
    return [...merged].sort((a, b) => b.lastModified - a.lastModified);
}
/**
 * 计算某会话当前生效的 env：
 *   - 绑定 profile → 该 profile 的 env（pruned）
 *   - 未绑定 / profile 不存在 → 空（用 CLI 默认）
 */
export async function resolveSessionEnv(sessionId) {
    const session = await getSession(sessionId);
    if (!session?.profileId)
        return {};
    return resolveProfileEnv(session.profileId);
}
/**
 * 按 profileId 直接拿 env（不经过会话，用于新建会话场景）。
 * profileId 为 null/undefined/不存在 → 返回空。
 */
export async function resolveProfileEnv(profileId) {
    if (!profileId)
        return {};
    const profile = await getProfile(profileId);
    if (!profile)
        return {};
    return pruneEnvValues(profile.env);
}
