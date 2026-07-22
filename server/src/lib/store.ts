import fsp from "node:fs/promises";
import path from "node:path";
import { DATA_DIR, HOME_DIR, PROFILES_FILE, SESSIONS_FILE } from "../env.js";
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
  const tmp: string = p + ".tmp";
  await fsp.writeFile(tmp, content, "utf8");
  await fsp.rename(tmp, p);
}

// ─────────────────────────────────────────────────────────────
// sessions.json
// ─────────────────────────────────────────────────────────────

async function readAllSessions(): Promise<SessionsFile> {
  await ensureFiles();
  try {
    const raw: string = await fsp.readFile(SESSIONS_FILE, "utf8");
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
    const raw: string = await fsp.readFile(PROFILES_FILE, "utf8");
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

// ─────────────────────────────────────────────────────────────
// 从 .claude/sessions 目录读取历史会话
// ─────────────────────────────────────────────────────────────

/**
 * 尝试从一个 sessions-index.json 条目中读取 .jsonl 转录文件，
 * 提取第一条用户消息作为 firstPrompt。
 */
async function extractFirstPromptFromTranscript(fullPath: string): Promise<string | null> {
  try {
    const content = await fsp.readFile(fullPath, "utf8");
    const lines = content.split("\n").filter((line) => line.trim());

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === "user" && entry.message?.content) {
          const msgContent = entry.message.content;
          if (typeof msgContent === "string") {
            const trimmed = msgContent.trim().slice(0, 200);
            if (trimmed) return trimmed;
          } else if (Array.isArray(msgContent) && msgContent.length > 0) {
            const firstText = msgContent.find((c) => typeof c === "string" && c.trim());
            if (firstText) return firstText.trim().slice(0, 200);
          }
        }
      } catch { /* skip malformed line */ }
    }
  } catch {
    // file not found or unreadable
  }
  return null;
}

/** .claude 下的会话元信息（同时支持新旧两种存储格式） */
export async function scanClaudeSessions(): Promise<SessionRecord[]> {
  const projectsDir: string = path.join(HOME_DIR, ".claude", "projects");
  const transcriptsDir: string = path.join(HOME_DIR, ".claude", "transcripts");

  const claudeSessions: SessionRecord[] = [];
  const localSessions = await readAllSessions();
  const seenIds = new Set<string>();

  // 读取本地会话记录（避免重复扫描）
  const localMap = new Map(
    localSessions.sessions.map((s) => [s.sessionId, s]),
  );

  // ── 1. 从 sessions-index.json 读取会话元数据（新版 CLI 存储格式） ──
  try {
    const projectDirs = await fsp.readdir(projectsDir, { withFileTypes: true });

    for (const projectDir of projectDirs) {
      if (!projectDir.isDirectory()) continue;

      const indexPath = path.join(projectsDir, projectDir.name, "sessions-index.json");
      try {
        const indexContent = await fsp.readFile(indexPath, "utf8");
        const index = JSON.parse(indexContent);
        if (!Array.isArray(index.entries)) continue;

        for (const entry of index.entries) {
          if (!entry.sessionId) continue;
          seenIds.add(entry.sessionId);

          const sessionId = entry.sessionId;
          const fullPath: string = entry.fullPath || "";
          const projectPath: string = entry.projectPath || "";

          // 先从 index 提取 firstPrompt，如果 .jsonl 存在则用实时内容覆盖
          let firstPrompt: string | null = entry.firstPrompt && entry.firstPrompt !== "No prompt"
            ? entry.firstPrompt
            : null;

          // 尝试从转录文件提取更准确的 firstPrompt
          if (fullPath) {
            const transcriptPrompt = await extractFirstPromptFromTranscript(fullPath);
            if (transcriptPrompt) firstPrompt = transcriptPrompt;
          }

          const record: SessionRecord = {
            sessionId,
            cwd: projectPath || "",
            title: entry.summary || null,
            firstPrompt: firstPrompt || null,
            createdAt: entry.created ? new Date(entry.created).getTime() : Date.now(),
            lastModified: entry.modified ? new Date(entry.modified).getTime() : Date.now(),
            profileId: null,
          };

          const local = localMap.get(sessionId);
          record.alreadyImported = !!local;
          if (local) {
            record.title = local.title || record.title;
            record.firstPrompt = local.firstPrompt || record.firstPrompt;
            record.profileId = local.profileId;
            record.lastModified = Math.max(local.lastModified, record.lastModified);
          }

          claudeSessions.push(record);
          localMap.delete(sessionId);
        }
      } catch {
        // sessions-index.json 不存在或格式错误，尝试旧格式（见下）
      }

      // ── 2. 旧格式：直接扫描项目目录下的 .jsonl 文件（兼容老版 CLI） ──
      try {
        const files = await fsp.readdir(path.join(projectsDir, projectDir.name), { withFileTypes: true });

        for (const file of files) {
          if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;

          const sessionId = file.name.replace(".jsonl", "");
          if (seenIds.has(sessionId)) continue; // 已被 index 覆盖
          seenIds.add(sessionId);

          const filePath = path.join(projectsDir, projectDir.name, file.name);

          try {
            const content = await fsp.readFile(filePath, "utf8");
            const lines = content.split("\n").filter((line) => line.trim());

            let cwd: string = "";
            let firstTimestamp: number = Date.now();
            let lastTimestamp: number = 0;
            let firstPrompt: string = "";

            for (const line of lines) {
              try {
                const jsonlEntry = JSON.parse(line);
                if (jsonlEntry.cwd && !cwd) cwd = jsonlEntry.cwd;
                if (jsonlEntry.timestamp) {
                  const timestamp = new Date(jsonlEntry.timestamp).getTime();
                  if (timestamp && timestamp < firstTimestamp) firstTimestamp = timestamp;
                  if (timestamp && timestamp > lastTimestamp) lastTimestamp = timestamp;
                }
                if (!firstPrompt && jsonlEntry.type === "user" && jsonlEntry.message?.content) {
                  const msgContent = jsonlEntry.message.content;
                  if (typeof msgContent === "string") {
                    firstPrompt = msgContent.trim().slice(0, 200);
                  } else if (Array.isArray(msgContent) && msgContent.length > 0) {
                    const firstText = msgContent.find((c) => typeof c === "string" && c.trim());
                    if (firstText) firstPrompt = firstText.trim().slice(0, 200);
                  }
                }
              } catch {}
            }

            const record: SessionRecord = {
              sessionId,
              cwd: cwd || "",
              title: null as any,
              firstPrompt: firstPrompt || null,
              createdAt: firstTimestamp || Date.now(),
              lastModified: lastTimestamp || firstTimestamp || Date.now(),
              profileId: null,
            };

            const local = localMap.get(sessionId);
            record.alreadyImported = !!local;
            if (local) {
              record.title = local.title;
              record.firstPrompt = local.firstPrompt || firstPrompt || null;
              record.profileId = local.profileId;
              record.lastModified = Math.max(local.lastModified, record.lastModified);
            }

            claudeSessions.push(record);
            localMap.delete(sessionId);
          } catch (err) {
            console.error(`Failed to parse ${file.name}:`, err);
          }
        }
      } catch {
        // 目录不可读，跳过
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("Failed to scan .claude/projects:", err);
    }
  }

  // ── 3. 扫描 ~/.claude/transcripts/ 下的 .jsonl 文件 ──
  try {
    const transcriptFiles = await fsp.readdir(transcriptsDir, { withFileTypes: true });
    for (const file of transcriptFiles) {
      if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;

      const sessionId = file.name.replace(".jsonl", "").replace(/^ses_/, "");
      if (seenIds.has(sessionId)) continue;
      seenIds.add(sessionId);

      const filePath = path.join(transcriptsDir, file.name);
      try {
        const content = await fsp.readFile(filePath, "utf8");
        const lines = content.split("\n").filter((line) => line.trim());

        let firstTimestamp: number = Date.now();
        let lastTimestamp: number = 0;
        let firstPrompt: string = "";

        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            if (entry.timestamp) {
              const ts = new Date(entry.timestamp).getTime();
              if (ts && ts < firstTimestamp) firstTimestamp = ts;
              if (ts && ts > lastTimestamp) lastTimestamp = ts;
            }
            if (!firstPrompt && entry.type === "user" && entry.message?.content) {
              const msgContent = entry.message.content;
              if (typeof msgContent === "string") {
                firstPrompt = msgContent.trim().slice(0, 200);
              } else if (Array.isArray(msgContent) && msgContent.length > 0) {
                const firstText = msgContent.find((c) => typeof c === "string" && c.trim());
                if (firstText) firstPrompt = firstText.trim().slice(0, 200);
              }
            }
          } catch {}
        }

        const record: SessionRecord = {
          sessionId,
          cwd: "",
          title: null as any,
          firstPrompt: firstPrompt || null,
          createdAt: firstTimestamp || Date.now(),
          lastModified: lastTimestamp || firstTimestamp || Date.now(),
          profileId: null,
        };

        const local = localMap.get(sessionId);
        record.alreadyImported = !!local;
        if (local) {
          record.title = local.title;
          record.firstPrompt = local.firstPrompt || firstPrompt || null;
          record.profileId = local.profileId;
          record.lastModified = Math.max(local.lastModified, record.lastModified);
        }

        claudeSessions.push(record);
        localMap.delete(sessionId);
      } catch {
        // 文件损坏，跳过
      }
    }
  } catch {
    // transcripts 目录不存在
  }

  // 补充本地会话记录（未被 .claude 扫描到的）
  for (const session of localSessions.sessions) {
    if (localMap.has(session.sessionId)) {
      session.alreadyImported = true;
      claudeSessions.push(session);
    }
  }

  return claudeSessions;
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
