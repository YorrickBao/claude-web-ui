package main

import (
	"context"
	"flag"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
)

// 协议相关超时与间隔
const (
	registerWait      = 10 * time.Second // 本地连上后等 register 帧的最长时间
	readIdleTimeout   = 90 * time.Second // 单次 Read 超时：心跳间隔 30s，留 3 倍余量
	heartbeatInterval = 30 * time.Second // 应用层心跳间隔
)

func main() {
	listen := flag.String("listen", "127.0.0.1:8787", "listen address (bind 127.0.0.1 behind Nginx)")
	prefix := flag.String("prefix", "", "external URL prefix when deployed behind a sub-path "+
		"(e.g. /relay). Empty = root deployment. Nginx must strip this prefix before proxying.")
	quiet := flag.Bool("quiet", false, "suppress log output")
	flag.Parse()

	// 默认输出日志；--quiet 静默（systemd 已有 journal，可选关闭应用层日志）
	if *quiet {
		log.SetOutput(io.Discard)
	}

	// 规范化外部前缀：确保以 / 开头、不以 / 结尾；空串表示根路径部署。
	extPrefix := normalizePrefix(*prefix)

	hub := NewHub(extPrefix)

	// 启动 token 清扫器：定时回收「铸造但从未被消费」的过期令牌，防止内存堆积。
	// 随进程生命周期运行，无需停止。
	go hub.startTokenSweeper(context.Background())

	mux := http.NewServeMux()

	// 健康检查（Nginx / 监控用）
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	})

	// 隧道端点：本地 WebUI 主动出站连这里注册
	mux.HandleFunc("/tunnel", hub.handleTunnel)

	// 中转状态页：显示活跃隧道数与未消费 token 数，供运维直连查看
	mux.HandleFunc("/stats", hub.handleStats)

	// 远程浏览器入口：所有其它请求（含根路径）走 HTTP 透明代理，
	// 经隧道转发到本地 WebUI。?t= 一次性令牌换 cookie；cookie 携带 accessKey。
	mux.HandleFunc("/", hub.handleProxy)

	srv := &http.Server{
		Addr:              *listen,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}

	log.Printf("[relay] listening on %s (behind Nginx for TLS)", *listen)
	if extPrefix != "" {
		log.Printf("[relay] external prefix: %s (sub-path deployment; nginx must strip it)", extPrefix)
	}
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Printf("[relay] server error: %v", err)
		os.Exit(1)
	}
}

// normalizePrefix 规范化子路径前缀：补齐前导 /、去掉结尾 /。
// 返回空串表示根路径部署（无前缀）。
// 例："/relay/" → "/relay"，"relay" → "/relay"，"/" → ""，"" → ""。
func normalizePrefix(p string) string {
	p = strings.TrimSpace(p)
	if p == "" || p == "/" {
		return ""
	}
	if !strings.HasPrefix(p, "/") {
		p = "/" + p
	}
	return strings.TrimSuffix(p, "/")
}
