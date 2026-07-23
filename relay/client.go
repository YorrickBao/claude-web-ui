package main

import (
	"context"
	"log"
	"net/http"
	"time"

	"github.com/coder/websocket"
)

// handleClient 处理远程浏览器的接入。
//
// URL 形如 /client?k=<accessKey>。凭 accessKey 找到对应隧道；找不到则 404（不升级 WS）。
// 浏览器侧由一段轻量 JS 把 fetch 请求包装成 req/req_body 帧，并消费 res/res_body 帧还原响应。
func (h *Hub) handleClient(w http.ResponseWriter, r *http.Request) {
	accessKey := r.URL.Query().Get("k")
	if accessKey == "" {
		http.Error(w, "missing access key", http.StatusBadRequest)
		return
	}

	tunnel, ok := h.Find(accessKey)
	if !ok {
		http.Error(w, "no tunnel for this key", http.StatusNotFound)
		return
	}

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true, // 一期不校验来源
	})
	if err != nil {
		log.Printf("[client] accept failed: %v", err)
		return
	}
	conn.SetReadLimit(1 << 20)

	client := NewClient(conn, tunnel)
	tunnel.addClient(client)
	log.Printf("[client] attached to tunnel %s", shortKey(tunnel.accessKey))

	heartbeatCtx, heartbeatCancel := context.WithCancel(context.Background())
	go client.clientHeartbeat(heartbeatCtx)

	client.clientReadLoop(r.Context(), tunnel)

	heartbeatCancel()
	tunnel.removeClient(client)
	client.shutdown("read loop ended")
	log.Printf("[client] detached from tunnel %s", shortKey(tunnel.accessKey))
}

// clientReadLoop 读取浏览器发来的帧，转发给隧道（本地 WebUI）。
// req/req_body/end 帧原样转发；req 时顺便登记 connId→client 路由，用于响应回程。
func (c *Client) clientReadLoop(parent context.Context, tunnel *Tunnel) {
	for {
		ctx, cancel := context.WithTimeout(parent, readIdleTimeout)
		_, raw, err := c.conn.Read(ctx)
		cancel()
		if err != nil {
			log.Printf("[client] read ended: %v", err)
			return
		}

		f, err := decodeFrame(raw)
		if err != nil {
			log.Printf("[client] decode failed: %v", err)
			continue
		}

		switch f.Type {
		case TypeReq:
			if f.ConnId == "" {
				log.Printf("[client] req without connId, dropping")
				continue
			}
			// 登记路由，方便本地响应帧回程时找到本 client
			tunnel.addRoute(f.ConnId, c)
			if err := tunnel.writeLocal(parent, f); err != nil {
				log.Printf("[client] forward req %s to tunnel failed: %v", f.ConnId, err)
				tunnel.deleteRoute(f.ConnId)
				return
			}

		case TypeReqBody:
			if err := tunnel.writeLocal(parent, f); err != nil {
				log.Printf("[client] forward req_body %s to tunnel failed: %v", f.ConnId, err)
				return
			}

		case TypeEnd:
			if err := tunnel.writeLocal(parent, f); err != nil {
				log.Printf("[client] forward end %s to tunnel failed: %v", f.ConnId, err)
				return
			}
			tunnel.deleteRoute(f.ConnId)

		case TypePing:
			_ = c.writeClient(parent, Frame{Type: TypePong})

		case TypePong:
			// 心跳回复，忽略

		default:
			log.Printf("[client] unexpected frame type %q", f.Type)
		}
	}
}

// clientHeartbeat 定时向浏览器发 ping。
func (c *Client) clientHeartbeat(ctx context.Context) {
	ticker := time.NewTicker(heartbeatInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := c.writeClient(ctx, Frame{Type: TypePing}); err != nil {
				log.Printf("[client] heartbeat write failed: %v", err)
				return
			}
		}
	}
}
