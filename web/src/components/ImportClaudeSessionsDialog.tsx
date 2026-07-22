import { FolderOpen, CheckCircle2, AlertCircle } from "lucide-react";
import { useState, useEffect } from "react";
import { scanClaudeSessions } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
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

  const newSessions = sessions.filter((s) => !s.alreadyImported);
  const skippedCount = sessions.length - newSessions.length;

  return (
    <Dialog open={open} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="h-[80vh] max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderOpen className="h-5 w-5 text-primary" />
            从 Claude Code CLI 导入
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto py-4">
          {loading && (
            <div className="flex flex-col gap-2 py-12">
              <Skeleton className="mx-auto h-4 w-32" />
              <Skeleton className="mx-auto h-4 w-48" />
            </div>
          )}

          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-5 w-5" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {!loading && !error && sessions.length === 0 && (
            <div className="flex items-center justify-center py-12">
              <div className="text-muted-foreground">
                未找到历史会话
              </div>
            </div>
          )}

          {!loading && !error && sessions.length > 0 && (
            <div className="space-y-2">
              {newSessions.length === 0 ? (
                <div className="flex items-center justify-center py-8">
                  <div className="text-muted-foreground">
                    全部 {sessions.length} 个会话均已导入，无新会话
                  </div>
                </div>
              ) : (
                <>
                  <div className="mb-4 text-sm text-muted-foreground">
                    找到 {newSessions.length} 个未导入的历史会话
                    {skippedCount > 0 && (
                      <span className="text-muted-foreground">
                        （已跳过 {skippedCount} 个已导入的）
                      </span>
                    )}
                  </div>
                  <div className="max-h-96 space-y-1 overflow-y-auto rounded-lg border border-border bg-card/50">
                    {newSessions.map((s) => (
                      <div
                        key={s.sessionId}
                        className="flex items-start gap-2 rounded px-3 py-2 text-sm hover:bg-muted"
                      >
                        <CheckCircle2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-foreground">
                            {s.title}
                          </div>
                          <div className="truncate text-xs text-muted-foreground">
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

        <DialogFooter>
          <Button
            variant="outline"
            onClick={onClose}
            disabled={importing}
          >
            取消
          </Button>
          <Button
            onClick={() => onImport(newSessions)}
            disabled={importing || newSessions.length === 0}
          >
            {importing ? "导入中…" : "确认导入"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}