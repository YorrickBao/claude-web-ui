package main

import (
	"crypto/subtle"
	"encoding/base64"
	"net/http"
	"strings"
)

// parseBasicAuth 解析 "user:pass" 格式的启动参数。
// 要求 user 和 pass 都非空；pass 可含冒号（用 SplitN 只切第一处）。
// 返回 (user, pass, ok)，无冒号或 user/pass 任一为空时 ok=false。
func parseBasicAuth(s string) (user, pass string, ok bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return "", "", false
	}
	parts := strings.SplitN(s, ":", 2)
	if len(parts) < 2 || parts[0] == "" || parts[1] == "" {
		return "", "", false
	}
	return parts[0], parts[1], true
}

// basicAuth 返回带 HTTP Basic Auth 校验的 handler 包装。
// 凭证不匹配时回 401 + WWW-Authenticate 触发浏览器弹框。
// 用 subtle.ConstantTimeCompare 做常量时间比较，防时序侧信道。
// 当前仅用于保护状态页 /stats；/、/tunnel 不走此包装。
func basicAuth(user, pass string, next http.HandlerFunc) http.HandlerFunc {
	// 预算期望的 Authorization 头值，避免每次请求重复编码
	expected := "Basic " + base64.StdEncoding.EncodeToString([]byte(user+":"+pass))
	return func(w http.ResponseWriter, r *http.Request) {
		got := r.Header.Get("Authorization")
		// 同时校验前缀和完整值，避免 "Basic " 前缀本身被 ConstantTimeCompare 当作命中信号
		if strings.HasPrefix(got, "Basic ") &&
			subtle.ConstantTimeCompare([]byte(got), []byte(expected)) == 1 {
			next(w, r)
			return
		}
		w.Header().Set("WWW-Authenticate", `Basic realm="claude-web-ui-relay", charset="UTF-8"`)
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
	}
}
