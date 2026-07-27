import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Markdown } from "@/components/Markdown";

/**
 * 工具调用 UI 组件。
 *
 * 时序交错渲染下，每个 tool-call part 由 ChatThread 的 mapToolPart 转成
 * ToolUIProps 后交给 <ToolRenderer>。ToolRenderer 按 toolName 分发到专门的
 * 参数/结果渲染，折叠态头部带一行 summary（文件路径 / 命令 / pattern…），
 * 未知工具兜底 JSON。
 */

export type ToolStatus = "running" | "complete" | "incomplete";

export interface ToolUIProps {
  toolName: string;
  args?: unknown;
  argsText?: string;
  result?: unknown;
  isError?: boolean;
  status: ToolStatus;
}

// ─── summary：折叠态头部的一行摘要（前端复刻后端 sdk.ts 的 summarizeToolCall） ───

/**
 * 从工具参数提取一行人类可读摘要，贴在工具名旁边。
 * 只取每个工具最关键的参数；返回空串则不显示。
 */
export function summarizeToolCall(toolName: string, input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const trunc = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n) + "…");
  switch (toolName) {
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return str(obj.file_path) || str(obj.notebook_path);
    case "Bash":
      return trunc(str(obj.command), 80);
    case "BashOutput":
    case "KillShell":
      return str(obj.shell_id);
    case "Grep":
      return `${trunc(str(obj.pattern), 60)}${str(obj.path) ? ` · ${str(obj.path)}` : ""}`;
    case "Glob":
      return `${str(obj.pattern)}${str(obj.path) ? ` · ${str(obj.path)}` : ""}`;
    case "LS":
      return str(obj.path) || ".";
    case "WebSearch":
      return trunc(str(obj.query), 60);
    case "WebFetch":
      return str(obj.url);
    case "Task":
    case "Agent":
      return str(obj.description) || str(obj.subagent_type) || "";
    case "TodoWrite": {
      const n = Array.isArray(obj.todos) ? obj.todos.length : 0;
      return n ? `${n} 项` : "";
    }
    default: {
      // 取第一个字符串型字段做兜底摘要
      const first = Object.values(obj).find((v) => typeof v === "string");
      return first ? trunc(String(first), 60) : "";
    }
  }
}

// ─── 结果归一化 + 大结果摘要折叠 ───

/** 把 tool_result.content（string | content block 数组 | 对象）归一化为可显示文本 */
function extractResultText(result: unknown): string {
  if (result == null) return "";
  if (typeof result === "string") return result;
  if (Array.isArray(result)) {
    // tool_result 的 content 数组：[{type:"text",text}, {type:"image",...}]
    return result
      .map((b) => {
        if (typeof b === "string") return b;
        if (b && typeof b === "object") {
          const o = b as { type?: string; text?: string };
          if (o.type === "text" && typeof o.text === "string") return o.text;
          if (o.type === "image") return "[图片]";
        }
        return "";
      })
      .join("\n")
      .trim();
  }
  // 对象 / 原始值统一走 JSON 序列化；循环引用 / BigInt 等无法序列化的给占位，
  // 避免 String(obj) 落到默认的 [object Object]。
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return "[无法序列化的结果]";
  }
}

const RESULT_PREVIEW_LINES = 15;
const RESULT_PREVIEW_CHARS = 1200;

/** 大结果默认只显示预览（前 N 行），提供"展开全部"按钮 */
function ResultView({ result, isError }: { result: unknown; isError?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const text = extractResultText(result);
  if (!text) {
    return <div className="text-xs text-muted-foreground/50">（无输出）</div>;
  }
  const lines = text.split("\n");
  const isLong =
    lines.length > RESULT_PREVIEW_LINES || text.length > RESULT_PREVIEW_CHARS;
  const preview =
    isLong && !expanded
      ? lines.slice(0, RESULT_PREVIEW_LINES).join("\n")
      : text;
  return (
    <div>
      <pre
        className={cn(
          "max-h-80 overflow-auto rounded-md bg-black/30 p-2 text-xs",
          isError ? "text-red-300/90" : "text-muted-foreground",
        )}
      >
        {preview}
        {isLong && !expanded && (
          <span className="text-muted-foreground/40">{"\n…"}</span>
        )}
      </pre>
      {isLong && (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        >
          {expanded ? "收起" : `展开全部（${lines.length} 行）`}
        </button>
      )}
    </div>
  );
}

// ─── 思考过程块 ───

/**
 * 思考过程（reasoning part）渲染。
 * - 流式中（isStreaming）默认展开，结束后自动收起一次（尊重用户手动操作）
 * - 空文本（刚开始）显示"思考中…"占位
 * - 无边框：仅用左侧缩进 + 收起/展开，视觉轻量
 */
export function ReasoningBlock({
  text,
  isStreaming,
}: {
  text?: string;
  isStreaming?: boolean;
}) {
  const [open, setOpen] = useState(!!isStreaming);
  const wasStreamingRef = useRef(!!isStreaming);
  useEffect(() => {
    // streaming → 结束自动收起一次；用户手动展开过的不覆盖
    if (wasStreamingRef.current && !isStreaming) setOpen(false);
    wasStreamingRef.current = !!isStreaming;
  }, [isStreaming]);

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

// ─── 消息错误块 ───

/** assistant 消息进入 incomplete/error 状态时显示。无边框，仅红色文字 + 左色条。 */
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

// ─── 工具卡片外壳 ───

/** 工具卡片外壳：可折叠 + 名称 + summary + 状态。
 *  - 运行中默认展开、结束后自动收起一次（出错时不收起，让用户看到错误）
 *  - 历史（初始即 complete）默认折叠
 *  - 用户手动展开/折叠后不再被自动行为覆盖 */
export function ToolCardShell({
  name,
  summary,
  status,
  isError,
  children,
}: {
  name: string;
  summary?: string;
  status: ToolStatus;
  isError?: boolean;
  children?: ReactNode;
}) {
  const isRunning = status === "running";
  const [open, setOpen] = useState(isRunning);
  const wasRunningRef = useRef(isRunning);
  useEffect(() => {
    // 运行中 → 结束自动收起；出错则保持展开（可见性优先）
    if (wasRunningRef.current && !isRunning && !isError) setOpen(false);
    wasRunningRef.current = isRunning;
  }, [isRunning, isError]);

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
          <span className="truncate font-mono text-xs text-muted-foreground/70">
            {summary}
          </span>
        )}
        {isRunning && (
          <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-amber-400">
            <span className="inline-block size-1.5 animate-pulse rounded-full bg-amber-400" />
            运行中
          </span>
        )}
        {isError && <span className="ml-auto text-[11px] text-red-400">出错</span>}
      </button>
      {open && children && (
        <div className="space-y-2 px-2 pb-2 pt-1">{children}</div>
      )}
    </div>
  );
}

// ─── 参数 / 结果细节渲染 ───

function Section({ title, children }: { title: string; children: ReactNode }) {
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
    text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  return (
    <pre className="max-h-80 overflow-auto rounded-md bg-black/30 p-2 text-xs text-muted-foreground">
      {text}
    </pre>
  );
}

/** 键值对列表：参数最常用的展示形态 */
function KeyValue({
  rows,
  mono,
}: {
  rows: { k: string; v: string }[];
  mono?: boolean;
}) {
  if (rows.length === 0) {
    return <div className="text-xs text-muted-foreground/50">（无）</div>;
  }
  return (
    <dl className="space-y-0.5">
      {rows.map((r, i) => (
        <div key={i} className="flex gap-2 text-xs">
          <dt className="shrink-0 text-muted-foreground/60">{r.k}</dt>
          <dd className={cn("min-w-0 break-all", mono && "font-mono")}>{r.v}</dd>
        </div>
      ))}
    </dl>
  );
}

function DiffBlock({
  label,
  tone,
  text,
}: {
  label: string;
  tone: "red" | "green";
  text: string;
}) {
  return (
    <div>
      <div
        className={cn(
          "mb-0.5 text-[11px]",
          tone === "red" ? "text-red-400/80" : "text-emerald-400/80",
        )}
      >
        {label}
      </div>
      <pre
        className={cn(
          "max-h-60 overflow-auto whitespace-pre-wrap rounded-md p-1.5 text-xs",
          tone === "red"
            ? "bg-red-500/10 text-red-300/90"
            : "bg-emerald-500/10 text-emerald-300/90",
        )}
      >
        {text}
      </pre>
    </div>
  );
}

/** Edit / MultiEdit 的参数：路径 + 旧/新字符串 diff 视图 */
function EditArgs({ obj }: { obj: Record<string, unknown> }) {
  const fp =
    typeof obj.file_path === "string"
      ? obj.file_path
      : typeof obj.notebook_path === "string"
        ? obj.notebook_path
        : "";
  return (
    <div className="space-y-1">
      {fp && (
        <div className="flex gap-2 text-xs">
          <span className="shrink-0 text-muted-foreground/60">路径</span>
          <span className="min-w-0 break-all font-mono">{fp}</span>
        </div>
      )}
      {Array.isArray(obj.edits) && (
        <div className="text-xs text-muted-foreground">{obj.edits.length} 处编辑</div>
      )}
      {typeof obj.old_string === "string" && (
        <DiffBlock label="- 旧" tone="red" text={obj.old_string} />
      )}
      {typeof obj.new_string === "string" && (
        <DiffBlock label="+ 新" tone="green" text={obj.new_string} />
      )}
    </div>
  );
}

/** TodoWrite 的参数：待办清单（带状态图标） */
function TodosView({ todos }: { todos: unknown }) {
  if (!Array.isArray(todos)) {
    return <div className="text-xs text-muted-foreground/50">（无）</div>;
  }
  return (
    <ul className="space-y-0.5 text-xs">
      {todos.map((t, i) => {
        const o = (t ?? {}) as { content?: string; status?: string };
        const done = o.status === "completed";
        const inProg = o.status === "in_progress";
        return (
          <li key={i} className="flex gap-1.5">
            <span
              className={cn(
                "shrink-0",
                done
                  ? "text-emerald-400"
                  : inProg
                    ? "text-amber-400"
                    : "text-muted-foreground/50",
              )}
            >
              {done ? "✓" : inProg ? "▶" : "○"}
            </span>
            <span className={cn(done && "text-muted-foreground/60 line-through")}>
              {o.content ?? ""}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** 按 toolName 渲染参数：已知工具提取关键字段，未知兜底 JSON */
function ArgsView({ toolName, args }: { toolName: string; args?: unknown }) {
  const obj = (args && typeof args === "object" ? args : {}) as Record<
    string,
    unknown
  >;
  type Row = { k: string; v: string };
  const rows: Row[] = [];
  const push = (k: string, v: unknown) => {
    if (typeof v === "string" && v) rows.push({ k, v });
    else if (typeof v === "number" || typeof v === "boolean")
      rows.push({ k, v: String(v) });
  };

  switch (toolName) {
    case "Read": {
      push("路径", obj.file_path);
      if (typeof obj.offset === "number") push("offset", obj.offset);
      if (typeof obj.limit === "number") push("limit", obj.limit);
      return <KeyValue rows={rows} mono />;
    }
    case "Write": {
      push("路径", obj.file_path);
      if (typeof obj.content === "string") {
        return (
          <div className="space-y-1">
            <KeyValue rows={rows} mono />
            <div>
              <div className="mb-0.5 text-[11px] text-muted-foreground/60">内容</div>
              <pre className="max-h-60 overflow-auto rounded-md bg-black/30 p-2 text-xs text-muted-foreground">
                {obj.content}
              </pre>
            </div>
          </div>
        );
      }
      return <KeyValue rows={rows} mono />;
    }
    case "Edit":
    case "MultiEdit":
      return <EditArgs obj={obj} />;
    case "Bash":
      push("命令", obj.command);
      push("说明", obj.description);
      return <KeyValue rows={rows} mono />;
    case "Grep":
      push("pattern", obj.pattern);
      push("path", obj.path);
      push("glob", obj.glob);
      push("output_mode", obj.output_mode);
      push("-i", obj.case_insensitive);
      return <KeyValue rows={rows} mono />;
    case "Glob":
      push("pattern", obj.pattern);
      push("path", obj.path);
      return <KeyValue rows={rows} mono />;
    case "LS":
      push("path", obj.path);
      return <KeyValue rows={rows} mono />;
    case "WebSearch":
      push("query", obj.query);
      return <KeyValue rows={rows} />;
    case "WebFetch":
      push("url", obj.url);
      push("prompt", obj.prompt);
      return <KeyValue rows={rows} />;
    case "Task":
    case "Agent":
      push("subagent_type", obj.subagent_type);
      push("description", obj.description);
      push("prompt", obj.prompt);
      return <KeyValue rows={rows} />;
    case "TodoWrite":
      return <TodosView todos={obj.todos} />;
    default:
      return <JsonView value={args} />;
  }
}

function ToolDetails(props: ToolUIProps) {
  return (
    <>
      <Section title="参数">
        <ArgsView toolName={props.toolName} args={props.args} />
      </Section>
      {props.result !== undefined && (
        <Section title={props.isError ? "错误输出" : "结果"}>
          <ResultView result={props.result} isError={props.isError} />
        </Section>
      )}
    </>
  );
}

/** 工具渲染入口：折叠卡 + summary + 按 toolName 分发的细节 */
export function ToolRenderer(props: ToolUIProps) {
  return (
    <ToolCardShell
      name={props.toolName}
      summary={summarizeToolCall(props.toolName, props.args)}
      status={props.status}
      isError={props.isError}
    >
      <ToolDetails {...props} />
    </ToolCardShell>
  );
}
