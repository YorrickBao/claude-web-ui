import { useEffect, useState } from "react";
import { X, Save, Eye, EyeOff, Loader2 } from "lucide-react";
import { ENV_FIELDS, type EnvValues } from "@/lib/envFields";
import {
  getEnvDefaults,
  setEnvDefaults,
  getSessionEnv,
  setSessionEnv,
} from "@/lib/api";

/**
 * 环境变量设置 Modal。
 *
 * scope:
 *   - "global"  → 读写全局默认（/api/env-defaults）
 *   - "session" → 读写某会话生效的 env（合并视图，/api/sessions/:id/env）
 *
 * 会话模式下展示的是"合并后生效值"（全局 + 会话 override），
 * 保存时整体写回会话级。这样用户看到的就是真实生效的配置。
 */
export interface EnvSettingsModalProps {
  open: boolean;
  onClose: () => void;
  scope: "global" | "session";
  /** scope="session" 时必填 */
  sessionId?: string;
  /** scope="session" 时的会话标题（展示用） */
  sessionTitle?: string;
}

export function EnvSettingsModal({
  open,
  onClose,
  scope,
  sessionId,
  sessionTitle,
}: EnvSettingsModalProps) {
  const [values, setValues] = useState<EnvValues>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showSecrets, setShowSecrets] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // 打开时拉取当前值
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setErr(null);
    const fetcher =
      scope === "global"
        ? getEnvDefaults
        : () => getSessionEnv(sessionId!);
    fetcher()
      .then((env) => {
        if (!cancelled) setValues(env);
      })
      .catch((e) => {
        if (!cancelled) setErr((e as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, scope, sessionId]);

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      const saver =
        scope === "global"
          ? () => setEnvDefaults(values)
          : () => setSessionEnv(sessionId!, values);
      const saved = await saver();
      setValues(saved);
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
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
          <div>
            <div className="text-sm font-semibold text-neutral-100">
              {scope === "global" ? "环境变量 · 全局默认" : "环境变量 · 当前会话"}
            </div>
            {scope === "session" && sessionTitle && (
              <div className="mt-0.5 truncate text-xs text-neutral-500">
                {sessionTitle}
              </div>
            )}
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 说明条 */}
        <div className="border-b border-neutral-800 bg-neutral-950/50 px-5 py-2 text-xs text-neutral-400">
          {scope === "global"
            ? "所有新会话的初始环境变量。已有会话不受影响（除非它没自定义）。"
            : "修改后只影响本会话的后续消息。展示的是合并全局后的生效值。"}
        </div>

        {/* 表单 */}
        <div className="max-h-[55vh] overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="flex items-center justify-center py-8 text-sm text-neutral-500">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 加载中…
            </div>
          ) : (
            <>
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
                      value={values[f.name] ?? ""}
                      onChange={(e) =>
                        setValues((prev) => ({
                          ...prev,
                          [f.name]: e.target.value,
                        }))
                      }
                      placeholder={f.placeholder}
                      className="w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 font-mono text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-accent focus:outline-none"
                    />
                    {f.help && (
                      <div className="mt-1 text-xs text-neutral-500">
                        {f.help}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        {/* 底部 */}
        <div className="flex items-center justify-between border-t border-neutral-800 px-5 py-3">
          <div className="text-xs">
            {err ? (
              <span className="text-red-400">⚠ {err}</span>
            ) : (
              <span className="text-neutral-600">
                空值 = 不设置（用 CLI 默认）
              </span>
            )}
          </div>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="rounded-lg border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-800"
            >
              取消
            </button>
            <button
              onClick={save}
              disabled={saving || loading}
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
      </div>
    </div>
  );
}
