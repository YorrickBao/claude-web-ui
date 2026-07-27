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

	// prefix 是外部 URL 前缀（子路径部署用），如 "/relay"；根路径部署为 ""。
	// 仅用于拼接对外输出的 Location 头和 cookie Path——
	// nginx 会把前缀剥掉再转发，relay 内部路由（/healthz、/tunnel、/）始终在根路径。
	prefix string
}

// tokenEntry 是一个短命令牌的映射项。
// 本地 WebUI 生成 token 后经隧道发 register_token 帧，中转存此映射；
// 远程浏览器用 ?t=token 首次访问时一次性消费，换得 accessKey cookie。
type tokenEntry struct {
	accessKey string
	expiresAt time.Time
}

func NewHub(prefix string) *Hub {
	return &Hub{
		tunnels: make(map[string]*Tunnel),
		tokens:  make(map[string]tokenEntry),
		prefix:  prefix,
	}
}

// externalPath 把内部根路径形式的 URL 段拼上外部前缀。
// 例：prefix="/relay", in="/" → "/relay/"；prefix="" , in="/" → "/"。
func (h *Hub) externalPath(p string) string {
	return h.prefix + p
}

// cookiePath 返回 cookie 的 Path 属性。
// 根路径部署返回 "/"，子路径部署返回前缀本身（cookie 仅发往该子路径下）。
func (h *Hub) cookiePath() string {
	if h.prefix == "" {
		return "/"
	}
	return h.prefix
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
//
// 并发安全：在锁内原子交换（旧值取出、新值写入同一次持锁），锁外再关闭旧隧道
// （关连接不应持锁）。此前的"释放锁→shutdown→重新加锁写入"存在 TOCTOU 窗口：
// 两个并发 register 会各自拿到同一个 old、各自 shutdown，但重新加锁后后写入者
// 覆盖先写入者，先写入者的 t 既不在 map 也未被 shutdown，成为僵尸隧道（本地侧
// WS/心跳/localReadLoop 永久驻留）。原子交换保证：并发时后到者拿到先到者的 t
// 作为 old 并 shutdown 它，无孤儿。unregister 的实例身份校验（cur == t）与新逻辑兼容。
func (h *Hub) register(accessKey string, t *Tunnel) (replaced bool) {
	h.mu.Lock()
	old := h.tunnels[accessKey]
	h.tunnels[accessKey] = t // 原子交换：新隧道一定在 map 里
	h.mu.Unlock()
	if old != nil {
		old.shutdown("replaced by new tunnel")
		return true
	}
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

// Stats 返回当前活跃隧道数与未消费（且未过期）的 token 数，供 /stats 状态页展示。
func (h *Hub) Stats() (tunnels, tokens int) {
	h.mu.Lock()
	tunnels = len(h.tunnels)
	h.mu.Unlock()
	h.tokensMu.Lock()
	tokens = len(h.tokens)
	h.tokensMu.Unlock()
	return
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

// writeTimeout 是向本地隧道 WS 写帧、以及向远程浏览器写 HTTP 响应的统一写截止时间。
//
// 必要性：coder/websocket 的写超时完全由 ctx.Done() 驱动（经 timeoutLoop →
// c.close()），本身不设 SetWriteDeadline。若调用方传 context.Background()
// 等无 deadline 的 ctx，TCP 写缓冲满时 c.bw.Flush() 会永久阻塞 → writeMu 被
// 永久持有 → 后续所有 req/ping/end 帧全部阻塞在 writeMu.Lock() → 所有请求
// pending。读路径用独立 readMu，localReadLoop 不会因此 idle 超时，无法自我修复。
//
// 给每次 writeLocal 包 15s 超时：超时后 ctx.Done() 触发 → timeoutLoop 调
// c.close() → rwc.Close() → 阻塞的 Flush 返回错误 → writeMu 释放。代价是整条
// WS 连接关闭、触发本地重连（relay.ts 已有 scheduleReconnect）。能写阻塞 15s
// 说明隧道已不健康，断开重连比僵死好。
const writeTimeout = 15 * time.Second

// writeLocal 向本地 WebUI 写一帧（线程安全）。
// 无论调用方传什么 ctx，都强制叠加 15s 写超时，防止 writeMu 被永久持有。
func (t *Tunnel) writeLocal(ctx context.Context, f Frame) error {
	data, err := encodeFrame(f)
	if err != nil {
		return err
	}
	t.writeMu.Lock()
	defer t.writeMu.Unlock()
	wctx, cancel := context.WithTimeout(ctx, writeTimeout)
	defer cancel()
	return t.conn.Write(wctx, websocket.MessageText, data)
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
// 并发模型（重要）：
//   - writeHeader/writeBody 仅在 localReadLoop（单 goroutine）调用；
//   - headerSent 跨 goroutine：localReadLoop 写（writeHeader 成功后）、handleProxy
//     读（wait 返回后判断能否写错误页）。wait 走 <-ctx.Done 分支（客户端断开）时
//     不经 done channel，无 happens-before，故用 atomic.Bool 保证可见性；
//   - fail/finish 可由多 goroutine 并发调用——localReadLoop（写失败/TypeEnd/TypeError）、
//     客户端断开 goroutine（proxy.go）、shutdown 收集路径都可能触发；
//   - err/failed 由 mu 保护；done 由 doneOnce 幂等关闭，杜绝双重 close 崩溃。
type pendingHTTP struct {
	w httpResponseWriter
	// rc 包裹 w，提供 SetWriteDeadline/Flush 等扩展写能力（Header/Write/WriteHeader
	// 仍直接走 w，ResponseController 不暴露这些基础方法）。
	// 远程浏览器读取缓慢时，写操作 15s 内无法完成即 fail 该请求，释放
	// localReadLoop——否则单慢客户端会卡住整个读循环，拖垮所有响应回传。
	rc         *http.ResponseController
	done       chan struct{}
	doneOnce   sync.Once  // 幂等关闭 done，防多 goroutine 并发 fail 双重 close 崩溃
	mu         sync.Mutex // 保护 err/failed（跨 goroutine 读写）
	err        error
	headerSent atomic.Bool // 跨 goroutine：localReadLoop 写、handleProxy 读
	failed     bool        // 写失败后置位，使后续 writeHeader/writeBody 变 no-op
}

type httpResponseWriter = interface {
	Header() http.Header
	WriteHeader(statusCode int)
	Write([]byte) (int, error)
}

func newPendingHTTP(w httpResponseWriter) *pendingHTTP {
	return &pendingHTTP{
		w:    w,
		rc:   http.NewResponseController(w),
		done: make(chan struct{}),
	}
}

// writeHeader 写响应头（仅一次）。跳过 hop-by-hop 头。
// 写回远程浏览器设 writeTimeout 截止时间：慢客户端 15s 内写不出即 fail，
// 释放 localReadLoop，避免单慢连接拖垮所有响应回传。
func (p *pendingHTTP) writeHeader(status int, headers map[string]string) {
	if p.headerSent.Load() {
		return
	}
	p.mu.Lock()
	if p.failed {
		p.mu.Unlock()
		return
	}
	p.mu.Unlock()
	h := p.w.Header()
	for k, v := range headers {
		if isHopByHop(k) {
			continue
		}
		h.Set(k, v)
	}
	p.setWriteDeadline()
	p.w.WriteHeader(status)
	if err := p.rc.Flush(); err != nil {
		p.fail("writeHeader flush: " + err.Error())
		return
	}
	p.headerSent.Store(true)
}

func (p *pendingHTTP) writeBody(body string) {
	p.mu.Lock()
	if p.failed {
		p.mu.Unlock()
		return
	}
	p.mu.Unlock()
	p.setWriteDeadline()
	if body != "" {
		if _, err := p.w.Write([]byte(body)); err != nil {
			p.fail("writeBody write: " + err.Error())
			return
		}
	}
	if err := p.rc.Flush(); err != nil {
		p.fail("writeBody flush: " + err.Error())
		return
	}
}

// setWriteDeadline 给写回浏览器的操作设 writeTimeout 截止时间。
// 每次写前重置，SSE 持续有数据时不会误超时；两次写之间静默超过 15s 才判失败。
// 不支持 SetWriteDeadline 的非标准 server 返回 errNotSupported，忽略即可。
func (p *pendingHTTP) setWriteDeadline() {
	_ = p.rc.SetWriteDeadline(time.Now().Add(writeTimeout))
}

// finish 标记响应流结束（正常或失败均走这里）。
// 用 doneOnce 保证 close(done) 只执行一次——fail 可由多个 goroutine 并发调用
// （localReadLoop 写失败、客户端断开 goroutine、shutdown 收集），裸 select+close
// 会因非原子的 check-then-close 导致双重 close panic。
// 同时清除本次请求设在底层 conn 上的写截止时间：net/http 不配 WriteTimeout 时
// 不会在请求间自动重置 writeDeadline，残留 deadline 会误杀复用连接上的后续
// 非代理响应（401/502/stats 等不走 pendingHTTP 的路径）。
func (p *pendingHTTP) finish() {
	p.doneOnce.Do(func() {
		close(p.done)
		_ = p.rc.SetWriteDeadline(time.Time{})
	})
}

// fail 标记失败（若尚未发头则可由 handler 写错误页）。
// 置 failed=true 使后续 writeHeader/writeBody 变 no-op，避免向已坏连接继续写。
func (p *pendingHTTP) fail(reason string) {
	p.mu.Lock()
	if p.err == nil {
		p.err = errors.New(reason)
	}
	p.failed = true
	p.mu.Unlock()
	p.finish()
}

// wait 阻塞直到响应结束、出错或客户端断开（ctx）。
func (p *pendingHTTP) wait(ctx context.Context) error {
	select {
	case <-p.done:
		p.mu.Lock()
		err := p.err
		p.mu.Unlock()
		return err
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
