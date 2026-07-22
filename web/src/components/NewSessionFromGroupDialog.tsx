import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";
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
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Plus className="h-5 w-5 text-primary" />
            新建会话
          </DialogTitle>
        </DialogHeader>

        <div className="py-2">
          <ProfileSelect value={profileId} onChange={setProfileId} />
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
