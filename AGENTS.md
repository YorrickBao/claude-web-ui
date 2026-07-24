# AGENTS.md

## 项目首要目标

制作一个 Web UI，方便在浏览器中执行与 Claude Code 等价的操作。

## 分发方式

用户通过 `npx` 直接使用，不从 npm registry 下载：

```
npx claude-web-ui
```

`package.json` 的 `files` 字段指定了发布内容：

```json
"files": ["cli.mjs", "server/dist/", "web/dist/"]
"bin": { "claude-web-ui": "cli.mjs", "cwu": "cli.mjs" }
```

`cli.mjs` 启动 Fastify 服务器，托管 `web/dist/` 静态文件并暴露 `/api/*` 路由。

**因此 `web/dist/` 和 `server/dist/` 必须提交到 Git。** 每次修改源码后：

1. `pnpm run build` — 重新构建前后端
2. 将 dist 变更一并提交

源码修改和构建产物可以分开 commit（源码 feat/fix + chore 构建产物），也可以合在一起。

## 发版

项目有两套独立产物，各用各的 tag 前缀，互不干扰：

| 产物 | 分发方式 | 触发 tag | CI 工作流 |
|---|---|---|---|
| relay（Go 中转服务） | GitHub Releases | `relay-v*` | `.github/workflows/build-relay.yml` |
| npm 包（WebUI 主程序） | `npx claude-web-ui` | `v*`（规划中） | — |

### relay 发版

改 `relay/` 后推 main 只会构建临时 artifact（90 天有效，不发版）。正式发版靠打 tag：

```bash
git tag -a relay-v0.x.0 -m "claude-web-ui-relay v0.x.0

变更说明：
- xxx"
git push origin relay-v0.x.0
```

约 1 分钟内 Actions 自动交叉编译 5 个平台（linux/darwin amd64+arm64、windows amd64）并发布到 Releases，无需手动上传。发版后可用 `gh release view relay-v0.x.0` 核对 assets 是否齐全。

注意事项：

- **tag 前缀必须是 `relay-v`**，否则不触发 relay 工作流（`on.push.tags: relay-v*`）。
- **不要把 `paths` 放回 `push` 块**——它会同时约束 `branches` 和 `tags`，导致 tag 指向的 commit 若在 `relay/` 下无 diff 就不触发 push 事件，Release 永远建不出来（已踩过这个坑）。`paths` 只保留在 `pull_request` 上省 CI。
- relay 与 npm 包独立版本号，各自递增，不强制对齐。

## 关键约束

- 所有设计决策应服务于"浏览器操作等效于终端 `claude` 命令"这一目标
- 会话与 CLI 共享同一份 `~/.claude/` 转录存储，WebUI 和终端 CLI 的会话完全互通
- 工程只存会话"名片"（元信息），不维护自己的消息数据库
- 仅本地使用，无认证，不要暴露到公网
- **后端代码严禁静默 catch 错误**：所有 `catch` 块必须用 `console.warn`/`console.error` 打印可读的错误信息（`err.message`），必要时附加上下文（如 sessionId），确保出现问题时能从终端日志快速定位

## UI 组件库

- 使用 **shadcn/ui**（底层引擎为 `@base-ui/react`，不是 Radix UI）
- shadcn/ui 组件位于 `web/src/components/ui/`，是对 Base UI 原语的封装
- `Select` 组件的 `onValueChange` 签名为 `(value: string | null, eventDetails) => void`
- **`SelectValue` 不会自动从 `SelectItem` children 提取显示文本**（这是 Base UI 的设计），必须给 `Select.Root` 传 `items` prop（`Record<string, string>`）告诉它值→标签的映射
