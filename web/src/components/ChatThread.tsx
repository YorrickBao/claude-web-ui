import {
  ThreadPrimitive,
  MessagePrimitive,
  ComposerPrimitive,
} from "@assistant-ui/react";
import { Markdown } from "@/components/Markdown";
import {
  BashToolUI,
  EditToolUI,
  WriteToolUI,
  ReadToolUI,
  GenericToolUI,
  type ToolUIProps,
} from "@/components/tools/ToolUIs";

/**
 * assistant-ui Primitive 搭 Tailwind 的最小 Thread。
 * 不依赖 shadcn，所有样式手写。
 */
export function ChatThread() {
  return (
    <ThreadPrimitive.Root className="flex h-full flex-col">
      <ThreadPrimitive.Viewport className="flex-1 overflow-y-auto">
        <ThreadPrimitive.Empty>
          <div className="flex h-full items-center justify-center p-8 text-center text-sm text-neutral-500">
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

      <ComposerPrimitive.Root className="sticky bottom-0 border-t border-neutral-800 bg-neutral-950/80 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-end gap-2 rounded-2xl border border-neutral-700 bg-neutral-900 px-3 py-2 focus-within:border-accent">
          <ComposerPrimitive.Input
            placeholder="输入消息…  (Enter 发送 / Shift+Enter 换行)"
            submitMode="enter"
            className="max-h-60 flex-1 resize-none bg-transparent text-sm text-neutral-100 placeholder:text-neutral-500 focus:outline-none"
          />
          <ComposerPrimitive.Send className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-sm font-medium text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-600">
            发送
          </ComposerPrimitive.Send>
          <ComposerPrimitive.Cancel className="flex h-8 w-8 items-center justify-center rounded-lg bg-neutral-700 text-neutral-200 hover:bg-neutral-600">
            停
          </ComposerPrimitive.Cancel>
        </div>
      </ComposerPrimitive.Root>
    </ThreadPrimitive.Root>
  );
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="mb-6 flex flex-row-reverse gap-3">
      <Avatar role="user" />
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
      <Avatar role="assistant" />
      <div className="min-w-0 flex-1">
        <div className="inline-block max-w-full rounded-2xl bg-neutral-900 px-4 py-3 text-neutral-100">
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
    <span className="inline-block h-4 w-2 animate-pulse bg-neutral-500 align-middle" />
  );
}

function Avatar({ role }: { role: "user" | "assistant" }) {
  return (
    <div
      className={
        "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-medium " +
        (role === "user"
          ? "bg-neutral-700 text-neutral-200"
          : "bg-accent text-white")
      }
    >
      {role === "user" ? "你" : "C"}
    </div>
  );
}
