package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

// Hub 维护 accessKey → Tunnel 的注册表。全局单例。
type Hub struct {
	mu      sync.Mutex
	tunnels map[string]*Tunnel

	tokensMu sync.Mutex
	tokens   map[string]tokenEntry // 短命访问令牌：token → accessKey，TTL 内可一次性换 cookie
}

// tokenEntry 是一个短命令牌的映射项。
// 本地 WebUI 生成 token 后经隧道发 register_token 帧，中转存此映射；
// 远程浏览器用 ?t=token 首次访问时一次性消费，换得 accessKey cookie。
type tokenEntry struct {
	accessKey string
	expiresAt time.Time
}

func NewHub() *Hub {
	return &Hub{
		tunnels: make(map[string]*Tunnel),
		tokens:  make(map[string]tokenEntry),
	}
}

// Find 按 accessKey 查找隧道（不创建）。
func (h *Hub) Find(accessKey string) (*Tunnel, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	t, ok := h.tunnels[accessKey]
	return t, ok
}

// register 注册或顶替一个隧道。若同 accessKey 已存在，旧隧道被关闭（视为僵尸重连）。
// 返回是否发生顶替，便于日志记录。
func (h *Hub) register(accessKey string, t *Tunnel) (replaced bool) {
	h.mu.Lock()
	old, ok := h.tunnels[accessKey]
	if ok {
		h.mu.Unlock()
		// 在锁外关闭旧连接，避免持锁阻塞
		old.shutdown("replaced by new tunnel")
		h.mu.Lock()
		h.tunnels[accessKey] = t
		h.mu.Unlock()
		return true
	}
	h.tunnels[accessKey] = t
	h.mu.Unlock()
	return false
}

// unregister 删除隧道（若仍是同一个实例）。幂等。
func (h *Hub) unregister(accessKey string, t *Tunnel) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if cur, ok := h.tunnels[accessKey]; ok && cur == t {
		delete(h.tunnels, accessKey)
	}
}

// storeToken 登记一个短命访问令牌：token → accessKey，存活 ttlSec 秒。
// accessKey 来自隧道自身（注册时已认证），可信，无需再次校验。
func (h *Hub) storeToken(token, accessKey string, ttlSec int) {
	if token == "" || accessKey == "" {
		return
	}
	if ttlSec <= 0 {
		ttlSec = 60
	}
	h.tokensMu.Lock()
	h.tokens[token] = tokenEntry{accessKey: accessKey, expiresAt: time.Now().Add(time.Duration(ttlSec) * time.Second)}
	h.tokensMu.Unlock()
}

// consumeToken 查找并删除一个令牌（一次性消费，防重放）。
// 返回关联的 accessKey 及是否命中（未过期）。
func (h *Hub) consumeToken(token string) (string, bool) {
	if token == "" {
		return "", false
	}
	h.tokensMu.Lock()
	defer h.tokensMu.Unlock()
	entry, ok := h.tokens[token]
	if !ok {
		return "", false
	}
	delete(h.tokens, token) // 一次性：无论是否过期，消费后即删
	if time.Now().After(entry.expiresAt) {
		return "", false
	}
	return entry.accessKey, true
}

// sweepTokens 清扫已过期的令牌，防止「铸造但从未被消费」的令牌堆积。
// 由 startTokenSweeper 定时调用。
func (h *Hub) sweepTokens() {
	now := time.Now()
	h.tokensMu.Lock()
	for k, e := range h.tokens {
		if now.After(e.expiresAt) {
			delete(h.tokens, k)
		}
	}
	h.tokensMu.Unlock()
}

// startTokenSweeper 每 30s 清扫一次过期令牌，直到 ctx 取消。
func (h *Hub) startTokenSweeper(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			h.sweepTokens()
		}
	}
}

// Tunnel 代表一条连到本地 WebUI 的出站隧道。
// 远程浏览器的 HTTP 请求经中转转成 req 帧发到这里，本地 fetch 后用 res/res_body
// 帧回传，中转再写回对应 HTTP 连接。每个在途 HTTP 请求用一个 connId 关联。
type Tunnel struct {
	accessKey string
	conn      *websocket.Conn
	writeMu   sync.Mutex // 串行化向本地 WS 写帧

	routesMu sync.Mutex
	routes   map[string]*pendingHTTP // connId → 在途 HTTP 响应（远程浏览器侧）

	closed  bool
	closeMu sync.Mutex
}

func NewTunnel(accessKey string, conn *websocket.Conn) *Tunnel {
	return &Tunnel{
		accessKey: accessKey,
		conn:      conn,
		routes:    make(map[string]*pendingHTTP),
	}
}

// writeLocal 向本地 WebUI 写一帧（线程安全）。
func (t *Tunnel) writeLocal(ctx context.Context, f Frame) error {
	data, err := encodeFrame(f)
	if err != nil {
		return err
	}
	t.writeMu.Lock()
	defer t.writeMu.Unlock()
	return t.conn.Write(ctx, websocket.MessageText, data)
}

// addRoute / takeRoute / peekRoute 维护 connId → pendingHTTP 路由。
func (t *Tunnel) addRoute(connId string, p *pendingHTTP) {
	t.routesMu.Lock()
	t.routes[connId] = p
	t.routesMu.Unlock()
}

// takeRoute 取出并删除（用于流结束、错误）。
func (t *Tunnel) takeRoute(connId string) (*pendingHTTP, bool) {
	t.routesMu.Lock()
	defer t.routesMu.Unlock()
	p, ok := t.routes[connId]
	return p, ok
}

// takeRouteKeep 取出但不删除（用于 res_body 多片，需要保留直到 last）。
func (t *Tunnel) takeRouteKeep(connId string) (*pendingHTTP, bool) {
	t.routesMu.Lock()
	defer t.routesMu.Unlock()
	p, ok := t.routes[connId]
	return p, ok
}

func (t *Tunnel) deleteRoute(connId string) {
	t.routesMu.Lock()
	delete(t.routes, connId)
	t.routesMu.Unlock()
}

// shutdown 关闭隧道：关闭本地 WS，并终结所有在途 HTTP 请求（返回 502）。
func (t *Tunnel) shutdown(reason string) {
	t.closeMu.Lock()
	if t.closed {
		t.closeMu.Unlock()
		return
	}
	t.closed = true
	t.closeMu.Unlock()

	_ = t.conn.Close(websocket.StatusNormalClosure, reason)

	// 收集所有在途请求并失败它们
	t.routesMu.Lock()
	pendings := make([]*pendingHTTP, 0, len(t.routes))
	for _, p := range t.routes {
		pendings = append(pendings, p)
	}
	t.routes = make(map[string]*pendingHTTP)
	t.routesMu.Unlock()
	for _, p := range pendings {
		p.fail("tunnel closed: " + reason)
	}
	log.Printf("[hub] tunnel %s shutdown: %s", shortKey(t.accessKey), reason)
}

// pendingHTTP 代表一个远程浏览器 HTTP 请求在隧道侧的"占位"。
// localReadLoop 收到 res/res_body 帧后写 ResponseWriter；HTTP handler
// goroutine 阻塞在 wait() 等流结束（或客户端断开）。
//
// 并发：writeHeader/writeBody 只在 localReadLoop（单 goroutine）调用；
// wait/fail 在 HTTP handler goroutine 调用；done channel 协调两者。
type pendingHTTP struct {
	w          httpResponseWriter
	flusher    http.Flusher
	done       chan struct{}
	err        error
	headerSent bool
}

type httpResponseWriter = interface {
	Header() http.Header
	WriteHeader(statusCode int)
	Write([]byte) (int, error)
}

func newPendingHTTP(w httpResponseWriter) *pendingHTTP {
	p := &pendingHTTP{w: w, done: make(chan struct{})}
	if fl, ok := w.(http.Flusher); ok {
		p.flusher = fl
	}
	return p
}

// writeHeader 写响应头（仅一次）。跳过 hop-by-hop 头。
func (p *pendingHTTP) writeHeader(status int, headers map[string]string) {
	if p.headerSent {
		return
	}
	h := p.w.Header()
	for k, v := range headers {
		if isHopByHop(k) {
			continue
		}
		h.Set(k, v)
	}
	p.w.WriteHeader(status)
	if p.flusher != nil {
		p.flusher.Flush()
	}
	p.headerSent = true
}

func (p *pendingHTTP) writeBody(body string) {
	if body != "" {
		_, _ = p.w.Write([]byte(body))
	}
	if p.flusher != nil {
		p.flusher.Flush()
	}
}

// finish 标记响应流正常结束。
func (p *pendingHTTP) finish() {
	select {
	case <-p.done:
	default:
		close(p.done)
	}
}

// fail 标记失败（若尚未发头则可由 handler 写错误页）。
func (p *pendingHTTP) fail(reason string) {
	if p.err == nil {
		p.err = errors.New(reason)
	}
	p.finish()
}

// wait 阻塞直到响应结束、出错或客户端断开（ctx）。
func (p *pendingHTTP) wait(ctx context.Context) error {
	select {
	case <-p.done:
		return p.err
	case <-ctx.Done():
		return ctx.Err()
	}
}

// ── 工具函数 ──

// connIdSeq 全局递增，保证 connId 唯一。
var connIdSeq uint64

// generateConnId 生成形如 c-<ns低位hex>-<seq> 的 connId，便于日志辨识且不重复。
func generateConnId() string {
	n := atomic.AddUint64(&connIdSeq, 1)
	lo := uint64(time.Now().UnixNano()) & 0xffff
	return "c-" + strconv.FormatUint(lo, 16) + "-" + strconv.FormatUint(n, 10)
}

func shortKey(k string) string {
	if len(k) <= 8 {
		return k
	}
	return k[:4] + "…" + k[len(k)-4:]
}

// isHopByHop 判断是否为 hop-by-hop / 不应转发的头。
func isHopByHop(name string) bool {
	switch name {
	case "Connection", "Keep-Alive", "Proxy-Authenticate",
		"Proxy-Authorization", "Te", "Trailers",
		"Transfer-Encoding", "Upgrade":
		return true
	}
	return false
}
