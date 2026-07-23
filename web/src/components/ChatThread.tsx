import {
  ThreadPrimitive,
  MessagePrimitive,
  ComposerPrimitive,
} from "@assistant-ui/react";
import { ArrowUp, Brain, Square } from "lucide-react";
import { Markdown } from "@/components/Markdown";
import { Button } from "@/components/ui/button";
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
  BashToolUI,
  EditToolUI,
  WriteToolUI,
  ReadToolUI,
  GenericToolUI,
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
    <ThreadPrimitive.Root className="flex h-full flex-col">
      <ThreadPrimitive.Viewport className="flex-1 overflow-y-auto">
        <ThreadPrimitive.Empty>
          <div className="flex h-full items-center justify-center p-8">
            <span className="text-sm text-muted-foreground/50 font-mono">
              $ 开始新的对话
            </span>
          </div>
        </ThreadPrimitive.Empty>

        <div className="mx-auto max-w-3xl px-3 py-4 md:px-4 md:py-6">
          <ThreadPrimitive.Messages
            components={{
              UserMessage: UserMessage,
              AssistantMessage: AssistantMessage,
            }}
          />
        </div>
      </ThreadPrimitive.Viewport>

      <ComposerPrimitive.Root className="sticky bottom-0 bg-gradient-to-t from-background via-background/95 to-transparent px-3 pt-8 pb-safe md:px-4">
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
    </ThreadPrimitive.Root>
  );
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="mb-4 flex justify-end md:mb-6">
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
    <MessagePrimitive.Root className="mb-4 flex gap-2 md:mb-6 md:gap-3">
      <div className="min-w-0 flex-1">
        <div className="inline-block max-w-full rounded-2xl rounded-bl-md bg-card px-3 py-2 text-foreground md:px-4 md:py-3">
          <MessagePrimitive.Parts
            components={{
              Text: ({ text }) =>
                text ? <Markdown>{text}</Markdown> : <RunningCursor />,
              tools: {
                by_name: {
                  Bash: BashToolUI as (p: ToolUIProps) => React.ReactElement,
                  Edit: EditToolUI as (p: ToolUIProps) => React.ReactElement,
                  Write: WriteToolUI as (p: ToolUIProps) => React.ReactElement,
                  Read: ReadToolUI as (p: ToolUIProps) => React.ReactElement,
                },
                Fallback:
                  GenericToolUI as (p: ToolUIProps) => React.ReactElement,
              },
            }}
          />
        </div>
      </div>
    </MessagePrimitive.Root>
  );
}

function RunningCursor() {
  return (
    <span className="ml-0.5 inline-block h-4 w-2.5 animate-pulse rounded-sm bg-accent align-middle" />
  );
}
