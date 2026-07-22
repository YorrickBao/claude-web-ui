import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Folder, ArrowRight } from "lucide-react";
import { browse, listProfiles } from "@/lib/api";
import type { DirEntry, EnvProfile } from "@/lib/types";
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

/**
 * 新建会话视图：选工作目录 + 选 profile。
 */
export function NewSessionView() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [cwd, setCwd] = useState<string>("");
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [browseError, setBrowseError] = useState<string | null>(null);
  
  const [profileId, setProfileId] = useState<string | null>(null);
  const [permissionMode, setPermissionMode] = useState<string>("default");
  const [effortLevel, setEffortLevel] = useState<string>("default");
  const [profiles, setProfiles] = useState<EnvProfile[]>([]);

  // Base UI Select 需要 items prop 才能让 SelectValue 显示 label 而非原始值
  const profileItems: Record<string, string> = {
    "": "默认",
    ...Object.fromEntries(profiles.map((p) => [p.id, p.name])),
  };
  /** 取 profile 的简要描述信息 */
  function profileDesc(p: EnvProfile): string {
    const baseUrl = p.env.ANTHROPIC_BASE_URL || "默认 URL";
    return baseUrl;
  }
  function profileModel(p: EnvProfile): string {
    return p.env.ANTHROPIC_MODEL || p.env.ANTHROPIC_DEFAULT_OPUS_MODEL || "";
  }
  const permissionItems: Record<string, string> = {
    bypassPermissions: "完全访问",
    default: "标准模式",
    acceptEdits: "自动编辑",
    plan: "仅规划",
    dontAsk: "静默拒绝",
    auto: "自动判断",
  };
  const effortItems: Record<string, string> = {
    default: "默认",
    low: "低",
    medium: "中",
    high: "高",
    xhigh: "极高",
    max: "最强",
    disabled: "关闭",
  };

  // 初次加载：如果 URL 带了 cwd 参数则直接进入该目录，否则尝试 home
  useEffect(() => {
    const initialCwd = searchParams.get("cwd");
    void doBrowse(initialCwd ?? "");
    listProfiles()
      .then(setProfiles)
      .catch(() => setProfiles([]));
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
      state: { cwd, profileId, permissionMode, effortLevel },
    });
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-4xl flex-col px-4 py-6 pt-14 md:px-4 md:py-8">
      <h1 className="mb-1 text-xl font-semibold text-foreground md:text-2xl">
        新建会话
      </h1>
      <p className="mb-6 text-sm text-muted-foreground">
        选择一个工作目录，Claude 将在该目录下运行工具。
      </p>

      {/* 当前路径 + 手动输入 */}
      <Label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
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
      <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
        <span>{browseError ?? "点击进入子目录"}</span>
        <Button variant="ghost" size="sm" onClick={goUp} className="text-xs">
          ↑ 上级
        </Button>
      </div>
      <div className="mb-6 max-h-48 flex-1 overflow-y-auto rounded-lg border border-border bg-card/50 md:max-h-72">
        {entries === null ? (
          <div className="flex flex-col gap-1.5 p-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-6 w-full" />
            ))}
          </div>
        ) : entries.length === 0 ? (
          <div className="p-3 text-sm text-muted-foreground">（空目录）</div>
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
                    : "h-4 w-4 text-muted-foreground"
                }
              />
              <span
                className={
                  e.isDir ? "text-foreground" : "text-muted-foreground"
                }
              >
                {e.name}
              </span>
            </Button>
          ))
        )}
      </div>

      {/* 简化选择器：无 label，无管理按钮 */}
      <div className="mb-6 flex items-center gap-2">
        <Select
          items={permissionItems}
          value={permissionMode}
          onValueChange={(v) => { if (v) setPermissionMode(v); }}
        >
          <SelectTrigger className="h-9 min-w-0 flex-1 text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="bypassPermissions">
              <span className="flex flex-col">
                <span>完全访问 · bypassPermissions</span>
                <span className="text-[10px] text-muted-foreground">跳过所有权限检查，allowDangerouslySkipPermissions</span>
              </span>
            </SelectItem>
            <SelectItem value="default">
              <span className="flex flex-col">
                <span>标准模式 · default</span>
                <span className="text-[10px] text-muted-foreground">危险操作弹窗确认</span>
              </span>
            </SelectItem>
            <SelectItem value="acceptEdits">
              <span className="flex flex-col">
                <span>自动编辑 · acceptEdits</span>
                <span className="text-[10px] text-muted-foreground">文件编辑自动放行，其余弹窗确认</span>
              </span>
            </SelectItem>
            <SelectItem value="plan">
              <span className="flex flex-col">
                <span>仅规划 · plan</span>
                <span className="text-[10px] text-muted-foreground">只读模式，不执行任何工具</span>
              </span>
            </SelectItem>
            <SelectItem value="dontAsk">
              <span className="flex flex-col">
                <span>静默拒绝 · dontAsk</span>
                <span className="text-[10px] text-muted-foreground">不弹窗，未预授权则直接拒绝</span>
              </span>
            </SelectItem>
            <SelectItem value="auto">
              <span className="flex flex-col">
                <span>自动判断 · auto</span>
                <span className="text-[10px] text-muted-foreground">模型自动判断批准或拒绝</span>
              </span>
            </SelectItem>
          </SelectContent>
        </Select>
        <Select
          items={profileItems}
          value={profileId ?? ""}
          onValueChange={(v) => setProfileId(v || null)}
        >
          <SelectTrigger className="h-9 min-w-0 flex-1 text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">
              <span className="flex flex-col">
                <span>默认</span>
                <span className="text-[10px] text-muted-foreground">使用 CLI 默认环境变量</span>
              </span>
            </SelectItem>
            {profiles.map((p) => {
              const model = profileModel(p);
              return (
              <SelectItem key={p.id} value={p.id}>
                <span className="flex flex-col">
                  <span>{p.name}{model ? <span className="text-muted-foreground"> · {model}</span> : null}</span>
                  <span className="text-[10px] text-muted-foreground">{profileDesc(p)}</span>
                </span>
              </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
        <Select
          items={effortItems}
          value={effortLevel}
          onValueChange={(v) => { if (v) setEffortLevel(v); }}
        >
          <SelectTrigger className="h-9 min-w-0 flex-1 text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="default">
              <span className="flex flex-col">
                <span>默认 · default</span>
                <span className="text-[10px] text-muted-foreground">使用 Profile 环境变量配置的思考深度</span>
              </span>
            </SelectItem>
            <SelectItem value="low">
              <span className="flex flex-col">
                <span>低 · low</span>
                <span className="text-[10px] text-muted-foreground">最少思考，最快响应</span>
              </span>
            </SelectItem>
            <SelectItem value="medium">
              <span className="flex flex-col">
                <span>中 · medium</span>
                <span className="text-[10px] text-muted-foreground">适度思考</span>
              </span>
            </SelectItem>
            <SelectItem value="high">
              <span className="flex flex-col">
                <span>高 · high</span>
                <span className="text-[10px] text-muted-foreground">深度推理</span>
              </span>
            </SelectItem>
            <SelectItem value="xhigh">
              <span className="flex flex-col">
                <span>极高 · xhigh</span>
                <span className="text-[10px] text-muted-foreground">更深层推理</span>
              </span>
            </SelectItem>
            <SelectItem value="max">
              <span className="flex flex-col">
                <span>最强 · max</span>
                <span className="text-[10px] text-muted-foreground">最大思考深度（需模型支持）</span>
              </span>
            </SelectItem>
            <SelectItem value="disabled">
              <span className="flex flex-col">
                <span>关闭 · disabled</span>
                <span className="text-[10px] text-muted-foreground">关闭扩展思考 · thinking: disabled</span>
              </span>
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

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
