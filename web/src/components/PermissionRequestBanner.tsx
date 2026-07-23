import { Button } from "@/components/ui/button";
import { Shield, X, Check, Loader2 } from "lucide-react";
import { useState } from "react";

export interface PendingPermission {
  requestId: string;
  toolName: string;
  toolInput: unknown;
  decisionReason?: string;
}

interface PermissionRequestBannerProps {
  pending: PendingPermission;
  onAllow: (
    requestId: string,
    opts?: { remember?: boolean; toolName?: string },
  ) => Promise<void>;
  onDeny: (requestId: string) => Promise<void>;
}

/** 工具权限审批横幅：显示在聊天界面顶部，等待用户审批 */
export function PermissionRequestBanner({
  pending,
  onAllow,
  onDeny,
}: PermissionRequestBannerProps) {
  const [responding, setResponding] = useState(false);
  const [remember, setRemember] = useState(false);

  async function handleAllow() {
    setResponding(true);
    try {
      await onAllow(pending.requestId, {
        remember,
        toolName: pending.toolName,
      });
    } finally {
      setResponding(false);
    }
  }

  async function handleDeny() {
    setResponding(true);
    try {
      await onDeny(pending.requestId);
    } finally {
      setResponding(false);
    }
  }

  const inputPreview = formatToolInput(pending.toolName, pending.toolInput);

  return (
    <div className="mx-auto mb-4 max-w-3xl" style={{ animation: "bannerSlideIn 0.2s ease-out" }}>
      <div className="rounded-xl border border-amber-500/30 bg-amber-50/80 px-4 py-3 shadow-sm backdrop-blur dark:border-amber-400/20 dark:bg-amber-950/40">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/50">
            <Shield className="h-4 w-4 text-amber-600 dark:text-amber-400" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">
              Claude 想要执行{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs font-mono">
                {pending.toolName}
              </code>
            </p>
            {pending.decisionReason && (
              <p className="mt-1 text-xs text-muted-foreground line-clamp-2">
                {pending.decisionReason}
              </p>
            )}
            {inputPreview && (
              <pre className="mt-2 max-h-32 overflow-auto rounded-md bg-muted/60 p-2 text-xs font-mono text-muted-foreground whitespace-pre-wrap break-all">
                {inputPreview}
              </pre>
            )}
            <div className="mt-3 flex items-center gap-2">
              <Button
                size="sm"
                variant="default"
                className="h-7 gap-1 text-xs"
                onClick={handleAllow}
                disabled={responding}
              >
                {responding ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Check className="h-3 w-3" />
                )}
                批准
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 gap-1 text-xs text-muted-foreground"
                onClick={handleDeny}
                disabled={responding}
              >
                <X className="h-3 w-3" />
                拒绝
              </Button>
              <label className="ml-1 flex cursor-pointer select-none items-center gap-1 text-[11px] text-muted-foreground">
                <input
                  type="checkbox"
                  className="h-3 w-3 cursor-pointer rounded border-border accent-amber-600"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                  disabled={responding}
                />
                始终允许此工具
              </label>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 将 toolInput 格式化为可读的预览文本 */
function formatToolInput(
  toolName: string,
  input: unknown,
): string | null {
  if (!input || typeof input !== "object") return null;

  const obj = input as Record<string, unknown>;

  switch (toolName) {
    case "Bash":
      return typeof obj.command === "string" ? obj.command : null;
    case "Write":
      return typeof obj.file_path === "string"
        ? `📄 ${obj.file_path}\n${truncate(String(obj.content ?? ""), 200)}`
        : null;
    case "Edit":
      return typeof obj.file_path === "string"
        ? `✏️ ${obj.file_path}\n${truncate(String(obj.old_string ?? ""), 100)}\n→ ${truncate(String(obj.new_string ?? ""), 100)}`
        : null;
    case "Read":
      return typeof obj.file_path === "string" ? `📖 ${obj.file_path}` : null;
    default:
      return truncate(JSON.stringify(obj, null, 2), 300);
  }
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + "…";
}
