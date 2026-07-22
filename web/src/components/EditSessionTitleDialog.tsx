import { Edit2, Save } from "lucide-react";
import { useState } from "react";
import { updateSessionTitle } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";

interface EditSessionTitleDialogProps {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  sessionId: string;
  currentTitle: string | null;
}

export function EditSessionTitleDialog({
  open,
  onClose,
  onSaved,
  sessionId,
  currentTitle,
}: EditSessionTitleDialogProps) {
  const [title, setTitle] = useState(currentTitle || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await updateSessionTitle(sessionId, title || null);
      onSaved();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Edit2 className="h-5 w-5 text-primary" />
            编辑会话标题
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto py-4">
          <Label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
            标题
          </Label>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="留空则不设置标题"
            className="mb-6"
          />

          {error && (
            <Alert variant="destructive" className="mb-4">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <div className="text-xs text-neutral-600">
            当前标题：{currentTitle || "（未设置）"}
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={onClose}
            disabled={saving}
          >
            取消
          </Button>
          <Button
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? "保存中…" : (
              <>
                <Save className="h-4 w-4" />
                保存
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}