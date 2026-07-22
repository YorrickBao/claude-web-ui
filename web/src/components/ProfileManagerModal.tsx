import { useEffect, useState, useCallback } from "react";
import {
  X,
  Plus,
  Trash2,
  Pencil,
  Save,
  Eye,
  EyeOff,
  Loader2,
  Copy,
} from "lucide-react";
import { ENV_FIELDS, pruneEnvValues, type EnvValues } from "@/lib/envFields";
import {
  listProfiles,
  createProfile,
  updateProfile,
  deleteProfile,
} from "@/lib/api";
import type { EnvProfile } from "@/lib/types";

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
  // 当前编辑的 profile id；"new" = 新建中；null = 列表态
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<{
    name: string;
    env: EnvValues;
  }>({ name: "", env: {} });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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

  // 列表变化时通知外层
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

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-2xl overflow-hidden rounded-2xl border border-neutral-700 bg-neutral-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between border-b border-neutral-800 px-5 py-3">
          <div className="text-sm font-semibold text-neutral-100">
            环境变量配置
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {editingId === null ? (
          /* 列表态 */
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
          /* 编辑态 */
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
      <div className="border-b border-neutral-800 bg-neutral-950/50 px-5 py-2 text-xs text-neutral-400">
        新建会话时从这里选一套。空 profile（字段都留空）= 完全用 CLI 默认。
      </div>
      <div className="max-h-[60vh] overflow-y-auto px-3 py-3">
        {loading ? (
          <div className="flex items-center justify-center py-8 text-sm text-neutral-500">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 加载中…
          </div>
        ) : profiles.length === 0 ? (
          <div className="py-10 text-center text-sm text-neutral-500">
            还没有配置。点下方"+ 新建"创建第一套。
          </div>
        ) : (
          <ul className="space-y-1.5">
            {profiles.map((p) => (
              <li
                key={p.id}
                className="flex items-center gap-2 rounded-lg border border-neutral-800 bg-neutral-950/40 px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-neutral-100">
                    {p.name}
                  </div>
                  <div className="truncate text-xs text-neutral-500">
                    {summarizeProfile(p)}
                  </div>
                </div>
                <button
                  onClick={() => onEdit(p)}
                  title="编辑"
                  className="rounded p-1.5 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => onDuplicate(p)}
                  title="复制"
                  className="rounded p-1.5 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
                >
                  <Copy className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => onDelete(p)}
                  title="删除"
                  className="rounded p-1.5 text-neutral-400 hover:bg-neutral-800 hover:text-red-400"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex items-center justify-between border-t border-neutral-800 px-5 py-3">
        <div className="text-xs">
          {err && <span className="text-red-400">⚠ {err}</span>}
        </div>
        <button
          onClick={onNew}
          className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-hover"
        >
          <Plus className="h-3.5 w-3.5" />
          新建
        </button>
      </div>
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

  return (
    <>
      <div className="border-b border-neutral-800 bg-neutral-950/50 px-5 py-2 text-xs text-neutral-400">
        {isNew ? "新建配置" : "编辑配置"}
      </div>
      <div className="max-h-[55vh] overflow-y-auto px-5 py-4">
        {/* 配置名 */}
        <div className="mb-4">
          <label className="mb-1 block text-sm font-medium text-neutral-200">
            配置名
          </label>
          <input
            type="text"
            value={form.name}
            onChange={(e) =>
              setForm((f) => ({ ...f, name: e.target.value }))
            }
            placeholder="如：生产 / 测试 / 某代理"
            className="w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-accent focus:outline-none"
          />
        </div>

        <div className="mb-3 flex justify-end">
          <button
            onClick={() => setShowSecrets((v) => !v)}
            className="flex items-center gap-1 text-xs text-neutral-400 hover:text-neutral-200"
          >
            {showSecrets ? (
              <EyeOff className="h-3.5 w-3.5" />
            ) : (
              <Eye className="h-3.5 w-3.5" />
            )}
            {showSecrets ? "隐藏敏感值" : "显示敏感值"}
          </button>
        </div>

        <div className="space-y-4">
          {ENV_FIELDS.map((f) => (
            <div key={f.name}>
              <label className="mb-1 flex items-center gap-2 text-sm">
                <span className="font-medium text-neutral-200">
                  {f.label}
                </span>
                <code className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-400">
                  {f.name}
                </code>
              </label>
              <input
                type={f.secret && !showSecrets ? "password" : "text"}
                value={form.env[f.name] ?? ""}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    env: { ...prev.env, [f.name]: e.target.value },
                  }))
                }
                placeholder={f.placeholder}
                className="w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 font-mono text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-accent focus:outline-none"
              />
              {f.help && (
                <div className="mt-1 text-xs text-neutral-500">{f.help}</div>
              )}
            </div>
          ))}
        </div>
      </div>
      <div className="flex items-center justify-between border-t border-neutral-800 px-5 py-3">
        <div className="text-xs">
          {err ? (
            <span className="text-red-400">⚠ {err}</span>
          ) : (
            <span className="text-neutral-600">空值 = 不设置</span>
          )}
        </div>
        <div className="flex gap-2">
          <button
            onClick={onCancel}
            className="rounded-lg border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-800"
          >
            取消
          </button>
          <button
            onClick={onSave}
            disabled={saving}
            className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-600"
          >
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            保存
          </button>
        </div>
      </div>
    </>
  );
}
