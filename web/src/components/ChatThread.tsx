import {
  ThreadPrimitive,
  MessagePrimitive,
  ComposerPrimitive,
} from "@assistant-ui/react";
import { Markdown } from "@/components/Markdown";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
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
 * 使用 shadcn/ui (Base UI) Button + Avatar。
 */
export function ChatThread() {
  return (
    <ThreadPrimitive.Root className="flex h-full flex-col">
      <ThreadPrimitive.Viewport className="flex-1 overflow-y-auto">
        <ThreadPrimitive.Empty>
          <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
            开始新的对话
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

      <ComposerPrimitive.Root className="sticky bottom-0 border-t border-border bg-background/80 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-end gap-2 rounded-2xl border border-input bg-card px-3 py-2 focus-within:border-accent">
          <ComposerPrimitive.Input
            placeholder="输入消息…  (Enter 发送 / Shift+Enter 换行)"
            submitMode="enter"
            className="max-h-60 flex-1 resize-none bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
          />
          <ComposerPrimitive.Send
            render={
              <Button size="icon" className="h-8 w-8" aria-label="发送">
                发送
              </Button>
            }
          />
          <ComposerPrimitive.Cancel
            render={
              <Button variant="secondary" size="icon" className="h-8 w-8" aria-label="停止">
                停
              </Button>
            }
          />
        </div>
      </ComposerPrimitive.Root>
    </ThreadPrimitive.Root>
  );
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="mb-6 flex flex-row-reverse gap-3">
      <AvatarUI role="user" />
      <div className="min-w-0 flex-1 text-right">
        <div className="inline-block max-w-full rounded-2xl bg-accent px-4 py-2 text-left text-white">
          <MessagePrimitive.Parts
            components={{
              Text: ({ text }) => (
                <div className="whitespace-pre-wrap break-words text-sm">
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
      <AvatarUI role="assistant" />
      <div className="min-w-0 flex-1">
        <div className="inline-block max-w-full rounded-2xl bg-card px-4 py-3 text-foreground">
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
    <span className="inline-block h-4 w-2 animate-pulse bg-muted-foreground align-middle" />
  );
}

function AvatarUI({ role }: { role: "user" | "assistant" }) {
  return (
    <Avatar className="h-8 w-8 shrink-0">
      <AvatarFallback
        className={
          role === "user"
            ? "bg-secondary text-xs text-foreground"
            : "bg-primary text-xs text-primary-foreground"
        }
      >
        {role === "user" ? "你" : "C"}
      </AvatarFallback>
    </Avatar>
  );
}
