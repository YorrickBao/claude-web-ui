/**
 * 子代理注册中心 —— 跟踪主会话下所有子代理的生命周期。
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
import { emitSessionEvent } from "./eventBus.js";
// ─────────────────────────────────────────────────────────────
// 注册表
// ─────────────────────────────────────────────────────────────
const registry = new Map();
/** 按 parentSessionId 索引的 agentId 集合，加速查询 */
const sessionIndex = new Map();
function indexBySession(record) {
    const set = sessionIndex.get(record.parentSessionId);
    if (set) {
        set.add(record.agentId);
    }
    else {
        sessionIndex.set(record.parentSessionId, new Set([record.agentId]));
    }
}
// ─────────────────────────────────────────────────────────────
// 注册 / 更新
// ─────────────────────────────────────────────────────────────
/** SubagentStart hook → 注册一条 running 记录 */
export function registerStart(input) {
    const record = {
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
}
/**
 * SubagentStop hook → 三信号校验后更新状态。
 * 返回最终的 AgentRecord（可能是 phantom）。
 */
export async function registerStop(input) {
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
        }
        catch {
            // 文件不存在
        }
    }
    const isPhantom = !hasType || !hasStart || !hasTranscript;
    const record = staged
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
    if (!staged)
        indexBySession(record);
    emitSessionEvent(input.session_id, {
        type: "subagent_stopped",
        agentId: input.agent_id,
        agentType: record.agentType,
        phantom: isPhantom,
    });
    return record;
}
// ─────────────────────────────────────────────────────────────
// 查询
// ─────────────────────────────────────────────────────────────
/** 获取某会话当前活跃（running）的子代理数量 */
export function getActiveCount(sessionId) {
    const set = sessionIndex.get(sessionId);
    if (!set)
        return 0;
    let count = 0;
    for (const agentId of set) {
        const rec = registry.get(agentId);
        if (rec?.status === "running")
            count++;
    }
    return count;
}
/** 获取某会话的子代理统计 */
export function getSessionStats(sessionId) {
    const set = sessionIndex.get(sessionId);
    if (!set)
        return { total: 0, running: 0, stopped: 0, phantom: 0, zombie: 0 };
    const stats = {
        total: 0,
        running: 0,
        stopped: 0,
        phantom: 0,
        zombie: 0,
    };
    for (const agentId of set) {
        const rec = registry.get(agentId);
        if (!rec)
            continue;
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
export function getAllSubagentIds() {
    const ids = new Set();
    for (const [agentId] of registry) {
        ids.add(agentId);
    }
    return ids;
}
/** 获取某会话的所有子代理记录 */
export function getSessionAgents(sessionId) {
    const set = sessionIndex.get(sessionId);
    if (!set)
        return [];
    const result = [];
    for (const agentId of set) {
        const rec = registry.get(agentId);
        if (rec)
            result.push(rec);
    }
    return result;
}
// ─────────────────────────────────────────────────────────────
// 僵尸清理
// ─────────────────────────────────────────────────────────────
const ZOMBIE_THRESHOLD_MS = 5 * 60 * 1000; // 5 分钟
const SCAN_INTERVAL_MS = 60 * 1000; // 每分钟扫一次
let scannerInterval = null;
async function scanZombies() {
    const now = Date.now();
    for (const [_agentId, record] of registry) {
        if (record.status !== "running")
            continue;
        if (now - record.startedAt < ZOMBIE_THRESHOLD_MS)
            continue;
        // 检查 transcript 是否真的存在
        let transcriptExists = false;
        if (record.transcriptPath) {
            try {
                await fsp.access(record.transcriptPath);
                transcriptExists = true;
            }
            catch {
                // 不存在
            }
        }
        if (!transcriptExists) {
            // 运行超过 5 分钟但没有 transcript → 幽灵子代理
            record.status = "zombie";
            emitSessionEvent(record.parentSessionId, {
                type: "subagent_stopped",
                agentId: record.agentId,
                agentType: record.agentType,
                phantom: false,
            });
        }
        // 如果有 transcript 但一直 running → 可能是后台长任务，不标记为 zombie
    }
}
/** 启动僵尸扫描（服务启动时调用一次即可） */
export function startZombieScanner() {
    if (scannerInterval)
        return;
    scannerInterval = setInterval(scanZombies, SCAN_INTERVAL_MS);
    // 允许进程退出（不阻止 event loop）
    if (scannerInterval.unref)
        scannerInterval.unref();
}
/** 停止僵尸扫描 */
export function stopZombieScanner() {
    if (scannerInterval) {
        clearInterval(scannerInterval);
        scannerInterval = null;
    }
}
/**
 * 会话结束时调用：将所有 running 子代理标记为 zombie。
 * 历史记录保留供统计查询，不删除。
 */
export function finalizeSession(sessionId) {
    const set = sessionIndex.get(sessionId);
    if (!set)
        return;
    for (const agentId of set) {
        const rec = registry.get(agentId);
        if (rec?.status === "running") {
            rec.status = "zombie";
        }
    }
}
/**
 * 清理某个会话的所有子代理记录（会话删除时调用）。
 * 返回清理数量。
 */
export function cleanupSession(sessionId) {
    const set = sessionIndex.get(sessionId);
    if (!set)
        return 0;
    let count = 0;
    for (const agentId of set) {
        registry.delete(agentId);
        count++;
    }
    sessionIndex.delete(sessionId);
    return count;
}
