import { query, listSessions, getSessionInfo, renameSession, } from "@anthropic-ai/claude-agent-sdk";
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
            // disabled → thinking: { type: 'disabled' }，其余 → effort 参数
            ...(params.effortLevel === "disabled"
                ? { thinking: { type: "disabled" } }
                : { effort: (params.effortLevel ?? "high") }),
            abortController: params.abortController,
            // 只在有 override 时才传，避免无谓替换（让 SDK 走默认继承 process.env）
            ...(childEnv ? { env: childEnv } : {}),
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
                    yield {
                        type: "done",
                        costUsd: msg.total_cost_usd,
                        numTurns: msg.num_turns,
                        durationMs: msg.duration_ms,
                    };
                }
                else {
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
