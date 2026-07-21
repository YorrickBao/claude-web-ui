import fsp from "node:fs/promises";
import { DATA_DIR, SESSIONS_FILE } from "../env.js";
import type { SessionRecord, SessionsFile } from "./types.js";

const EMPTY: SessionsFile = { sessions: [] };

/** 确保数据目录 + 文件存在 */
async function ensureFile(): Promise<void> {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  try {
    await fsp.access(SESSIONS_FILE);
  } catch {
    await writeRaw(EMPTY);
  }
}

/** 原子写：写到 .tmp 再 rename */
async function writeRaw(data: SessionsFile): Promise<void> {
  const tmp = SESSIONS_FILE + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fsp.rename(tmp, SESSIONS_FILE);
}

/** 读全部（单用户场景并发量低，简单读即可） */
async function readAll(): Promise<SessionsFile> {
  await ensureFile();
  try {
    const raw = await fsp.readFile(SESSIONS_FILE, "utf8");
    return JSON.parse(raw) as SessionsFile;
  } catch {
    return EMPTY;
  }
}

export async function listSessions(): Promise<SessionRecord[]> {
  const data = await readAll();
  return [...data.sessions].sort((a, b) => b.lastModified - a.lastModified);
}

export async function getSession(
  sessionId: string,
): Promise<SessionRecord | undefined> {
  const data = await readAll();
  return data.sessions.find((s) => s.sessionId === sessionId);
}

export async function upsertSession(record: SessionRecord): Promise<void> {
  const data = await readAll();
  const idx = data.sessions.findIndex(
    (s) => s.sessionId === record.sessionId,
  );
  if (idx >= 0) {
    data.sessions[idx] = { ...data.sessions[idx], ...record };
  } else {
    data.sessions.push(record);
  }
  await writeRaw(data);
}

/** 标记会话最近活跃时间 */
export async function touchSession(
  sessionId: string,
  patch: Partial<SessionRecord> = {},
): Promise<void> {
  const data = await readAll();
  const idx = data.sessions.findIndex((s) => s.sessionId === sessionId);
  if (idx < 0) return;
  data.sessions[idx] = {
    ...data.sessions[idx],
    ...patch,
    lastModified: Date.now(),
  };
  await writeRaw(data);
}
