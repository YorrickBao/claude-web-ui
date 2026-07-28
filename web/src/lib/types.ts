/** 后端 → 前端的 SSE 事件（与 server/src/lib/types.ts SSEEvent 保持一致） */
export type SSEEvent =
  | { type: "session_created"; sessionId: string }
  | { type: "text"; text: string }
  /** 用户文本输入（观察方据此显示用户消息） */
  | { type: "user_message"; text: string }
  /** 思考过程增量（扩展思考），前端追加到 reasoning part */
  | { type: "thinking"; text: string }
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
      /** 本轮 input tokens（SDK result.usage） */
      inputTokens: number;
      /** 本轮 output tokens */
      outputTokens: number;
      /** 本轮 cache_read_input_tokens */
      cacheReadTokens: number;
      /** 本轮 cache_creation_input_tokens */
      cacheCreationTokens: number;
      durationMs: number;
      /** 本回合最终答案的 assistant message uuid，用作 forkSession 的 upToMessageId */
      lastAssistantUuid?: string;
    }
  /** 一个 agentic 步骤开始（模型开始本轮思考/调用）。index 从 1 起 */
  | { type: "step_start"; index: number }
  /** 一个 agentic 步骤结束（模型产出完整 assistant 消息）。index 与对应 step_start 一致 */
  | { type: "step_end"; index: number }
  | { type: "waiting_for_user" }
  /** 进行中的瞬态状态（压缩 / API 重试 / 限流）。kind: "idle" 为清除信号 */
  | {
      type: "status";
      kind: "compacting" | "api_retry" | "rate_limit" | "idle";
      message: string;
      detail?: { attempt?: number; maxRetries?: number };
    }
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
  | { type: "mode_changed"; mode: string }
  /** 远程控制隧道状态变更（全局频道，GET /api/events/stream 推送） */
  | { type: "relay_status"; status: RelayStatusSnapshot }
  /** 会话列表/状态变更通知（全局频道，GET /api/events/stream 推送，无数据负载） */
  | { type: "sessions_changed" }
  /** 会话查询开始（全局频道，驱动观察方接入实时流） */
  | { type: "session_started"; sessionId: string }
  /** 会话查询结束（全局频道） */
  | { type: "session_ended"; sessionId: string }
  /** 远程设备列表变更（全局频道，设备上下线） */
  | { type: "device_changed"; devices: DeviceEntry[] };

/** relay_status 事件里的隧道状态快照 */
export interface RelayStatusSnapshot {
  enabled: boolean;
  connected: boolean;
  connecting: boolean;
  relayUrl: string;
  accessKey: string;
  remoteUrl: string;
  /** 当前访问令牌的到期时间戳（ms）；null 表示无有效令牌 */
  tokenExpiresAt: number | null;
  error: string | null;
}

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
  /** 累计 input tokens（仅详情视图填充；列表不扫盘） */
  inputTokens?: number;
  /** 累计 output tokens（仅详情视图填充） */
  outputTokens?: number;
  /** 累计 cache_read_input_tokens（仅详情视图填充） */
  cacheReadTokens?: number;
  /** 累计 cache_creation_input_tokens（仅详情视图填充） */
  cacheCreationTokens?: number;
  /** 最近一轮 prompt 实际尺寸 = input + cache_read + cache_creation（仅详情视图填充）。
   *  反映当前上下文窗口占用，用于 ContextUsageRing。 */
  lastTurnPromptTokens?: number;
  /** 最近一轮的耗时（ms） */
  lastDurationMs: number;
  /** 当前进行中轮次的开始时刻（ms）；0 表示无进行中轮次 */
  currentTurnStartedAt: number;
}

/** 一套环境变量配置 */
export interface EnvProfile {
  id: string;
  name: string;
  env: Record<string, string>;
  /** 手动排序位置（升序，越小越靠前） */
  order: number;
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

/** 远程接入设备记录（与 server/src/lib/relayDevices.ts 的 DeviceEntry 同构） */
export interface DeviceEntry {
  id: string;
  browser: string;
  deviceType: string;
  os: string;
  ip: string;
  firstSeen: number;
  lastSeen: number;
}
