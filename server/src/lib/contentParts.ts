/**
 * SDK content blocks → assistant-ui content parts 的共享映射。
 *
 * 供 sdk.ts（流式累积快照 + 完整消息兜底）和 replay.ts（历史回放）共用，
 * 保证实时、兜底、历史三条路径产出的 part 形态完全一致。
 *
 * 对齐前端 ThreadMessageLike 的 content part：
 * - text     纯文本
 * - reasoning 思考过程（来自 thinking / redacted_thinking block）
 * - tool-call 工具调用（result/isError 为可选字段，由后续 tool_result 回填）
 */

export type AssistantPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | {
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      args?: unknown;
      argsText?: string;
      result?: unknown;
      isError?: boolean;
    };

/**
 * 把 SDK 的一条 assistant 消息的 content blocks 映射成 assistant-ui parts。
 * @param dropEmptyText 是否丢弃空/纯空白 text（历史回放丢弃，流式快照保留以驱动光标）
 */
export function contentBlocksToParts(
  content: unknown[],
  dropEmptyText = false,
): AssistantPart[] {
  const parts: AssistantPart[] = [];
  for (const block of content) {
    const b = block as { type: string; [k: string]: unknown };
    if (b.type === "text" && typeof b.text === "string") {
      if (dropEmptyText && !b.text.trim()) continue;
      parts.push({ type: "text", text: b.text });
    } else if (b.type === "thinking" && typeof b.thinking === "string") {
      // 扩展思考：保留原文，签名（signature）字段不参与渲染
      parts.push({ type: "reasoning", text: b.thinking });
    } else if (b.type === "redacted_thinking") {
      // 被加密的思考块：无法还原内容，给一个占位提示
      parts.push({ type: "reasoning", text: "[此段思考内容已加密，无法显示]" });
    } else if (
      b.type === "tool_use" &&
      typeof b.id === "string" &&
      typeof b.name === "string"
    ) {
      parts.push({
        type: "tool-call",
        toolCallId: b.id,
        toolName: b.name,
        args: b.input ?? {},
        argsText: safeStringify(b.input),
      });
    }
    // 其余 block（server_tool_use / web_search_tool_result / mcp_* 等）暂不映射
  }
  return parts;
}

export function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
