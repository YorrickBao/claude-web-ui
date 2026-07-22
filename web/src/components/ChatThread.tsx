import {
  ThreadPrimitive,
  MessagePrimitive,
  ComposerPrimitive,
} from "@assistant-ui/react";
import { ArrowUp, Square, User, Bot } from "lucide-react";
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
    <MessagePrimitive.Root className="mb-6 flex flex-row-reverse gap-3">
      <AvatarUI role="user" />
      <div className="min-w-0 flex-1 text-right">
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
      <AvatarUI role="assistant" />
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

function AvatarUI({ role }: { role: "user" | "assistant" }) {
  return (
    <Avatar className="h-7 w-7 shrink-0">
      <AvatarFallback
        className={
          role === "user"
            ? "bg-secondary text-foreground/70"
            : "bg-primary text-primary-foreground"
        }
      >
        {role === "user" ? (
          <User className="h-3.5 w-3.5" />
        ) : (
          <Bot className="h-3.5 w-3.5" />
        )}
      </AvatarFallback>
    </Avatar>
  );
}
