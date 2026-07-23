import { query, listSessions, listSubagents, getSessionInfo, renameSession, } from "@anthropic-ai/claude-agent-sdk";
import { registerStart, registerStop } from "./agentRegistry.js";
import { createPendingPermission } from "./inflight.js";
import { emitSessionEvent } from "./eventBus.js";
// 重新导出 SDK 会话管理函数供 store 和 routes 使用
export { listSessions, listSubagents, getSessionInfo, renameSession };
// PermissionRequest hook 的回调返回类型与泛型 HookJSONOutput 不兼容
// （SDK 类型系统尚未完全统一），单独构建此 hook 的闭包后用 any 注入
function buildPermissionRequestHook(sessionIdRef) {
    return async (input) => {
        const sid = sessionIdRef.current;
        if (!sid) {
            return {
                hookEventName: "PermissionRequest",
                decision: { behavior: "deny", message: "Session not initialized" },
            };
        }
        const { requestId, promise } = createPendingPermission(sid, input.tool_name, input.tool_input, input.decision_reason);
        emitSessionEvent(sid, {
            type: "permission_request",
            requestId,
            toolName: input.tool_name,
            toolInput: input.tool_input,
            decisionReason: input.decision_reason,
        });
        const decision = await promise;
        if (decision.behavior === "deny") {
            return {
                hookEventName: "PermissionRequest",
                decision: {
                    behavior: "deny",
                    message: decision.message ?? "User denied the operation",
                },
            };
        }
        // allow：透传 updatedPermissions（"始终允许此工具"）和 updatedInput
        const allowDecision = { behavior: "allow" };
        if (decision.updatedInput)
            allowDecision.updatedInput = decision.updatedInput;
        if (decision.updatedPermissions)
            allowDecision.updatedPermissions = decision.updatedPermissions;
        return {
            hookEventName: "PermissionRequest",
            decision: allowDecision,
        };
    };
}
export async function* runQuery(params) {
    // SDK 的 env 是"完全替换"，所以必须 spread process.env 再合 override，
    // 否则 PATH/HOME 等基础变量会丢，子进程直接挂掉
    const childEnv = params.env && Object.keys(params.env).length > 0
        ? { ...process.env, ...params.env }
        : undefined;
    const mode = params.permissionMode ?? "default";
    const isPlanMode = mode === "plan";
    // 仅这三种模式需要人工审批 hook：
    // - default / acceptEdits：危险操作需弹窗
    // - plan：只读工具仍可能触发审批
    // dontAsk / auto / bypassPermissions 由 SDK 内部决定，不安装 hook，
    // 避免 SDK 在这些模式下仍调用 hook 导致无人响应的 5 分钟挂起。
    const needsPermissionHook = mode === "default" || mode === "acceptEdits" || mode === "plan";
    // 在 plan 模式下累积计划文本，conversation_reset 时发送给前端
    let planTextBuffer = "";
    // plan 模式下累积规划过程只读工具调用摘要，作为计划依据附在 planContent 后
    let planToolsBuffer = "";
    // SessionId 的引用对象，供 buildPermissionRequestHook 闭包捕获
    const sessionIdRef = { current: undefined };
    // 预构建 PermissionRequest hook（只构建一次，避免每次 query 都创建闭包）
    const permissionRequestHook = needsPermissionHook
        ? buildPermissionRequestHook(sessionIdRef)
        : undefined;
    const stream = query({
        prompt: params.prompt,
        options: {
            cwd: params.cwd,
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
            ...(params.effortLevel === "disabled"
                ? { thinking: { type: "disabled" } }
                : (params.effortLevel === "default" || !params.effortLevel)
                    ? {}
                    : { effort: params.effortLevel }),
            abortController: params.abortController,
            ...(childEnv ? { env: childEnv } : {}),
            hooks: {
                // PermissionRequest: HITL 权限审批（非 bypass 模式）
                ...(permissionRequestHook
                    ? {
                        PermissionRequest: [
                            { matcher: "*", hooks: [permissionRequestHook] },
                        ],
                    }
                    : {}),
                // 子代理生命周期追踪
                SubagentStart: [
                    {
                        matcher: "*",
                        hooks: [
                            async (input) => {
                                try {
                                    registerStart(input);
                                }
                                catch (err) {
                                    console.warn("[sdk] registerStart failed:", err instanceof Error ? err.message : err);
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
                                catch (err) {
                                    console.warn("[sdk] registerStop failed:", err instanceof Error ? err.message : err);
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
                    sessionIdRef.current = msg.session_id;
                    yield { type: "session_created", sessionId: msg.session_id };
                }
                else if (msg.subtype === "session_state_changed") {
                    // SDK 会话状态变更：idle / running / requires_action
                    const stateMsg = msg;
                    if (stateMsg.state === "requires_action") {
                        yield { type: "waiting_for_user" };
                    }
                }
                break;
            }
            // Plan mode 退出：session 重置，准备进入执行阶段
            case "conversation_reset": {
                if (isPlanMode && planTextBuffer) {
                    // 将规划过程的只读工具调用摘要附在计划文本之后，
                    // 作为审批依据。用分隔线隔离，不干扰 LLM 计划主体。
                    const planContent = planToolsBuffer.trim()
                        ? `${planTextBuffer}\n\n---\n\n**规划依据（只读工具调用）：**\n${planToolsBuffer}`
                        : planTextBuffer;
                    yield {
                        type: "plan_proposed",
                        planContent,
                    };
                    planTextBuffer = "";
                    planToolsBuffer = "";
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
                        // Plan 模式下累积计划文本
                        if (isPlanMode) {
                            planTextBuffer += b.text;
                        }
                        yield { type: "text", text: b.text };
                    }
                    else if (b.type === "tool_use" &&
                        typeof b.id === "string" &&
                        typeof b.name === "string") {
                        // Plan 模式下累积规划工具调用摘要
                        if (isPlanMode) {
                            planToolsBuffer += `- ${summarizeToolCall(b.name, b.input)}\n`;
                        }
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
/**
 * 把规划阶段的只读工具调用压缩为单行摘要，附在计划审批文本后。
 * 只提取每个工具最关键的参数，避免把完整 JSON 塞进 planContent。
 */
function summarizeToolCall(toolName, input) {
    if (!input || typeof input !== "object")
        return `${toolName}()`;
    const obj = input;
    switch (toolName) {
        case "Read":
            return `Read(${obj.file_path ?? "?"})`;
        case "Glob":
            return `Glob(${obj.pattern ?? "?"}${obj.path ? `, ${obj.path}` : ""})`;
        case "Grep":
            return `Grep("${truncate(String(obj.pattern ?? ""), 60)}"${obj.path ? `, ${obj.path}` : ""})`;
        case "Bash":
            return `Bash(${truncate(String(obj.command ?? ""), 80)})`;
        case "LS":
            return `LS(${obj.path ?? "?"})`;
        case "WebSearch":
            return `WebSearch("${truncate(String(obj.query ?? ""), 60)}")`;
        case "WebFetch":
            return `WebFetch(${obj.url ?? "?"})`;
        default:
            return `${toolName}(${truncate(JSON.stringify(obj), 100)})`;
    }
}
function truncate(s, maxLen) {
    if (s.length <= maxLen)
        return s;
    return s.slice(0, maxLen) + "…";
}
