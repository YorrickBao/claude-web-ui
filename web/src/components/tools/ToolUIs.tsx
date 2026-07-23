import { useState } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Markdown } from "@/components/Markdown";

/**
 * 工具调用 UI 组件。
 *
 * 这是 MessagePrimitive.Parts 的 components.tools.by_name 用的组件签名。
 * 关键 props（来自 ToolCallMessagePartProps）：
 *   - toolName, args, argsText
 *   - result（未知类型，需判空）
 *   - isError
 *   - status: { type: "running" | "complete" | "incomplete" | "requires-action" }
 */
export interface ToolUIProps {
  toolName: string;
  args?: unknown;
  argsText?: string;
  result?: unknown;
  isError?: boolean;
  status: { type: "running" | "complete" | "incomplete" | "requires-action" };
}

/**
 * 思考过程（reasoning part）渲染。
 * - 消息运行中（status running）默认展开、模型往下走后收起。
 * - 空文本（流式刚开始）显示"思考中…"占位。
 * - 无边框：仅用左侧细色条 + 收起/展开，视觉轻量。
 */
export function ReasoningBlock({
  text,
  isStreaming,
}: {
  text?: string;
  isStreaming?: boolean;
}) {
  const [open, setOpen] = useState(!!isStreaming);
  const showCursor = isStreaming && !text;

  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        {open ? (
          <ChevronDown className="size-3 shrink-0" />
        ) : (
          <ChevronRight className="size-3 shrink-0" />
        )}
        <span className="font-medium">
          {showCursor ? "思考中…" : "思考过程"}
        </span>
        {isStreaming && (
          <span className="ml-0.5 inline-block size-1.5 animate-pulse rounded-full bg-amber-400" />
        )}
      </button>
      {open && (text || showCursor) && (
        <div className="mt-1 pl-3.5 text-[13px] leading-relaxed text-muted-foreground/80">
          {showCursor ? (
            <span className="text-muted-foreground/50">…</span>
          ) : (
            <Markdown>{text ?? ""}</Markdown>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 消息错误块：assistant 消息进入 incomplete/error 状态时显示。
 * 无边框，仅用红色文字 + 左色条。
 */
export function MessageErrorBlock({ message }: { message?: string }) {
  return (
    <div className="my-1 border-l-2 border-red-500/50 pl-3 py-1 text-sm text-red-400">
      <div className="font-medium">⚠ 出错了</div>
      {message && (
        <div className="mt-0.5 text-[13px] text-red-400/70">{message}</div>
      )}
    </div>
  );
}

/** 工具卡片外壳：可折叠 + 名称 + 状态。无边框，仅 hover 时浅背景。 */
export function ToolCardShell({
  name,
  summary,
  status,
  isError,
  children,
}: {
  name: string;
  summary?: string;
  status: ToolUIProps["status"];
  isError?: boolean;
  children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const isRunning = status.type === "running";

  return (
    <div className="rounded-md transition-colors hover:bg-muted/30">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 py-1 pr-2 text-left text-sm"
      >
        {open ? (
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
        )}
        <span
          className={cn(
            "font-mono text-[13px] font-medium",
            isError
              ? "text-red-400"
              : isRunning
                ? "text-amber-400"
                : "text-accent",
          )}
        >
          {name}
        </span>
        {summary && (
          <span className="truncate font-mono text-xs text-muted-foreground/70">{summary}</span>
        )}
        {isRunning && (
          <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-amber-400">
            <span className="inline-block size-1.5 animate-pulse rounded-full bg-amber-400" />
            运行中
          </span>
        )}
        {isError && (
          <span className="ml-auto text-[11px] text-red-400">出错</span>
        )}
      </button>
      {open && children && (
        <div className="space-y-2 px-2 pb-2 pt-1">{children}</div>
      )}
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      <div className="overflow-auto">{children}</div>
    </div>
  );
}

function JsonView({ value }: { value: unknown }) {
  let text: string;
  try {
    text =
      typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  return (
    <pre className="max-h-80 overflow-auto rounded-md bg-black/30 p-2 text-xs text-muted-foreground">
      {text}
    </pre>
  );
}

/** 默认 fallback：任意工具都可用 */
export function GenericToolUI(props: ToolUIProps) {
  return (
    <ToolCardShell
      name={props.toolName}
      status={props.status}
      isError={props.isError}
    >
      <Section title="参数">
        <JsonView value={props.args} />
      </Section>
      {props.result !== undefined && (
        <Section title="结果">
          <JsonView value={props.result} />
        </Section>
      )}
    </ToolCardShell>
  );
}

/** Bash：摘要显示命令，结果按文本展示 */
export function BashToolUI(props: ToolUIProps) {
  const command = (props.args as { command?: string })?.command ?? "";
  return (
    <ToolCardShell
      name="Bash"
      summary={command.slice(0, 80)}
      status={props.status}
      isError={props.isError}
    >
      <Section title="命令">
        <pre className="overflow-auto rounded-md bg-black/30 p-2 text-xs text-muted-foreground whitespace-pre-wrap">
          {command}
        </pre>
      </Section>
      {props.result !== undefined && (
        <Section title="输出">
          <pre className="max-h-80 overflow-auto rounded bg-black/40 p-2 text-xs text-muted-foreground whitespace-pre-wrap">
            {typeof props.result === "string"
              ? props.result
              : JSON.stringify(props.result, null, 2)}
          </pre>
        </Section>
      )}
    </ToolCardShell>
  );
}

/** Edit：显示 old/new diff */
export function EditToolUI(props: ToolUIProps) {
  const a = props.args as {
    file_path?: string;
    old_string?: string;
    new_string?: string;
  };
  return (
    <ToolCardShell
      name="Edit"
      summary={a?.file_path}
      status={props.status}
      isError={props.isError}
    >
      <div className="text-xs">
        <div className="mb-1 text-muted-foreground">文件</div>
        <code className="text-muted-foreground">{a?.file_path}</code>
      </div>
      <div>
        <div className="mb-1 text-xs text-red-400">- 旧</div>
        <pre className="rounded-md bg-red-950/30 p-2 text-xs text-red-300 whitespace-pre-wrap">
          {a?.old_string}
        </pre>
      </div>
      <div>
        <div className="mb-1 text-xs text-green-400">+ 新</div>
        <pre className="rounded-md bg-green-950/30 p-2 text-xs text-green-300 whitespace-pre-wrap">
          {a?.new_string}
        </pre>
      </div>
      {props.result !== undefined && (
        <Section title="结果">
          <JsonView value={props.result} />
        </Section>
      )}
    </ToolCardShell>
  );
}

export function WriteToolUI(props: ToolUIProps) {
  const a = props.args as { file_path?: string };
  return (
    <ToolCardShell
      name="Write"
      summary={a?.file_path}
      status={props.status}
      isError={props.isError}
    >
      <Section title="参数">
        <JsonView value={props.args} />
      </Section>
      {props.result !== undefined && (
        <Section title="结果">
          <JsonView value={props.result} />
        </Section>
      )}
    </ToolCardShell>
  );
}

export function ReadToolUI(props: ToolUIProps) {
  const a = props.args as { file_path?: string };
  return (
    <ToolCardShell
      name="Read"
      summary={a?.file_path}
      status={props.status}
      isError={props.isError}
    >
      <Section title="参数">
        <JsonView value={props.args} />
      </Section>
      {props.result !== undefined && (
        <Section title="结果">
          <JsonView value={props.result} />
        </Section>
      )}
    </ToolCardShell>
  );
}
