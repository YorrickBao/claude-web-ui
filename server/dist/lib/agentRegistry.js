/**
 * 子代理注册中心 —— 追踪主会话下所有子代理的运行时生命周期。
 *
 * 职责边界（重要）：
 *   「识别哪些会话是子代理并从会话列表过滤」由 SDK listSessions 负责
 *   （它内部用 isSidechain 自动排除 sidechain 会话，参见 sdk.d.ts:704）。
 *   本模块**不做会话识别**，只做：
 *     ① SubagentStart/Stop hook 实时记录活跃子代理
 *     ② query 结束时把残留 running 子代理标记为 zombie（finalizeSession）
 *     ③ 会话删除时清理 registry 内存记录（cleanupSession）
 *     ④ 服务启动加载持久化数据 + 周期性僵尸扫描
 *
 * 持久化：
 *   registry 数据写入 server/data/subagents.json，跨进程重启保留。
 *
 * 僵尸清理：
 *   每 60s 扫描一次，超过 5 分钟仍为 "running" 且没有 transcript 的
 *   标记为 zombie 并清理。
 *
 * 自愈：
 *   loadRegistry 加载历史记录时，校验每条记录的 transcriptPath 是否
 *   符合子代理路径模式（…/subagents/agent-<id>.jsonl），不符合的视为
 *   历史误判（旧版 seed 逻辑把主会话误判为子代理）并剔除。
 */
import fsp from "node:fs/promises";
import { SUBAGENTS_FILE } from "../env.js";
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
let saveTimer = null;
let dirty = false;
function scheduleSave() {
    dirty = true;
    if (saveTimer)
        return;
    saveTimer = setTimeout(async () => {
        saveTimer = null;
        if (!dirty)
            return;
        dirty = false;
        try {
            const data = { agents: Object.fromEntries(registry) };
            await fsp.writeFile(SUBAGENTS_FILE, JSON.stringify(data, null, 2), "utf-8");
        }
        catch (err) {
            // eslint-disable-next-line no-console
            console.warn("[agentRegistry] failed to persist:", err instanceof Error ? err.message : err);
        }
    }, 500); // 500ms 防抖：短时间内多次变更只写一次盘
}
/**
 * 判定 transcriptPath 是否是合法的子代理转录路径。
 * 合法形态：`.../subagents/agent-<id>.jsonl`（SDK 0.3.216+ 标准）。
 * 旧版 seed 误判的主会话记录要么无 transcriptPath，要么指向顶级
 * `<sessionId>.jsonl`，都不匹配此模式。
 */
function isValidSubagentTranscript(p) {
    if (!p)
        return false;
    return /[\\/]subagents[\\/]agent-[^\\/]+\.jsonl$/.test(p);
}
/**
 * 加载持久化数据并做自愈清理：剔除历史误判的主会话记录。
 *
 * 自愈判据：合法子代理的 transcriptPath 必须形如
 *   `.../subagents/agent-<id>.jsonl`。
 * 不符合的（旧版 seed 把主会话误判为子代理时未设 transcriptPath，
 * 或 registerStop 误记录了顶级会话路径）一律剔除并重写磁盘。
 */
async function loadRegistry() {
    let cleaned = 0;
    try {
        const raw = await fsp.readFile(SUBAGENTS_FILE, "utf-8");
        const data = JSON.parse(raw);
        if (data.agents) {
            for (const [agentId, record] of Object.entries(data.agents)) {
                // 自愈：transcriptPath 不符合子代理路径模式 → 历史误判的主会话，剔除
                if (!isValidSubagentTranscript(record.transcriptPath)) {
                    cleaned++;
                    continue;
                }
                registry.set(agentId, record);
                indexBySession(record);
            }
        }
        // eslint-disable-next-line no-console
        console.log(`[agentRegistry] loaded ${registry.size} agents from disk` +
            (cleaned > 0 ? ` (self-healed: removed ${cleaned} misclassified records)` : ""));
        if (cleaned > 0) {
            // 立即重写 subagents.json，把误判记录从磁盘也清掉
            try {
                const fresh = { agents: Object.fromEntries(registry) };
                await fsp.writeFile(SUBAGENTS_FILE, JSON.stringify(fresh, null, 2), "utf-8");
            }
            catch (err) {
                // eslint-disable-next-line no-console
                console.warn("[agentRegistry] self-heal save failed:", err instanceof Error ? err.message : err);
            }
        }
    }
    catch {
        // 文件不存在或损坏 → 从空开始
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
    scheduleSave();
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
    scheduleSave();
    return record;
}
// ─────────────────────────────────────────────────────────────
// 僵尸清理
// ─────────────────────────────────────────────────────────────
const ZOMBIE_THRESHOLD_MS = 5 * 60 * 1000; // 5 分钟
const SCAN_INTERVAL_MS = 60 * 1000; // 每分钟扫一次
let scannerInterval = null;
async function scanZombies() {
    const now = Date.now();
    let anyZombie = false;
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
            anyZombie = true;
        }
        // 如果有 transcript 但一直 running → 可能是后台长任务，不标记为 zombie
    }
    if (anyZombie)
        scheduleSave();
}
/** 启动僵尸扫描（服务启动时调用一次即可）。同时从磁盘加载持久化数据。 */
export function startZombieScanner() {
    if (scannerInterval)
        return;
    // 异步加载历史数据（不阻塞启动）
    loadRegistry().catch((err) => {
        // eslint-disable-next-line no-console
        console.warn("[agentRegistry] load failed:", err instanceof Error ? err.message : err);
    });
    scannerInterval = setInterval(scanZombies, SCAN_INTERVAL_MS);
    // 允许进程退出（不阻止 event loop）
    if (scannerInterval.unref)
        scannerInterval.unref();
}
/**
 * 会话结束时调用：将所有 running 子代理标记为 zombie。
 * 历史记录保留供统计查询，不删除。
 */
export function finalizeSession(sessionId) {
    const set = sessionIndex.get(sessionId);
    if (!set)
        return;
    let anyChanged = false;
    for (const agentId of set) {
        const rec = registry.get(agentId);
        if (rec?.status === "running") {
            rec.status = "zombie";
            anyChanged = true;
        }
    }
    if (anyChanged)
        scheduleSave();
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
    if (count > 0)
        scheduleSave();
    return count;
}
