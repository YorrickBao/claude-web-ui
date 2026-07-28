/**
 * 从 ~/.claude/projects 的会话转录（.jsonl）中计算 token 用量。
 *
 * 为什么需要这个模块：
 *   SDK 的 getSessionMessages() 抽象会把每条消息的 usage 字段丢掉，
 *   而 SDK 的 result 消息只覆盖当轮、不会跨 query 累计。
 *   要拿到「整个会话的累计 token」，只能直接读 jsonl 转录。
 *
 * 去重规则（关键，否则会虚高 ~2.7x）：
 *   一条逻辑 assistant 消息 = 一个 message.id，
 *   但在 jsonl 里按 content block 拆成多行，每行带相同的 usage。
 *   按 message.id 去重，每个 id 只计一次。
 *
 * 口径对齐：跳过 isSidechain:true（子代理）的消息，
 *   与 SDK result 消息顶层 usage 字段的口径一致（顶层 agent loop，不含子代理）。
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { HOME_DIR } from "../env.js";

/** 单条 assistant 消息的 token 用量 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/** 会话级 token 用量：累计 + 最近一轮 */
export interface SessionTokenUsage {
  /** 跨所有轮次累计（已按 message.id 去重） */
  totals: TokenUsage;
  /** 最近一条 assistant 消息（去重后最末 id）的用量；无消息则 null */
  lastTurn: TokenUsage | null;
}

const ZERO: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

const EMPTY_RESULT: SessionTokenUsage = { totals: ZERO, lastTurn: null };

/** ~/.claude/projects 目录 */
const PROJECTS_DIR = path.join(HOME_DIR, ".claude", "projects");

interface AssistantUsageRow {
  messageId: string;
  usage: TokenUsage;
}

/**
 * 在 ~/.claude/projects/* 下定位 <sessionId>.jsonl。
 * 一个 sessionId 只会存在于一个 cwd 目录下，取首个命中。
 * 找不到返回 null。
 */
function locateTranscript(sessionId: string): string | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(PROJECTS_DIR);
  } catch {
    return null;
  }
  const target = `${sessionId}.jsonl`;
  for (const dir of entries) {
    const full = path.join(PROJECTS_DIR, dir, target);
    try {
      if (fs.statSync(full).isFile()) return full;
    } catch {
      // 不存在，继续
    }
  }
  return null;
}

/**
 * 流式读取 jsonl，提取去重后的 assistant 用量（按出现顺序）。
 * 用 readline 避免大文件一次性入内存。
 */
async function readAssistantUsages(file: string): Promise<AssistantUsageRow[]> {
  const stream = fs.createReadStream(file, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const seen = new Set<string>();
  const out: AssistantUsageRow[] = [];

  for await (const line of rl) {
    if (!line) continue;
    let obj: {
      type?: string;
      isSidechain?: boolean;
      message?: {
        id?: string;
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cache_read_input_tokens?: number;
          cache_creation_input_tokens?: number;
        };
      };
    };
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // 损坏行跳过
    }
    if (obj.type !== "assistant") continue;
    if (obj.isSidechain) continue; // 子代理：与 SDK result usage 口径一致
    const id = obj.message?.id;
    const u = obj.message?.usage;
    if (!id || !u) continue;
    if (seen.has(id)) continue; // 同一 message.id 多行只计一次
    seen.add(id);
    out.push({
      messageId: id,
      usage: {
        inputTokens: u.input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        cacheReadTokens: u.cache_read_input_tokens ?? 0,
        cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
      },
    });
  }
  return out;
}

/**
 * 计算某会话的累计 + 末轮 token 用量。
 * 转录文件不存在时返回全 0、不抛错（供路由层安全降级）。
 */
export async function getSessionTokenUsage(
  sessionId: string,
): Promise<SessionTokenUsage> {
  const file = locateTranscript(sessionId);
  if (!file) return EMPTY_RESULT;

  let rows: AssistantUsageRow[];
  try {
    rows = await readAssistantUsages(file);
  } catch (err) {
    console.warn(
      `[transcriptTokens] read failed for ${sessionId}:`,
      err instanceof Error ? err.message : err,
    );
    return EMPTY_RESULT;
  }
  if (rows.length === 0) return EMPTY_RESULT;

  const totals: TokenUsage = { ...ZERO };
  for (const r of rows) {
    totals.inputTokens += r.usage.inputTokens;
    totals.outputTokens += r.usage.outputTokens;
    totals.cacheReadTokens += r.usage.cacheReadTokens;
    totals.cacheCreationTokens += r.usage.cacheCreationTokens;
  }
  // 最后一条 assistant 消息代表「最近一轮」的 prompt 实际尺寸
  const lastTurn = rows[rows.length - 1].usage;
  return { totals, lastTurn };
}
