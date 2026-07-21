import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Folder, ArrowRight } from "lucide-react";
import { browse } from "@/lib/api";
import type { DirEntry } from "@/lib/types";

/**
 * 新建会话视图：选工作目录 + 输入第一条消息。
 *
 * 第一版用"输入框 + 目录建议下拉"。
 * 后续可以升级成完整树形浏览器（DirectoryPicker）。
 */
export function NewSessionView() {
  const navigate = useNavigate();
  const [cwd, setCwd] = useState<string>("");
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  // 初次加载：尝试 home 目录
  useEffect(() => {
    void doBrowse("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function doBrowse(path: string) {
    setBrowseError(null);
    try {
      const r = await browse(path || ".");
      setCwd(r.path);
      setEntries(r.entries);
    } catch {
      setBrowseError("无法读取目录");
      setEntries(null);
    }
  }

  function pick(dir: DirEntry) {
    if (dir.isDir) void doBrowse(dir.path);
  }

  function goUp() {
    if (!cwd) return;
    const parent = cwd.replace(/\/[^/]+\/?$/, "") || "/";
    void doBrowse(parent === cwd ? "/" : parent);
  }

  function manualSet(path: string) {
    setCwd(path);
  }

  function start() {
    if (!cwd) return;
    // 跳到一个"待创建"的聊天页：sessionId=null，首条消息通过 ChatView 触发后端创建
    navigate("/pending", {
      state: { cwd, firstMessage: message },
    });
  }

  return (
    <div className="mx-auto flex h-full max-w-2xl flex-col px-4 py-8">
      <h1 className="mb-1 text-2xl font-semibold text-neutral-100">
        新建会话
      </h1>
      <p className="mb-6 text-sm text-neutral-500">
        选择一个工作目录，Claude 将在该目录下运行工具。
      </p>

      {/* 当前路径 + 手动输入 */}
      <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-neutral-500">
        工作目录
      </label>
      <div className="mb-2 flex gap-2">
        <input
          value={cwd}
          onChange={(e) => manualSet(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void doBrowse(cwd);
          }}
          placeholder="/path/to/project"
          className="flex-1 rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 focus:border-accent focus:outline-none"
        />
        <button
          onClick={() => doBrowse(cwd)}
          className="rounded-lg border border-neutral-700 px-3 py-2 text-sm text-neutral-300 hover:bg-neutral-800"
        >
          浏览
        </button>
      </div>

      {/* 目录列表 */}
      <div className="mb-2 flex items-center justify-between text-xs text-neutral-500">
        <span>{browseError ?? "点击进入子目录"}</span>
        <button onClick={goUp} className="hover:text-neutral-300">
          ↑ 上级
        </button>
      </div>
      <div className="mb-6 max-h-72 flex-1 overflow-y-auto rounded-lg border border-neutral-800 bg-neutral-900/50">
        {entries === null ? (
          <div className="p-3 text-sm text-neutral-500">加载中…</div>
        ) : entries.length === 0 ? (
          <div className="p-3 text-sm text-neutral-500">（空目录）</div>
        ) : (
          entries.map((e) => (
            <button
              key={e.path}
              onClick={() => pick(e)}
              disabled={!e.isDir}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-neutral-800/50 disabled:cursor-default disabled:hover:bg-transparent"
            >
              <Folder
                className={
                  e.isDir
                    ? "h-4 w-4 text-accent"
                    : "h-4 w-4 text-neutral-600"
                }
              />
              <span
                className={
                  e.isDir ? "text-neutral-200" : "text-neutral-500"
                }
              >
                {e.name}
              </span>
            </button>
          ))
        )}
      </div>

      {/* 首条消息（可选） */}
      <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-neutral-500">
        首条消息（可选，留空则进入会话再发）
      </label>
      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        rows={2}
        placeholder="想让 Claude 做什么？"
        className="mb-6 resize-none rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 focus:border-accent focus:outline-none"
      />

      <button
        onClick={start}
        disabled={!cwd}
        className="flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-600"
      >
        进入会话
        <ArrowRight className="h-4 w-4" />
      </button>
    </div>
  );
}
