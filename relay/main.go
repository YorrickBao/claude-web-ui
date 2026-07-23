package main

import (
	"flag"
	"io"
	"log"
	"net/http"
	"os"
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
	quiet := flag.Bool("quiet", false, "suppress log output")
	flag.Parse()

	// 默认输出日志；--quiet 静默（systemd 已有 journal，可选关闭应用层日志）
	if *quiet {
		log.SetOutput(io.Discard)
	}

	hub := NewHub()

	mux := http.NewServeMux()

	// 健康检查（Nginx / 监控用）
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	})

	// 隧道端点：本地 WebUI 主动出站连这里注册
	mux.HandleFunc("/tunnel", hub.handleTunnel)

	// 客户端端点：远程浏览器连这里（?k=<accessKey>）
	mux.HandleFunc("/client", hub.handleClient)

	// 根路径：返回一个极简的落地说明页（远程浏览器访问 wss://relay/?k=... 时，
	// 如果直接访问根路径会命中这里）。实际 SPA 由本地 WebUI 经隧道提供。
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(`<!doctype html><meta charset="utf-8"><title>Claude WebUI Relay</title>
<body style="font-family:system-ui;padding:2rem;color:#333">
<h2>Claude WebUI 中转服务</h2>
<p>请通过本地 WebUI 的「远程控制」面板获取的链接访问。</p>
<p>如需启动隧道，请在本地 WebUI 中启用远程控制。</p>`))
	})

	srv := &http.Server{
		Addr:              *listen,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}

	log.Printf("[relay] listening on %s (behind Nginx for TLS)", *listen)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Printf("[relay] server error: %v", err)
		os.Exit(1)
	}
}
