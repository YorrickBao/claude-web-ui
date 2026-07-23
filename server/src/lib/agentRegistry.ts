/**
 * 子代理注册中心 —— 跟踪主会话下所有子代理的生命周期。
 *
 * 持久化：
 *   注册表数据写入 server/data/subagents.json，跨进程重启保留。
 *   getAllSubagentIds() 返回的数据包含已持久化的历史记录
 *   + 当前进程内 Hook 捕获的实时记录。
 *
 * 三种信号判定幽灵 SubagentStop：
 *   ① agent_type 存在（SubagentStopHookInput 上必有）
 *   ② agentRegistry 中有对应的 SubagentStart 记录
 *   ③ agent_transcript_path 指向的文件存在
 * 三个都满足才算真子代理，否则标记为 phantom。
 *
 * 僵尸清理：
 *   每 60s 扫描一次，超过 5 分钟仍为 "running" 且没有 transcript 的
 *   标记为 zombie 并清理。
 */

import fsp from "node:fs/promises";
import type {
  SubagentStartHookInput,
  SubagentStopHookInput,
} from "@anthropic-ai/claude-agent-sdk";
import { SUBAGENTS_FILE } from "../env.js";
import { emitSessionEvent } from "./eventBus.js";

// ─────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────

export interface AgentRecord {
  agentId: string;
  parentSessionId: string;
  agentType: string;
  status: "running" | "stopped" | "phantom" | "zombie";
  startedAt: number;
  stoppedAt?: number;
  transcriptPath?: string;
  /** SubagentStop hook 报告的 last_assistant_message */
  lastMessage?: string;
}

/** 会话级子代理统计 */
export interface SessionAgentStats {
  total: number;
  running: number;
  stopped: number;
  phantom: number;
  zombie: number;
}

// ─────────────────────────────────────────────────────────────
// 注册表
// ─────────────────────────────────────────────────────────────

const registry = new Map<string, AgentRecord>();

/** 按 parentSessionId 索引的 agentId 集合，加速查询 */
const sessionIndex = new Map<string, Set<string>>();

function indexBySession(record: AgentRecord): void {
  const set = sessionIndex.get(record.parentSessionId);
  if (set) {
    set.add(record.agentId);
  } else {
    sessionIndex.set(record.parentSessionId, new Set([record.agentId]));
  }
}

// ─────────────────────────────────────────────────────────────
// 持久化
// ─────────────────────────────────────────────────────────────

/** 序列化格式：{ agents: Record<agentId, AgentRecord> } */
interface PersistedRegistry {
  agents: Record<string, AgentRecord>;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let dirty = false;
let loaded = false;

function scheduleSave(): void {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    if (!dirty) return;
    dirty = false;
    try {
      const data: PersistedRegistry = { agents: Object.fromEntries(registry) };
      await fsp.writeFile(SUBAGENTS_FILE, JSON.stringify(data, null, 2), "utf-8");
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[agentRegistry] failed to persist:", err instanceof Error ? err.message : err);
    }
  }, 500); // 500ms 防抖：短时间内多次变更只写一次盘
}

/**
 * 首次启动存量扫描：遍历所有 .jsonl 文件识别已有子代理，
 * 播种到持久化 registry。仅当 subagents.json 为空时执行一次，
 * 之后由 Hook 维护。
 */
async function seedRegistryFromDisk(): Promise<void> {
  const os = await import("node:os");
  const path = await import("node:path");
  const projectsDir = path.join(os.homedir(), ".claude", "projects");

  let projectNames: string[];
  try {
    projectNames = await fsp.readdir(projectsDir);
  } catch {
    return;
  }

  let found = 0;

  for (const projName of projectNames) {
    const projectPath = path.join(projectsDir, projName);

    let entries: string[];
    try {
      entries = await fsp.readdir(projectPath);
    } catch {
      continue;
    }

    for (const entry of entries) {
      // 新格式：顶级 .jsonl → 读首行判 enqueue content
      if (entry.endsWith(".jsonl")) {
        const agentId = entry.slice(0, -6);
        if (registry.has(agentId)) continue; // 已从磁盘加载
        const filePath = path.join(projectPath, entry);
        try {
          const fh = await fsp.open(filePath, "r");
          let firstLine: string;
          try {
            const buf = Buffer.alloc(8192);
            const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
            const text = buf.toString("utf-8", 0, bytesRead);
            const nl = text.indexOf("\n");
            firstLine = nl >= 0 ? text.slice(0, nl) : text;
          } finally {
            await fh.close();
          }
          const parsed = JSON.parse(firstLine);
          if (
            parsed.type === "queue-operation" &&
            parsed.operation === "enqueue" &&
            "content" in parsed
          ) {
            const record: AgentRecord = {
              agentId,
              parentSessionId: "", // 存量数据无法回溯父会话
              agentType: "unknown",
              status: "stopped",
              startedAt: Date.now(),
              stoppedAt: Date.now(),
            };
            registry.set(agentId, record);
            indexBySession(record);
            found++;
          }
        } catch {
          // 文件不可读 → 跳过
        }
        continue;
      }

      // 旧格式兜底：目录下 subagents/agent-*.jsonl
      const subagentsPath = path.join(projectPath, entry, "subagents");
      let agentFiles: string[];
      try {
        agentFiles = await fsp.readdir(subagentsPath);
      } catch {
        continue;
      }

      for (const file of agentFiles) {
        if (file.startsWith("agent-") && file.endsWith(".jsonl")) {
          const agentId = file.slice(6, -6);
          if (registry.has(agentId)) continue;
          const record: AgentRecord = {
            agentId,
            parentSessionId: entry, // 旧格式中目录名即父会话 ID
            agentType: "unknown",
            status: "stopped",
            startedAt: Date.now(),
            stoppedAt: Date.now(),
          };
          registry.set(agentId, record);
          indexBySession(record);
          found++;
        }
      }
    }
  }

  if (found > 0) {
    // eslint-disable-next-line no-console
    console.log(`[agentRegistry] seeded ${found} agents from disk scan`);
    // 立即持久化，不等待防抖
    try {
      const data: PersistedRegistry = { agents: Object.fromEntries(registry) };
      await fsp.writeFile(SUBAGENTS_FILE, JSON.stringify(data, null, 2), "utf-8");
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[agentRegistry] seed save failed:", err instanceof Error ? err.message : err);
    }
  }
}

async function loadRegistry(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await fsp.readFile(SUBAGENTS_FILE, "utf-8");
    const data = JSON.parse(raw) as PersistedRegistry;
    if (data.agents) {
      for (const [agentId, record] of Object.entries(data.agents)) {
        registry.set(agentId, record);
        indexBySession(record);
      }
    }
    // eslint-disable-next-line no-console
    console.log(`[agentRegistry] loaded ${registry.size} agents from disk`);
  } catch {
    // 文件不存在或损坏 → 从空开始
  }

  // 每次启动都做增量扫描：发现 CLI 或其他进程新建的子代理则补入
  await seedRegistryFromDisk();
}

// ─────────────────────────────────────────────────────────────
// 注册 / 更新
// ─────────────────────────────────────────────────────────────

/** SubagentStart hook → 注册一条 running 记录 */
export function registerStart(input: SubagentStartHookInput): void {
  const record: AgentRecord = {
    agentId: input.agent_id,
    parentSessionId: input.session_id,
    agentType: input.agent_type,
    status: "running",
    startedAt: Date.now(),
  };
  registry.set(input.agent_id, record);
  indexBySession(record);

  emitSessionEvent(input.session_id, {
    type: "subagent_started",
    agentId: input.agent_id,
    agentType: input.agent_type,
  });

  scheduleSave();
}

/**
 * SubagentStop hook → 三信号校验后更新状态。
 * 返回最终的 AgentRecord（可能是 phantom）。
 */
export async function registerStop(
  input: SubagentStopHookInput,
): Promise<AgentRecord> {
  const staged = registry.get(input.agent_id);

  // 信号 ①：agent_type 存在（SubagentStopHookInput 上永远有，这里做防御）
  const hasType = typeof input.agent_type === "string" && input.agent_type.length > 0;

  // 信号 ②：有对应的 SubagentStart 记录
  const hasStart = !!staged;

  // 信号 ③：transcript 文件存在
  let hasTranscript = false;
  if (input.agent_transcript_path) {
    try {
      await fsp.access(input.agent_transcript_path);
      hasTranscript = true;
    } catch {
      // 文件不存在
    }
  }

  const isPhantom = !hasType || !hasStart || !hasTranscript;

  const record: AgentRecord = staged
    ? {
        ...staged,
        status: isPhantom ? "phantom" : "stopped",
        stoppedAt: Date.now(),
        transcriptPath: input.agent_transcript_path,
        lastMessage: input.last_assistant_message,
      }
    : {
        agentId: input.agent_id,
        parentSessionId: input.session_id,
        agentType: input.agent_type || "unknown",
        status: isPhantom ? "phantom" : "stopped",
        startedAt: Date.now(),
        stoppedAt: Date.now(),
        transcriptPath: input.agent_transcript_path,
        lastMessage: input.last_assistant_message,
      };

  registry.set(input.agent_id, record);
  if (!staged) indexBySession(record);

  emitSessionEvent(input.session_id, {
    type: "subagent_stopped",
    agentId: input.agent_id,
    agentType: record.agentType,
    phantom: isPhantom,
  });

  scheduleSave();

  return record;
}

// ─────────────────────────────────────────────────────────────
// 查询
// ─────────────────────────────────────────────────────────────

/** 获取某会话当前活跃（running）的子代理数量 */
export function getActiveCount(sessionId: string): number {
  const set = sessionIndex.get(sessionId);
  if (!set) return 0;
  let count = 0;
  for (const agentId of set) {
    const rec = registry.get(agentId);
    if (rec?.status === "running") count++;
  }
  return count;
}

/** 获取某会话的子代理统计 */
export function getSessionStats(sessionId: string): SessionAgentStats {
  const set = sessionIndex.get(sessionId);
  if (!set) return { total: 0, running: 0, stopped: 0, phantom: 0, zombie: 0 };

  const stats: SessionAgentStats = {
    total: 0,
    running: 0,
    stopped: 0,
    phantom: 0,
    zombie: 0,
  };

  for (const agentId of set) {
    const rec = registry.get(agentId);
    if (!rec) continue;
    stats.total++;
    switch (rec.status) {
      case "running":
        stats.running++;
        break;
      case "stopped":
        stats.stopped++;
        break;
      case "phantom":
        stats.phantom++;
        break;
      case "zombie":
        stats.zombie++;
        break;
    }
  }

  return stats;
}

/** 获取当前内存中所有已知子代理的 agentId 集合（用于过滤会话列表） */
export function getAllSubagentIds(): Set<string> {
  const ids = new Set<string>();
  for (const [agentId] of registry) {
    ids.add(agentId);
  }
  return ids;
}

/** 获取某会话的所有子代理记录 */
export function getSessionAgents(sessionId: string): AgentRecord[] {
  const set = sessionIndex.get(sessionId);
  if (!set) return [];
  const result: AgentRecord[] = [];
  for (const agentId of set) {
    const rec = registry.get(agentId);
    if (rec) result.push(rec);
  }
  return result;
}

// ─────────────────────────────────────────────────────────────
// 僵尸清理
// ─────────────────────────────────────────────────────────────

const ZOMBIE_THRESHOLD_MS = 5 * 60 * 1000; // 5 分钟
const SCAN_INTERVAL_MS = 60 * 1000; // 每分钟扫一次

let scannerInterval: ReturnType<typeof setInterval> | null = null;

async function scanZombies(): Promise<void> {
  const now = Date.now();
  let anyZombie = false;
  for (const [_agentId, record] of registry) {
    if (record.status !== "running") continue;
    if (now - record.startedAt < ZOMBIE_THRESHOLD_MS) continue;

    // 检查 transcript 是否真的存在
    let transcriptExists = false;
    if (record.transcriptPath) {
      try {
        await fsp.access(record.transcriptPath);
        transcriptExists = true;
      } catch {
        // 不存在
      }
    }

    if (!transcriptExists) {
      // 运行超过 5 分钟但没有 transcript → 幽灵子代理
      record.status = "zombie";
      anyZombie = true;
      emitSessionEvent(record.parentSessionId, {
        type: "subagent_stopped",
        agentId: record.agentId,
        agentType: record.agentType,
        phantom: false,
      });
    }
    // 如果有 transcript 但一直 running → 可能是后台长任务，不标记为 zombie
  }
  if (anyZombie) scheduleSave();
}

/** 启动僵尸扫描（服务启动时调用一次即可）。同时从磁盘加载持久化数据。 */
export function startZombieScanner(): void {
  if (scannerInterval) return;
  // 异步加载历史数据（不阻塞启动）
  loadRegistry().catch((err) => {
    // eslint-disable-next-line no-console
    console.warn("[agentRegistry] load failed:", err instanceof Error ? err.message : err);
  });
  scannerInterval = setInterval(scanZombies, SCAN_INTERVAL_MS);
  // 允许进程退出（不阻止 event loop）
  if (scannerInterval.unref) scannerInterval.unref();
}

/** 停止僵尸扫描 */
export function stopZombieScanner(): void {
  if (scannerInterval) {
    clearInterval(scannerInterval);
    scannerInterval = null;
  }
}

/**
 * 会话结束时调用：将所有 running 子代理标记为 zombie。
 * 历史记录保留供统计查询，不删除。
 */
export function finalizeSession(sessionId: string): void {
  const set = sessionIndex.get(sessionId);
  if (!set) return;
  let anyChanged = false;
  for (const agentId of set) {
    const rec = registry.get(agentId);
    if (rec?.status === "running") {
      rec.status = "zombie";
      anyChanged = true;
    }
  }
  if (anyChanged) scheduleSave();
}

/**
 * 清理某个会话的所有子代理记录（会话删除时调用）。
 * 返回清理数量。
 */
export function cleanupSession(sessionId: string): number {
  const set = sessionIndex.get(sessionId);
  if (!set) return 0;
  let count = 0;
  for (const agentId of set) {
    registry.delete(agentId);
    count++;
  }
  sessionIndex.delete(sessionId);
  if (count > 0) scheduleSave();
  return count;
}
