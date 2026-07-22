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
      /** 会话累计 input tokens（含本轮） */
      inputTokens: number;
      /** 会话累计 output tokens（含本轮） */
      outputTokens: number;
      /** 本轮耗时（ms） */
      durationMs: number;
    }
  | { type: "waiting_for_user" }
  /** GET /stream 订阅：先发送全部历史消息，再转发现场事件 */
  | { type: "history"; messages: unknown[] };

/** 会话列表/详情里的单条会话 */
export interface SessionView {
  sessionId: string;
  cwd: string;
  title: string;
  createdAt: number;
  lastModified: number;
  profileId: string | null;
  /** 会话运行状态 */
  runningStatus: "idle" | "running" | "waiting";
  /** 权限模式 */
  permissionMode: "bypassPermissions" | "default" | "acceptEdits" | "plan" | "dontAsk" | "auto";
  /** 思考级别 */
  effortLevel: "low" | "medium" | "high" | "xhigh" | "max" | "disabled";
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
