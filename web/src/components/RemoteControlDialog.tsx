import { useCallback, useEffect, useRef, useState } from "react";
import {
  Loader2,
  Copy,
  Check,
  RefreshCw,
  Power,
  Wifi,
  WifiOff,
  ExternalLink,
  Smartphone,
  KeyRound,
  Clock,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface RelayStatus {
  enabled: boolean;
  connected: boolean;
  connecting: boolean;
  relayUrl: string;
  accessKey: string;
  remoteUrl: string;
  tokenExpiresAt: number | null;
  error: string | null;
}

/**
 * 远程控制面板。
 *
 * 通过公网中转服务把本地 WebUI 暴露给远程浏览器。
 * 用户在此填中转地址、生成 accessKey、启用/停止隧道；
 * 启用后展示「远程访问地址」与二维码，供手机/远程浏览器扫码接入。
 */
export function RemoteControlDialog() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<RelayStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [relayUrl, setRelayUrl] = useState("");
  const [accessKey, setAccessKey] = useState("");
  const [toggling, setToggling] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [copied, setCopied] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("api/relay/status");
      if (!res.ok) return;
      const data = (await res.json()) as RelayStatus;
      setStatus(data);
      // 同步表单（仅在没有用户未提交的编辑时）
      setRelayUrl((prev) => prev || data.relayUrl);
      setAccessKey((prev) => prev || data.accessKey);
    } catch {
      // 静默：状态拉取失败不弹 toast
    }
  }, []);

  // 订阅 relay 状态 SSE 流：状态变化即时推送，驱动左下角图标颜色，无需轮询。
  // 本组件挂在 Sidebar 里是常驻单例，故挂载即订阅、卸载即断开。
  useEffect(() => {
    const es = new EventSource("api/relay/stream");
    es.addEventListener("relay_status", (ev) => {
      try {
        const data = (JSON.parse((ev as MessageEvent).data) as { status: RelayStatus }).status;
        setStatus(data);
        setRelayUrl((prev) => prev || data.relayUrl);
        setAccessKey((prev) => prev || data.accessKey);
      } catch {
        /* 忽略格式异常 */
      }
    });
    // EventSource 遇到网络错误会自动重连，无需手动处理
    return () => es.close();
  }, []);

  // 打开对话框且尚无状态时，拉一次兜底（SSE 首帧可能稍晚）
  useEffect(() => {
    if (open && !status) {
      setLoading(true);
      void fetchStatus().finally(() => setLoading(false));
    }
  }, [open, status, fetchStatus]);

  const enabled = status?.enabled ?? false;
  const connected = status?.connected ?? false;
  const connecting = status?.connecting ?? false;
  const remoteUrl = status?.remoteUrl ?? "";
  const tokenExpiresAt = status?.tokenExpiresAt ?? null;

  // 倒计时：token 有效期内的剩余秒数。每秒刷新一次，到期归零。
  // tokenExpiresAt 变化（重新生成/清空）时重建定时器，unmount 时清理。
  const [remaining, setRemaining] = useState(0);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (countdownRef.current) {
      clearInterval(countdownRef.current);
      countdownRef.current = null;
    }
    if (!tokenExpiresAt) {
      setRemaining(0);
      return;
    }
    const tick = () => setRemaining(Math.max(0, Math.round((tokenExpiresAt - Date.now()) / 1000)));
    tick();
    countdownRef.current = setInterval(tick, 1000);
    return () => {
      if (countdownRef.current) {
        clearInterval(countdownRef.current);
        countdownRef.current = null;
      }
    };
  }, [tokenExpiresAt]);

  async function handleRefreshToken() {
    setRefreshing(true);
    try {
      const res = await fetch("api/relay/refresh-token", { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      // 成功后状态由 SSE 推送的快照驱动，无需手动 setStatus
      toast.success("已生成访问链接（60 秒有效）");
    } catch (err) {
      toast.error(`生成失败：${(err as Error).message}`);
    } finally {
      setRefreshing(false);
    }
  }

  async function handleToggle() {
    setToggling(true);
    try {
      if (enabled) {
        const res = await fetch("api/relay/stop", { method: "POST" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        toast.success("已停止远程控制");
      } else {
        const res = await fetch("api/relay/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ relayUrl, accessKey }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        toast.success("已启用远程控制");
      }
      await fetchStatus();
    } catch (err) {
      toast.error(`操作失败：${(err as Error).message}`);
    } finally {
      setToggling(false);
    }
  }

  async function handleRegenerate() {
    setRegenerating(true);
    try {
      const res = await fetch("api/relay/regenerate-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ relayUrl }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { accessKey: string };
      setAccessKey(data.accessKey);
      toast.success("已重新生成 accessKey");
      await fetchStatus();
    } catch (err) {
      toast.error(`重新生成失败：${(err as Error).message}`);
    } finally {
      setRegenerating(false);
    }
  }

  async function handleCopy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      toast.success(`已复制${label}`);
    } catch {
      toast.error("复制失败");
    }
  }

  const statusBadge = connecting ? (
    <span className="inline-flex items-center gap-1 text-xs text-amber-600">
      <Loader2 className="h-3 w-3 animate-spin" /> 连接中…
    </span>
  ) : connected ? (
    <span className="inline-flex items-center gap-1 text-xs text-emerald-600">
      <Wifi className="h-3 w-3" /> 已连接
    </span>
  ) : enabled ? (
    <span className="inline-flex items-center gap-1 text-xs text-red-500">
      <WifiOff className="h-3 w-3" /> 已断开{status?.error ? `（${status.error}）` : ""}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      <Power className="h-3 w-3" /> 未启用
    </span>
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            title={
              connected
                ? "远程控制：已接入"
                : enabled
                  ? "远程控制：等待接入"
                  : "远程控制"
            }
            className={cn(
              enabled && connected && "text-emerald-500",
              enabled && !connected && "text-amber-500",
            )}
          />
        }
      >
        <Smartphone className="h-3.5 w-3.5" />
      </DialogTrigger>
      <DialogContent className="md:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Smartphone className="h-4 w-4" /> 远程控制
          </DialogTitle>
          <DialogDescription>
            通过公网中转服务远程访问本地 WebUI。部署中转服务见仓库 <code>relay/README.md</code>。
          </DialogDescription>
        </DialogHeader>

        {loading && !status ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-4">
            {/* 状态徽章 */}
            <div className="flex items-center justify-between rounded-lg border bg-muted/40 px-3 py-2">
              <span className="text-xs font-medium text-muted-foreground">隧道状态</span>
              {statusBadge}
            </div>

            {/* 中转地址 */}
            <div className="space-y-1.5">
              <Label htmlFor="relay-url" className="text-xs">
                中转地址
              </Label>
              <Input
                id="relay-url"
                placeholder="wss://relay.your-domain.com"
                value={relayUrl}
                onChange={(e) => setRelayUrl(e.target.value)}
                disabled={enabled}
                className="text-xs"
              />
              <p className="text-[11px] text-muted-foreground">
                你的中转服务对外地址（经 Nginx 提供 wss）。
              </p>
            </div>

            {/* accessKey */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="relay-key" className="text-xs">
                  Access Key
                </Label>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleRegenerate}
                  disabled={regenerating || enabled}
                  className="h-6 gap-1 px-2 text-[11px]"
                  title={enabled ? "停止后才能重新生成" : "重新生成"}
                >
                  {regenerating ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3 w-3" />
                  )}
                  重新生成
                </Button>
              </div>
              <div className="flex items-center gap-1.5">
                <Input
                  id="relay-key"
                  readOnly
                  value={accessKey}
                  className="font-mono text-xs"
                  placeholder="点击「重新生成」创建"
                />
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => accessKey && handleCopy(accessKey, "Access Key")}
                  disabled={!accessKey}
                  title="复制"
                  className="h-8 w-8 shrink-0"
                >
                  <Copy className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>

            {/* 启用/停止按钮 */}
            <Button
              onClick={handleToggle}
              disabled={toggling || !relayUrl || !accessKey}
              variant={enabled ? "destructive" : "default"}
              className="w-full gap-2"
            >
              {toggling ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : enabled ? (
                <Power className="h-4 w-4" />
              ) : (
                <Power className="h-4 w-4" />
              )}
              {enabled ? "停止远程控制" : "启用远程控制"}
            </Button>

            {/* 已连接：访问令牌管理 */}
            {connected && (
              <div className="space-y-2 rounded-lg border border-primary/30 bg-primary/5 p-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 text-xs font-medium text-primary">
                    <Check className="h-3.5 w-3.5" /> 远程访问链接
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleRefreshToken}
                    disabled={refreshing}
                    className="h-6 gap-1 px-2 text-[11px]"
                    title="生成新的访问链接"
                  >
                    {refreshing ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <KeyRound className="h-3 w-3" />
                    )}
                    {tokenExpiresAt ? "刷新链接" : "生成链接"}
                  </Button>
                </div>

                {/* 无 token 或已失效：提示生成 */}
                {!tokenExpiresAt || remaining === 0 ? (
                  <div className="rounded bg-background px-2 py-2 text-[11px] text-muted-foreground">
                    {tokenExpiresAt ? (
                      <>链接已失效，请点击「刷新链接」重新生成。</>
                    ) : (
                      <>点击「生成链接」创建一次性访问链接（60 秒内有效），在远程浏览器或手机扫码打开。</>
                    )}
                  </div>
                ) : (
                  <>
                    <code className="block w-full break-all rounded bg-background px-2 py-1 text-[11px]">
                      {remoteUrl}
                    </code>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 gap-1 px-2 text-[11px]"
                        onClick={() => handleCopy(remoteUrl, "远程地址")}
                        title="复制"
                      >
                        {copied ? (
                          <Check className="h-3.5 w-3.5 text-emerald-500" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )}
                        复制
                      </Button>
                      <a
                        href={remoteUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex h-7 items-center gap-1 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                        title="新窗口打开"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                        打开
                      </a>
                      <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-amber-600">
                        <Clock className="h-3 w-3" /> 剩余 {remaining}s
                      </span>
                    </div>
                    <div className="flex justify-center rounded-lg bg-white p-3">
                      <QRCodeSVG value={remoteUrl} size={160} />
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      链接是一次性令牌，首次打开后即失效；在任意浏览器或手机扫码打开即可远程操作。
                    </p>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
