package main

import (
	"context"
	"log"
	"net/http"
	"time"

	"github.com/coder/websocket"
)

// handleTunnel 处理本地 WebUI 主动出站建立的隧道连接。
//
// 握手：连接建立后，本地必须在 registerWait 内发来第一帧 {"type":"register","accessKey":"..."}，
// 否则视为非法连接，关闭。
func (h *Hub) handleTunnel(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// 一期不做认证，本地隧道经 Nginx/直连抵达，不校验 Origin
		InsecureSkipVerify: true,
	})
	if err != nil {
		log.Printf("[tunnel] accept failed: %v", err)
		return
	}
	// 限制读尺寸：单帧最大 1MB（HTTP body 单片足够；大 body 会分多片）
	conn.SetReadLimit(1 << 20)

	ctx, cancel := context.WithTimeout(r.Context(), registerWait)
	_, raw, err := conn.Read(ctx)
	cancel()
	if err != nil {
		log.Printf("[tunnel] read register failed: %v", err)
		_ = conn.Close(websocket.StatusPolicyViolation, "register required")
		return
	}

	f, err := decodeFrame(raw)
	if err != nil || f.Type != TypeRegister || f.AccessKey == "" {
		log.Printf("[tunnel] invalid register frame")
		_ = conn.Close(websocket.StatusPolicyViolation, "invalid register")
		return
	}

	accessKey := f.AccessKey
	t := NewTunnel(accessKey, conn)
	if replaced := h.register(accessKey, t); replaced {
		log.Printf("[tunnel] replaced existing tunnel for %s", shortKey(accessKey))
	} else {
		log.Printf("[tunnel] registered tunnel for %s", shortKey(accessKey))
	}

	// 注册成功确认
	if err := t.writeLocal(r.Context(), Frame{Type: TypeRegistered, Ok: true}); err != nil {
		log.Printf("[tunnel] write registered ack failed: %v", err)
		h.unregister(accessKey, t)
		_ = conn.Close(websocket.StatusInternalError, "ack failed")
		return
	}

	// 启动心跳
	heartbeatCtx, heartbeatCancel := context.WithCancel(context.Background())
	go t.localHeartbeat(heartbeatCtx)

	// 读循环：本地 → 中转（路由到 client）
	t.localReadLoop(r.Context(), h)
	heartbeatCancel()

	h.unregister(accessKey, t)
	t.shutdown("read loop ended")
}

// localReadLoop 读取本地 WebUI 发来的帧，按类型分发。
// tunnel 帧（res/res_body/end/error）按 connId 路由回对应 client。
func (t *Tunnel) localReadLoop(parent context.Context, h *Hub) {
	for {
		ctx, cancel := context.WithTimeout(parent, readIdleTimeout)
		_, raw, err := t.conn.Read(ctx)
		cancel()
		if err != nil {
			log.Printf("[tunnel] %s read ended: %v", shortKey(t.accessKey), err)
			return
		}

		f, err := decodeFrame(raw)
		if err != nil {
			log.Printf("[tunnel] %s decode failed: %v", shortKey(t.accessKey), err)
			continue
		}

		switch f.Type {
		case TypeRes:
			// 响应头：写到对应 HTTP 连接（保留路由，body 可能多片）
			p, ok := t.takeRouteKeep(f.ConnId)
			if !ok {
				continue
			}
			p.writeHeader(f.Status, f.Headers)

		case TypeResBody:
			p, ok := t.takeRouteKeep(f.ConnId)
			if !ok {
				continue
			}
			if !p.headerSent {
				// 本地没发 res 头就先发 body（异常），补一个 200
				p.writeHeader(http.StatusOK, nil)
			}
			p.writeBody(f.Body)
			if f.Last {
				t.deleteRoute(f.ConnId)
				p.finish()
			}

		case TypeEnd:
			// 本地主动终止该请求
			p, ok := t.takeRoute(f.ConnId)
			if !ok {
				continue
			}
			p.fail("ended by local")

		case TypeError:
			// 本地处理出错
			if f.ConnId == "" {
				log.Printf("[tunnel] %s error: %s", shortKey(t.accessKey), f.Message)
				continue
			}
			p, ok := t.takeRoute(f.ConnId)
			if !ok {
				continue
			}
			p.fail("local error: " + f.Message)

		case TypePong:
			// 心跳回复，忽略

		case TypePing:
			_ = t.writeLocal(parent, Frame{Type: TypePong})

		case TypeRegisterToken:
			// 本地请求登记一个短命访问令牌：token → 当前隧道的 accessKey。
			// accessKey 在隧道注册时已认证，这里直接取 t.accessKey，可信。
			h.storeToken(f.Token, t.accessKey, f.TtlSec)

		default:
			log.Printf("[tunnel] %s unexpected frame type %q", shortKey(t.accessKey), f.Type)
		}
	}
}

// localHeartbeat 每 heartbeatInterval 向本地发 ping，保活并探测僵尸连接。
func (t *Tunnel) localHeartbeat(ctx context.Context) {
	ticker := time.NewTicker(heartbeatInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := t.writeLocal(ctx, Frame{Type: TypePing}); err != nil {
				log.Printf("[tunnel] %s heartbeat write failed: %v", shortKey(t.accessKey), err)
				return
			}
		}
	}
}
