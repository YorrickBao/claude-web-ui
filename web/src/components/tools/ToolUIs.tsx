import { useState } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

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

/** 工具卡片外壳：可折叠 + 名称 + 状态徽章 */
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
    <div className="my-2 rounded-lg border border-border bg-card/60">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted/50"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <span
          className={cn(
            "font-mono font-medium",
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
          <span className="truncate text-muted-foreground">{summary}</span>
        )}
        {isRunning && (
          <Badge variant="outline" className="ml-auto animate-pulse text-amber-400">
            运行中…
          </Badge>
        )}
        {isError && (
          <Badge variant="destructive" className="ml-auto">出错</Badge>
        )}
      </button>
      {open && children && (
        <div className="space-y-2 border-t border-border px-3 py-2">
          {children}
        </div>
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
    <pre className="max-h-80 overflow-auto rounded bg-black/40 p-2 text-xs text-muted-foreground">
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
        <pre className="overflow-auto rounded bg-black/40 p-2 text-xs text-muted-foreground whitespace-pre-wrap">
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
        <pre className="rounded bg-red-950/30 p-2 text-xs text-red-300 whitespace-pre-wrap">
          {a?.old_string}
        </pre>
      </div>
      <div>
        <div className="mb-1 text-xs text-green-400">+ 新</div>
        <pre className="rounded bg-green-950/30 p-2 text-xs text-green-300 whitespace-pre-wrap">
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
