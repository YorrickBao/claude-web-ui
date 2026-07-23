package main

import (
	"context"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
)

const (
	// cookieName 携带 accessKey，让远程浏览器后续请求自动鉴权。
	cookieName   = "cwu_relay_key"
	cookieMaxAge = 86400 * 30 // 30 天
)

// handleProxy 是远程浏览器的主入口：所有非 /tunnel、非 /healthz 的 HTTP 请求都走这里。
//
// 工作流：
//  1. 从 cookie 或 ?k= 取 accessKey；无则返回落地说明页（根路径）或 401。
//  2. 首次带 ?k= 访问时种 cookie，后续请求浏览器自动携带。
//  3. 凭 accessKey 找到隧道；找不到返回 502。
//  4. 把 HTTP 请求转成 req/req_body 帧发到本地隧道，阻塞等待 res/res_body 流式回填。
//  5. 客户端断开时（r.Context 取消）通知本地终止该请求。
func (h *Hub) handleProxy(w http.ResponseWriter, r *http.Request) {
	accessKey := accessKeyFromRequest(r)

	if accessKey == "" {
		// 无 key：根路径展示落地页，其它路径 401
		if r.URL.Path == "/" {
			renderLanding(w)
			return
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = io.WriteString(w, "missing access key — open the link from Claude WebUI remote panel")
		return
	}

	// 首次 ?k= 访问：种 cookie（Secure 仅在 wss/https 下生效，http 本地测试会被忽略）
	if qk := r.URL.Query().Get("k"); qk != "" {
		http.SetCookie(w, &http.Cookie{
			Name:     cookieName,
			Value:    accessKey,
			Path:     "/",
			MaxAge:   cookieMaxAge,
			HttpOnly: true,
			Secure:   r.TLS != nil,
			SameSite: http.SameSiteLaxMode,
		})
	}

	tunnel, ok := h.Find(accessKey)
	if !ok {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusBadGateway)
		_, _ = io.WriteString(w, "tunnel offline — please enable remote control in Claude WebUI")
		return
	}

	// 读请求体（一次性；本项目请求体都很小，不存在大上传场景）
	var body string
	if r.Body != nil {
		b, err := io.ReadAll(r.Body)
		if err != nil {
			log.Printf("[proxy] %s read body failed: %v", shortKey(accessKey), err)
		} else {
			body = string(b)
		}
	}

	// 构造转发 path + query，剥离中转专属的 k 参数
	path := stripKeyParam(r.URL)

	// 收集请求头，剥离 hop-by-hop
	headers := collectHeaders(r.Header)

	connId := generateConnId()
	p := newPendingHTTP(w)
	tunnel.addRoute(connId, p)
	defer tunnel.deleteRoute(connId)

	// 客户端断开（浏览器关连接）时通知本地终止，并唤醒阻塞的 wait
	ctx := r.Context()
	go func() {
		<-ctx.Done()
		tunnel.deleteRoute(connId)
		p.fail("client disconnected")
		// 通知本地取消该请求
		_ = tunnel.writeLocal(context.Background(), Frame{Type: TypeEnd, ConnId: connId})
	}()

	// 发 req 帧
	if err := tunnel.writeLocal(ctx, Frame{
		Type:    TypeReq,
		ConnId:  connId,
		Method:  r.Method,
		Path:    path,
		Headers: headers,
	}); err != nil {
		log.Printf("[proxy] %s write req %s failed: %v", shortKey(accessKey), connId, err)
		if !p.headerSent {
			w.WriteHeader(http.StatusBadGateway)
			_, _ = io.WriteString(w, "tunnel write failed")
		}
		return
	}

	// 发请求体：无论是否有 body，都发一个 req_body:last 帧标记请求体结束，
	// 让隧道对端逻辑统一（GET 无 body 时也收到终结信号）。
	if err := tunnel.writeLocal(ctx, Frame{
		Type:   TypeReqBody,
		ConnId: connId,
		Body:   body,
		Last:   true,
	}); err != nil {
		log.Printf("[proxy] %s write req_body %s failed: %v", shortKey(accessKey), connId, err)
	}

	// 阻塞等待本地响应流结束（或客户端断开）
	if err := p.wait(ctx); err != nil {
		log.Printf("[proxy] %s %s wait ended: %v", shortKey(accessKey), connId, err)
		// 若头尚未发送，可返回错误页；否则连接已部分写出，无法改写状态
		if !p.headerSent {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			w.WriteHeader(http.StatusBadGateway)
			_, _ = io.WriteString(w, "upstream error: "+err.Error())
		}
		return
	}
}

// accessKeyFromRequest 优先从 cookie 取，其次从 ?k= query 取。
func accessKeyFromRequest(r *http.Request) string {
	if c, err := r.Cookie(cookieName); err == nil && c.Value != "" {
		return c.Value
	}
	return r.URL.Query().Get("k")
}

// stripKeyParam 返回去掉 k 参数后的 path（含剩余 query）。
// 中转用 ?k= 首次携带 accessKey，该参数不能透传给本地 API。
func stripKeyParam(u *url.URL) string {
	q := u.Query()
	q.Del("k")
	encoded := q.Encode()
	if encoded == "" {
		return u.Path
	}
	return u.Path + "?" + encoded
}

// collectHeaders 从 http.Header 收集非 hop-by-hop 头为 map。
func collectHeaders(h http.Header) map[string]string {
	out := make(map[string]string, len(h))
	for k, vs := range h {
		if isHopByHop(k) {
			continue
		}
		// 跳过会让本地 fetch 混淆的头
		lk := strings.ToLower(k)
		if lk == "host" || lk == "content-length" {
			continue
		}
		if len(vs) > 0 {
			out[k] = vs[0]
		}
	}
	return out
}

// renderLanding 返回中转的落地说明页（无 accessKey 时访问根路径所见）。
func renderLanding(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = io.WriteString(w, `<!doctype html>
<html lang="zh"><meta charset="utf-8">
<title>Claude WebUI Relay</title>
<body style="font-family:system-ui,sans-serif;padding:2.5rem;color:#333;max-width:36rem;margin:0 auto">
<h2>Claude WebUI 中转服务</h2>
<p>这是远程控制中转。请通过本地 WebUI 的「远程控制」面板获取的链接访问：</p>
<ol>
<li>在本地 WebUI 左下角点击 <b>📱 远程控制</b>；</li>
<li>填写中转地址并启用；</li>
<li>复制「远程访问地址」在浏览器打开，或扫码。</li>
</ol>
<p style="color:#888;font-size:0.85rem">部署中转见仓库 relay/README.md</p>`)
}
