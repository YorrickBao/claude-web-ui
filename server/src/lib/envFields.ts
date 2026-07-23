/**
 * 环境变量字段白名单（与前端 envFields.ts 保持一致）。
 *
 * 这些是 CLI 真实认的环境变量名（已从 claude 二进制核实）。
 * 用作后端校验：用户提交的 env 配置只允许是这些键，防注入。
 */
export const ENV_FIELD_NAMES: readonly string[] = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "CLAUDE_CODE_EFFORT_LEVEL",
  "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH",
  "CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS",
  "CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION",
];

/** 键 → 字符串值的字典 */
export type EnvValues = Record<string, string>;

/** 过滤掉空串/非白名单/非字符串，得到真正要传给子进程的 env */
export function pruneEnvValues(input: unknown): EnvValues {
  if (!input || typeof input !== "object") return {};
  const allow = new Set(ENV_FIELD_NAMES);
  const out: EnvValues = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (!allow.has(k)) continue;
    if (typeof v === "string" && v.trim() !== "") {
      out[k] = v;
    }
  }
  return out;
}

/** 给用户返回时，保留所有白名单键（空值也给空串），方便前端表单回填 */
export function normalizeEnvValues(input: unknown): EnvValues {
  const pruned = pruneEnvValues(input);
  const out: EnvValues = {};
  for (const name of ENV_FIELD_NAMES) {
    out[name] = pruned[name] ?? "";
  }
  return out;
}
