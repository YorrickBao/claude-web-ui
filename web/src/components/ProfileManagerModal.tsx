import { useEffect, useState, useCallback } from "react";
import {
  Plus,
  Trash2,
  Pencil,
  Save,
  Eye,
  EyeOff,
  Loader2,
  Copy,
  QrCode,
  X,
  Check,
} from "lucide-react";
import { ENV_FIELDS, pruneEnvValues, type EnvValues } from "@/lib/envFields";
import {
  listProfiles,
  createProfile,
  updateProfile,
  deleteProfile,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import type { EnvProfile } from "@/lib/types";

interface FeishuStatus {
  connected: boolean;
  appId?: string;
  domain?: string;
}

/**
 * Profile 管理器：列出所有 profile，支持新建/编辑/删除/复制。
 *
 * 这个 modal 只负责"管理 profile 本身"，不负责"给会话选 profile"
 * —— 选 profile 的逻辑在 NewSessionView 和 ChatView 头部各有一份。
 */
export interface ProfileManagerModalProps {
  open: boolean;
  onClose: () => void;
  /** 当 profile 列表变化时通知（让外层刷新会话列表等） */
  onChanged?: () => void;
}

export function ProfileManagerModal({
  open,
  onClose,
  onChanged,
}: ProfileManagerModalProps) {
  const [profiles, setProfiles] = useState<EnvProfile[]>([]);
  const [loading, setLoading] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<{
    name: string;
    env: EnvValues;
  }>({ name: "", env: {} });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [feishuStatus, setFeishuStatus] = useState<FeishuStatus>({ connected: false });
  const [feishuBinding, setFeishuBinding] = useState(false);
  const [feishuQRCode, setFeishuQRCode] = useState<string | null>(null);
  const [feishuBindingStatus, setFeishuBindingStatus] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    fetch("/api/feishu/status")
      .then((res) => res.json())
      .then(setFeishuStatus)
      .catch(() => setFeishuStatus({ connected: false }));
  }, [open]);

  async function handleFeishuBind() {
    setFeishuBinding(true);
    setFeishuQRCode(null);
    setFeishuBindingStatus(null);

    try {
      const res = await fetch("/api/feishu/connect", { method: "POST" });
      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const text = decoder.decode(value);
        const lines = text.split("\n");
        for (const line of lines) {
          if (line.startsWith("event: ")) {
            const eventType = line.replace("event: ", "").trim();
            const nextLine = lines[lines.indexOf(line) + 1];
            if (nextLine?.startsWith("data: ")) {
              try {
                const data = JSON.parse(nextLine.replace("data: ", "").trim());
                if (eventType === "qr_code") {
                  setFeishuQRCode(data.url);
                } else if (eventType === "waiting_for_scan") {
                  setFeishuBindingStatus("waiting");
                } else if (eventType === "connected") {
                  setFeishuBindingStatus("connected");
                  setFeishuStatus({ connected: true, appId: data.appId, domain: data.domain });
                  setTimeout(() => {
                    setFeishuBinding(false);
                    setFeishuQRCode(null);
                    setFeishuBindingStatus(null);
                  }, 2000);
                } else if (eventType === "error") {
                  setFeishuBindingStatus("error");
                  setFeishuBinding(false);
                } else if (eventType === "success") {
                  setFeishuBindingStatus("success");
                  setFeishuStatus({ connected: true, appId: data.appId, domain: data.domain });
                  setTimeout(() => {
                    setFeishuBinding(false);
                    setFeishuQRCode(null);
                    setFeishuBindingStatus(null);
                  }, 2000);
                }
              } catch {
                // ignore parse errors
              }
            }
          }
        }
      }
    } catch (e) {
      setFeishuBindingStatus("error");
      setFeishuBinding(false);
    }
  }

  async function handleFeishuDisconnect() {
    if (!confirm("确定断开飞书绑定？")) return;
    try {
      await fetch("/api/feishu/disconnect", { method: "POST" });
      setFeishuStatus({ connected: false });
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  const refresh = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      setProfiles(await listProfiles());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  useEffect(() => {
    if (open) onChanged?.();
  }, [profiles, open, onChanged]);

  function startNew() {
    const empty: EnvValues = {};
    for (const f of ENV_FIELDS) empty[f.name] = "";
    setEditForm({ name: "新配置", env: empty });
    setEditingId("new");
  }

  function startEdit(p: EnvProfile) {
    const env: EnvValues = {};
    for (const f of ENV_FIELDS) env[f.name] = p.env[f.name] ?? "";
    setEditForm({ name: p.name, env });
    setEditingId(p.id);
  }

  function startDuplicate(p: EnvProfile) {
    const env: EnvValues = {};
    for (const f of ENV_FIELDS) env[f.name] = p.env[f.name] ?? "";
    setEditForm({ name: p.name + " 副本", env });
    setEditingId("new");
  }

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      const env = pruneEnvValues(editForm.env);
      if (editingId === "new") {
        await createProfile(editForm.name, env);
      } else if (editingId) {
        await updateProfile(editingId, { name: editForm.name, env });
      }
      await refresh();
      setEditingId(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function remove(p: EnvProfile) {
    if (!confirm(`确定删除配置「${p.name}」？`)) return;
    try {
      await deleteProfile(p.id);
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="max-h-[95vh] max-w-[calc(100%-0.5rem)] sm:max-w-2xl md:max-w-4xl">
        <DialogHeader>
          <DialogTitle>环境变量配置</DialogTitle>
        </DialogHeader>

        <div className="mb-4 border-b border-border pb-4">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <QrCode className="h-4 w-4 text-primary" />
              <span className="text-sm font-medium">飞书机器人绑定</span>
            </div>
            {feishuStatus.connected && (
              <div className="flex items-center gap-1 text-xs text-green-500">
                <Check className="h-3 w-3" />
                已绑定
              </div>
            )}
          </div>

          {feishuBinding ? (
            <div className="flex flex-col items-center gap-4 p-6 bg-muted/50 rounded-lg">
              {feishuQRCode ? (
                <>
                  <div className="text-sm text-muted-foreground">使用飞书扫码绑定</div>
                  <img src={feishuQRCode} alt="QR Code" className="h-48 w-48 rounded-lg border border-border" />
                  <div className="text-xs text-muted-foreground">
                    {feishuBindingStatus === "waiting" && "等待扫码..."}
                    {feishuBindingStatus === "connected" && "✓ 绑定成功！"}
                    {feishuBindingStatus === "error" && "✗ 绑定失败"}
                  </div>
                </>
              ) : (
                <div className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span className="text-sm">生成二维码中...</span>
                </div>
              )}
              <Button variant="outline" size="sm" onClick={() => setFeishuBinding(false)}>
                <X className="h-3 w-3" />
                取消
              </Button>
            </div>
          ) : feishuStatus.connected ? (
            <div className="flex items-center justify-between rounded-lg border border-border bg-card/40 px-4 py-3">
              <div className="text-sm">
                <div className="font-medium">App ID: {feishuStatus.appId}</div>
                <div className="text-xs text-muted-foreground">Domain: {feishuStatus.domain}</div>
              </div>
              <Button variant="outline" size="sm" onClick={handleFeishuDisconnect} className="text-destructive hover:text-destructive">
                断开绑定
              </Button>
            </div>
          ) : (
            <div className="flex items-center justify-between rounded-lg border border-dashed border-border p-4">
              <div>
                <div className="text-sm font-medium">扫码绑定飞书机器人</div>
                <div className="text-xs text-muted-foreground">绑定后可在飞书中直接使用 Claude</div>
              </div>
              <Button variant="default" size="sm" onClick={handleFeishuBind}>
                <QrCode className="h-3 w-3" />
                扫码绑定
              </Button>
            </div>
          )}
        </div>

        {editingId === null ? (
          <ListView
            profiles={profiles}
            loading={loading}
            err={err}
            onNew={startNew}
            onEdit={startEdit}
            onDuplicate={startDuplicate}
            onDelete={remove}
          />
        ) : (
          <EditView
            form={editForm}
            setForm={setEditForm}
            saving={saving}
            err={err}
            onCancel={() => setEditingId(null)}
            onSave={save}
            isNew={editingId === "new"}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────
// 列表态
// ─────────────────────────────────────────────────────────────

function ListView({
  profiles,
  loading,
  err,
  onNew,
  onEdit,
  onDuplicate,
  onDelete,
}: {
  profiles: EnvProfile[];
  loading: boolean;
  err: string | null;
  onNew: () => void;
  onEdit: (p: EnvProfile) => void;
  onDuplicate: (p: EnvProfile) => void;
  onDelete: (p: EnvProfile) => void;
}) {
  return (
    <>
      <div className="border-b border-border bg-card/50 px-5 py-2 text-xs text-muted-foreground">
        新建会话时从这里选一套。空 profile（字段都留空）= 完全用 CLI 默认。
      </div>
      <div className="max-h-[40vh] overflow-y-auto px-3 py-3 md:max-h-[60vh]">
        {loading ? (
          <div className="flex flex-col items-center gap-3 py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            <Skeleton className="h-4 w-32" />
          </div>
        ) : profiles.length === 0 ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            还没有配置。点下方"+ 新建"创建第一套。
          </div>
        ) : (
          <ul className="space-y-1.5">
            {profiles.map((p) => (
              <li
                key={p.id}
                className="flex items-center gap-2 rounded-lg border border-border bg-card/40 px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-foreground">
                    {p.name}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {summarizeProfile(p)}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => onEdit(p)}
                  title="编辑"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => onDuplicate(p)}
                  title="复制"
                >
                  <Copy className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => onDelete(p)}
                  title="删除"
                  className="hover:text-destructive"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <DialogFooter className="flex items-center justify-between">
        <div className="text-xs">
          {err && <span className="text-destructive">⚠ {err}</span>}
        </div>
        <Button onClick={onNew} variant="default">
          <Plus className="h-3.5 w-3.5" />
          新建
        </Button>
      </DialogFooter>
    </>
  );
}

/** profile 一行小摘要：取已设字段拼一下 */
function summarizeProfile(p: EnvProfile): string {
  const setFields = ENV_FIELDS.filter(
    (f) => p.env[f.name] && p.env[f.name].trim(),
  );
  if (setFields.length === 0) return "（空 · 纯 CLI 默认）";
  return setFields.map((f) => `${f.label}=${p.env[f.name]}`).join(" · ");
}

// ─────────────────────────────────────────────────────────────
// 编辑态
// ─────────────────────────────────────────────────────────────

function EditView({
  form,
  setForm,
  saving,
  err,
  onCancel,
  onSave,
  isNew,
}: {
  form: { name: string; env: EnvValues };
  setForm: React.Dispatch<
    React.SetStateAction<{ name: string; env: EnvValues }>
  >;
  saving: boolean;
  err: string | null;
  onCancel: () => void;
  onSave: () => void;
  isNew: boolean;
}) {
  const [showSecrets, setShowSecrets] = useState(false);
  /** 独立显隐的敏感字段（全局关闭时，可单独点开某个字段） */
  const [revealedFields, setRevealedFields] = useState<Set<string>>(
    new Set(),
  );

  const isSecretRevealed = (name: string) =>
    showSecrets || revealedFields.has(name);

  const toggleSingleField = (name: string) =>
    setRevealedFields((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  return (
    <>
      <div className="border-b border-border bg-card/50 px-5 py-2 text-xs text-muted-foreground">
        {isNew ? "新建配置" : "编辑配置"}
      </div>
      <div className="max-h-[35vh] overflow-y-auto px-5 py-4 md:max-h-[55vh]">
        {/* 配置名 */}
        <div className="mb-4">
          <Label className="mb-1 block text-sm font-medium text-foreground">
            配置名
          </Label>
          <Input
            type="text"
            value={form.name}
            onChange={(e) =>
              setForm((f) => ({ ...f, name: e.target.value }))
            }
            placeholder="如：生产 / 测试 / 某代理"
            className="bg-card"
          />
        </div>

        <div className="mb-3 flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setShowSecrets((v) => !v);
              if (!showSecrets) setRevealedFields(new Set());
            }}
            className="text-xs"
          >
            {showSecrets ? (
              <EyeOff className="h-3.5 w-3.5" />
            ) : (
              <Eye className="h-3.5 w-3.5" />
            )}
            {showSecrets ? "隐藏敏感值" : "显示敏感值"}
          </Button>
        </div>

        <div className="space-y-4">
          {ENV_FIELDS.map((f) => (
            <div key={f.name}>
              <label className="mb-1 flex items-center gap-2 text-sm">
                <span className="font-medium text-foreground">
                  {f.label}
                </span>
                <code className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  {f.name}
                </code>
              </label>
              {f.type === "select" ? (
                <Select
                  value={form.env[f.name] ?? ""}
                  onValueChange={(value) =>
                    setForm((prev) => ({
                      ...prev,
                      env: { ...prev.env, [f.name]: value ?? "" },
                    }))
                  }
                >
                  <SelectTrigger className="w-full font-mono text-sm">
                    <SelectValue placeholder={f.placeholder} />
                  </SelectTrigger>
                  <SelectContent>
                    {(f.options ?? []).map((opt) => (
                      <SelectItem key={opt} value={opt}>
                        {opt}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : f.secret ? (
                <div className="relative">
                  <Input
                    type={isSecretRevealed(f.name) ? "text" : "password"}
                    value={form.env[f.name] ?? ""}
                    onChange={(e) =>
                      setForm((prev) => ({
                        ...prev,
                        env: { ...prev.env, [f.name]: e.target.value },
                      }))
                    }
                    placeholder={f.placeholder}
                    className="pr-8 font-mono text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => toggleSingleField(f.name)}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground transition-colors"
                    tabIndex={-1}
                  >
                    {isSecretRevealed(f.name) ? (
                      <EyeOff className="h-3.5 w-3.5" />
                    ) : (
                      <Eye className="h-3.5 w-3.5" />
                    )}
                  </button>
                </div>
              ) : (
                <Input
                  type={f.type === "number" ? "number" : "text"}
                  min={f.type === "number" ? 0 : undefined}
                  step={f.type === "number" ? 1 : undefined}
                  value={form.env[f.name] ?? ""}
                  onChange={(e) =>
                    setForm((prev) => ({
                      ...prev,
                      env: { ...prev.env, [f.name]: e.target.value },
                    }))
                  }
                  placeholder={f.placeholder}
                  className="font-mono text-sm"
                />
              )}
              {f.help && (
                <div className="mt-1 text-xs text-muted-foreground">{f.help}</div>
              )}
            </div>
          ))}
        </div>
      </div>
      <DialogFooter className="flex items-center justify-between">
        <div className="text-xs">
          {err ? (
            <span className="text-destructive">⚠ {err}</span>
          ) : (
            <span className="text-muted-foreground">空值 = 不设置</span>
          )}
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={onCancel}
          >
            取消
          </Button>
          <Button
            onClick={onSave}
            disabled={saving}
          >
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            保存
          </Button>
        </div>
      </DialogFooter>
    </>
  );
}