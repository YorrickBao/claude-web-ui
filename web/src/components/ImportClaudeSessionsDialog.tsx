import { FolderOpen, CheckCircle2, AlertCircle, X } from "lucide-react";
import { useState, useEffect } from "react";
import { scanClaudeSessions } from "@/lib/api";
import type { SessionView } from "@/lib/types";

interface ImportClaudeSessionsDialogProps {
  open: boolean;
  onClose: () => void;
  onImport: (sessions: SessionView[]) => void;
  importing: boolean;
  importError: string | null;
}

export function ImportClaudeSessionsDialog({
  open,
  onClose,
  onImport,
  importing,
  importError,
}: ImportClaudeSessionsDialogProps) {
  const [sessions, setSessions] = useState<SessionView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  void importError;

  useEffect(() => {
    if (open) {
      async function loadSessions() {
        setLoading(true);
        setError(null);
        try {
          const imported = await scanClaudeSessions();
          setSessions(imported);
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setLoading(false);
        }
      }
      loadSessions();
    }
  }, [open]);

  if (!open) return null;

  const newSessions = sessions.filter((s) => !s.alreadyImported);
  const skippedCount = sessions.length - newSessions.length;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="relative flex h-[80vh] w-[90vw] max-w-2xl flex-col rounded-lg border border-neutral-700 bg-neutral-900 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-neutral-800 px-6 py-4">
          <div className="flex items-center gap-2">
            <FolderOpen className="h-5 w-5 text-accent" />
            <h2 className="text-lg font-semibold text-neutral-100">
              导入历史会话
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
          {loading && (
            <div className="flex items-center justify-center py-12">
              <div className="text-neutral-500">加载中…</div>
            </div>
          )}

          {error && (
            <div className="flex items-center gap-2 rounded-lg border border-red-800 bg-red-950/30 px-4 py-3">
              <AlertCircle className="h-5 w-5 text-red-400" />
              <div className="text-sm text-red-400">{error}</div>
            </div>
          )}

          {!loading && !error && sessions.length === 0 && (
            <div className="flex items-center justify-center py-12">
              <div className="text-neutral-500">
                未找到历史会话
              </div>
            </div>
          )}

          {!loading && !error && sessions.length > 0 && (
            <div className="space-y-2">
              {newSessions.length === 0 ? (
                <div className="flex items-center justify-center py-8">
                  <div className="text-neutral-500">
                    全部 {sessions.length} 个会话均已导入，无新会话
                  </div>
                </div>
              ) : (
                <>
                  <div className="mb-4 text-sm text-neutral-500">
                    找到 {newSessions.length} 个未导入的历史会话
                    {skippedCount > 0 && (
                      <span className="text-neutral-600">
                        （已跳过 {skippedCount} 个已导入的）
                      </span>
                    )}
                  </div>
                  <div className="max-h-96 space-y-1 overflow-y-auto rounded-lg border border-neutral-800 bg-neutral-950/50">
                    {newSessions.map((s) => (
                      <div
                        key={s.sessionId}
                        className="flex items-start gap-2 rounded px-3 py-2 text-sm hover:bg-neutral-800"
                      >
                        <CheckCircle2 className="h-4 w-4 shrink-0 text-neutral-600" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-neutral-200">
                            {s.title}
                          </div>
                          <div className="truncate text-xs text-neutral-600">
                            {s.cwd}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 border-t border-neutral-800 px-6 py-4">
          <button
            onClick={onClose}
            disabled={importing}
            className="rounded-lg border border-neutral-700 px-4 py-2 text-sm text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
          >
            取消
          </button>
          <button
            onClick={() => onImport(newSessions)}
            disabled={importing || newSessions.length === 0}
            className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {importing ? "导入中…" : "确认导入"}
          </button>
        </div>
      </div>
    </div>
  );
}
