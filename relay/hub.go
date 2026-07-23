package main

import (
	"context"
	"log"
	"sync"

	"github.com/coder/websocket"
)

// Hub 维护 accessKey → Tunnel 的注册表。全局单例。
type Hub struct {
	mu      sync.Mutex
	tunnels map[string]*Tunnel
}

func NewHub() *Hub {
	return &Hub{tunnels: make(map[string]*Tunnel)}
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

// Tunnel 代表一条连到本地 WebUI 的出站隧道，可挂多个远程 client。
type Tunnel struct {
	accessKey string
	conn      *websocket.Conn
	writeMu   sync.Mutex // 串行化向本地 WS 写帧

	clientsMu sync.Mutex
	clients   map[*Client]struct{} // 挂在此隧道上的所有 client

	routesMu sync.Mutex
	routes   map[string]*Client // connId → client（路由本地响应帧回 client）

	closed  bool
	closeMu sync.Mutex
}

func NewTunnel(accessKey string, conn *websocket.Conn) *Tunnel {
	return &Tunnel{
		accessKey: accessKey,
		conn:      conn,
		clients:   make(map[*Client]struct{}),
		routes:    make(map[string]*Client),
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

// addClient / removeClient 维护 client 集合。
func (t *Tunnel) addClient(c *Client) {
	t.clientsMu.Lock()
	t.clients[c] = struct{}{}
	t.clientsMu.Unlock()
}

func (t *Tunnel) removeClient(c *Client) {
	t.clientsMu.Lock()
	delete(t.clients, c)
	t.clientsMu.Unlock()
	// 清理该 client 所有路由
	t.routesMu.Lock()
	for id, cl := range t.routes {
		if cl == c {
			delete(t.routes, id)
		}
	}
	t.routesMu.Unlock()
}

// addRoute / takeRoute 维护 connId → client 路由。
func (t *Tunnel) addRoute(connId string, c *Client) {
	t.routesMu.Lock()
	t.routes[connId] = c
	t.routesMu.Unlock()
}

func (t *Tunnel) takeRoute(connId string) (*Client, bool) {
	t.routesMu.Lock()
	defer t.routesMu.Unlock()
	c, ok := t.routes[connId]
	return c, ok
}

// deleteRoute 删除单个路由（响应流结束后调用）。
func (t *Tunnel) deleteRoute(connId string) {
	t.routesMu.Lock()
	delete(t.routes, connId)
	t.routesMu.Unlock()
}

// shutdown 关闭隧道：关闭本地 WS，并关闭所有挂着的 client。
func (t *Tunnel) shutdown(reason string) {
	t.closeMu.Lock()
	if t.closed {
		t.closeMu.Unlock()
		return
	}
	t.closed = true
	t.closeMu.Unlock()

	_ = t.conn.Close(websocket.StatusNormalClosure, reason)

	t.clientsMu.Lock()
	clients := make([]*Client, 0, len(t.clients))
	for c := range t.clients {
		clients = append(clients, c)
	}
	t.clientsMu.Unlock()
	for _, c := range clients {
		c.shutdown("tunnel closed")
	}
	log.Printf("[hub] tunnel %s shutdown: %s", shortKey(t.accessKey), reason)
}

// Client 是一个远程浏览器的 WS 连接，挂在某条 Tunnel 上。
type Client struct {
	conn    *websocket.Conn
	tunnel  *Tunnel
	writeMu sync.Mutex
	closed  bool
	closeMu sync.Mutex
}

func NewClient(conn *websocket.Conn, tunnel *Tunnel) *Client {
	return &Client{conn: conn, tunnel: tunnel}
}

func (c *Client) writeClient(ctx context.Context, f Frame) error {
	data, err := encodeFrame(f)
	if err != nil {
		return err
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	return c.conn.Write(ctx, websocket.MessageText, data)
}

func (c *Client) shutdown(reason string) {
	c.closeMu.Lock()
	if c.closed {
		c.closeMu.Unlock()
		return
	}
	c.closed = true
	c.closeMu.Unlock()
	_ = c.conn.Close(websocket.StatusNormalClosure, reason)
}

func shortKey(k string) string {
	if len(k) <= 8 {
		return k
	}
	return k[:4] + "…" + k[len(k)-4:]
}
