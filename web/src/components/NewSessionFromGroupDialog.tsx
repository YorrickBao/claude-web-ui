import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Folder, Plus } from "lucide-react";
import { ProfileSelect } from "@/components/ProfileSelect";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";

interface NewSessionFromGroupDialogProps {
  open: boolean;
  cwd: string | null;
  onClose: () => void;
}

/**
 * 从侧栏分组新建会话的弹窗：只需选 profile，然后直接进入对话界面。
 */
export function NewSessionFromGroupDialog({
  open,
  cwd,
  onClose,
}: NewSessionFromGroupDialogProps) {
  const navigate = useNavigate();
  const [profileId, setProfileId] = useState<string | null>(null);

  function handleStart() {
    if (!cwd) return;
    navigate("/pending", { state: { cwd, profileId } });
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Plus className="h-5 w-5 text-primary" />
            新建会话
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* 工作目录（只读） */}
          <div>
            <span className="block text-xs font-medium uppercase tracking-wide text-muted-foreground mb-1">
              工作目录
            </span>
            <div className="flex items-center gap-2 rounded-md border border-border bg-muted/50 px-3 py-2 text-sm text-foreground">
              <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate" title={cwd ?? ""}>
                {cwd ?? "—"}
              </span>
            </div>
          </div>

          {/* Profile 选择 */}
          <div>
            <span className="block text-xs font-medium uppercase tracking-wide text-muted-foreground mb-1">
              环境变量配置（profile）
            </span>
            <ProfileSelect value={profileId} onChange={setProfileId} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button onClick={handleStart} disabled={!cwd}>
            进入会话
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
