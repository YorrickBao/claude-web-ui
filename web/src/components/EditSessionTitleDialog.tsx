import { Edit2, X, Save } from "lucide-react";
import { useState } from "react";
import { updateSessionTitle } from "@/lib/api";

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

  if (!open) return null;

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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="relative flex h-80 w-[500px] flex-col rounded-lg border border-neutral-700 bg-neutral-900 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-neutral-800 px-6 py-4">
          <div className="flex items-center gap-2">
            <Edit2 className="h-5 w-5 text-accent" />
            <h2 className="text-lg font-semibold text-neutral-100">
              编辑会话标题
            </h2>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-neutral-500">
            标题
          </label>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="留空则不设置标题"
            className="mb-6 w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 focus:border-accent focus:outline-none"
          />

          {error && (
            <div className="mb-4 rounded-lg border border-red-800 bg-red-950/30 px-4 py-3">
              <div className="text-sm text-red-400">{error}</div>
            </div>
          )}

          <div className="text-xs text-neutral-600">
            当前标题：{currentTitle || "（未设置）"}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 border-t border-neutral-800 px-6 py-4">
          <button
            onClick={onClose}
            disabled={saving}
            className="rounded-lg border border-neutral-700 px-4 py-2 text-sm text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
          >
            取消
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? "保存中…" : (
              <>
                <Save className="h-4 w-4" />
                保存
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
