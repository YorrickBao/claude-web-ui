/**
 * 环境变量字段的元信息。
 * 前后端共享这个清单 —— 后端用来校验、前端用来渲染表单。
 *
 * CLI 实际认的环境变量名（已从 claude 二进制核实）。
 */

export interface EnvFieldMeta {
  /** CLI 真实环境变量名 */
  name: string;
  /** 中文显示名 */
  label: string;
  /** 输入框 placeholder */
  placeholder?: string;
  /** 是否敏感（密码框） */
  secret?: boolean;
  /** 帮助说明 */
  help?: string;
  /** 取值示例/枚举 */
  examples?: string[];
  /** 输入控件类型：默认 text */
  type?: "text" | "select" | "number";
  /** select 类型的下拉选项 */
  options?: string[];
}

/**
 * 用户列出的 9 个字段（已修正 typo）。
 * 保持这个顺序：连接相关 → 模型 → 行为。
 */
export const ENV_FIELDS: readonly EnvFieldMeta[] = [
  {
    name: "ANTHROPIC_BASE_URL",
    label: "Base URL",
    placeholder: "https://api.anthropic.com",
    help: "API 接入地址。指向反代或第三方网关时改这里。",
  },
  {
    name: "ANTHROPIC_AUTH_TOKEN",
    label: "Auth Token",
    placeholder: "sk-ant-… 或自定义 token",
    secret: true,
    help: "认证 token（与 API Key 二选一，第三方网关多用这个）。",
  },
  {
    name: "ANTHROPIC_MODEL",
    label: "主模型",
    placeholder: "claude-sonnet-5 / opus / haiku …",
    help: "默认使用的主模型。",
  },
  {
    name: "CLAUDE_CODE_SUBAGENT_MODEL",
    label: "子 Agent 模型",
    placeholder: "如 haiku",
    help: "子 agent（Task 工具）使用的模型。",
  },
  {
    name: "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH",
    label: "子 Agent 嵌套深度",
    placeholder: "留空用默认（1）",
    type: "number",
    help: "子 agent 最多能再派生几层子 agent。0.3.217 起默认 1（不再嵌套）；需要多层嵌套时调大。",
  },
  {
    name: "CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS",
    label: "子 Agent 并发上限",
    placeholder: "留空用默认（20）",
    type: "number",
    help: "同一会话内同时运行的子 agent 数量上限。0.3.217 起默认 20。",
  },
  {
    name: "CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION",
    label: "单会话子 Agent 总数",
    placeholder: "留空用 CLI 默认",
    type: "number",
    help: "单个会话内允许创建的子 agent 总数上限。",
  },
  {
    name: "ANTHROPIC_DEFAULT_OPUS_MODEL",
    label: "Opus 模型",
    placeholder: "留空使用 CLI 默认",
    help: "“opus”别名指向的实际模型 ID。",
  },
  {
    name: "ANTHROPIC_DEFAULT_SONNET_MODEL",
    label: "Sonnet 模型",
    placeholder: "留空使用 CLI 默认",
    help: "“sonnet”别名指向的实际模型 ID。",
  },
  {
    name: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    label: "Haiku 模型",
    placeholder: "留空使用 CLI 默认",
    help: "“haiku”别名指向的实际模型 ID（后台小任务用）。",
  },
  {
    name: "CLAUDE_CODE_EFFORT_LEVEL",
    label: "思考深度",
    placeholder: "选择思考强度",
    type: "select",
    options: ["default", "low", "medium", "high", "xhigh", "max"],
    help: "思考强度。会话级强制覆盖（高于 /effort 命令）。",
  },
  {
    name: "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
    label: "自动压缩窗口",
    placeholder: "如 100000（token 数）",
    type: "number",
    help: "上下文达到此 token 数时触发自动压缩。留空用 CLI 默认。",
  },
] as const;

/** 环境变量键 → 元信息（快速查找） */
export const ENV_FIELDS_BY_NAME: Record<string, EnvFieldMeta> =
  Object.fromEntries(ENV_FIELDS.map((f) => [f.name, f]));

/** 字段名集合（白名单，防注入） */
export const ENV_FIELD_NAMES: readonly string[] = ENV_FIELDS.map(
  (f) => f.name,
);

/** 字段值类型：键为环境变量名，值为字符串 */
export type EnvValues = Record<string, string>;

/** 给定 EnvValues，过滤掉空串/undefined，得到真正要设置的 env */
export function pruneEnvValues(values: EnvValues): EnvValues {
  const out: EnvValues = {};
  for (const [k, v] of Object.entries(values)) {
    if (typeof v === "string" && v.trim() !== "") {
      out[k] = v;
    }
  }
  return out;
}
