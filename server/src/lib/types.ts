/**
 * 共享类型定义 —— 后端内部 + SSE 线缆（前后端共有）
 */

/** SDK 权限模式 */
export type PermissionMode = "bypassPermissions" | "default" | "acceptEdits" | "plan" | "dontAsk" | "auto";

/** SDK 思考级别（disabled = 关闭扩展思考） */
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max" | "disabled";

/** 一套环境变量配置（profile） */
export interface EnvProfile {
  /** 唯一 id（前端生成的 uuid） */
  id: string;
  /** 显示名 */
  name: string;
  /** 9 个白名单环境变量的值（空串=不设置） */
  env: Record<string, string>;
  /** 创建时间（ms） */
  createdAt: number;
  /** 最后修改时间（ms） */
  updatedAt: number;
}

/** 我们自己存的会话元信息（sessions.json 里的一条记录）。
 *  标题由 SDK 的 customTitle/summary 管理，这里只存 SDK 不覆盖的字段。 */
export interface SessionRecord {
  /** SDK 的 session_id，同时也是前端 URL id */
  sessionId: string;
  /** 工作目录（绝对路径） */
  cwd: string;
  /** 创建时间（ms） */
  createdAt: number;
  /** 最后活跃时间（ms） */
  lastModified: number;
  /** 当前绑定的 profile id（null = 不绑定，纯用 CLI 默认） */
  profileId: string | null;
  /** 权限模式（默认完全放行兼容旧数据） */
  permissionMode: PermissionMode;
  /** 思考级别（默认深度推理兼容旧数据） */
  effortLevel: EffortLevel;
}

/** 返回给前端的会话（合并 SDK 元信息后）。标题来自 SDK customTitle / summary。 */
export interface SessionView {
  sessionId: string;
  cwd: string;
  title: string;
  createdAt: number;
  lastModified: number;
  /** 当前绑定的 profile id（null = 纯 CLI 默认） */
  profileId: string | null;
  /** 会话运行状态 */
  runningStatus: "idle" | "running" | "waiting";
  /** 权限模式 */
  permissionMode: PermissionMode;
  /** 思考级别 */
  effortLevel: EffortLevel;
}

/** sessions.json 文件结构 */
export interface SessionsFile {
  sessions: SessionRecord[];
}

// ─────────────────────────────────────────────────────────────
// SSE 线缆：后端 → 前端
// 这些类型前后端都要用，前端会按 event 名分发
// ─────────────────────────────────────────────────────────────

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
    }
  | { type: "waiting_for_user" }
  /** GET /stream 订阅时，先发历史消息再转发现场事件 */
  | { type: "history"; messages: unknown[] };

/** 新建会话请求 */
export interface CreateSessionRequest {
  cwd: string;
  title?: string;
  message: string;
  /** 启动时绑定的 profile id（null/缺省 = 不绑定） */
  profileId?: string | null;
  /** 权限模式（缺省 = bypassPermissions 兼容旧客户端） */
  permissionMode?: PermissionMode;
  /** 思考级别（缺省 = high） */
  effortLevel?: EffortLevel;
}

/** 发消息请求 */
export interface SendMessageRequest {
  message: string;
}
