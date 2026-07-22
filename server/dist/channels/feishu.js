import * as Lark from "@larksuiteoapi/node-sdk";
import { connectFeishuBot, validateCredentials, createBot } from "connect-feishu-bot";
import { runQuery } from "../lib/sdk.js";
import { resolveProfileEnv } from "../lib/store.js";
const sessionMap = new Map();
let feishuBot = null;
async function buildReplyContent(events) {
    const parts = [];
    for (const evt of events) {
        if (evt.type === "text") {
            parts.push(evt.text);
        }
        else if (evt.type === "tool_use") {
            parts.push(`\`\`\`\n${evt.name}: ${JSON.stringify(evt.input, null, 2)}\n\`\`\``);
        }
        else if (evt.type === "tool_result") {
            const prefix = evt.isError ? "❌" : "✅";
            parts.push(`${prefix} ${evt.name}\n\`\`\`\n${JSON.stringify(evt.result, null, 2)}\n\`\`\``);
        }
        else if (evt.type === "error") {
            parts.push(`❌ ${evt.message}`);
        }
        else if (evt.type === "done") {
            parts.push(`\n---\n完成 | 耗时 ${(evt.durationMs / 1000).toFixed(1)}s | input ${evt.inputTokens} tokens | output ${evt.outputTokens} tokens`);
        }
    }
    return parts.join("\n");
}
async function handleMessageNew(message, config) {
    const { chatId, text, senderId, chatType } = message;
    if (!text.trim()) {
        return;
    }
    const sessionKey = `${senderId}_${chatId}`;
    const existingSessionId = sessionMap.get(sessionKey);
    const cwd = config.defaultCwd || process.cwd();
    const env = await resolveProfileEnv(config.defaultProfileId);
    const events = [];
    let newSessionId;
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
    }
    catch (err) {
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
    }
    catch (err) {
        console.error("[feishu] failed to send reply:", err);
    }
}
export async function startFeishuChannel(config) {
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
            onMessage: async (message) => {
                await handleMessageNew(message, config);
            },
        });
        await feishuBot.connect();
        console.info("[feishu] channel started successfully");
    }
    catch (err) {
        console.error("[feishu] failed to start channel:", err);
        throw err;
    }
}
export async function connectViaQRCode(options) {
    return connectFeishuBot({
        onQRCode: options?.onQRCode,
        onStatus: options?.onStatus,
        signal: options?.signal,
    });
}
export async function validateFeishuCredentials(appId, appSecret) {
    return validateCredentials(appId, appSecret);
}
