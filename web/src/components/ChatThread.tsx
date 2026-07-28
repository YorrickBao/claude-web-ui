import {
  ThreadPrimitive,
  MessagePrimitive,
  ComposerPrimitive,
  ActionBarPrimitive,
  useMessage,
  useThread,
  useComposerRuntime,
  unstable_useComposerInputHistory,
  groupPartByType,
} from "@assistant-ui/react";
import { ArrowUp, Brain, ChevronDown, ChevronRight, Square, Copy, Check, ShieldCheck, UserCog, GitFork } from "lucide-react";
import { ThreadOutline, messageAnchorId } from "@/components/ThreadOutline";
import { Markdown } from "@/components/Markdown";
import { Button } from "@/components/ui/button";
import { cn, formatDuration } from "@/lib/utils";



import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useProfiles } from "@/lib/profilesStore";
import type { EnvProfile } from "@/lib/types";
import { SlashCommandPopup } from "@/components/SlashCommandPopup";
import { ContextUsageRing } from "@/components/ContextUsageRing";
import {
  ToolRenderer,
  ReasoningBlock,
  MessageErrorBlock,
  type ToolUIProps,
} from "@/components/tools/ToolUIs";

/**
 * assistant-ui Primitive 搭 Tailwind 的 Thread。
 * 使用 shadcn/ui (Base UI) Button。
 */

/**
 * 模块级"从此处分叉"回调槽。
 *
 * assistant-ui 的 <ThreadPrimitive.Messages components={{AssistantMessage}}>
 * 不支持给 message 组件透传自定义 props，但 AssistantMessage 是本模块
 * 顶层函数。ChatView 渲染 ChatThread 时把回调塞进这个 ref，
 * AssistantActionBar 读它（并从 metadata.custom.assistantUuid 取本条消息
 * 的 transcript uuid）来触发 forkSession。
 */
const forkFromMessageRef: { current: ((upToMessageId: string) => void) | null } = {
  current: null,
};

/**
 * 当前轮次计时上下文。
 *
 * 走字计时器（isRunning 期间每 100ms 更新）独立放在 TurnTimerProvider 的
 * state 里：它的 100ms 抖动只会触发 Provider 自身与"本轮耗时"标签重渲，
 * 不会向上冒泡到 ChatView、更不会重渲整条消息流（children 元素引用稳定，
 * React 会跳过）。ChatView 因此完全不需要随计时器重渲。
 */
const TurnTimerContext = createContext<{
  isRunning: boolean;
  runningElapsedMs: number;
  lastDurationMs: number | undefined;
}>({ isRunning: false, runningElapsedMs: 0, lastDurationMs: undefined });

const useTurnTimer = () => useContext(TurnTimerContext);

export function TurnTimerProvider({
  isRunning,
  startedAt,
  lastDurationMs,
  children,
}: {
  isRunning: boolean;
  /** 当前进行中轮次的起点（ms）；优先用后端的 currentTurnStartedAt，刷新后能接着走 */
  startedAt?: number;
  /** 最近一轮的最终耗时（ms）；运行中作为 done 后的定值展示 */
  lastDurationMs?: number;
  children: ReactNode;
}) {
  // 后端起点用 ref 收纳、不进 effect 依赖：它是"轮次起点"（生命周期信号），
  // sessions_changed 在权限往返时会刷新 meta，若进依赖会反复重建 interval 丢精度。
  const startedAtRef = useRef(startedAt ?? 0);
  startedAtRef.current = startedAt ?? 0;
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!isRunning) {
      setElapsed(0);
      return;
    }
    // relay 远程访问时浏览器与服务器时钟可能不一致，用 Math.min 兜底，
    // 后端起点晚于本地现在时退回本地时刻，避免算出负数。
    const now = Date.now();
    const start = Math.min(startedAtRef.current > 0 ? startedAtRef.current : now, now);
    setElapsed(now - start);
    const id = setInterval(() => setElapsed(Date.now() - start), 100);
    return () => clearInterval(id);
  }, [isRunning]);
  const value = useMemo(
    () => ({ isRunning, runningElapsedMs: elapsed, lastDurationMs }),
    [isRunning, elapsed, lastDurationMs],
  );
  return <TurnTimerContext.Provider value={value}>{children}</TurnTimerContext.Provider>;
}
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
  /** "从此处分叉"回调：把本条 assistant 消息的 transcript uuid 作为 upToMessageId */
  onForkFromMessage?: (upToMessageId: string) => void;
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
  onForkFromMessage,
}: ChatThreadProps) {
  // profile 列表来自全局 store：应用启动即预取，与会话 meta fetch 并行，
  // 避免刷新时 Select 因映射表缺键而闪现原始 UUID。
  const { profiles, loaded: profilesLoaded } = useProfiles();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 终端式输入历史：空输入框按 ↑ 回填上一条 user 消息，↓ 反向。
  // 仅在输入框为空时触发，与斜杠命令弹窗（需以 / 开头才打开）条件互斥，不冲突。
  const inputHistory = unstable_useComposerInputHistory();

  // 把"分叉"回调同步到模块级槽，供 AssistantActionBar（顶层函数）读取。
  // 用 effect 而非 render 期赋值，避免在渲染中途改动可变 ref。
  useEffect(() => {
    forkFromMessageRef.current = onForkFromMessage ?? null;
    return () => {
      forkFromMessageRef.current = null;
    };
  }, [onForkFromMessage]);

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

        <div className="px-4 py-4 md:px-8 md:py-6">
          <ThreadPrimitive.Messages
            components={{
              UserMessage: UserMessage,
              AssistantMessage: AssistantMessage,
            }}
          />
        </div>

        {/* 滚动到底部按钮：sticky 在视口底部居中，到底部时 primitive 自动 disabled */}
        <div className="pointer-events-none sticky bottom-0 flex justify-center pb-2">
          <ThreadPrimitive.ScrollToBottom
            aria-label="滚动到底部"
            className="pointer-events-auto flex h-8 w-8 items-center justify-center rounded-full border border-border/60 bg-card/95 shadow-md shadow-black/10 backdrop-blur transition-opacity duration-150 hover:bg-card disabled:pointer-events-none disabled:opacity-0"
          >
            <ChevronDown className="size-4" />
          </ThreadPrimitive.ScrollToBottom>
        </div>
      </ThreadPrimitive.Viewport>

      <ComposerPrimitive.Root className="sticky bottom-0 bg-gradient-to-t from-background via-background/95 to-transparent px-4 pt-2 pb-safe md:px-8">
        <div>
          <div className="rounded-2xl border border-border/60 bg-card shadow-lg shadow-black/5 transition-all duration-200 focus-within:border-primary/50 focus-within:shadow-xl focus-within:shadow-black/10 focus-within:ring-2 focus-within:ring-primary/20 relative">
            <div className="flex items-end gap-1.5 px-2 py-1 md:gap-2 md:px-3 md:py-1.5">
              <ComposerPrimitive.Input
                ref={textareaRef}
                {...inputHistory}
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
                <SelectTrigger variant="ghost" className="h-7 w-auto min-w-0 justify-center gap-1 px-1.5 text-[11px] text-muted-foreground md:min-w-[52px] md:justify-between md:gap-1.5 md:pl-2.5 md:pr-2">
                  <ShieldCheck className="h-3 w-3 shrink-0 text-muted-foreground md:hidden" />
                  <SelectValue className="hidden md:flex" />
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
            <div className="flex-1" />
            {inputTokens !== undefined && inputTokens > 0 && (
              <ContextUsageRing used={inputTokens} max={contextMax} />
            )}
            <Select
              items={profileItems}
              // profiles 未加载完、或当前 profileId 不在列表中时，传 ""（命中"默认"占位），
              // 避免 SelectValue 因 items 表缺键而 fallback 渲染原始 UUID。
              value={
                profileId && profilesLoaded && profileItems[profileId]
                  ? profileId
                  : ""
              }
              onValueChange={(v) => onProfileChange(v || null)}
            >
              <SelectTrigger variant="ghost" className="h-7 w-auto min-w-0 justify-center gap-1 px-1.5 text-[11px] text-muted-foreground md:min-w-[52px] md:justify-between md:gap-1.5 md:pl-2.5 md:pr-2">
                <UserCog className="h-3 w-3 shrink-0 text-muted-foreground md:hidden" />
                <SelectValue className="hidden md:flex" />
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
                <SelectTrigger variant="ghost" className="h-7 w-auto min-w-0 justify-center gap-1 px-1.5 text-[11px] text-muted-foreground md:min-w-[52px] md:justify-between md:gap-1.5 md:pl-2.5 md:pr-2">
                  <Brain className="h-3 w-3 shrink-0 text-muted-foreground" />
                  <SelectValue className="hidden md:flex" />
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
  const content = useMessage((s) => s.content);
  // 当前轮次的耗时只挂在"最后一条 user 消息"下方；非最后一条不显示
  const isLastUserMessage = useThread((s) => {
    for (let i = s.messages.length - 1; i >= 0; i--) {
      if (s.messages[i].role === "user") return s.messages[i].id === msgId;
    }
    return false;
  });
  // SDK 在用户中断查询时，会向转录写入一条 "[Request interrupted by user]"
  // 的 user 消息——它不是用户真实输入，渲染成跨栏事件条而非蓝色气泡
  const text = (content as readonly { type: string; text?: string }[] | undefined)
    ?.filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("") ?? "";
  if (isInterruptText(text)) {
    return <InterruptEventBar id={messageAnchorId(msgId)} />;
  }
  return (
    <MessagePrimitive.Root
      id={messageAnchorId(msgId)}
      className="group/msg mb-4 flex flex-col md:mb-6"
    >
      <div className="flex min-w-0 justify-end">
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
      {isLastUserMessage && <TurnDuration />}
    </MessagePrimitive.Root>
  );
}

/**
 * 最后一条 user 消息下方的"本轮耗时"标签，左对齐。
 * 运行中显示走字计时（脉冲点），结束后显示 SDK 上报的定值。
 * 只有它会订阅 TurnTimerContext，因此 100ms 抖动只重渲这一个标签。
 */
function TurnDuration() {
  const { isRunning, runningElapsedMs, lastDurationMs } = useTurnTimer();
  const ms = isRunning ? runningElapsedMs : lastDurationMs;
  if (!ms || ms <= 0) return null;
  return (
    <div
      className="mt-1 flex items-center gap-1.5 self-start pl-0.5 text-[11px] text-muted-foreground/70"
      title={isRunning ? "当前轮次进行中" : "本轮总耗时"}
    >
      <span className={cn("size-1.5 shrink-0 rounded-full bg-current", isRunning && "animate-pulse")} />
      <span className="font-mono tabular-nums">{formatDuration(ms)}</span>
    </div>
  );
}

/**
 * 检测一条 user 消息文本是否是 SDK 写入的中断标记（非用户真实输入）。
 * 宽松匹配 "[Request interrupted ...]"，兼容 "by user for tool use" 等变体。
 */
function isInterruptText(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return /^\[Request interrupted\b/i.test(t) && t.endsWith("]");
}

/**
 * 中断事件条：用居中、细线分隔的低调形态呈现"回答已中断"，
 * 明确表达这是一个对话事件而非用户发言。
 */
function InterruptEventBar({ id }: { id: string }) {
  return (
    <div
      id={id}
      role="note"
      className="my-2 flex items-center gap-3 md:my-3"
    >
      <span className="h-px flex-1 bg-border/50" />
      <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground/70">
        <Square className="size-2.5 fill-current" />
        回答已中断
      </span>
      <span className="h-px flex-1 bg-border/50" />
    </div>
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
 * assistant 消息正文：用 assistant-ui 的 GroupedParts 做分组渲染。
 *
 * 分组策略（chain-of-thought 范式）：相邻的 reasoning 与 tool-call 共享
 * 外层 group-work，被合并成一个可折叠「工作段」；text 不进任何 group，
 * 作为常显叙述正文直接渲染。与原手写 segmentParts 等价，但分组逻辑下沉
 * 给库（相邻同前缀自动 coalesce），渲染层只负责 switch 分发。
 *
 * - group-work：外层工作段容器（WorkGroup），消费 children 做折叠
 * - group-tool / group-reasoning：内层容器，仅做间距
 * - text 叶子：Markdown 渲染；空文本 + running 时用光标占位
 * - reasoning 叶子：ReasoningBlock（自身已可折叠，故外层不再双层折叠）
 * - tool-call 叶子：绕开 part.toolUI（项目未注册 registry），直接调 ToolRenderer
 * - indicator：流式尾部 loading 位（末尾非 text/reasoning 时由库自动注入）
 */
function AssistantContent() {
  return (
    <MessagePrimitive.GroupedParts groupBy={GROUP_BY} indicator="no-text">
      {({ part, children }) => {
        switch (part.type) {
          case "group-work":
            return (
              <WorkGroup status={part.status} indices={part.indices}>
                {children}
              </WorkGroup>
            );
          case "group-tool":
            return <div className="space-y-0.5">{children}</div>;
          case "group-reasoning":
            return <div className="space-y-0.5">{children}</div>;
          case "text":
            return <TextLeaf part={part} />;
          case "reasoning":
            return <ReasoningLeaf part={part} />;
          case "tool-call":
            return <ToolRenderer {...mapPartToToolUI(part)} />;
          case "indicator":
            return <RunningCursor />;
          default:
            return null;
        }
      }}
    </MessagePrimitive.GroupedParts>
  );
}

/**
 * 分组配置：reasoning 与 tool-call 都收进 group-work，内层再按类型细分。
 * 用 groupPartByType 构造，自带 memo 指纹，即便每次 render 重建也不破坏树。
 */
const GROUP_BY = groupPartByType({
  reasoning: ["group-work", "group-reasoning"],
  "tool-call": ["group-work", "group-tool"],
});

/** text 叶子：空文本 + running 时用光标占位，否则 Markdown 渲染。 */
function TextLeaf({
  part,
}: {
  part: { type: "text"; text: string; status?: { type: string } };
}) {
  const isRunning = part.status?.type === "running";
  const isEmpty = !part.text.trim();
  if (isEmpty) {
    return isRunning ? <RunningCursor /> : null;
  }
  return <Markdown streaming={isRunning}>{part.text}</Markdown>;
}

/** reasoning 叶子：ReasoningBlock，streaming 态由 part.status 推导。 */
function ReasoningLeaf({
  part,
}: {
  part: { type: "reasoning"; text: string; status?: { type: string } };
}) {
  const isRunning = part.status?.type === "running";
  return (
    <ReasoningBlock
      text={typeof part.text === "string" ? part.text : undefined}
      isStreaming={isRunning}
    />
  );
}

/**
 * 工作段：把一段连续的 reasoning + tool-call 包成可折叠组（替代原 WorkStepGroup）。
 *
 * 设计：分组与叶子渲染交给 GroupedParts（children 已是递归渲染好的子树），
 * 本组件只负责折叠壳——有工具时折叠展开、纯思考段不折叠直接透传 children。
 *
 * - isActive 读 GroupPart 的 status（库镜像组内最后一个 part 的状态），
 *   不再依赖「父消息 running + 本段是最后一段」的全局判断。
 * - 工具名 label 从 useMessage(content) 按 indices 切片收集。
 * - 纯思考段（indices 里无 tool-call）直接返回 children，避免与
 *   ReasoningBlock 自身折叠重复嵌套。
 */
function WorkGroup({
  status,
  indices,
  children,
}: {
  status: { type: string };
  indices: readonly number[];
  children: ReactNode;
}) {
  const content = useMessage((s) => s.content) as readonly AnyPart[] | undefined;
  const isActive = status.type === "running";

  // 按 indices 从消息 content 切出本组覆盖的 parts，收集工具名做 label
  const partsInGroup = (indices ?? []).map((idx) => content?.[idx]).filter(Boolean) as AnyPart[];
  const hasTool = partsInGroup.some((p) => p.type === "tool-call");
  const toolNames = Array.from(
    new Set(
      partsInGroup
        .filter((p) => p.type === "tool-call")
        .map((p) => (p.toolName as string) ?? "")
        .filter(Boolean),
    ),
  );
  const label = toolNames.length > 0 ? toolNames.join(" · ") : "思考过程";

  const [open, setOpen] = useState(isActive);
  const wasActiveRef = useRef(isActive);
  useEffect(() => {
    // 从「活跃」变为「不活跃」（回合结束 / 后面追加了新段）自动收起一次
    if (wasActiveRef.current && !isActive) setOpen(false);
    wasActiveRef.current = isActive;
  }, [isActive]);

  // 纯思考段（无工具）：不包折叠壳，直接透传 children（ReasoningBlock 自身已可折叠）
  if (!hasTool) {
    return <div className="space-y-0.5">{children}</div>;
  }

  return (
    <div className="text-sm">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        {open ? (
          <ChevronDown className="size-3" />
        ) : (
          <ChevronRight className="size-3" />
        )}
        <span className="font-mono">{label}</span>
        {isActive && (
          <span className="ml-0.5 inline-block size-1.5 animate-pulse rounded-full bg-amber-400" />
        )}
      </button>
      {open && (
        <div className="mt-1 space-y-0.5 border-l border-border/40 pl-3">
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * 把 tool-call part 映射成 ToolUIProps。
 * leaf part 自带 status，直接读 part.status 推导 running/completed；
 * result 是否已回填决定 complete vs running。
 */
function mapPartToToolUI(part: AnyPart): ToolUIProps {
  const result = (part as { result?: unknown }).result;
  const hasResult = result !== undefined;
  const partStatus = (part as { status?: { type?: string } }).status;
  const isRunning = partStatus?.type === "running";
  return {
    toolName: (part.toolName as string) ?? "",
    args: part.args,
    argsText: typeof part.argsText === "string" ? part.argsText : undefined,
    result,
    isError: typeof part.isError === "boolean" ? part.isError : undefined,
    status: hasResult ? "complete" : isRunning ? "running" : "incomplete",
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
 * assistant 消息操作：错误块 + 操作按钮组（复制 / 分叉）。
 * 用 ActionBarPrimitive.Root 承担定位 + 显隐：
 *  - autohide="always"：默认隐藏，hover 消息时挂载显示（由 isHovering 驱动 mount/unmount）
 * 不加 hideWhenRunning：复制/分叉在生成过程中也应可用（SDK 无此限制）。
 * 正在生成的那条消息自然不显示按钮——无文本则复制守卫挡住，无 assistantUuid 则分叉守卫挡住。
 */
function AssistantActionBar() {
  return (
    <>
      <AssistantErrorIfAny />
      <ActionBarPrimitive.Root
        autohide="always"
        className="absolute -bottom-2.5 left-2 flex items-center gap-1 md:left-3"
      >
        <CopyAction />
        <ForkFromHereButton />
      </ActionBarPrimitive.Root>
    </>
  );
}

/**
 * 复制按钮：用 ActionBarPrimitive.Copy（自带 copied 状态，通过 data-copied 暴露）。
 * 仅当消息有文本内容时渲染（纯工作过程组不显示）。
 * 按钮自身声明为 group/copy，children 用 group-data-[copied=true]/copy: 切换图标。
 */
function CopyAction() {
  const hasText = useMessage((s) => {
    const content = s.content as readonly { type: string; text?: string }[] | undefined;
    return content?.some((p) => p.type === "text" && (p.text ?? "").trim()) ?? false;
  });
  if (!hasText) return null;
  return (
    <ActionBarPrimitive.Copy
      copiedDuration={2000}
      title="复制回答"
      className="group/copy flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground data-[copied=true]:text-emerald-400"
    >
      <Copy className="size-3 group-data-[copied=true]/copy:hidden" />
      <Check className="hidden size-3 text-emerald-400 group-data-[copied=true]/copy:block" />
      <span className="group-data-[copied=true]/copy:hidden">复制</span>
      <span className="hidden text-emerald-400 group-data-[copied=true]/copy:inline">已复制</span>
    </ActionBarPrimitive.Copy>
  );
}

/**
 * "分叉"按钮：仅当本条 assistant 消息带 metadata.custom.assistantUuid
 * （即本回合已结束、有最终答案）且外部注入了 forkFromMessageRef 回调时渲染。
 *
 * 运行中（thread 级 isRunning）时显示为 disabled 态：后端 forkSession 在会话
 * 运行中返回 409（SDK 转录层约束），UI 提前禁用避免点击无反应的困惑。
 */
function ForkFromHereButton() {
  const assistantUuid = useMessage(
    (s) =>
      (s as { metadata?: { custom?: { assistantUuid?: string } } })
        .metadata?.custom?.assistantUuid,
  );
  const isThreadRunning = useThread((s) => s.isRunning);
  const handle = forkFromMessageRef.current;
  // 无 uuid 或未注入回调时不渲染
  if (!assistantUuid || !handle) return null;

  return (
    <button
      type="button"
      title={isThreadRunning ? "会话运行中，结束后再分叉" : "分叉：复制到该回答为止的历史，原会话不变"}
      disabled={isThreadRunning}
      onClick={() => handle(assistantUuid)}
      className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
    >
      <GitFork className="size-3" /> 分叉
    </button>
  );
}

function RunningCursor() {
  return (
    <span className="ml-0.5 inline-block h-4 w-2.5 animate-cursor-blink rounded-sm bg-accent align-middle" />
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

