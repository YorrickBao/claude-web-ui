# Claude WebUI 中转服务（Relay）

远程控制功能需要一个部署在公网 VPS 上的中转服务，用于打通 NAT：本地 WebUI（绑定 127.0.0.1）主动出站连接中转，远程浏览器经中转反向访问本地。

```
[远程浏览器] ──wss(443)──► [Nginx:TLS终止] ──ws明文(127.0.0.1:8787)──► [Go中转] ◄──ws出站隧道── [本地WebUI]
```

中转是纯转发，不解析 HTTP 内容，不做 TLS（交 Nginx）。

## 获取二进制

**方式一（推荐）：从 GitHub Releases 下载预编译产物**

仓库已配置 GitHub Actions（`.github/workflows/build-relay.yml`）：推 main 自动构建 Linux/macOS/Windows 多平台临时 artifact；打 `relay-v*` tag 时发布正式 Release。

- 最新临时构建：仓库 → Actions → 选最近一次 Build Relay → 下载对应平台的 artifact（90 天有效）
- 正式发布：仓库 → [Releases](https://github.com/YorrickBao/claude-web-ui/releases)

### 发版方法

正式发版由 maintainer 打 tag 触发，详见根目录 [AGENTS.md → 发版](../AGENTS.md#发版)。简言之：

```bash
git tag -a relay-v0.x.0 -m "claude-web-ui-relay v0.x.0"
git push origin relay-v0.x.0
```

> tag 前缀必须是 `relay-v`（不是 `v`）。relay 与 npm 包（`npx claude-web-ui`）独立版本化，互不干扰。

**方式二：本地编译**（需 Go 1.26+、[just](https://github.com/casey/just)）

```bash
cd relay
# 当前平台
just build

# 交叉编译到 Linux amd64（最常见 VPS）
just build-linux
# 产物：claude-web-ui-relay-linux-amd64
```

> 注意：Go 构建产物不提交进仓库（已在 .gitignore 排除），统一由 CI 构建。

## 部署到 VPS

### 1. 上传二进制

```bash
scp claude-web-ui-relay-linux-amd64 user@your-vps:~/
ssh user@your-vps

# 放到 /opt 下（下方 ProtectHome=true 会屏蔽 /home，二进制必须挪出登录目录）
sudo mkdir -p /opt/claude-web-ui-relay
sudo mv claude-web-ui-relay-linux-amd64 /opt/claude-web-ui-relay/claude-web-ui-relay
sudo chmod +x /opt/claude-web-ui-relay/claude-web-ui-relay

# 专用低权用户，不要复用登录账号
sudo useradd -r -s /usr/sbin/nologin cwu-relay
```

### 2. 用 systemd 托管

`/etc/systemd/system/claude-web-ui-relay.service`：

```ini
[Unit]
Description=Claude WebUI Relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/opt/claude-web-ui-relay/claude-web-ui-relay --listen 127.0.0.1:8787
WorkingDirectory=/opt/claude-web-ui-relay
User=cwu-relay
Group=cwu-relay

Restart=on-failure
RestartSec=3
StartLimitIntervalSec=60
StartLimitBurst=5

# WebSocket 长连接吃 fd，默认 1024 不够
LimitNOFILE=65536

# ── 基础加固（与 bao-auth 一致）──
NoNewPrivileges=true       # 禁止提权
ProtectSystem=strict       # 全盘只读（relay 无状态，无需 ReadWritePaths）
ProtectHome=true           # 屏蔽 /home（故二进制须放 /opt）
PrivateTmp=true            # 独立 /tmp

# ── 内核篡改防护（systemd 官方：对所有服务零副作用）──
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true

# ── seccomp：唯一真正缩小攻击面的项（RCE 后限制可调用 syscall）──
SystemCallFilter=@system-service
SystemCallFilter=~@privileged @resources

UMask=0077

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now claude-web-ui-relay
sudo systemctl status claude-web-ui-relay
```

健康检查：`curl http://127.0.0.1:8787/healthz` → `{"ok":true}`

### 3. Nginx 反代（WebSocket + TLS）

先用 certbot 给域名签证书，然后配置站点：

```nginx
server {
    listen 443 ssl http2;
    server_name relay.your-domain.com;

    ssl_certificate     /etc/letsencrypt/live/relay.your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/relay.your-domain.com/privkey.pem;

    # ── 安全相关响应头 ──
    # HSTS：强制后续访问走 HTTPS（首次访问仍可能被中间人，但锁定后不再降级）
    add_header Strict-Transport-Security "max-age=31536000" always;
    # 不向任何外站泄露 Referer（避免 accessKey 经 Referer 流出，见下方安全说明）
    add_header Referrer-Policy "no-referrer" always;

    # 关键：WebSocket 升级头
    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        # relay 依赖此头判断客户端是否走 HTTPS，决定 cookie 的 Secure 标记
        proxy_set_header X-Forwarded-Proto $scheme;

        # WS 长连接，关闭缓冲，加大超时
        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}

# HTTP → HTTPS 跳转
server {
    listen 80;
    server_name relay.your-domain.com;
    return 301 https://$host$request_uri;
}
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

验证：`curl https://relay.your-domain.com/healthz` → `{"ok":true}`

### 3b. 部署在子路径下（可选）

如果无法给中转分配独立端口或子域名，可以让它挂在某个现有站点的一个 location 下（例如 `/relay/`）。前端已用相对路径 + HashRouter，同一份产物在子路径下无需任何路径重写。

关键点：
- nginx `location /relay/` 用尾斜杠 `proxy_pass` **裁掉前缀**，让中转仍看到根路径；
- 必须有一条 `location = /relay` 把无斜杠访问 301 到 `/relay/`——相对路径解析依赖文档 URL 以斜杠结尾。

```nginx
# 无斜杠访问重定向到带斜杠（相对路径解析的前提）
location = /relay { return 301 /relay/; }

location /relay/ {
    proxy_pass http://127.0.0.1:8787/;   # 尾斜杠 = 裁掉 /relay/ 前缀
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;

    # WS 长连接，关闭缓冲，加大超时
    proxy_buffering off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
```

验证：
- `curl https://your-domain.com/relay/healthz` → `{"ok":true}`
- 浏览器打开远程访问地址（形如 `https://your-domain.com/relay/?k=KEY`）应正常加载

> 本地面板「中转地址」填 `wss://your-domain.com/relay`：客户端会自动拼出
> `wss://your-domain.com/relay/tunnel`，经 nginx 裁前缀后命中中转的 `/tunnel`。

### 4. 在本地 WebUI 启用

打开 WebUI → 左下角 Smartphone 图标 → 远程控制面板：
- 中转地址填 `wss://relay.your-domain.com`
- 启用后，面板会展示「远程访问地址」（带 accessKey），复制到任意浏览器或手机扫码即可远程操作。

## 协议

见 `protocol.go` 顶部注释。核心帧：`register` / `req` / `req_body` / `res` / `res_body` / `ping`，用 `connId` 关联一次 HTTP 往来。另有 `register_token` 帧：本地→中转，登记一个 60 秒一次性访问令牌（`token` + `ttlSec` 字段），供远程浏览器用 `?t=token` 换取 accessKey cookie。

## 运维

- 日志：`journalctl -u claude-web-ui-relay -f`
- 二进制升级：重新 `just build-linux` + `scp` + `systemctl restart claude-web-ui-relay`
- 无状态、无持久化，重启不丢配置（配置在本地 WebUI 端）

## 安全说明

远程控制把绑定 `127.0.0.1` 的本地服务暴露到公网，远程浏览器可执行与本地终端 `claude` 完全等效的操作（含执行命令、读写文件）。请务必读完本节再决定是否部署到公网。

### 访问令牌（token）交换机制

远程访问**不再在 URL 中携带长期 accessKey**，改用一次性短命令牌：

1. 本地 WebUI 面板点击「生成链接」→ 本地生成 192 bit 随机 token，经隧道登记到中转（`register_token` 帧），存为 `token → accessKey` 映射，**60 秒有效**
2. 远程地址形如 `https://relay.example.com/?t=<TOKEN>`（仅含一次性 token，无 accessKey）
3. 浏览器首次打开 → 中转一次性消费 token，种下 accessKey cookie，302 回根路径（剥掉 token）
4. 后续请求走 cookie 鉴权，accessKey 不出现在任何 URL

这样 accessKey **不会进入 nginx 日志 / Referer / 浏览器历史**——这些位置至多留下一次性 token，且 60 秒后即失效、消费后不可重放。

### accessKey 的安全性

- **强度**：accessKey 与 token 均为 24 字节随机数（192 bit 熵），穷举不可行
- **token 一次性**：消费后立即删除，即便在 60s 窗口内也无法重放
- **cookie 保护**：`HttpOnly` + `SameSite=Lax`，防 XSS 读取和部分 CSRF
- **判定 HTTPS**：relay 直连时看连接 TLS 标记，经 Nginx 终止 TLS 时看 `X-Forwarded-Proto` 头（上面的 nginx 配置已透传该头），据此决定 cookie 的 `Secure` 标记

### 残余威胁与缓解

| 途径 | 说明 | 缓解 |
|------|------|------|
| **HTTP 明文中间人** | 首次 token 交换在明文下可被截获 | 强制 HTTPS：上方配置已做 HTTP→HTTPS 跳转 + HSTS |
| **浏览器历史留有 token** | token 仍在历史记录（非 accessKey） | 一次性、60s 失效，泄露窗口极短；过期后无害 |
| **cookie 被盗** | cookie 有效期 30 天 | `Secure`（HTTPS 下）+ `HttpOnly`；必要时在面板「重新生成」accessKey 使旧 cookie 失效 |
| **relay 重启丢失 token** | 未交换的 token 随进程消失 | 用户在面板重新生成即可 |

### 日志脱敏（可选）

token 交换后 URL 不含 accessKey，但 token 仍可能进 access log。如需彻底无痕：

```nginx
location / {
    access_log off;
    # ... 其余 proxy 配置 ...
}
```

### 风险判断

- **个人/临时远程访问**：按上方配置部署（HTTPS + HSTS + Referrer-Policy + 透传 `X-Forwarded-Proto`），风险可接受
- **长期挂公网 / 多人 / 敏感机器**：不建议。等效本地 shell 的权限即便有 token 保护，cookie 泄露仍等于本机沦陷，且无审计告警
- **不要**把当前有效的访问链接分享到公开渠道——虽是一次性 token，60s 内仍可被他人抢先使用
