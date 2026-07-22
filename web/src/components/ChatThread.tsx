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

        <div className="mx-auto max-w-3xl px-4 py-6">
          <ThreadPrimitive.Messages
            components={{
              UserMessage: UserMessage,
              AssistantMessage: AssistantMessage,
            }}
          />
        </div>
      </ThreadPrimitive.Viewport>

      <ComposerPrimitive.Root className="sticky bottom-0 bg-gradient-to-t from-background via-background/95 to-transparent px-4 pb-4 pt-8">
        <div className="mx-auto max-w-3xl">
          <div className="flex items-end gap-2 rounded-2xl border border-border/60 bg-card px-3 py-1.5 shadow-lg shadow-black/5 transition-all duration-200 focus-within:border-accent/50 focus-within:shadow-xl focus-within:shadow-black/10 focus-within:ring-2 focus-within:ring-accent/20">
            <ComposerPrimitive.Input
              placeholder="输入消息…"
              submitMode="enter"
              className="max-h-60 flex-1 resize-none bg-transparent py-1.5 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none"
            />
            <ComposerPrimitive.Cancel
              render={
                <Button variant="ghost" size="icon" className="h-8 w-8 rounded-lg text-muted-foreground/60 hover:text-foreground" aria-label="停止生成">
                  <Square className="size-3.5" />
                </Button>
              }
            />
            <ComposerPrimitive.Send
              render={
                <Button size="icon" className="h-8 w-8 rounded-lg" aria-label="发送消息">
                  <ArrowUp className="size-4" />
                </Button>
              }
            />
          </div>
          {/* 简化选择器：无 label，无管理按钮 */}
          <div className="mt-2 flex items-center gap-2">
            <Select
              value={profileId ?? ""}
              onValueChange={(v) => onProfileChange(v || null)}
            >
              <SelectTrigger className="h-7 min-w-0 flex-1 text-[11px] text-muted-foreground">
                <SelectValue placeholder="profile" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">默认</SelectItem>
                {profiles.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={permissionMode}
              onValueChange={(v) => v && onPermissionModeChange(v)}
            >
              <SelectTrigger className="h-7 min-w-0 flex-1 text-[11px] text-muted-foreground">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="bypassPermissions">完全访问</SelectItem>
                <SelectItem value="default">标准模式</SelectItem>
                <SelectItem value="acceptEdits">自动编辑</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <p className="mt-2 text-center text-[0.7rem] text-muted-foreground/35">
            Enter 发送  ·  Shift + Enter 换行
          </p>
        </div>
      </ComposerPrimitive.Root>
    </ThreadPrimitive.Root>
  );
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="mb-6 flex justify-end">
      <div className="min-w-0">
        <div className="inline-block max-w-full rounded-2xl rounded-br-md bg-accent px-4 py-2.5 text-left text-white">
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
    <MessagePrimitive.Root className="mb-6 flex gap-3">
      <div className="min-w-0 flex-1">
        <div className="inline-block max-w-full rounded-2xl rounded-bl-md bg-card px-4 py-3 text-foreground">
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
