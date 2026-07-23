# Claude WebUI 中转服务（Relay）

远程控制功能需要一个部署在公网 VPS 上的中转服务，用于打通 NAT：本地 WebUI（绑定 127.0.0.1）主动出站连接中转，远程浏览器经中转反向访问本地。

```
[远程浏览器] ──wss(443)──► [Nginx:TLS终止] ──ws明文(127.0.0.1:8787)──► [Go中转] ◄──ws出站隧道── [本地WebUI]
```

中转是纯转发，不解析 HTTP 内容，不做 TLS（交 Nginx）。

## 获取二进制

**方式一（推荐）：从 GitHub Actions / Releases 下载预编译产物**

仓库已配置 GitHub Actions，每次推送 `relay/` 改动会自动构建 Linux/macOS/Windows 多平台二进制。打 `v*` tag 时会发布到 Releases。

- 最新构建产物：仓库 → Actions → 选最近一次 Build Relay → 下载对应平台的 artifact
- 正式发布：仓库 → Releases

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
mv claude-web-ui-relay-linux-amd64 claude-web-ui-relay
chmod +x claude-web-ui-relay
```

### 2. 用 systemd 托管

`/etc/systemd/system/claude-web-ui-relay.service`：

```ini
[Unit]
Description=Claude WebUI Relay
After=network.target

[Service]
ExecStart=/home/user/claude-web-ui-relay --listen 127.0.0.1:8787
Restart=on-failure
RestartSec=3
User=user

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

    # 关键：WebSocket 升级头
    location / {
        proxy_pass http://127.0.0.1:8787;
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

### 4. 在本地 WebUI 启用

打开 WebUI → 左下角 Smartphone 图标 → 远程控制面板：
- 中转地址填 `wss://relay.your-domain.com`
- 启用后，面板会展示「远程访问地址」（带 accessKey），复制到任意浏览器或手机扫码即可远程操作。

## 协议

见 `protocol.go` 顶部注释。核心帧：`register` / `req` / `req_body` / `res` / `res_body` / `ping`，用 `connId` 关联一次 HTTP 往来。

## 运维

- 日志：`journalctl -u claude-web-ui-relay -f`
- 二进制升级：重新 `just build-linux` + `scp` + `systemctl restart claude-web-ui-relay`
- 无状态、无持久化，重启不丢配置（配置在本地 WebUI 端）
