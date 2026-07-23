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
  Shield,
  Settings2,
  Bot,
  Info,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
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
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { useConfirm } from "@/components/ConfirmDialog";
import type { EnvProfile } from "@/lib/types";

interface FeishuStatus {
  connected: boolean;
  appId?: string;
  domain?: string;
}

export function SettingsPage() {
  const confirm = useConfirm();
  const [profiles, setProfiles] = useState<EnvProfile[]>([]);
  const [loading, setLoading] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<{
    name: string;
    env: EnvValues;
  }>({ name: "", env: {} });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [feishuStatus, setFeishuStatus] = useState<FeishuStatus>({
    connected: false,
  });
  const [feishuBinding, setFeishuBinding] = useState(false);
  const [feishuQRCode, setFeishuQRCode] = useState<string | null>(null);
  const [feishuBindingStatus, setFeishuBindingStatus] = useState<string | null>(
    null,
  );

  useEffect(() => {
    fetch("/api/feishu/status")
      .then((res) => res.json())
      .then(setFeishuStatus)
      .catch(() => setFeishuStatus({ connected: false }));
  }, []);

  async function handleFeishuBind() {
    setFeishuBinding(true);
    setFeishuQRCode(null);
    setFeishuBindingStatus(null);

    try {
      const res = await fetch("/api/feishu/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value);

        while (buffer.includes("\n\n")) {
          const boundaryIndex = buffer.indexOf("\n\n");
          const eventBlock = buffer.substring(0, boundaryIndex);
          buffer = buffer.substring(boundaryIndex + 2);

          const lines = eventBlock.split("\n");
          let eventType = "";
          let eventData: Record<string, unknown> = {};

          for (const line of lines) {
            if (line.startsWith("event: ")) {
              eventType = line.replace("event: ", "").trim();
            } else if (line.startsWith("data: ")) {
              try {
                eventData = JSON.parse(line.replace("data: ", "").trim());
              } catch {
                // ignore parse errors
              }
            }
          }

          if (eventType === "qr_code" && eventData.url) {
            setFeishuQRCode(String(eventData.url));
          } else if (eventType === "waiting_for_scan") {
            setFeishuBindingStatus("waiting");
          } else if (eventType === "connected") {
            setFeishuBindingStatus("connected");
            setFeishuStatus({
              connected: true,
              appId: String(eventData.appId || ""),
              domain: String(eventData.domain || "feishu"),
            });
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
            setFeishuStatus({
              connected: true,
              appId: String(eventData.appId || ""),
              domain: String(eventData.domain || "feishu"),
            });
            setTimeout(() => {
              setFeishuBinding(false);
              setFeishuQRCode(null);
              setFeishuBindingStatus(null);
            }, 2000);
          }
        }
      }
    } catch (e) {
      console.error("Feishu bind error:", e);
      setFeishuBindingStatus("error");
      setFeishuBinding(false);
    }
  }

  async function handleFeishuDisconnect() {
    if (
      !(await confirm({
        title: "断开飞书绑定",
        description: "确定断开飞书绑定？",
        confirmLabel: "断开",
      }))
    )
      return;
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
    void refresh();
  }, [refresh]);

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
    if (
      !(await confirm({
        title: "删除配置",
        description: `确定删除配置「${p.name}」？`,
        variant: "destructive",
        confirmLabel: "删除",
      }))
    )
      return;
    try {
      await deleteProfile(p.id);
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      {/* ── 页头 ── */}
      <header className="sticky top-0 z-10 border-b border-border/30 bg-background/80 backdrop-blur-xl">
        <div className="mx-auto max-w-2xl pl-14 pr-4 pt-3 pb-3 md:px-6 md:py-4">
          <h1 className="text-lg font-semibold tracking-tight sm:text-xl">
            设置
          </h1>
        </div>
      </header>

      {/* ── 内容区 ── */}
      <div className="mx-auto w-full max-w-2xl space-y-10 pl-14 pr-4 py-6 md:px-6 md:py-10">
        {/* ── 环境变量配置 ── */}
        <section>
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex items-center gap-2.5">
              <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10">
                <Settings2 className="h-3.5 w-3.5 text-primary" />
              </div>
              <div>
                <h2 className="text-sm font-semibold tracking-tight">
                  环境变量配置
                </h2>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  新建会话时可选一套配置；留空则使用 CLI 默认值
                </p>
              </div>
            </div>
            {editingId === null && (
              <Button onClick={startNew} size="sm" className="self-end sm:self-center">
                <Plus className="h-3.5 w-3.5" />
                新建
              </Button>
            )}
          </div>

          {editingId === null ? (
            <ListView
              profiles={profiles}
              loading={loading}
              err={err}
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
              onCancel={() => {
                setErr(null);
                setEditingId(null);
              }}
              onSave={save}
              isNew={editingId === "new"}
            />
          )}
        </section>

        <Separator className="opacity-30" />

        {/* ── 飞书绑定 ── */}
        <section>
          <div className="mb-4 flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10">
              <Bot className="h-3.5 w-3.5 text-primary" />
            </div>
            <h2 className="text-sm font-semibold tracking-tight">
              飞书机器人绑定
            </h2>
          </div>

          <div className="overflow-hidden rounded-xl border border-border/50 bg-card/40 shadow-sm">
            {feishuBinding ? (
              <div className="flex flex-col items-center gap-5 px-4 py-10 sm:px-6">
                {feishuQRCode ? (
                  <>
                    <p className="text-sm font-medium">
                      使用飞书扫码完成绑定
                    </p>
                    <div className="rounded-xl border border-border/30 bg-white p-3 shadow-sm">
                      <QRCodeSVG value={feishuQRCode} size={160} level="H" />
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {feishuBindingStatus === "waiting" && (
                        <span className="inline-flex items-center gap-1.5">
                          <span className="h-2 w-2 animate-pulse rounded-full bg-amber-400" />
                          等待扫码…
                        </span>
                      )}
                      {feishuBindingStatus === "connected" && (
                        <span className="inline-flex items-center gap-1.5 font-medium text-emerald-500">
                          <Check className="h-3.5 w-3.5" />
                          绑定成功
                        </span>
                      )}
                      {feishuBindingStatus === "error" && (
                        <span className="text-destructive">
                          绑定失败，请重试
                        </span>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="flex items-center gap-3 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    正在生成二维码…
                  </div>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setFeishuBinding(false)}
                >
                  <X className="h-3.5 w-3.5" />
                  取消绑定
                </Button>
              </div>
            ) : feishuStatus.connected ? (
              <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
                <div className="flex items-start gap-3.5 sm:gap-4">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-500/10 sm:h-10 sm:w-10">
                    <Check className="h-4 w-4 text-emerald-500" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">已连接</span>
                      <Badge
                        variant="outline"
                        className="border-emerald-500/30 bg-emerald-500/5 text-[10px] text-emerald-400"
                      >
                        运行中
                      </Badge>
                    </div>
                    <div className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                      <div className="truncate">
                        App ID:{" "}
                        <code className="rounded bg-muted/60 px-1 py-0.5 text-[11px]">
                          {feishuStatus.appId}
                        </code>
                      </div>
                      {feishuStatus.domain && (
                        <div className="truncate">
                          Domain:{" "}
                          <code className="rounded bg-muted/60 px-1 py-0.5 text-[11px]">
                            {feishuStatus.domain}
                          </code>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleFeishuDisconnect}
                  className="shrink-0 self-end text-xs text-muted-foreground hover:text-destructive sm:self-center"
                >
                  断开
                </Button>
              </div>
            ) : (
              <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
                <div className="flex items-start gap-3.5 sm:gap-4">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-muted/80 sm:h-10 sm:w-10">
                    <QrCode className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div>
                    <p className="text-sm font-medium">尚未绑定</p>
                    <p className="mt-1 max-w-xs text-xs text-muted-foreground">
                      绑定后可在飞书中直接与 Claude 对话，接收会话状态通知
                    </p>
                  </div>
                </div>
                <Button
                  onClick={handleFeishuBind}
                  size="sm"
                  className="shrink-0 self-end sm:self-center"
                >
                  <QrCode className="h-3.5 w-3.5" />
                  扫码绑定
                </Button>
              </div>
            )}
          </div>
        </section>

        <Separator className="opacity-30" />

        {/* ── 会话共享说明 ── */}
        <section>
          <div className="mb-4 flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10">
              <Info className="h-3.5 w-3.5 text-primary" />
            </div>
            <h2 className="text-sm font-semibold tracking-tight">
              会话共享与多端使用
            </h2>
          </div>

          <div className="space-y-4 rounded-xl border border-border/50 bg-card/40 p-4 text-xs leading-relaxed text-muted-foreground sm:p-5">
            <p>
              本工具设计为<strong className="font-medium text-foreground">
                单进程本地使用
              </strong>
              ，不推荐同时启动多个实例，与 Claude Code CLI 的会话共享能力有限。
            </p>

            <div className="space-y-2">
              <p className="font-medium text-foreground">按场景的共享能力：</p>
              <ul className="space-y-1.5">
                <li className="flex gap-2">
                  <span className="shrink-0 text-emerald-500">✓</span>
                  <span>
                    <strong className="font-medium text-foreground">
                      同进程多标签页
                    </strong>
                    ：完全共享（实时流、运行状态、发消息、审批）
                  </span>
                </li>
                <li className="flex gap-2">
                  <span className="shrink-0 text-amber-500">~</span>
                  <span>
                    <strong className="font-medium text-foreground">
                      多个 Web UI 进程 / 与 Claude Code CLI
                    </strong>
                    ：仅静态共享——会话列表和历史消息互通，但
                    <strong className="font-medium text-foreground">
                      看不到对方的实时输出、运行状态、也无法中止对方
                    </strong>
                  </span>
                </li>
              </ul>
            </div>

            <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
              <p className="text-amber-600 dark:text-amber-400">
                <strong className="font-medium">需要完整共享？</strong>
                用远程控制（手机扫码连接本浏览器）即可——它走的是同一个运行实例，
                实时流、状态、操作全部互通。
              </p>
            </div>
          </div>
        </section>

        <div className="pb-8" />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// 列表态
// ─────────────────────────────────────────────────────────────

function ListView({
  profiles,
  loading,
  err,
  onEdit,
  onDuplicate,
  onDelete,
}: {
  profiles: EnvProfile[];
  loading: boolean;
  err: string | null;
  onEdit: (p: EnvProfile) => void;
  onDuplicate: (p: EnvProfile) => void;
  onDelete: (p: EnvProfile) => void;
}) {
  if (loading) {
    return (
      <div className="flex flex-col items-center gap-4 py-20">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        <Skeleton className="h-4 w-40" />
      </div>
    );
  }

  if (profiles.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border/60 py-16">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted/80">
          <Shield className="h-4 w-4 text-muted-foreground" />
        </div>
        <p className="text-sm text-muted-foreground">还没有环境配置</p>
        <p className="max-w-xs text-center text-xs text-muted-foreground/60">
          点击上方"新建"创建第一套配置
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {err && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-2.5 text-xs text-destructive">
          {err}
        </div>
      )}
      <ul className="space-y-2">
        {profiles.map((p) => (
          <li
            key={p.id}
            className="group relative flex flex-col gap-3 rounded-xl border border-border/50 bg-card/40 px-4 py-3.5 transition-all hover:border-border hover:bg-card/60 sm:flex-row sm:items-center"
          >
            {/* 左侧色条 */}
            <div className="absolute inset-y-2 left-0 w-[3px] rounded-full bg-primary/40" />

            <div className="min-w-0 flex-1 pl-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium">{p.name}</span>
                {summarizeFieldCount(p) > 0 && (
                  <Badge variant="secondary" className="shrink-0 text-[10px]">
                    {summarizeFieldCount(p)} 项
                  </Badge>
                )}
              </div>
              <div className="mt-1 truncate text-xs text-muted-foreground">
                {summarizeProfile(p)}
              </div>
            </div>

            {/* 操作按钮：移动端始终可见，桌面端 hover 显示 */}
            <div className="flex shrink-0 items-center gap-0.5 self-end transition-opacity sm:opacity-0 sm:group-hover:opacity-100">
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => onEdit(p)}
                title="编辑"
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => onDuplicate(p)}
                title="复制"
              >
                <Copy className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => onDelete(p)}
                title="删除"
                className="hover:text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function summarizeProfile(p: EnvProfile): string {
  const setFields = ENV_FIELDS.filter(
    (f) => p.env[f.name] && p.env[f.name].trim(),
  );
  if (setFields.length === 0) return "空配置 · 纯 CLI 默认";
  return setFields.map((f) => `${f.label}=${p.env[f.name]}`).join(" · ");
}

function summarizeFieldCount(p: EnvProfile): number {
  return ENV_FIELDS.filter(
    (f) => p.env[f.name] && p.env[f.name].trim(),
  ).length;
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
  const [revealedFields, setRevealedFields] = useState<Set<string>>(new Set());

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
    <div className="space-y-4">
      {err && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-2.5 text-xs text-destructive">
          {err}
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-border/50 bg-card/40 shadow-sm">
        {/* 编辑标题 */}
        <div className="border-b border-border/40 px-4 py-3 sm:px-5">
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="text-[10px]">
              {isNew ? "新建" : "编辑"}
            </Badge>
            <span className="text-xs text-muted-foreground">
              {isNew
                ? "创建一套新的环境变量配置"
                : "修改已有配置的环境变量"}
            </span>
          </div>
        </div>

        <div className="space-y-5 px-4 py-5 sm:px-5">
          {/* 配置名 */}
          <div>
            <Label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              配置名称
            </Label>
            <Input
              type="text"
              value={form.name}
              onChange={(e) =>
                setForm((f) => ({ ...f, name: e.target.value }))
              }
              placeholder="如：生产环境 / 测试环境"
              className="bg-background/60"
            />
          </div>

          {/* 敏感值切换 */}
          <div className="flex items-center justify-between border-b border-border/30 pb-4">
            <span className="text-xs font-medium text-muted-foreground">
              环境变量
            </span>
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
                <>
                  <EyeOff className="h-3.5 w-3.5" />
                  隐藏敏感值
                </>
              ) : (
                <>
                  <Eye className="h-3.5 w-3.5" />
                  显示敏感值
                </>
              )}
            </Button>
          </div>

          {/* 字段列表 */}
          <div className="space-y-4">
            {ENV_FIELDS.map((f) => (
              <div key={f.name}>
                <label className="mb-1.5 flex items-center gap-2">
                  <span className="text-sm font-medium text-foreground">
                    {f.label}
                  </span>
                  <code className="rounded-md bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                    {f.name}
                  </code>
                </label>
                {f.type === "select" ? (
                  <Select
                    value={form.env[f.name] ?? ""}
                    items={Object.fromEntries(
                      (f.options ?? []).map((opt) => [opt, opt]),
                    )}
                    onValueChange={(value) =>
                      setForm((prev) => ({
                        ...prev,
                        env: { ...prev.env, [f.name]: value ?? "" },
                      }))
                    }
                  >
                    <SelectTrigger className="w-full bg-background/60 font-mono text-sm">
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
                      className="bg-background/60 pr-9 font-mono text-sm"
                    />
                    <button
                      type="button"
                      onClick={() => toggleSingleField(f.name)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
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
                    className="bg-background/60 font-mono text-sm"
                  />
                )}
                {f.help && (
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    {f.help}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 操作栏 */}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
        <span className="text-xs text-muted-foreground">
          留空的字段 = 不设置，使用 CLI 默认
        </span>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={onCancel}>
            取消
          </Button>
          <Button onClick={onSave} disabled={saving} size="sm">
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            保存
          </Button>
        </div>
      </div>
    </div>
  );
}
