package main

import "encoding/json"

// 帧类型常量。
//
// 中转协议是 JSON 文本帧。一次 HTTP 往来用 connId 关联：
//
//	client(远程浏览器) → 中转 → tunnel(本地WebUI) → 本地 fetch → tunnel → 中转 → client
//
// body 字段一律按 UTF-8 文本承载（本项目所有 HTTP 响应都是 JSON / SSE / HTML 文本）。
// 中转不解析 body 内容，原样透传。
const (
	TypeRegister   = "register"   // 本地→中转：注册隧道
	TypeRegistered = "registered" // 中转→本地：注册结果
	TypeReq        = "req"        // 一次 HTTP 请求的起始（method/path/headers）
	TypeReqBody    = "req_body"   // 请求体分片
	TypeRes        = "res"        // 响应起始（status/headers）
	TypeResBody    = "res_body"   // 响应体分片
	TypeError      = "error"      // 错误（含 connId 时关联到具体请求，否则连接级）
	TypePing       = "ping"       // 心跳
	TypePong       = "pong"       // 心跳回复
	TypeEnd        = "end"        // 终止某 connId（client 或本地异常时通知对端清理）
	TypeRegisterToken = "register_token" // 本地→中转：注册一个短命访问令牌（token→accessKey 映射，TTL 内可一次性换取 cookie）
)

// Frame 是所有帧的公共信封。解析时先看 Type 再按需读字段。
type Frame struct {
	Type      string            `json:"type"`
	ConnId    string            `json:"connId,omitempty"`
	AccessKey string            `json:"accessKey,omitempty"`
	Method    string            `json:"method,omitempty"`
	Path      string            `json:"path,omitempty"`
	Status    int               `json:"status,omitempty"`
	Headers   map[string]string `json:"headers,omitempty"`
	Body      string            `json:"body,omitempty"`
	Last      bool              `json:"last,omitempty"`
	Ok        bool              `json:"ok,omitempty"`
	Message   string            `json:"message,omitempty"`
	Token     string            `json:"token,omitempty"`  // register_token 帧携带的短命令牌
	TtlSec    int               `json:"ttlSec,omitempty"` // register_token 帧的存活秒数
}

func encodeFrame(f Frame) ([]byte, error) {
	return json.Marshal(f)
}

func decodeFrame(data []byte) (Frame, error) {
	var f Frame
	err := json.Unmarshal(data, &f)
	return f, err
}
