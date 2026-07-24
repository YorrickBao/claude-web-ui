package main

import "testing"

func TestNormalizePrefix(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"", ""},        // 根路径部署
		{"/", ""},       // 仅斜杠 = 根路径
		{"   ", ""},     // 空白
		{"relay", "/relay"},         // 补前导 /
		{"/relay", "/relay"},        // 已规范
		{"/relay/", "/relay"},       // 去结尾 /
		{"  /relay/  ", "/relay"},   // trim + 去结尾
		{"/relay/sub", "/relay/sub"},      // 多段前缀
		{"/relay/sub/", "/relay/sub"},     // 多段 + 去结尾
	}
	for _, c := range cases {
		if got := normalizePrefix(c.in); got != c.want {
			t.Errorf("normalizePrefix(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestHubExternalPath(t *testing.T) {
	cases := []struct {
		prefix, in, want string
	}{
		{"", "/", "/"},                         // 根部署：原样
		{"/relay", "/", "/relay/"},             // 子路径：根段拼前缀
		{"/relay", "/?key=1", "/relay/?key=1"}, // 子路径：带 query
		{"", "/?key=1", "/?key=1"},             // 根部署：带 query
		{"/relay", "/assets/x.css", "/relay/assets/x.css"},
	}
	for _, c := range cases {
		h := NewHub(c.prefix)
		if got := h.externalPath(c.in); got != c.want {
			t.Errorf("prefix=%q externalPath(%q) = %q, want %q",
				c.prefix, c.in, got, c.want)
		}
	}
}

func TestHubCookiePath(t *testing.T) {
	if got := NewHub("").cookiePath(); got != "/" {
		t.Errorf("root deployment cookiePath = %q, want %q", got, "/")
	}
	if got := NewHub("/relay").cookiePath(); got != "/relay" {
		t.Errorf("sub-path deployment cookiePath = %q, want %q", got, "/relay")
	}
}
