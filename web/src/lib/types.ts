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
      costUsd: number;
      numTurns: number;
      durationMs: number;
    };

/** 会话列表/详情里的单条会话 */
export interface SessionView {
  sessionId: string;
  cwd: string;
  title: string;
  firstPrompt: string | null;
  createdAt: number;
  lastModified: number;
  profileId: string | null;
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
