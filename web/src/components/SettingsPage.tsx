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
  Shield,
  Settings2,
  Info,
  GripVertical,
} from "lucide-react";
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import { ENV_FIELDS, pruneEnvValues, type EnvValues } from "@/lib/envFields";
import {
  createProfile,
  updateProfile,
  deleteProfile,
  reorderProfiles,
  getVersion,
} from "@/lib/api";
import { useProfiles, refreshProfiles, setProfiles as setProfilesGlobal } from "@/lib/profilesStore";
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
import { cn } from "@/lib/utils";
import type { EnvProfile } from "@/lib/types";

export function SettingsPage() {
  const confirm = useConfirm();
  // profiles 来自全局 store（与 ChatThread 等共享），增删改后用 refreshProfiles 同步全局
  const { profiles } = useProfiles();
  const [loading, setLoading] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<{
    name: string;
    env: EnvValues;
  }>({ name: "", env: {} });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /** 版本信息：undefined=未取到；{webui, claudeCode} */
  const [versionInfo, setVersionInfo] = useState<{
    webui: string;
    claudeCode: string | null;
  } | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      await refreshProfiles();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // store 已在应用启动时预取，这里仅确保进入设置页时数据是最新的
    void refresh();
  }, [refresh]);

  // 版本信息：claudeCode 首次可能为 null（后端正在 prime），轮询直到拿到或用尽次数
  useEffect(() => {
    let cancelled = false;
    let tries = 0;
    const poll = async () => {
      while (tries < 6 && !cancelled) {
        tries++;
        try {
          const r = await getVersion();
          if (cancelled) return;
          setVersionInfo(r);
          if (r.claudeCode) return;
        } catch {
          /* 忽略，继续重试 */
        }
        await new Promise((res) => setTimeout(res, 1500));
      }
    };
    void poll();
    return () => {
      cancelled = true;
    };
  }, []);

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

  // 拖拽排序：乐观更新全局 store 顺序，失败回滚并提示
  async function handleReorder(ids: string[]) {
    const prev = profiles;
    const next = ids
      .map((id) => prev.find((p) => p.id === id))
      .filter((p): p is EnvProfile => Boolean(p));
    setProfilesGlobal(next);
    try {
      const reordered = await reorderProfiles(ids);
      setProfilesGlobal(reordered);
    } catch (e) {
      setProfilesGlobal(prev);
      setErr(`排序失败：${(e as Error).message}`);
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
              onReorder={handleReorder}
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

        <footer className="pb-8 pt-2 text-center text-xs text-muted-foreground/50">
          {versionInfo?.webui && `Claude WebUI ${versionInfo.webui}`}
          {versionInfo?.webui && versionInfo?.claudeCode ? " · " : ""}
          Claude Code{versionInfo?.claudeCode ? ` ${versionInfo.claudeCode}` : ""}
        </footer>
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
  onReorder,
}: {
  profiles: EnvProfile[];
  loading: boolean;
  err: string | null;
  onEdit: (p: EnvProfile) => void;
  onDuplicate: (p: EnvProfile) => void;
  onDelete: (p: EnvProfile) => void;
  onReorder: (ids: string[]) => void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

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

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ids = profiles.map((p) => p.id);
    const oldIndex = ids.indexOf(String(active.id));
    const newIndex = ids.indexOf(String(over.id));
    if (oldIndex < 0 || newIndex < 0) return;
    onReorder(arrayMove(ids, oldIndex, newIndex));
  }

  return (
    <div className="space-y-2">
      {err && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-2.5 text-xs text-destructive">
          {err}
        </div>
      )}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToVerticalAxis]}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={profiles.map((p) => p.id)}
          strategy={verticalListSortingStrategy}
        >
          <ul className="space-y-2">
            {profiles.map((p) => (
              <SortableProfileItem
                key={p.id}
                profile={p}
                onEdit={onEdit}
                onDuplicate={onDuplicate}
                onDelete={onDelete}
              />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
    </div>
  );
}

function SortableProfileItem({
  profile: p,
  onEdit,
  onDuplicate,
  onDelete,
}: {
  profile: EnvProfile;
  onEdit: (p: EnvProfile) => void;
  onDuplicate: (p: EnvProfile) => void;
  onDelete: (p: EnvProfile) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: p.id });

  return (
    <li
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
      className={cn(
        "group relative flex flex-col gap-3 rounded-xl border border-border/50 bg-card/40 px-4 py-3.5 transition-all hover:border-border hover:bg-card/60 sm:flex-row sm:items-center",
        isDragging && "z-10 cursor-grabbing border-primary/40 bg-card shadow-lg",
      )}
    >
      {/* 左侧色条 */}
      <div className="absolute inset-y-2 left-0 w-[3px] rounded-full bg-primary/40" />

      {/* 拖拽手柄 */}
      <button
        ref={setActivatorNodeRef}
        type="button"
        aria-label="拖拽排序"
        {...attributes}
        {...listeners}
        className="flex shrink-0 cursor-grab touch-none self-center pl-0.5 text-muted-foreground/40 transition-colors hover:text-muted-foreground active:cursor-grabbing sm:-ml-1"
        tabIndex={-1}
      >
        <GripVertical className="h-4 w-4" />
      </button>

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
      <div className="flex shrink-0 items-center gap-0.5 self-end transition-opacity sm:self-center sm:opacity-0 sm:group-hover:opacity-100">
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
                    <SelectTrigger className="w-full bg-background/60 text-sm">
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
                      className="bg-background/60 pr-9 text-sm"
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
                    className="bg-background/60 text-sm"
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
