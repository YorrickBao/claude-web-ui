import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import { contentBlocksToParts, type AssistantPart } from "./contentParts.js";

/**
 * 历史消息 part —— 与前端 ThreadMessageLike 的 content part 对齐：
 * - text: 文本
 * - reasoning: 思考过程
 * - tool-call: 工具调用 + 结果在同一 part（result 为可选字段）
 */
export type ReplayPart = AssistantPart;

export interface ReplayMessage {
  role: "user" | "assistant";
  content: ReplayPart[];
}

/**
 * 拉取会话历史 → ReplayMessage[]。
 *
 * SDK 转录里 user/assistant 消息交替，tool_use 在 assistant 消息里，
 * 对应的 tool_result 在紧随其后的 user 消息里（带 tool_use_id）。
 * 我们用这个 id 把 result 合并到同一个 tool-call part 上，
 * 让前端一条 assistant 消息就能完整展示"调用 + 结果"。
 */
export async function replaySession(
  sessionId: string,
  cwd: string,
): Promise<ReplayMessage[]> {
  const out: ReplayMessage[] = [];
  const pendingTools = new Map<string, { msgIdx: number; partIdx: number }>();

  const messages = await getSessionMessages(sessionId, { dir: cwd });

  for (const m of messages) {
    if (m.type === "user") {
      const content = (m.message as { content?: unknown[] }).content;
      if (!Array.isArray(content)) continue;

      const textParts: ReplayPart[] = [];
      for (const block of content) {
        const b = block as {
          type: string;
          text?: string;
          tool_use_id?: string;
          content?: unknown;
          is_error?: boolean;
        };

        if (b.type === "text" && typeof b.text === "string") {
          if (b.text.trim()) textParts.push({ type: "text", text: b.text });
        } else if (
          b.type === "tool_result" &&
          typeof b.tool_use_id === "string"
        ) {
          const slot = pendingTools.get(b.tool_use_id);
          if (slot) {
            const target = out[slot.msgIdx];
            if (target && target.content[slot.partIdx]?.type === "tool-call") {
              target.content[slot.partIdx] = {
                ...(target.content[slot.partIdx] as Extract<
                  ReplayPart,
                  { type: "tool-call" }
                >),
                result: b.content,
                isError: b.is_error === true,
              };
            }
            pendingTools.delete(b.tool_use_id);
          }
        }
      }

      if (textParts.length > 0) {
        out.push({ role: "user", content: textParts });
      }
    } else if (m.type === "assistant") {
      const content = (m.message as { content?: unknown[] }).content;
      if (!Array.isArray(content)) continue;

      // 复用共享映射：text / thinking→reasoning / tool_use→tool-call
      // dropEmptyText=true 去掉空文本块（历史回放不需要占位）
      const parts = contentBlocksToParts(content, true);
      if (parts.length === 0) continue;

      // 合并连续的 assistant 消息：agentic loop 的每轮 SDK assistant
      // 消息（thinking/tool_use/中间 text）都属于同一个用户回合，
      // 合并进同一条前端消息，避免把一个回合碎成几十条消息。
      const last = out[out.length - 1];
      let msgIdx: number;
      if (last && last.role === "assistant") {
        // 追加到已有 assistant 消息
        msgIdx = out.length - 1;
        const baseLen = last.content.length;
        last.content.push(...parts);
        parts.forEach((p, i) => {
          if (p.type === "tool-call") {
            pendingTools.set(p.toolCallId, { msgIdx, partIdx: baseLen + i });
          }
        });
      } else {
        // 开新的 assistant 消息
        msgIdx = out.length;
        out.push({ role: "assistant", content: [...parts] });
        parts.forEach((p, partIdx) => {
          if (p.type === "tool-call") {
            pendingTools.set(p.toolCallId, { msgIdx, partIdx });
          }
        });
      }
    }
  }

  return out;
}
