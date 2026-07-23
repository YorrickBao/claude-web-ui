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
  QrCode,
  Smartphone,
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
  const [copied, setCopied] = useState(false);
  const [showQR, setShowQR] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/relay/status");
      if (!res.ok) return;
      const data = (await res.json()) as RelayStatus;
      setStatus(data);
      // 同步表单（仅在没有用户未提交的编辑时）
      setRelayUrl((prev) => prev || data.relayUrl);
      setAccessKey((prev) => prev || data.accessKey);
    } catch {
      // 静默：状态轮询失败不弹 toast
    }
  }, []);

  // 打开时拉取一次，并启动轮询
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    void fetchStatus().finally(() => setLoading(false));
    pollRef.current = setInterval(() => void fetchStatus(), 2000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [open, fetchStatus]);

  const enabled = status?.enabled ?? false;
  const connected = status?.connected ?? false;
  const connecting = status?.connecting ?? false;
  const remoteUrl = status?.remoteUrl ?? "";

  async function handleToggle() {
    setToggling(true);
    try {
      if (enabled) {
        const res = await fetch("/api/relay/stop", { method: "POST" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        toast.success("已停止远程控制");
      } else {
        const res = await fetch("/api/relay/start", {
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
      const res = await fetch("/api/relay/regenerate-key", {
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
            title="远程控制"
            className={cn(enabled && connected && "text-primary")}
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
              <div className="flex gap-1.5">
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
                  className="h-9 w-9 shrink-0"
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

            {/* 已连接：远程访问地址 + 二维码 */}
            {connected && remoteUrl && (
              <div className="space-y-2 rounded-lg border border-primary/30 bg-primary/5 p-3">
                <div className="flex items-center gap-1.5 text-xs font-medium text-primary">
                  <Check className="h-3.5 w-3.5" /> 远程访问地址
                </div>
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
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1 px-2 text-[11px]"
                    onClick={() => setShowQR((v) => !v)}
                    title="二维码"
                  >
                    <QrCode className="h-3.5 w-3.5" />
                    二维码
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
                </div>
                {showQR && (
                  <div className="flex justify-center rounded-lg bg-white p-3">
                    <QRCodeSVG value={remoteUrl} size={160} />
                  </div>
                )}
                <p className="text-[11px] text-muted-foreground">
                  在任意浏览器或手机扫码打开，即可远程操作。
                </p>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
