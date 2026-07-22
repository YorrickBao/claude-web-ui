import { query, listSessions, getSessionInfo, renameSession, } from "@anthropic-ai/claude-agent-sdk";
import { registerStart, registerStop } from "./agentRegistry.js";
// 重新导出 SDK 会话管理函数供 store 和 routes 使用
export { listSessions, getSessionInfo, renameSession };
export async function* runQuery(params) {
    // SDK 的 env 是"完全替换"，所以必须 spread process.env 再合 override，
    // 否则 PATH/HOME 等基础变量会丢，子进程直接挂掉
    const childEnv = params.env && Object.keys(params.env).length > 0
        ? { ...process.env, ...params.env }
        : undefined;
    const mode = params.permissionMode ?? "bypassPermissions";
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
            permissionMode: mode,
            allowDangerouslySkipPermissions: mode === "bypassPermissions",
            // disabled → thinking: { type: 'disabled' }
            // default/未指定 → 不传 effort，让 SDK 用环境变量 CLAUDE_CODE_EFFORT_LEVEL
            // 其余 → effort 参数
            ...(params.effortLevel === "disabled"
                ? { thinking: { type: "disabled" } }
                : (params.effortLevel === "default" || !params.effortLevel)
                    ? {}
                    : { effort: params.effortLevel }),
            abortController: params.abortController,
            // 只在有 override 时才传，避免无谓替换（让 SDK 走默认继承 process.env）
            ...(childEnv ? { env: childEnv } : {}),
            // 子代理生命周期追踪：SubagentStart/Stop hook → agentRegistry
            hooks: {
                SubagentStart: [
                    {
                        matcher: "*",
                        hooks: [
                            async (input) => {
                                try {
                                    registerStart(input);
                                }
                                catch {
                                    // 追踪失败不阻塞 agent 执行
                                }
                                return { continue: true };
                            },
                        ],
                    },
                ],
                SubagentStop: [
                    {
                        matcher: "*",
                        hooks: [
                            async (input) => {
                                try {
                                    await registerStop(input);
                                }
                                catch {
                                    // 追踪失败不阻塞 agent 执行
                                }
                                return { continue: true };
                            },
                        ],
                    },
                ],
            },
        },
    });
    for await (const msg of stream) {
        switch (msg.type) {
            case "system": {
                if (msg.subtype === "init") {
                    yield { type: "session_created", sessionId: msg.session_id };
                }
                else if (msg.subtype === "session_state_changed") {
                    // SDK 会话状态变更：idle / running / requires_action（HITL 等待用户决策）
                    const stateMsg = msg;
                    if (stateMsg.state === "requires_action") {
                        yield { type: "waiting_for_user" };
                    }
                }
                break;
            }
            case "assistant": {
                const content = msg.message.content;
                if (!Array.isArray(content))
                    break;
                for (const block of content) {
                    const b = block;
                    if (b.type === "text" && typeof b.text === "string") {
                        yield { type: "text", text: b.text };
                    }
                    else if (b.type === "tool_use" &&
                        typeof b.id === "string" &&
                        typeof b.name === "string") {
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
                const content = msg.message.content;
                if (!Array.isArray(content))
                    break;
                for (const block of content) {
                    const b = block;
                    if (b.type === "tool_result" &&
                        typeof b.tool_use_id === "string") {
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
                    const s = msg;
                    yield {
                        type: "done",
                        inputTokens: s.usage?.input_tokens ?? 0,
                        outputTokens: s.usage?.output_tokens ?? 0,
                        durationMs: msg.duration_ms,
                    };
                }
                else {
                    // error_max_turns / error_during_execution / ...
                    // 即使在错误退出路径上，前面轮次消耗的 token 也是真实数据，先发 done 累加上去
                    const e = msg;
                    yield {
                        type: "done",
                        inputTokens: e.usage?.input_tokens ?? 0,
                        outputTokens: e.usage?.output_tokens ?? 0,
                        durationMs: msg.duration_ms,
                    };
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
