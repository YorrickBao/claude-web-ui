import {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export type ConfirmVariant = "destructive" | "default";

export type ConfirmOptions = {
  /** 对话框标题 */
  title: string;
  /** 描述文本，支持 \n 换行 */
  description: string;
  /** 视觉风格：destructive 显示红色警告图标，default 为普通确认 */
  variant?: ConfirmVariant;
  /** 确认按钮文字，默认"确定" */
  confirmLabel?: string;
  /** 取消按钮文字，默认"取消" */
  cancelLabel?: string;
};

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

// ─────────────────────────────────────────────────────────────
// Context
// ─────────────────────────────────────────────────────────────

const ConfirmContext = createContext<ConfirmFn | null>(null);

// ─────────────────────────────────────────────────────────────
// Provider
// ─────────────────────────────────────────────────────────────

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const resolveRef = useRef<((value: boolean) => void) | null>(null);
  // 控制警告图标的单次脉冲动画
  const [iconKey, setIconKey] = useState(0);

  const confirm = useCallback((opts: ConfirmOptions): Promise<boolean> => {
    return new Promise((resolve) => {
      resolveRef.current = resolve;
      setOptions(opts);
      setIconKey((k) => k + 1);
      setOpen(true);
    });
  }, []);

  const settle = useCallback((value: boolean) => {
    resolveRef.current?.(value);
    resolveRef.current = null;
    setOpen(false);
  }, []);

  const isDestructive = options?.variant === "destructive";

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}

      <AlertDialog
        open={open}
        onOpenChange={(v) => {
          if (!v) settle(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            {isDestructive && (
              <AlertDialogMedia
                key={iconKey}
                className={cn(
                  "bg-destructive/10 text-destructive",
                  "animate-confirm-icon-pulse",
                )}
              >
                <AlertTriangle className="h-5 w-5" />
              </AlertDialogMedia>
            )}
            <AlertDialogTitle>{options?.title}</AlertDialogTitle>
            <AlertDialogDescription>
              {options?.description.split("\n").map((line, i) => (
                <span key={i}>
                  {i > 0 && <br />}
                  {line}
                </span>
              ))}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => settle(false)}>
              {options?.cancelLabel ?? "取消"}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => settle(true)}
              variant={isDestructive ? "destructive" : "default"}
            >
              {options?.confirmLabel ?? "确定"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ConfirmContext.Provider>
  );
}

// ─────────────────────────────────────────────────────────────
// Hook
// ─────────────────────────────────────────────────────────────

/**
 * 命令式确认弹窗。
 *
 * 用法：
 * ```ts
 * const confirm = useConfirm();
 * const ok = await confirm({
 *   title: "删除会话",
 *   description: "此操作不可恢复",
 *   variant: "destructive",
 * });
 * if (!ok) return;
 * // 执行删除...
 * ```
 */
export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) {
    throw new Error("useConfirm must be used within a <ConfirmProvider>");
  }
  return ctx;
}
