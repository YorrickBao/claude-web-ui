import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { SSEEvent } from "./types.js";

/**
 * 运行一次 Claude Agent SDK 的 query()，把 SDKMessage 流翻译成 SSEEvent 流。
 *
 * @returns 一个 async generator，调用方 `for await ... of` 消费
 */
export interface RunQueryParams {
  cwd: string;
  prompt: string;
  /** 续接已有会话；undefined 则新开 */
  resume?: string;
  /** 取消信号 */
  abortController: AbortController;
}

export async function* runQuery(
  params: RunQueryParams,
): AsyncGenerator<SSEEvent> {
  const stream = query({
    prompt: params.prompt,
    options: {
      cwd: params.cwd,
      // 新会话不 resume；老会话传 resume
      ...(params.resume ? { resume: params.resume } : {}),
      allowedTools: [
        "Bash",
        "Read",
        "Write",
        "Edit",
        "Glob",
        "Grep",
        "WebSearch",
        "WebFetch",
      ],
      // 第一版纯本地、不做权限 UI：全权限放行
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      abortController: params.abortController,
    },
  });

  for await (const msg of stream as AsyncIterable<SDKMessage>) {
    switch (msg.type) {
      case "system": {
        if (msg.subtype === "init") {
          yield { type: "session_created", sessionId: msg.session_id };
        }
        break;
      }

      case "assistant": {
        const content = (msg.message as { content?: unknown[] }).content;
        if (!Array.isArray(content)) break;
        for (const block of content) {
          const b = block as {
            type: string;
            text?: string;
            id?: string;
            name?: string;
            input?: unknown;
          };
          if (b.type === "text" && typeof b.text === "string") {
            yield { type: "text", text: b.text };
          } else if (
            b.type === "tool_use" &&
            typeof b.id === "string" &&
            typeof b.name === "string"
          ) {
            yield {
              type: "tool_use",
              id: b.id,
              name: b.name,
              input: b.input,
            };
          }
        }
        break;
      }

      case "user": {
        const content = (
          msg.message as { content?: unknown[] }
        ).content;
        if (!Array.isArray(content)) break;
        for (const block of content) {
          const b = block as {
            type: string;
            tool_use_id?: string;
            content?: unknown;
            is_error?: boolean;
          };
          if (
            b.type === "tool_result" &&
            typeof b.tool_use_id === "string"
          ) {
            yield {
              type: "tool_result",
              id: b.tool_use_id,
              // name 会被前端通过之前 tool_use 的 id 映射补上；
              // 这里先填空串，前端 fallback 到 "工具"
              name: "",
              result: b.content,
              isError: b.is_error === true,
            };
          }
        }
        break;
      }

      case "result": {
        if (msg.subtype === "success") {
          yield {
            type: "done",
            costUsd: msg.total_cost_usd,
            numTurns: msg.num_turns,
            durationMs: msg.duration_ms,
          };
        } else {
          // error_max_turns / error_during_execution / ...
          yield {
            type: "error",
            message: `会话结束（${msg.subtype}）`,
          };
        }
        break;
      }
    }
  }
}
