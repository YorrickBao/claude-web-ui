import fsp from "node:fs/promises";
import path from "node:path";
import { DATA_DIR, HOME_DIR, PROFILES_FILE, SESSIONS_FILE } from "../env.js";
import type { EnvProfile, SessionRecord, SessionsFile } from "./types.js";
import { normalizeEnvValues, pruneEnvValues } from "./envFields.js";
import { getInflight } from "./inflight.js";

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
// CLI 磁盘遍历（唯一入口，所有 CLI 扫描逻辑只写一遍）
// ─────────────────────────────────────────────────────────────

/** walkCliSessions 对每个磁盘会话产出的原始条目 */
interface RawCliEntry {
  sessionId: string;
  /** jsonl 文件的绝对路径 */
  jsonlPath: string;
  /** sessions-index.json 中的原始条目（存在时优先用其元数据） */
  indexEntry?: Record<string, unknown>;
}

/**
 * 遍历 CLI 磁盘上的所有会话（~/.claude/projects/ + ~/.claude/transcripts/）。
 *
 * 每个 session 只产出一次：
 *  - 优先用 sessions-index.json 中的条目（元数据更丰富）
 *  - 回退到直接扫 *.jsonl 文件
 *
 * 不解析 jsonl 内容，只收集文件路径和 index 元数据。
 */
async function* walkCliSessions(): AsyncGenerator<RawCliEntry> {
  const projectsDir = path.join(HOME_DIR, ".claude", "projects");
  const transcriptsDir = path.join(HOME_DIR, ".claude", "transcripts");
  const seen = new Set<string>();

  // ── 1. projects/ 目录 ──
  try {
    const dirs = await fsp.readdir(projectsDir, { withFileTypes: true });
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const dp = path.join(projectsDir, d.name);

      // 先读 sessions-index.json，建立 id → 条目 映射
      const indexMap = new Map<string, Record<string, unknown>>();
      try {
        const raw = await fsp.readFile(
          path.join(dp, "sessions-index.json"),
          "utf8",
        );
        const idx = JSON.parse(raw);
        if (Array.isArray(idx.entries)) {
          for (const e of idx.entries) {
            if (e.sessionId) indexMap.set(e.sessionId, e);
          }
        }
      } catch { /* 无 index */ }

      // 扫 *.jsonl，优先匹配 index 条目
      try {
        const files = await fsp.readdir(dp);
        for (const f of files) {
          if (!f.endsWith(".jsonl")) continue;
          const sid = f.replace(".jsonl", "");
          if (seen.has(sid)) continue;
          seen.add(sid);
          yield {
            sessionId: sid,
            jsonlPath: path.join(dp, f),
            indexEntry: indexMap.get(sid),
          };
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          console.error(`Failed to read project directory ${dp}:`, err);
        }
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("Failed to scan .claude/projects:", err);
    }
  }

  // ── 2. transcripts/ 目录（兼容旧格式） ──
  try {
    const files = await fsp.readdir(transcriptsDir);
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const sid = f.replace(".jsonl", "").replace(/^ses_/, "");
      if (seen.has(sid)) continue;
      seen.add(sid);
      yield { sessionId: sid, jsonlPath: path.join(transcriptsDir, f) };
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("Failed to scan .claude/transcripts:", err);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// 扫描 CLI 会话（完整版：解析 jsonl，合并本地元数据）
// ─────────────────────────────────────────────────────────────

/**
 * 尝试从 jsonl 转录文件中提取第一条用户消息。
 */
async function extractFirstPromptFromTranscript(
  fullPath: string,
): Promise<string | null> {
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
            const firstText = msgContent.find(
              (c: unknown) => typeof c === "string" && (c as string).trim(),
            );
            if (firstText) return (firstText as string).trim().slice(0, 200);
          }
        }
      } catch { /* skip malformed line */ }
    }
  } catch { /* file not found or unreadable */ }
  return null;
}

/** .claude 下的会话元信息（同时支持新旧两种存储格式） */
export async function scanClaudeSessions(): Promise<SessionRecord[]> {
  const localSessions = await readAllSessions();
  const localMap = new Map(localSessions.sessions.map((s) => [s.sessionId, s]));
  const claudeSessions: SessionRecord[] = [];

  for await (const raw of walkCliSessions()) {
    let cwd = "";
    let title: string | null = null;
    let firstPrompt: string | null = null;
    let createdAt = Date.now();
    let lastModified = Date.now();

    if (raw.indexEntry) {
      // ── 有 index：直接取结构化元数据 ──
      const e = raw.indexEntry as Record<string, unknown>;
      cwd = (e.projectPath as string) || "";
      title = (e.summary as string) || null;
      firstPrompt =
        e.firstPrompt && e.firstPrompt !== "No prompt"
          ? (e.firstPrompt as string)
          : null;
      createdAt = e.created
        ? new Date(e.created as string).getTime()
        : Date.now();
      lastModified = e.modified
        ? new Date(e.modified as string).getTime()
        : Date.now();

      // 优先从 jsonl 实时提取 firstPrompt（比 index 里的更准确）
      const transcriptPrompt = await extractFirstPromptFromTranscript(
        raw.jsonlPath,
      );
      if (transcriptPrompt) firstPrompt = transcriptPrompt;
    } else {
      // ── 无 index：从 jsonl 解析全部元数据 ──
      try {
        const st = await fsp.stat(raw.jsonlPath);
        lastModified = st.mtimeMs;
        if (st.birthtimeMs) createdAt = st.birthtimeMs;
      } catch { /* stat 失败 */ }

      try {
        const content = await fsp.readFile(raw.jsonlPath, "utf8");
        const lines = content.split("\n").filter((l) => l.trim());
        let firstTimestamp = Date.now();
        let lastTimestamp = 0;

        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            if (entry.cwd && !cwd) cwd = entry.cwd;
            if (entry.timestamp) {
              const ts = new Date(entry.timestamp).getTime();
              if (ts && ts < firstTimestamp) firstTimestamp = ts;
              if (ts && ts > lastTimestamp) lastTimestamp = ts;
            }
            if (!firstPrompt && entry.type === "user" && entry.message?.content) {
              const mc = entry.message.content;
              if (typeof mc === "string") {
                firstPrompt = mc.trim().slice(0, 200);
              } else if (Array.isArray(mc) && mc.length > 0) {
                const ft = mc.find(
                  (c: unknown) => typeof c === "string" && (c as string).trim(),
                );
                if (ft) firstPrompt = (ft as string).trim().slice(0, 200);
              }
            }
          } catch { /* skip malformed line */ }
        }

        if (firstTimestamp < createdAt) createdAt = firstTimestamp;
        if (lastTimestamp > lastModified) lastModified = lastTimestamp;
      } catch (err) {
        console.error(`Failed to parse ${raw.jsonlPath}:`, err);
      }
    }

    const record: SessionRecord = {
      sessionId: raw.sessionId,
      cwd,
      title,
      firstPrompt,
      createdAt,
      lastModified,
      profileId: null,
      permissionMode: "bypassPermissions",
      effortLevel: "high",
    };

    // 合并本地元数据（title / profileId / firstPrompt / permissionMode / effortLevel）
    const local = localMap.get(raw.sessionId);
    if (local) {
      record.title = local.title || record.title;
      record.firstPrompt = local.firstPrompt || record.firstPrompt;
      record.profileId = local.profileId;
      record.permissionMode = local.permissionMode || record.permissionMode;
      record.effortLevel = local.effortLevel || record.effortLevel;
      record.lastModified = Math.max(local.lastModified, record.lastModified);
    }

    claudeSessions.push(record);
    localMap.delete(raw.sessionId);
  }

  // 补充本地会话记录（未被 CLI 扫描到的，如手动导入的旧数据）
  for (const session of localSessions.sessions) {
    if (localMap.has(session.sessionId)) {
      claudeSessions.push(session);
    }
  }

  return claudeSessions;
}

// ─────────────────────────────────────────────────────────────
// 实时同步：sessions.json 作为 CLI 磁盘状态的镜像缓存
// ─────────────────────────────────────────────────────────────

/**
 * 快速收集 CLI 磁盘上的所有会话 id（不解析 jsonl 内容，轻量）。
 * 用于 syncAndListSessions 的"哪些会话在 CLI 磁盘上"判断。
 */
async function collectCliSessionIds(): Promise<
  Map<string, { cwd: string; lastModified: number }>
> {
  const result = new Map<string, { cwd: string; lastModified: number }>();
  for await (const raw of walkCliSessions()) {
    let cwd = "";
    let lastModified = Date.now();

    if (raw.indexEntry) {
      const e = raw.indexEntry as Record<string, unknown>;
      cwd = (e.projectPath as string) || "";
      lastModified = e.modified
        ? new Date(e.modified as string).getTime()
        : Date.now();
    } else {
      try {
        const st = await fsp.stat(raw.jsonlPath);
        lastModified = st.mtimeMs;
      } catch { /* stat 失败用当前时间 */ }
    }

    result.set(raw.sessionId, { cwd, lastModified });
  }
  return result;
}

/**
 * 列出所有会话——先与 CLI 磁盘同步再返回。
 *
 * 同步规则：
 *  ① CLI 磁盘上有但 sessions.json 里没有 → 自动导入
 *  ② sessions.json 里有但 CLI 磁盘上已不存在 → 移除（被 CLI 端删掉了）
 *  ③ 两边都有 → 保留 sessions.json 的 title/profileId，时间戳取最新
 *
 * 这是个写操作：同步后的结果会原子写回 sessions.json。
 */
export async function syncAndListSessions(): Promise<SessionRecord[]> {
  const local = await readAllSessions();
  const cliMap = await collectCliSessionIds();
  const cliIds = new Set(cliMap.keys());

  let changed = false;
  const kept: SessionRecord[] = [];

  // ① + ③：遍历 sessions.json，保留 CLI 磁盘上仍存在的
  for (const s of local.sessions) {
    if (cliIds.has(s.sessionId)) {
      const cliInfo = cliMap.get(s.sessionId)!;
      if (cliInfo.lastModified > s.lastModified) {
        s.lastModified = cliInfo.lastModified;
        changed = true;
      }
      kept.push(s);
    } else if (getInflight(s.sessionId)) {
      // 正在创建中（SDK 可能尚未落盘 JSONL），保留不删
      kept.push(s);
    } else {
      changed = true; // 被 CLI 端删除 → 移除
    }
  }

  // ②：CLI 磁盘上有但 sessions.json 里没有 → 自动导入
  const keptIds = new Set(kept.map((s) => s.sessionId));
  const newIds = [...cliIds].filter((id) => !keptIds.has(id));

  if (newIds.length > 0) {
    // 新会话需要 firstPrompt（作兜底标题），调用完整扫描获取元数据
    const fullScan = await scanClaudeSessions();
    for (const cs of fullScan) {
      if (newIds.includes(cs.sessionId)) {
        kept.push({
          sessionId: cs.sessionId,
          cwd: cs.cwd,
          title: cs.title,
          firstPrompt: cs.firstPrompt,
          createdAt: cs.createdAt,
          lastModified: cs.lastModified,
          profileId: null,
          permissionMode: "bypassPermissions",
          effortLevel: "high",
        });
        changed = true;
      }
    }
  }

  if (changed) {
    await writeSessions({ sessions: kept });
  }

  return [...kept].sort((a, b) => b.lastModified - a.lastModified);
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
