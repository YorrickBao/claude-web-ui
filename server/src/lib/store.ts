import fsp from "node:fs/promises";
import { DATA_DIR, PROFILES_FILE, SESSIONS_FILE } from "../env.js";
import type { EnvProfile, SessionRecord, SessionsFile } from "./types.js";
import { normalizeEnvValues, pruneEnvValues } from "./envFields.js";

const EMPTY_SESSIONS: SessionsFile = { sessions: [] };
const EMPTY_PROFILES: { profiles: EnvProfile[] } = { profiles: [] };

/** 确保数据目录 + 文件存在 */
async function ensureFiles(): Promise<void> {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await Promise.all([
    ensureFile(SESSIONS_FILE, JSON.stringify(EMPTY_SESSIONS)),
    ensureFile(PROFILES_FILE, JSON.stringify(EMPTY_PROFILES)),
  ]);
}

async function ensureFile(p: string, defaultContent: string): Promise<void> {
  try {
    await fsp.access(p);
  } catch {
    await fsp.writeFile(p, defaultContent, "utf8");
  }
}

/** 原子写 */
async function writeFile_atomic(p: string, content: string): Promise<void> {
  const tmp = p + ".tmp";
  await fsp.writeFile(tmp, content, "utf8");
  await fsp.rename(tmp, p);
}

// ─────────────────────────────────────────────────────────────
// sessions.json
// ─────────────────────────────────────────────────────────────

async function readAllSessions(): Promise<SessionsFile> {
  await ensureFiles();
  try {
    const raw = await fsp.readFile(SESSIONS_FILE, "utf8");
    return JSON.parse(raw) as SessionsFile;
  } catch {
    return EMPTY_SESSIONS;
  }
}

async function writeSessions(data: SessionsFile): Promise<void> {
  await writeFile_atomic(SESSIONS_FILE, JSON.stringify(data, null, 2));
}

export async function listSessions(): Promise<SessionRecord[]> {
  const data = await readAllSessions();
  return [...data.sessions].sort((a, b) => b.lastModified - a.lastModified);
}

export async function getSession(
  sessionId: string,
): Promise<SessionRecord | undefined> {
  const data = await readAllSessions();
  return data.sessions.find((s) => s.sessionId === sessionId);
}

export async function upsertSession(record: SessionRecord): Promise<void> {
  const data = await readAllSessions();
  const idx = data.sessions.findIndex((s) => s.sessionId === record.sessionId);
  if (idx >= 0) {
    data.sessions[idx] = { ...data.sessions[idx], ...record };
  } else {
    data.sessions.push(record);
  }
  await writeSessions(data);
}

export async function touchSession(
  sessionId: string,
  patch: Partial<SessionRecord> = {},
): Promise<void> {
  const data = await readAllSessions();
  const idx = data.sessions.findIndex((s) => s.sessionId === sessionId);
  if (idx < 0) return;
  data.sessions[idx] = {
    ...data.sessions[idx],
    ...patch,
    lastModified: Date.now(),
  };
  await writeSessions(data);
}

/** 删除会话记录（sessions.json）。返回被删的记录（找不到返回 undefined）。 */
export async function deleteSessionRecord(
  sessionId: string,
): Promise<SessionRecord | undefined> {
  const data = await readAllSessions();
  const idx = data.sessions.findIndex((s) => s.sessionId === sessionId);
  if (idx < 0) return undefined;
  const [removed] = data.sessions.splice(idx, 1);
  await writeSessions(data);
  return removed;
}

// ─────────────────────────────────────────────────────────────
// profiles.json
// ─────────────────────────────────────────────────────────────

async function readAllProfiles(): Promise<{ profiles: EnvProfile[] }> {
  await ensureFiles();
  try {
    const raw = await fsp.readFile(PROFILES_FILE, "utf8");
    return JSON.parse(raw) as { profiles: EnvProfile[] };
  } catch {
    return EMPTY_PROFILES;
  }
}

async function writeProfiles(data: { profiles: EnvProfile[] }): Promise<void> {
  await writeFile_atomic(PROFILES_FILE, JSON.stringify(data, null, 2));
}

export async function listProfiles(): Promise<EnvProfile[]> {
  const data = await readAllProfiles();
  return [...data.profiles].sort((a, b) => a.createdAt - b.createdAt);
}

export async function getProfile(id: string): Promise<EnvProfile | undefined> {
  const data = await readAllProfiles();
  return data.profiles.find((p) => p.id === id);
}

export async function createProfile(
  name: string,
  envInput: unknown,
): Promise<EnvProfile> {
  const data = await readAllProfiles();
  const profile: EnvProfile = {
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

export async function updateProfile(
  id: string,
  patch: { name?: string; env?: unknown },
): Promise<EnvProfile | undefined> {
  const data = await readAllProfiles();
  const idx = data.profiles.findIndex((p) => p.id === id);
  if (idx < 0) return undefined;
  const cur = data.profiles[idx];
  const updated: EnvProfile = {
    ...cur,
    ...(patch.name !== undefined ? { name: patch.name.trim() || cur.name } : {}),
    ...(patch.env !== undefined ? { env: normalizeEnvValues(patch.env) } : {}),
    updatedAt: Date.now(),
  };
  data.profiles[idx] = updated;
  await writeProfiles(data);
  return updated;
}

export async function deleteProfile(id: string): Promise<boolean> {
  const data = await readAllProfiles();
  const before = data.profiles.length;
  data.profiles = data.profiles.filter((p) => p.id !== id);
  if (data.profiles.length === before) return false;
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
  if (changed) await writeSessions(sessions);
  return true;
}

// ─────────────────────────────────────────────────────────────
// 会话 ↔ profile 绑定
// ─────────────────────────────────────────────────────────────

/** 设置会话当前使用的 profile（null = 解绑，纯 CLI 默认） */
export async function setSessionProfile(
  sessionId: string,
  profileId: string | null,
): Promise<void> {
  await touchSession(sessionId, { profileId });
}

/**
 * 计算某会话当前生效的 env：
 *   - 绑定 profile → 该 profile 的 env（pruned）
 *   - 未绑定 / profile 不存在 → 空（用 CLI 默认）
 */
export async function resolveSessionEnv(
  sessionId: string,
): Promise<Record<string, string>> {
  const session = await getSession(sessionId);
  if (!session?.profileId) return {};
  return resolveProfileEnv(session.profileId);
}

/**
 * 按 profileId 直接拿 env（不经过会话，用于新建会话场景）。
 * profileId 为 null/undefined/不存在 → 返回空。
 */
export async function resolveProfileEnv(
  profileId: string | null | undefined,
): Promise<Record<string, string>> {
  if (!profileId) return {};
  const profile = await getProfile(profileId);
  if (!profile) return {};
  return pruneEnvValues(profile.env);
}
