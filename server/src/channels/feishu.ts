import * as Lark from "@larksuiteoapi/node-sdk";
import { runQuery } from "../lib/sdk.js";
import type { SSEEvent } from "../lib/types.js";
import { resolveProfileEnv } from "../lib/store.js";

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  enabled: boolean;
  domain?: "feishu" | "lark";
  defaultCwd?: string;
  defaultProfileId?: string | null;
}

export interface FeishuContext {
  chatId: string;
  openId: string;
  messageId: string;
}

const sessionMap = new Map<string, string>();

async function buildReplyContent(events: SSEEvent[]): Promise<string> {
  const parts: string[] = [];
  for (const evt of events) {
    if (evt.type === "text") {
      parts.push(evt.text);
    } else if (evt.type === "tool_use") {
      parts.push(`\`\`\`\n${evt.name}: ${JSON.stringify(evt.input, null, 2)}\n\`\`\``);
    } else if (evt.type === "tool_result") {
      const prefix = evt.isError ? "❌" : "✅";
      parts.push(`${prefix} ${evt.name}\n\`\`\`\n${JSON.stringify(evt.result, null, 2)}\n\`\`\``);
    } else if (evt.type === "error") {
      parts.push(`❌ ${evt.message}`);
    } else if (evt.type === "done") {
      parts.push(`\n---\n完成 | 耗时 ${(evt.durationMs / 1000).toFixed(1)}s | 花费 $${evt.costUsd.toFixed(4)}`);
    }
  }
  return parts.join("\n");
}

async function handleMessage(
  client: Lark.Client,
  data: unknown,
  config: FeishuConfig,
): Promise<void> {
  const eventData = data as {
    header: { event_type: string };
    event: {
      message: {
        chat_id: string;
        message_id: string;
        content: string;
        chat_type: string;
      };
      sender: {
        sender_id: { open_id?: string };
      };
    };
  };

  if (eventData.header.event_type !== "im.message.receive_v1") return;

  const { chat_id, content, chat_type } = eventData.event.message;
  const open_id = eventData.event.sender.sender_id.open_id;

  if (!open_id) {
    console.warn("[feishu] missing open_id");
    return;
  }

  let text: string;
  try {
    const parsed = JSON.parse(content);
    text = parsed.text?.trim() || "";
  } catch {
    text = "";
  }

  if (!text) return;

  console.info(`[feishu] ${chat_type === "p2p" ? "DM" : "Group"} ${open_id}: ${text.slice(0, 50)}...`);

  const sessionKey = `${open_id}_${chat_id}`;
  const existingSessionId = sessionMap.get(sessionKey);

  const cwd = config.defaultCwd || process.cwd();
  const env = await resolveProfileEnv(config.defaultProfileId);

  const events: SSEEvent[] = [];
  let newSessionId: string | undefined;

  try {
    const stream = runQuery({
      cwd,
      prompt: text,
      resume: existingSessionId,
      abortController: new AbortController(),
      env,
    });

    for await (const evt of stream) {
      events.push(evt);
      if (evt.type === "session_created") {
        newSessionId = evt.sessionId;
      }
    }

    if (newSessionId) {
      sessionMap.set(sessionKey, newSessionId);
    }
  } catch (err) {
    events.push({ type: "error", message: err instanceof Error ? err.message : "unknown error" });
  }

  const replyText = await buildReplyContent(events);

  if (!replyText.trim()) {
    console.warn("[feishu] empty reply, skipping");
    return;
  }

  try {
    await client.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chat_id,
        content: JSON.stringify({ text: replyText.slice(0, 4000) }),
        msg_type: "text",
      },
    });
    console.info(`[feishu] reply sent to ${chat_id}`);
  } catch (err) {
    console.error("[feishu] failed to send reply:", err);
  }
}

export async function startFeishuChannel(config: FeishuConfig): Promise<void> {
  if (!config.enabled) {
    console.info("[feishu] channel disabled");
    return;
  }

  if (!config.appId || !config.appSecret) {
    console.warn("[feishu] appId or appSecret not provided, skipping");
    return;
  }

  const baseConfig = {
    appId: config.appId,
    appSecret: config.appSecret,
  };

  const client = new Lark.Client(baseConfig);
  const wsClient = new Lark.WSClient({
    ...baseConfig,
    loggerLevel: Lark.LoggerLevel.info,
    domain: config.domain === "lark" ? "lark" : "feishu",
  });

  try {
    await wsClient.start({
      eventDispatcher: new Lark.EventDispatcher({}).register({
        "im.message.receive_v1": async (data) => {
          await handleMessage(client, data, config);
        },
      }),
    });
    console.info("[feishu] channel started successfully");
  } catch (err) {
    console.error("[feishu] failed to start channel:", err);
    throw err;
  }
}