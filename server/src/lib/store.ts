import fsp from "node:fs/promises";
import { DATA_DIR, ENV_DEFAULTS_FILE, SESSIONS_FILE } from "../env.js";
import type { SessionRecord, SessionsFile } from "./types.js";
import { normalizeEnvValues, pruneEnvValues } from "./envFields.js";

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

// ─────────────────────────────────────────────────────────────
// env 默认值（全局）：env-defaults.json
// ─────────────────────────────────────────────────────────────

async function readEnvDefaultsRaw(): Promise<Record<string, string>> {
  await ensureFile();
  try {
    const raw = await fsp.readFile(ENV_DEFAULTS_FILE, "utf8");
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

async function writeEnvDefaultsRaw(values: Record<string, string>): Promise<void> {
  const tmp = ENV_DEFAULTS_FILE + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(values, null, 2), "utf8");
  await fsp.rename(tmp, ENV_DEFAULTS_FILE);
}

/** 读取全局 env 默认值（带白名单 + 补全所有键，给前端表单用） */
export async function getEnvDefaults(): Promise<Record<string, string>> {
  return normalizeEnvValues(await readEnvDefaultsRaw());
}

/** 写全局 env 默认值（输入先 prune 过滤白名单/空值） */
export async function setEnvDefaults(
  input: unknown,
): Promise<Record<string, string>> {
  const pruned = pruneEnvValues(input);
  await writeEnvDefaultsRaw(pruned);
  return normalizeEnvValues(pruned);
}

/** 只读全局默认（pruned，不带补全空键）—— 用于新建会话场景 */
export async function getGlobalEnv(): Promise<Record<string, string>> {
  return pruneEnvValues(await readEnvDefaultsRaw());
}

/**
 * 计算某会话最终生效的 env：
 *   { ...prune(env-defaults), ...prune(session.envOverrides) }
 * 会话级覆盖全局。
 */
export async function resolveSessionEnv(
  sessionId: string,
): Promise<Record<string, string>> {
  const base = pruneEnvValues(await readEnvDefaultsRaw());
  const session = await getSession(sessionId);
  const overrides = pruneEnvValues(session?.envOverrides);
  return { ...base, ...overrides };
}

/** 更新某会话的 env override（整体替换，只动 envOverrides 字段） */
export async function setSessionEnvOverrides(
  sessionId: string,
  input: unknown,
): Promise<Record<string, string>> {
  const pruned = pruneEnvValues(input);
  const data = await readAll();
  const idx = data.sessions.findIndex((s) => s.sessionId === sessionId);
  if (idx < 0) {
    throw new Error(`session not found: ${sessionId}`);
  }
  data.sessions[idx] = {
    ...data.sessions[idx],
    envOverrides: pruned,
    lastModified: Date.now(),
  };
  await writeRaw(data);
  return normalizeEnvValues(pruned);
}
