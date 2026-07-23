import * as Lark from "@larksuiteoapi/node-sdk";
import { connectFeishuBot, validateCredentials, createBot } from "connect-feishu-bot";
import { runQuery } from "../lib/sdk.js";
import type { SSEEvent } from "../lib/types.js";
import { resolveProfileEnv } from "../lib/store.js";
import type { IncomingMessage, FeishuBot } from "connect-feishu-bot";

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  enabled: boolean;
  domain?: "feishu" | "lark";
  defaultCwd?: string;
  defaultProfileId?: string | null;
}

export interface ConnectOptions {
  onQRCode?: (url: string) => void;
  onStatus?: (status: RegistrationStatus) => void;
  signal?: AbortSignal;
}

export type RegistrationStatus =
  | { phase: "initializing" }
  | { phase: "waiting_for_scan"; qrUrl: string; expiresIn: number }
  | { phase: "success"; appId: string; appSecret: string; userOpenId?: string; domain: "feishu" | "lark" }
  | { phase: "denied" }
  | { phase: "expired" }
  | { phase: "error"; message: string };

export interface ConnectResult {
  appId: string;
  appSecret: string;
  userOpenId?: string;
  domain: "feishu" | "lark";
}

const sessionMap = new Map<string, string>();
let feishuBot: FeishuBot | null = null;

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
      parts.push(`\n---\n完成 | 耗时 ${(evt.durationMs / 1000).toFixed(1)}s | input ${evt.inputTokens} tokens | output ${evt.outputTokens} tokens`);
    }
  }
  return parts.join("\n");
}

async function handleMessageNew(
  message: IncomingMessage,
  config: FeishuConfig,
): Promise<void> {
  const { chatId, text, senderId, chatType } = message;

  if (!text.trim()) {
    return;
  }

  const sessionKey = `${senderId}_${chatId}`;
  const existingSessionId = sessionMap.get(sessionKey);

  const cwd = config.defaultCwd || process.cwd();
  const env = await resolveProfileEnv(config.defaultProfileId);

  const events: SSEEvent[] = [];
  let newSessionId: string | undefined;

  try {
    // 飞书渠道是无人值守的机器人通道，没有任何审批 UI 订阅
    // permission_request 事件，若用 default 模式会因 hook 等不到响应
    // 而挂满 5 分钟超时再 deny。这里显式 bypassPermissions。
    const stream = runQuery({
      cwd,
      prompt: text,
      resume: existingSessionId,
      abortController: new AbortController(),
      env,
      permissionMode: "bypassPermissions",
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
    console.error("[feishu] runQuery error:", err);
    events.push({ type: "error", message: err instanceof Error ? err.message : "unknown error" });
  }

  const replyText = await buildReplyContent(events);

  if (!replyText.trim()) {
    return;
  }

  try {
    if (feishuBot) {
      const target = chatType === "p2p" ? `open:${chatId}` : `chat:${chatId}`;
      await feishuBot.sendText(target, replyText.slice(0, 4000));
    }
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

  try {
    feishuBot = createBot({
      appId: config.appId,
      appSecret: config.appSecret,
      domain: config.domain === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu,
      onMessage: async (message: IncomingMessage) => {
        await handleMessageNew(message, config);
      },
    });

    await feishuBot.connect();
    console.info("[feishu] channel started successfully");
  } catch (err) {
    console.error("[feishu] failed to start channel:", err);
    throw err;
  }
}

export async function connectViaQRCode(options?: ConnectOptions): Promise<ConnectResult> {
  return connectFeishuBot({
    onQRCode: options?.onQRCode,
    onStatus: options?.onStatus,
    signal: options?.signal,
  });
}

export async function validateFeishuCredentials(appId: string, appSecret: string): Promise<boolean> {
  return validateCredentials(appId, appSecret);
}