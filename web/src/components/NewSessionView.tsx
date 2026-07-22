import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Folder, ArrowRight } from "lucide-react";
import { browse } from "@/lib/api";
import type { DirEntry } from "@/lib/types";
import { ProfileSelect } from "@/components/ProfileSelect";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * 新建会话视图：选工作目录 + 选 profile + 输入第一条消息。
 */
export function NewSessionView() {
  const navigate = useNavigate();
  const [cwd, setCwd] = useState<string>("");
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [profileId, setProfileId] = useState<string | null>(null);

  // 初次加载：尝试 home 目录
  useEffect(() => {
    void doBrowse("");
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
      state: { cwd, firstMessage: message, profileId },
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
      <Label className="mb-1 block text-xs font-medium uppercase tracking-wide text-neutral-500">
        工作目录
      </Label>
      <div className="mb-2 flex gap-2">
        <Input
          value={cwd}
          onChange={(e) => manualSet(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void doBrowse(cwd);
          }}
          placeholder="/path/to/project"
          className="flex-1"
        />
        <Button
          variant="outline"
          onClick={() => doBrowse(cwd)}
        >
          浏览
        </Button>
      </div>

      {/* 目录列表 */}
      <div className="mb-2 flex items-center justify-between text-xs text-neutral-500">
        <span>{browseError ?? "点击进入子目录"}</span>
        <Button variant="ghost" size="sm" onClick={goUp} className="text-xs">
          ↑ 上级
        </Button>
      </div>
      <div className="mb-6 max-h-72 flex-1 overflow-y-auto rounded-lg border border-neutral-800 bg-neutral-900/50">
        {entries === null ? (
          <div className="flex flex-col gap-1.5 p-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-6 w-full" />
            ))}
          </div>
        ) : entries.length === 0 ? (
          <div className="p-3 text-sm text-neutral-500">（空目录）</div>
        ) : (
          entries.map((e) => (
            <Button
              key={e.path}
              variant="ghost"
              onClick={() => pick(e)}
              disabled={!e.isDir}
              className="flex w-full justify-start gap-2 px-3 py-1.5 text-left text-sm"
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
            </Button>
          ))
        )}
      </div>

      {/* 环境变量 profile */}
      <Label className="mb-1 block text-xs font-medium uppercase tracking-wide text-neutral-500">
        环境变量配置（profile）
      </Label>
      <div className="mb-6">
        <ProfileSelect value={profileId} onChange={setProfileId} />
      </div>

      {/* 首条消息（可选） */}
      <Label className="mb-1 block text-xs font-medium uppercase tracking-wide text-neutral-500">
        首条消息（可选，留空则进入会话再发）
      </Label>
      <Textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        rows={2}
        placeholder="想让 Claude 做什么？"
        className="mb-6"
      />

      <Button
        onClick={start}
        disabled={!cwd}
        className="flex items-center justify-center gap-2"
      >
        进入会话
        <ArrowRight className="h-4 w-4" />
      </Button>
    </div>
  );
}
