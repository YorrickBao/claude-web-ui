import { useThread } from "@assistant-ui/react";
import { List } from "lucide-react";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";

/** 统一消息 DOM 锚点 id，供 UserMessage 挂 id 与大纲定位共用 */
export function messageAnchorId(id: string): string {
  return `aui-msg-${id}`;
}

interface OutlineItem {
  id: string;
  title: string;
}

/** 从一条 user 消息的 content 中提取首行非空文本作标题 */
function extractTitle(
  content: readonly { type: string; text?: string }[] | undefined,
): string {
  const text =
    content
      ?.filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
      .join("") ?? "";
  const firstLine =
    text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "(无文本)";
  return firstLine.length > 40 ? firstLine.slice(0, 40) + "…" : firstLine;
}

/**
 * 对话大纲：左侧常驻浮层，列出当前会话每一轮用户提问。
 * hover 触发条展开编号列表，点击条目平滑滚动到对应用户消息。
 */
export function ThreadOutline() {
  const messages = useThread((s) => s.messages);

  const items = useMemo<OutlineItem[]>(() => {
    return messages
      .filter((m) => m.role === "user")
      .map((m) => ({
        id: m.id,
        title: extractTitle(
          m.content as readonly { type: string; text?: string }[],
        ),
      }));
  }, [messages]);

  function jumpTo(id: string) {
    document
      .getElementById(messageAnchorId(id))
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <div className="pointer-events-none absolute left-1 top-1/2 z-30 -translate-y-1/2 group">
      {/* 触发条：常驻可见的窄竖条 */}
      <Button
        variant="ghost"
        size="icon"
        aria-label="对话大纲"
        className="pointer-events-auto h-7 w-7 text-muted-foreground/60 hover:text-foreground"
      >
        <List className="size-4" />
      </Button>

      {/* 桥接：填充触发条与面板间的 4px 间隙，保持 hover 连续，避免移动中途面板闪退 */}
      <div
        aria-hidden
        className="pointer-events-auto absolute left-full top-1/2 h-7 w-2 -translate-y-1/2"
      />

      {/* 面板：hover 显隐，无动效 */}
      <div className="pointer-events-none absolute left-full top-1/2 ml-1 max-h-[60vh] w-64 -translate-y-1/2 rounded-lg border border-border bg-popover/95 p-1.5 opacity-0 shadow-lg backdrop-blur group-hover:pointer-events-auto group-hover:opacity-100">
        {items.length === 0 ? (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            暂无提问
          </div>
        ) : (
          <div className="flex max-h-[60vh] flex-col gap-0.5 overflow-y-auto">
            {items.map((it, idx) => (
              <button
                key={it.id}
                type="button"
                onClick={() => jumpTo(it.id)}
                title={it.title}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-accent/10 hover:text-foreground"
              >
                <span className="shrink-0 tabular-nums">{idx + 1}.</span>
                <span className="truncate">{it.title}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
