import {
  ThreadPrimitive,
  MessagePrimitive,
  ComposerPrimitive,
  useThreadViewport,
  useThreadViewportStore,
  useMessage,
  useComposerRuntime,
} from "@assistant-ui/react";
import { ArrowUp, Brain, ChevronDown, ChevronRight, Square, Copy, Check } from "lucide-react";
import { ThreadOutline, messageAnchorId } from "@/components/ThreadOutline";
import { Markdown } from "@/components/Markdown";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useEffect, useMemo, useRef, useState } from "react";
import { listProfiles } from "@/lib/api";
import type { EnvProfile } from "@/lib/types";
import { SlashCommandPopup } from "@/components/SlashCommandPopup";
import { ContextUsageRing } from "@/components/ContextUsageRing";
import {
  GenericToolUI,
  ReasoningBlock,
  MessageErrorBlock,
  type ToolUIProps,
} from "@/components/tools/ToolUIs";

/**
 * assistant-ui Primitive 搭 Tailwind 的 Thread。
 * 使用 shadcn/ui (Base UI) Button。
 */
interface ChatThreadProps {
  /** 当前会话的工作目录，用于获取项目特定的斜杠命令 */
  cwd: string | null;
  profileId: string | null;
  permissionMode: string;
  effortLevel: string;
  isRunning: boolean;
  /** 当前累计 input tokens（用于上下文占用指示器） */
  inputTokens?: number;
  onProfileChange: (id: string | null) => void;
  onPermissionModeChange: (mode: string) => void;
  onEffortLevelChange: (level: string) => void;
}

export function ChatThread({
  cwd,
  profileId,
  permissionMode,
  effortLevel,
  isRunning,
  inputTokens,
  onProfileChange,
  onPermissionModeChange,
  onEffortLevelChange,
}: ChatThreadProps) {
  const [profiles, setProfiles] = useState<EnvProfile[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    listProfiles()
      .then(setProfiles)
      .catch(() => setProfiles([]));
  }, []);

  /** 从当前 profile 的 AUTO_COMPACT_WINDOW 推导上下文上限，否则默认 200k */
  const contextMax = useMemo(() => {
    const profile = profiles.find((p) => p.id === profileId);
    const compactWindow = profile?.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
    if (compactWindow) {
      const n = parseInt(compactWindow, 10);
      if (!isNaN(n) && n > 0) return n;
    }
    return 200_000;
  }, [profileId, profiles]);

  // Base UI Select 需要 items prop 才能让 SelectValue 显示 label 而非原始值
  const profileItems: Record<string, string> = {
    "": "默认",
    ...Object.fromEntries(profiles.map((p) => [p.id, p.name])),
  };
  /** 取 profile 的简要描述信息 */
  function profileDesc(p: EnvProfile): string {
    const baseUrl = p.env.ANTHROPIC_BASE_URL || "默认 URL";
    return baseUrl;
  }
  function profileModel(p: EnvProfile): string {
    return p.env.ANTHROPIC_MODEL || p.env.ANTHROPIC_DEFAULT_OPUS_MODEL || "";
  }
  const permissionItems: Record<string, string> = {
    bypassPermissions: "完全访问",
    default: "标准模式",
    acceptEdits: "自动编辑",
    plan: "仅规划",
    dontAsk: "静默拒绝",
    auto: "自动判断",
  };
  const effortItems: Record<string, string> = {
    default: "默认",
    low: "低",
    medium: "中",
    high: "高",
    xhigh: "极高",
    max: "最高",
    disabled: "关闭",
  };

  return (
    <ThreadPrimitive.Root className="relative flex h-full flex-col">
      <ThreadPrimitive.Viewport className="flex-1 overflow-y-auto">
        <ThreadPrimitive.Empty>
          <EmptyState />
        </ThreadPrimitive.Empty>

        <div className="mx-auto max-w-3xl px-3 py-4 md:px-4 md:py-6">
          <ThreadPrimitive.Messages
            components={{
              UserMessage: UserMessage,
              AssistantMessage: AssistantMessage,
            }}
          />
        </div>

        {/* 滚动到底部按钮：sticky 在视口底部居中，仅在不在底部时渲染 */}
        <div className="pointer-events-none sticky bottom-0 flex justify-center pb-2">
          <ScrollToBottomButton />
        </div>
      </ThreadPrimitive.Viewport>

      <ComposerPrimitive.Root className="sticky bottom-0 bg-gradient-to-t from-background via-background/95 to-transparent px-3 pt-2 pb-safe md:px-4">
        <div className="mx-auto max-w-3xl">
          <div className="rounded-2xl border border-border/60 bg-card shadow-lg shadow-black/5 transition-all duration-200 focus-within:border-primary/50 focus-within:shadow-xl focus-within:shadow-black/10 focus-within:ring-2 focus-within:ring-primary/20 relative">
            <div className="flex items-end gap-1.5 px-2 py-1 md:gap-2 md:px-3 md:py-1.5">
              <ComposerPrimitive.Input
                ref={textareaRef}
                placeholder="输入消息… (Enter 发送 · Shift+Enter 换行 · / 命令)"
                submitMode="enter"
                className="max-h-40 flex-1 resize-none bg-transparent py-2 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none md:max-h-60 md:py-1.5"
              />
            </div>
            <SlashCommandPopup
              cwd={cwd}
              textareaRef={textareaRef}
            />
            <div className="flex items-center gap-1.5 px-3 py-1.5">
              <Select
                items={permissionItems}
                value={permissionMode}
                onValueChange={(v) => { if (v) onPermissionModeChange(v); }}
              >
                <SelectTrigger variant="ghost" className="h-7 w-auto min-w-[52px] text-[11px] text-muted-foreground">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="bypassPermissions">
                    <span className="flex flex-col">
                      <span>完全访问 · bypassPermissions</span>
                      <span className="text-[10px] text-muted-foreground">跳过所有权限检查，allowDangerouslySkipPermissions</span>
                    </span>
                  </SelectItem>
                  <SelectItem value="default">
                    <span className="flex flex-col">
                      <span>标准模式 · default</span>
                      <span className="text-[10px] text-muted-foreground">危险操作弹窗确认</span>
                    </span>
                  </SelectItem>
                  <SelectItem value="acceptEdits">
                    <span className="flex flex-col">
                      <span>自动编辑 · acceptEdits</span>
                      <span className="text-[10px] text-muted-foreground">文件编辑自动放行，其余弹窗确认</span>
                    </span>
                  </SelectItem>
                <SelectItem value="plan">
                  <span className="flex flex-col">
                    <span>仅规划 · plan</span>
                    <span className="text-[10px] text-muted-foreground">只读模式，不执行任何工具</span>
                  </span>
                </SelectItem>
                <SelectItem value="dontAsk">
                  <span className="flex flex-col">
                    <span>静默拒绝 · dontAsk</span>
                    <span className="text-[10px] text-muted-foreground">不弹窗，未预授权则直接拒绝</span>
                  </span>
                </SelectItem>
                <SelectItem value="auto">
                  <span className="flex flex-col">
                    <span>自动判断 · auto</span>
                    <span className="text-[10px] text-muted-foreground">模型自动判断批准或拒绝</span>
                  </span>
                </SelectItem>
              </SelectContent>
            </Select>
            {isRunning && (
              <span className="text-[10px] text-muted-foreground/70 whitespace-nowrap">
                模式下次消息生效
              </span>
            )}
            <div className="flex-1" />
            {inputTokens !== undefined && inputTokens > 0 && (
              <ContextUsageRing used={inputTokens} max={contextMax} />
            )}
            <Select
              items={profileItems}
              value={profileId ?? ""}
              onValueChange={(v) => onProfileChange(v || null)}
            >
              <SelectTrigger variant="ghost" className="h-7 w-auto min-w-[52px] text-[11px] text-muted-foreground">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">
                  <span className="flex flex-col">
                    <span>默认</span>
                    <span className="text-[10px] text-muted-foreground">使用 CLI 默认环境变量</span>
                  </span>
                </SelectItem>
                {profiles.map((p) => {
                    const model = profileModel(p);
                    return (
                  <SelectItem key={p.id} value={p.id}>
                    <span className="flex flex-col">
                      <span>{p.name}{model ? <span className="text-muted-foreground"> · {model}</span> : null}</span>
                      <span className="text-[10px] text-muted-foreground">{profileDesc(p)}</span>
                    </span>
                  </SelectItem>
                    );
                  })}
              </SelectContent>
            </Select>
              <Select
                items={effortItems}
                value={effortLevel}
                onValueChange={(v) => { if (v) onEffortLevelChange(v); }}
              >
                <SelectTrigger variant="ghost" className="h-7 w-auto min-w-[52px] text-[11px] text-muted-foreground">
                  <Brain className="mr-1 h-3 w-3 shrink-0 text-muted-foreground" />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">
                    <span className="flex flex-col">
                      <span>默认 · default</span>
                      <span className="text-[10px] text-muted-foreground">使用 Profile 环境变量配置的思考深度</span>
                    </span>
                  </SelectItem>
                  <SelectItem value="low">
                    <span className="flex flex-col">
                      <span>低 · low</span>
                      <span className="text-[10px] text-muted-foreground">最少思考，最快响应</span>
                    </span>
                  </SelectItem>
                  <SelectItem value="medium">
                    <span className="flex flex-col">
                      <span>中 · medium</span>
                      <span className="text-[10px] text-muted-foreground">适度思考</span>
                    </span>
                  </SelectItem>
                  <SelectItem value="high">
                    <span className="flex flex-col">
                      <span>高 · high</span>
                      <span className="text-[10px] text-muted-foreground">深度推理</span>
                    </span>
                  </SelectItem>
                  <SelectItem value="xhigh">
                    <span className="flex flex-col">
                      <span>极高 · xhigh</span>
                      <span className="text-[10px] text-muted-foreground">更深层推理</span>
                    </span>
                  </SelectItem>
                  <SelectItem value="max">
                    <span className="flex flex-col">
                      <span>最高 · max</span>
                      <span className="text-[10px] text-muted-foreground">最大思考深度（需模型支持）</span>
                    </span>
                  </SelectItem>
                  <SelectItem value="disabled">
                    <span className="flex flex-col">
                      <span>关闭 · disabled</span>
                      <span className="text-[10px] text-muted-foreground">关闭扩展思考 · thinking: disabled</span>
                    </span>
                  </SelectItem>
                </SelectContent>
              </Select>
              {isRunning ? (
                <ComposerPrimitive.Cancel
                  render={
                    <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0 rounded-md text-muted-foreground/60 hover:text-foreground" aria-label="停止生成">
                      <Square className="size-3.5" />
                    </Button>
                  }
                />
              ) : (
                <ComposerPrimitive.Send
                  render={
                    <Button size="icon" className="h-7 w-7 shrink-0 rounded-md" aria-label="发送消息">
                      <ArrowUp className="size-3.5" />
                    </Button>
                  }
                />
              )}
          </div>
          </div>
        </div>
      </ComposerPrimitive.Root>

      {/* 对话大纲：常驻左侧浮层，hover 显隐 */}
      <ThreadOutline />
    </ThreadPrimitive.Root>
  );
}

function UserMessage() {
  const msgId = useMessage((s) => s.id);
  return (
    <MessagePrimitive.Root
      id={messageAnchorId(msgId)}
      className="group/msg mb-4 flex justify-end gap-1 md:mb-6"
    >
      <div className="min-w-0">
        <div className="inline-block max-w-full rounded-2xl rounded-br-md bg-accent px-3 py-2 text-left text-white md:px-4 md:py-2.5">
          <MessagePrimitive.Parts
            components={{
              Text: ({ text }) => (
                <div className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                  {text}
                </div>
              ),
            }}
          />
        </div>
      </div>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="group/msg relative mb-4 flex gap-2 md:mb-6 md:gap-3">
      <div className="min-w-0 flex-1">
        <div className="inline-block max-w-full rounded-2xl rounded-bl-md bg-card px-3 py-2 text-foreground md:px-4 md:py-3">
          <AssistantContent />
        </div>
      </div>
      <AssistantActionBar />
    </MessagePrimitive.Root>
  );
}

/**
 * assistant 消息正文：用 GroupedParts 把连续的 reasoning + tool-call
 * 包成"思维链"折叠块，运行中展开、结束后收起，最终只露文本回答。
 */
function AssistantContent() {
  const status = useMessage((s) => s.status);
  const content = useMessage((s) => s.content);
  const isRunning = status?.type === "running";

  // 把 parts 分成"正文（text）"和"工作过程（reasoning + tool-call）"两类。
  // 无论中间是否被 text 隔断，所有 reasoning/tool-call 都合并成
  // 一个"工作过程"折叠块，正文文本单独渲染。
  const parts = (content as readonly AnyPart[] | undefined) ?? [];
  const textParts = parts.filter((p) => p.type === "text");
  const workParts = parts.filter(
    (p) => p.type === "reasoning" || p.type === "tool-call",
  );
  const hasText = textParts.some(
    (p) => typeof p.text === "string" && p.text.trim(),
  );
  const hasWork = workParts.length > 0;

  return (
    <>
      {hasWork && (
        <WorkProcessGroup parts={workParts} isRunning={isRunning} />
      )}
      {hasText ? (
        <div className={hasWork ? "mt-2" : ""}>
          <Markdown>
            {textParts.map((p) => (p.text ?? "")).join("")}
          </Markdown>
        </div>
      ) : isRunning && !hasWork ? (
        <RunningCursor />
      ) : null}
    </>
  );
}

/**
 * 工作过程折叠块：把一轮里所有 reasoning + tool-call 合并为一个可折叠组。
 * - 运行中默认展开，对话结束（running→complete）自动收起
 * - 历史消息（初始非 running）默认折叠
 * - 用户手动展开/折叠后不再被自动行为覆盖
 */
function WorkProcessGroup({
  parts,
  isRunning,
}: {
  parts: readonly AnyPart[];
  isRunning: boolean;
}) {
  const [open, setOpen] = useState(isRunning);
  // 运行中→结束时自动折叠一次（用户手动展开过的不再覆盖）
  const wasRunningRef = useRef(isRunning);
  useEffect(() => {
    if (wasRunningRef.current && !isRunning) {
      setOpen(false);
    }
    wasRunningRef.current = isRunning;
  }, [isRunning]);
  const toolCount = parts.filter((p) => p.type === "tool-call").length;

  return (
    <div className="text-sm">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        {open ? (
          <ChevronDown className="size-3" />
        ) : (
          <ChevronRight className="size-3" />
        )}
        <span className="font-medium">工作过程</span>
        {toolCount > 0 && (
          <span className="text-muted-foreground/60">{toolCount} 个工具</span>
        )}
        {isRunning && (
          <span className="ml-0.5 inline-block size-1.5 animate-pulse rounded-full bg-amber-400" />
        )}
      </button>
      {open && (
        <div className="mt-1 space-y-0.5 border-l border-border/40 pl-3">
          {parts.map((p, i) => {
            if (p.type === "reasoning") {
              return (
                <ReasoningBlock
                  key={i}
                  text={typeof p.text === "string" ? p.text : undefined}
                  isStreaming={isRunning}
                />
              );
            }
            if (p.type === "tool-call") {
              return <GenericToolUI key={i} {...mapToolPart(p)} />;
            }
            return null;
          })}
        </div>
      )}
    </div>
  );
}

/** 把 part 的 tool-call 映射成 ToolUIProps */
function mapToolPart(part: AnyPart): ToolUIProps {
  const st = (part as { status?: { type?: string } }).status;
  return {
    toolName: (part.toolName as string) ?? "",
    args: part.args,
    argsText: typeof part.argsText === "string" ? part.argsText : undefined,
    result: part.result,
    isError: typeof part.isError === "boolean" ? part.isError : undefined,
    status: {
      type:
        st?.type === "running"
          ? "running"
          : st?.type === "complete"
            ? "complete"
            : st?.type === "incomplete"
              ? "incomplete"
              : "requires-action",
    },
  };
}

type AnyPart = { type: string; [k: string]: unknown };

/**
 * assistant 消息错误块：消息进入 incomplete/error 状态时显示。
 */
function AssistantErrorIfAny() {
  const status = useMessage((s) => s.status);
  if (status?.type !== "incomplete" || status.reason !== "error") return null;
  const errMsg = typeof status.error === "string" ? status.error : undefined;
  return <MessageErrorBlock message={errMsg} />;
}

/**
 * assistant 消息操作：错误块 + 复制按钮。
 * 复制按钮绝对定位浮在气泡外，hover 消息时淡入，不占文档流（避免布局抖动）。
 * 仅当消息有文本内容时才渲染（工作过程组无文本回答时不显示）。
 */
function AssistantActionBar() {
  return (
    <>
      <AssistantErrorIfAny />
      <CopyButton />
    </>
  );
}

/** 复制按钮：提取消息文本，用 navigator.clipboard 复制，2s 内显示对勾 */
function CopyButton() {
  const [copied, setCopied] = useState(false);
  const text = useMessage((s) =>
    (s.content as readonly { type: string; text?: string }[] | undefined)
      ?.filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
      .join("") ?? "",
  );
  // 没有文本内容（纯工作过程组）时不渲染复制按钮
  if (!text.trim()) return null;

  const handleCopy = () => {
    void navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      (err) =>
        console.warn(
          "[copy] clipboard write failed:",
          err instanceof Error ? err.message : err,
        ),
    );
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="absolute -bottom-2.5 left-2 flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground opacity-0 transition-opacity duration-150 hover:bg-muted/60 hover:text-foreground group-hover/msg:opacity-100 md:left-3"
    >
      {copied ? (
        <>
          <Check className="size-3 text-emerald-400" /> 已复制
        </>
      ) : (
        <>
          <Copy className="size-3" /> 复制
        </>
      )}
    </button>
  );
}

function RunningCursor() {
  return (
    <span className="ml-0.5 inline-block h-4 w-2.5 animate-pulse rounded-sm bg-accent align-middle" />
  );
}

/**
 * 空状态：提示语 + 建议词。点击建议词把文本填入 composer（不自动发送，
 * 让用户可调整后再按 Enter）。
 */
function EmptyState() {
  const composer = useComposerRuntime();
  const suggestions = [
    "解释这个项目的结构",
    "帮我修复一个 bug",
    "重构这段代码",
    "给这个文件写测试",
  ];
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-8">
      <span className="font-mono text-sm text-muted-foreground/50">
        $ 开始新的对话
      </span>
      <div className="flex max-w-md flex-wrap items-center justify-center gap-2">
        {suggestions.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => composer?.setText(s)}
            className="rounded-full border border-border/60 bg-card/60 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:bg-card hover:text-foreground"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * 滚动到底部按钮。
 * 始终挂载，仅切换可见性（opacity + pointer-events），避免卸载/挂载
 * 改变滚动区域高度导致的内容跳动。底部时通过 opacity-0 完全透明且不可点击。
 */
function ScrollToBottomButton() {
  const isAtBottom = useThreadViewport((s) => s.isAtBottom);
  const viewportStore = useThreadViewportStore();
  return (
    <Button
      variant="outline"
      size="icon"
      onClick={() => viewportStore.getState().scrollToBottom({ behavior: "instant" })}
      aria-hidden={isAtBottom}
      tabIndex={isAtBottom ? -1 : 0}
      className={cn(
        "pointer-events-auto h-8 w-8 rounded-full border-border/60 bg-card/95 shadow-md shadow-black/10 backdrop-blur transition-opacity duration-150 hover:bg-card",
        isAtBottom ? "pointer-events-none opacity-0" : "opacity-100",
      )}
      aria-label="滚动到底部"
    >
      <ChevronDown className="size-4" />
    </Button>
  );
}
