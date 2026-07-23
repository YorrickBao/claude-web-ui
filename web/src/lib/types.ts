/** 后端 → 前端的 SSE 事件（与 server/src/lib/types.ts SSEEvent 保持一致） */
export type SSEEvent =
  | { type: "session_created"; sessionId: string }
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      id: string;
      name: string;
      result: unknown;
      isError: boolean;
    }
  | { type: "error"; message: string }
  | {
      type: "done";
      inputTokens: number;
      outputTokens: number;
      durationMs: number;
    }
  | { type: "waiting_for_user" }
  | { type: "history"; messages: unknown[] }
  /** 工具权限请求：agent 想执行某个操作，需要用户审批 */
  | {
      type: "permission_request";
      requestId: string;
      toolName: string;
      toolInput: unknown;
      decisionReason?: string;
    }
  /** 权限请求已解决：清除对应横幅（超时/中止/已被响应） */
  | {
      type: "permission_resolved";
      requestId: string;
      reason: "timeout" | "aborted" | "resolved";
    }
  /** Plan mode 退出：LLM 产出了计划，等待用户审批 */
  | { type: "plan_proposed"; planContent: string }
  /** 权限模式已变更 */
  | { type: "mode_changed"; mode: string };

/** 会话列表/详情里的单条会话 */
export interface SessionView {
  sessionId: string;
  cwd: string;
  title: string;
  createdAt: number;
  lastModified: number;
  profileId: string | null;
  /** 会话运行状态 */
  runningStatus: "idle" | "running" | "waiting" | "completed";
  /** 权限模式 */
  permissionMode: "bypassPermissions" | "default" | "acceptEdits" | "plan" | "dontAsk" | "auto";
  /** 思考级别 */
  effortLevel: "low" | "medium" | "high" | "xhigh" | "max" | "disabled" | "default";
  /** 累计 input tokens */
  inputTokens: number;
  /** 累计 output tokens */
  outputTokens: number;
}

/** 一套环境变量配置 */
export interface EnvProfile {
  id: string;
  name: string;
  env: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}

/** 斜杠命令定义 */
export interface SlashCommand {
  name: string;
  description: string;
  argumentHint?: string;
}

/** /api/browse 返回的目录项 */
export interface DirEntry {
  name: string;
  isDir: boolean;
  path: string;
}

export interface BrowseResult {
  path: string;
  entries: DirEntry[];
}
