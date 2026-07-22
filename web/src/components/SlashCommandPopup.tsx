import { useEffect, useState, useRef, useMemo } from "react";
import { fetchSlashCommands } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { SlashCommand } from "@/lib/types";

interface SlashCommandPopupProps {
  /** 当前工作目录，用于获取项目特定的命令列表 */
  cwd: string | null;
  /** 输入框 textarea 的 ref，用于监听输入、读写光标位置 */
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  /** 选中命令后的回调 */
  onSelect?: (command: SlashCommand) => void;
}

/**
 * 斜杠命令自动补全弹出层。
 *
 * - 监听 textareaRef 的 input 事件，当输入以 "/" 开头时弹出命令列表
 * - 支持键盘导航（↑↓ Enter Escape）、点击选择
 * - 命令列表按 cwd 从后端获取，内存缓存 5 分钟
 */
export function SlashCommandPopup({
  cwd,
  textareaRef,
  onSelect,
}: SlashCommandPopupProps) {
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);

  // 用 ref 保存回调，避免事件监听器重建
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  // 用 ref 保存 commands，避免 keydown handler 的闭包问题
  const commandsRef = useRef(commands);
  commandsRef.current = commands;

  // 缓存：避免切换会话时重复请求同一个 cwd
  const lastCwdRef = useRef<string | null>(null);

  // 当 cwd 变化时获取命令列表
  useEffect(() => {
    if (!cwd || cwd === lastCwdRef.current) return;
    lastCwdRef.current = cwd;
    fetchSlashCommands(cwd)
      .then(setCommands)
      .catch(() => setCommands([]));
  }, [cwd]);

  // 过滤后的命令列表（最多展示 8 条）
  const filtered = useMemo(() => {
    if (!filter) return commands.slice(0, 8);
    const lower = filter.toLowerCase();
    return commands
      .filter(
        (c) =>
          c.name.toLowerCase().includes(lower) ||
          c.description.toLowerCase().includes(lower),
      )
      .slice(0, 8);
  }, [commands, filter]);

  // 在 textarea 中替换 /xxx 为完整命令名并加空格
  function applyCommand(el: HTMLTextAreaElement, cmd: SlashCommand) {
    const value = el.value;
    const cursorPos = el.selectionStart ?? 0;
    const textBeforeCursor = value.slice(0, cursorPos);

    const lastSlashIdx = textBeforeCursor.lastIndexOf("/");
    if (lastSlashIdx < 0) return;

    const before = value.slice(0, lastSlashIdx);
    const after = value.slice(cursorPos);
    const replacement = cmd.name + " ";
    el.value = before + replacement + after;

    const newCursorPos = before.length + replacement.length;
    el.setSelectionRange(newCursorPos, newCursorPos);
    el.focus();

    setIsOpen(false);
    onSelectRef.current?.(cmd);

    // 触发 input 事件让 assistant-ui 感知到值变化
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  // 监听 textarea 的 input 和 keydown 事件
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;

    const handleInput = () => {
      const value = el.value;
      const cursorPos = el.selectionStart ?? 0;
      const textBeforeCursor = value.slice(0, cursorPos);
      const slashMatch = textBeforeCursor.match(/(?:^|\s)\/(\S*)$/);

      if (slashMatch) {
        setFilter(slashMatch[1]);
        setIsOpen(true);
        setSelectedIndex(0);
      } else {
        setIsOpen(false);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      // 读 DOM 避免 isOpen/filtered 闭包过期问题
      const popup = document.querySelector(
        '[role="listbox"][aria-label="斜杠命令"]',
      );
      if (!popup) return;

      const items = popup.querySelectorAll('[role="option"]');
      if (items.length === 0) return;

      const currentIdx = Array.from(items).findIndex(
        (item) => item.getAttribute("aria-selected") === "true",
      );

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((prev) => (prev >= items.length - 1 ? 0 : prev + 1));
          break; /* items.length 读自 DOM，始终反映当前列表长度 */
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((prev) => (prev <= 0 ? items.length - 1 : prev - 1));
          break;
        case "Enter":
        case "Tab": {
          const selectedEl = items[Math.max(0, currentIdx)] as
            | HTMLElement
            | undefined;
          const cmdName = selectedEl?.dataset.commandName;
          if (cmdName) {
            const cmd = commandsRef.current.find((c) => c.name === cmdName);
            if (cmd) {
              e.preventDefault();
              applyCommand(el, cmd);
            }
          }
          break;
        }
        case "Escape":
          e.preventDefault();
          setIsOpen(false);
          break;
      }
    };

    el.addEventListener("input", handleInput);
    el.addEventListener("keydown", handleKeyDown, true);
    return () => {
      el.removeEventListener("input", handleInput);
      el.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [textareaRef]);

  if (!isOpen || filtered.length === 0) return null;

  return (
    <div
      className="absolute bottom-full left-0 right-0 mb-2 overflow-hidden rounded-xl border border-border bg-popover shadow-2xl shadow-black/20"
      role="listbox"
      aria-label="斜杠命令"
    >
      <div className="px-2 py-1.5">
        <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider px-1">
          命令
        </span>
      </div>
      <div className="max-h-[240px] overflow-y-auto">
        {filtered.map((cmd, i) => (
          <div
            key={cmd.name}
            role="option"
            data-command-name={cmd.name}
            aria-selected={i === selectedIndex}
            className={cn(
              "flex items-center gap-2.5 px-3 py-2 cursor-pointer text-sm transition-colors",
              i === selectedIndex
                ? "bg-accent text-accent-foreground"
                : "hover:bg-muted/50",
            )}
            onMouseDown={(e) => {
              e.preventDefault();
              const el = textareaRef.current;
              if (el) applyCommand(el, cmd);
            }}
            onMouseEnter={() => setSelectedIndex(i)}
          >
            <span className="font-mono font-semibold text-[13px] shrink-0 text-foreground/80">
              {cmd.name}
            </span>
            <span className="text-muted-foreground truncate flex-1">
              {cmd.description}
            </span>
            {cmd.argumentHint && (
              <span className="text-muted-foreground/40 text-[11px] shrink-0 font-mono">
                {cmd.argumentHint}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
