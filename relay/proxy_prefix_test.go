package main

import (
	"net/http/httptest"
	"strings"
	"testing"
)

// TestHandleProxyTokenRedirect 验证 token 交换分支的对外输出（重定向 Location、cookie Path）
// 是否正确拼上外部前缀。这是子路径部署的核心修复点。
func TestHandleProxyTokenRedirect(t *testing.T) {
	cases := []struct {
		name           string
		prefix         string
		wantLocation   string
		wantCookiePath string
	}{
		{"根路径部署", "", "/", "/"},
		{"子路径部署", "/relay", "/relay/", "/relay"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h := NewHub(c.prefix)
			token := "tok-" + c.name
			h.storeToken(token, "test-key", 60)

			r := httptest.NewRequest("GET", "/?t="+token, nil)
			w := httptest.NewRecorder()
			h.handleProxy(w, r)

			if w.Code != 302 {
				t.Fatalf("status = %d, want 302", w.Code)
			}
			if got := w.Header().Get("Location"); got != c.wantLocation {
				t.Errorf("Location = %q, want %q", got, c.wantLocation)
			}
			// Set-Cookie 形如 cwu_relay_key=test-key; Path=/relay; ...
			cookie := w.Header().Get("Set-Cookie")
			if !strings.Contains(cookie, "Path="+c.wantCookiePath) {
				t.Errorf("Set-Cookie = %q, want Path=%s", cookie, c.wantCookiePath)
			}
		})
	}
}
