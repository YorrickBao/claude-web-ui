package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestParseBasicAuth(t *testing.T) {
	cases := []struct {
		in       string
		wantUser string
		wantPass string
		wantOK   bool
	}{
		{"", "", "", false},       // 空
		{"   ", "", "", false},    // 空白
		{"user", "", "", false},   // 无冒号
		{":pass", "", "", false},  // user 空
		{"user:", "", "", false},  // pass 空
		{":", "", "", false},      // 都空
		{"user:pass", "user", "pass", true},
		{"user:pa:ss", "user", "pa:ss", true},  // pass 含冒号（SplitN 只切第一处）
		{"  user:pass  ", "user", "pass", true}, // trim
		{"a:b", "a", "b", true},
	}
	for _, c := range cases {
		gotUser, gotPass, gotOK := parseBasicAuth(c.in)
		if gotUser != c.wantUser || gotPass != c.wantPass || gotOK != c.wantOK {
			t.Errorf("parseBasicAuth(%q) = (%q,%q,%v), want (%q,%q,%v)",
				c.in, gotUser, gotPass, gotOK, c.wantUser, c.wantPass, c.wantOK)
		}
	}
}

func TestBasicAuthMiddleware(t *testing.T) {
	called := false
	inner := func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	}
	h := basicAuth("admin", "s3cret", inner)

	t.Run("无凭证拒绝", func(t *testing.T) {
		called = false
		r := httptest.NewRequest("GET", "/stats", nil)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if called {
			t.Error("inner handler 不应被调用")
		}
		if w.Code != 401 {
			t.Errorf("status = %d, want 401", w.Code)
		}
		if got := w.Header().Get("WWW-Authenticate"); got == "" {
			t.Error("缺少 WWW-Authenticate 头，浏览器不会弹框")
		}
	})

	t.Run("错误凭证拒绝", func(t *testing.T) {
		called = false
		r := httptest.NewRequest("GET", "/stats", nil)
		r.Header.Set("Authorization", "Basic YWRtaW46d3Jvbmc=") // admin:wrong
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if called {
			t.Error("inner handler 不应被调用")
		}
		if w.Code != 401 {
			t.Errorf("status = %d, want 401", w.Code)
		}
	})

	t.Run("正确凭证放行", func(t *testing.T) {
		called = false
		r := httptest.NewRequest("GET", "/stats", nil)
		r.Header.Set("Authorization", "Basic YWRtaW46czNjcmV0") // admin:s3cret
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if !called {
			t.Error("inner handler 应被调用")
		}
		if w.Code != 200 {
			t.Errorf("status = %d, want 200", w.Code)
		}
	})

	t.Run("仅前缀匹配不等于命中", func(t *testing.T) {
		// 防止 "Basic " 前缀本身被当命中信号
		called = false
		r := httptest.NewRequest("GET", "/stats", nil)
		r.Header.Set("Authorization", "Basic ")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if called {
			t.Error("空凭证值不应命中")
		}
		if w.Code != 401 {
			t.Errorf("status = %d, want 401", w.Code)
		}
	})
}
