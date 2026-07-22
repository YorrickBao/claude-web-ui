import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/Markdown";
import { FileText, Check, X, Loader2, Pencil } from "lucide-react";
import { useState } from "react";

export interface PendingPlanApproval {
  planContent: string;
}

interface PlanApprovalBannerProps {
  pending: PendingPlanApproval;
  onApprove: (opts?: { editedPlan?: string; prompt?: string }) => Promise<void>;
  onReject: () => void;
}

/** 计划审批横幅：LLM 产出计划后展示，等待用户审批 */
export function PlanApprovalBanner({
  pending,
  onApprove,
  onReject,
}: PlanApprovalBannerProps) {
  const [responding, setResponding] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editedContent, setEditedContent] = useState(pending.planContent);
  const [customPrompt, setCustomPrompt] = useState("");

  async function handleApprove() {
    setResponding(true);
    try {
      const opts: { editedPlan?: string; prompt?: string } = {};
      if (isEditing && editedContent !== pending.planContent) {
        opts.editedPlan = editedContent;
      }
      if (customPrompt.trim()) {
        opts.prompt = customPrompt.trim();
      }
      await onApprove(opts);
    } finally {
      setResponding(false);
    }
  }

  function handleReject() {
    onReject();
  }

  return (
    <div className="mx-auto mb-4 max-w-3xl" style={{ animation: "bannerSlideIn 0.2s ease-out" }}>
      <div className="rounded-xl border border-blue-500/30 bg-blue-50/80 px-4 py-4 shadow-sm backdrop-blur dark:border-blue-400/20 dark:bg-blue-950/40">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-100 dark:bg-blue-900/50">
            <FileText className="h-4 w-4 text-blue-600 dark:text-blue-400" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">
              实施计划
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Claude 已完成规划。请审批后再执行。
            </p>
          </div>
        </div>

        {/* 计划内容 */}
        <div className="mt-3 rounded-lg border border-border/60 bg-card/60 p-3">
          {isEditing ? (
            <textarea
              className="w-full min-h-[120px] rounded-md border border-border bg-background px-3 py-2 text-sm font-mono text-foreground resize-y focus:outline-none focus:ring-2 focus:ring-primary/20"
              value={editedContent}
              onChange={(e) => setEditedContent(e.target.value)}
            />
          ) : (
            <div className="prose prose-sm max-w-none dark:prose-invert prose-headings:mt-3 prose-headings:mb-1 prose-p:my-1 prose-li:my-0">
              <Markdown>{pending.planContent}</Markdown>
            </div>
          )}
        </div>

        {/* 可选：附加提示 */}
        <div className="mt-2">
          <input
            type="text"
            className="w-full rounded-md border border-border/60 bg-background/40 px-3 py-1.5 text-xs text-muted-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-primary/20"
            placeholder="附加执行提示（可选）…"
            value={customPrompt}
            onChange={(e) => setCustomPrompt(e.target.value)}
          />
        </div>

        {/* 操作按钮 */}
        <div className="mt-3 flex items-center gap-2">
          <Button
            size="sm"
            variant="default"
            className="h-7 gap-1 text-xs"
            onClick={handleApprove}
            disabled={responding}
          >
            {responding ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Check className="h-3 w-3" />
            )}
            批准并执行
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1 text-xs"
            onClick={() => setIsEditing(!isEditing)}
          >
            <Pencil className="h-3 w-3" />
            {isEditing ? "预览" : "编辑"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1 text-xs text-muted-foreground"
            onClick={handleReject}
            disabled={responding}
          >
            <X className="h-3 w-3" />
            拒绝
          </Button>
        </div>
      </div>
    </div>
  );
}
