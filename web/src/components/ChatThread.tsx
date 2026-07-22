import {
  ThreadPrimitive,
  MessagePrimitive,
  ComposerPrimitive,
} from "@assistant-ui/react";
import { ArrowUp, Square } from "lucide-react";
import { Markdown } from "@/components/Markdown";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useEffect, useState } from "react";
import { listProfiles } from "@/lib/api";
import type { EnvProfile } from "@/lib/types";
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
  profileId: string | null;
  permissionMode: string;
  onProfileChange: (id: string | null) => void;
  onPermissionModeChange: (mode: string) => void;
}

export function ChatThread({
  profileId,
  permissionMode,
  onProfileChange,
  onPermissionModeChange,
}: ChatThreadProps) {
  const [profiles, setProfiles] = useState<EnvProfile[]>([]);

  useEffect(() => {
    listProfiles()
      .then(setProfiles)
      .catch(() => setProfiles([]));
  }, []);

  // Base UI Select 需要 items prop 才能让 SelectValue 显示 label 而非原始值
  const profileItems: Record<string, string> = {
    "": "默认",
    ...Object.fromEntries(profiles.map((p) => [p.id, p.name])),
  };
  const permissionItems: Record<string, string> = {
    bypassPermissions: "完全访问",
    default: "标准模式",
    acceptEdits: "自动编辑",
    plan: "仅规划",
    dontAsk: "静默拒绝",
    auto: "自动判断",
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

        <div className="mx-auto max-w-3xl px-2 py-4 md:px-4 md:py-6">
          <ThreadPrimitive.Messages
            components={{
              UserMessage: UserMessage,
              AssistantMessage: AssistantMessage,
            }}
          />
        </div>
      </ThreadPrimitive.Viewport>

      <ComposerPrimitive.Root className="sticky bottom-0 bg-gradient-to-t from-background via-background/95 to-transparent px-2 pb-4 pt-8 md:px-4 pb-safe">
        <div className="mx-auto max-w-3xl">
          <div className="flex items-end gap-1.5 rounded-2xl border border-border/60 bg-card px-2 py-1 shadow-lg shadow-black/5 transition-all duration-200 focus-within:border-accent/50 focus-within:shadow-xl focus-within:shadow-black/10 focus-within:ring-2 focus-within:ring-accent/20 md:gap-2 md:px-3 md:py-1.5">
            <ComposerPrimitive.Input
              placeholder="输入消息…"
              submitMode="enter"
              className="max-h-40 flex-1 resize-none bg-transparent py-2 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none md:max-h-60 md:py-1.5"
            />
            <ComposerPrimitive.Cancel
              render={
                <Button variant="ghost" size="icon" className="h-10 w-10 shrink-0 rounded-lg text-muted-foreground/60 hover:text-foreground md:h-8 md:w-8" aria-label="停止生成">
                  <Square className="size-4 md:size-3.5" />
                </Button>
              }
            />
            <ComposerPrimitive.Send
              render={
                <Button size="icon" className="h-10 w-10 shrink-0 rounded-lg md:h-8 md:w-8" aria-label="发送消息">
                  <ArrowUp className="size-5 md:size-4" />
                </Button>
              }
            />
          </div>
          {/* 简化选择器：无 label，无管理按钮 */}
          <div className="mt-2 flex items-center gap-2">
            <Select
              items={permissionItems}
              value={permissionMode}
              onValueChange={(v) => { if (v) onPermissionModeChange(v); }}
            >
              <SelectTrigger className="h-7 min-w-0 flex-1 text-[11px] text-muted-foreground">
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
            <Select
              items={profileItems}
              value={profileId ?? ""}
              onValueChange={(v) => onProfileChange(v || null)}
            >
              <SelectTrigger className="h-7 min-w-0 flex-1 text-[11px] text-muted-foreground">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(profileItems).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <p className="mt-2 text-center text-[0.7rem] text-muted-foreground/35">
            <span className="hidden md:inline">Enter 发送  ·  Shift + Enter 换行</span>
            <span className="inline md:hidden">轻触发送</span>
          </p>
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
