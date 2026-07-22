# Claude WebUI

基于 [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/typescript) (`@anthropic-ai/claude-agent-sdk`) 的浏览器聊天界面。在网页里用 Claude Code 的全部能力（工具调用、文件编辑、Bash 等），支持多会话、工作目录选择、历史回放。

前端用 [assistant-ui](https://www.assistant-ui.com/) 的 headless Primitive（`ThreadPrimitive` / `MessagePrimitive` / `ComposerPrimitive`）+ Tailwind 自定义样式，**不依赖 shadcn**。

> 仅本地使用。无认证、全权限放行 —— 不要暴露到公网。

## 快速开始

前置：Node ≥ 20、pnpm ≥ 9、本机已 `claude login`（SDK 会 spawn `claude` 子进程）。

```bash
pnpm install
pnpm dev
```

打开 http://localhost:25173 —— 前端 25173，后端 25174，dev 模式下 vite 自动反代 `/api`。前端监听 `0.0.0.0`，局域网/容器内可通过主机 IP 访问。

**生产模式**（后端托管前端）：

```bash
pnpm build
pnpm start
# 打开 http://127.0.0.1:25174
```

## 功能

- ✅ 新建会话时**选择工作目录**（Claude 在该目录下运行工具）
- ✅ 流式回复（SSE，逐 token）
- ✅ 工具调用渲染为可折叠卡片（Bash / Edit / Write / Read 有定制展示，其余走通用卡片）
- ✅ Markdown + 代码高亮
- ✅ 多会话管理（侧边栏列表 + 切换）
- ✅ 历史回放（SDK transcript → 前端消息）
- ✅ 续接历史会话（SDK `resume`）
- ✅ 中止进行中的请求

## 架构

```
浏览器 (React 19 + Vite + assistant-ui Primitive)
  ↑ fetch + ReadableStream 解析 SSE
  ↓ POST /api/sessions(/:id/messages)
后端 (Fastify + Claude Agent SDK)
  ↓ query() → AsyncIterable<SDKMessage>
  翻译成 SSE 事件: session_created / text / tool_use / tool_result / done / error
```

**核心设计**：
- 后端把 SDK 的 `SDKMessage` 流翻译成扁平 SSE 事件，前端只认这 6 种事件类型 —— 不直接耦合 SDK。
- 前端 `useChatSSE` hook 用 assistant-ui 的 `useExternalStoreRuntime` 自管消息 state，把 SSE 事件增量应用到 `ThreadMessageLike[]`。工具调用是单 part（`result` 是同 part 的字段，无独立 tool-result part）。
- 会话 id = SDK 的 `session_id`，前端 URL 直接用它，无双轨制。
- 历史回放与实时流共用同一套前端渲染逻辑（后端 `replaySession()` 把 SDK transcript 转成与 `ThreadMessageLike` 等价的结构）。
- 新建会话时 URL 从 `/pending` 静默 `replaceState` 到 `/c/<id>`，对话状态不丢。
- 工具卡片渲染：`MessagePrimitive.Parts` 的 `components.tools.by_name` 按 toolName 匹配（Bash/Edit/Write/Read 有定制 UI），未注册走 `Fallback`。

### 项目结构

```
server/              Fastify 后端
  src/
    index.ts         入口
    env.ts           配置（端口、路径）
    routes/index.ts  所有 /api 路由
    lib/
      sdk.ts         query() → SSEEvent 生成器
      replay.ts      getSessionMessages() → 前端消息结构
      store.ts       sessions.json 原子读写
      sse.ts         SSE 响应辅助
      inflight.ts    进行中 query 的 AbortController 管理
      types.ts       共享类型（含 SSE 线缆）
web/                 Vite + React + assistant-ui 前端
  src/
    App.tsx          根
    components/
      AppShell.tsx   布局 + 路由分发
      Sidebar.tsx    会话列表
      NewSessionView 选工作目录 + 首条消息
      ChatView       头部 + AssistantRuntimeProvider 包住 ChatThread
      ChatThread     assistant-ui Primitive 组装的 Thread/Message/Composer
      Markdown       react-markdown + 代码高亮
      tools/ToolUIs.tsx  工具卡片（Bash/Edit/Write/Read + 通用 Fallback）
    hooks/
      useChatSSE.ts  SSE → useExternalStoreRuntime 的核心 hook
      useSessions.ts 会话列表
    lib/
      api.ts         fetch 封装
      sse.ts         SSE 流解析
      types.ts       与后端 SSEEvent 对齐
```

## API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/sessions` | 列出所有会话 |
| GET | `/api/sessions/:id` | 单会话元信息 + 历史消息 |
| POST | `/api/sessions` | 新建会话 + 跑首条消息（SSE 响应） |
| POST | `/api/sessions/:id/messages` | 已有会话发消息（SSE 响应） |
| POST | `/api/sessions/:id/abort` | 中止 |
| GET | `/api/browse?path=` | 列目录（供前端选 cwd） |

### SSE 事件协议

| event | data | 说明 |
|---|---|---|
| `session_created` | `{ type, sessionId }` | 新会话 id（来自 SDK `system/init`） |
| `text` | `{ type, text }` | assistant 文本增量 |
| `tool_use` | `{ type, id, name, input }` | 工具调用 |
| `tool_result` | `{ type, id, name, result, isError }` | 工具结果 |
| `error` | `{ type, message }` | 错误 |
| `done` | `{ type, costUsd, numTurns, durationMs }` | 本轮完成 |

## 配置

### 后端进程

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `25174` | 后端端口 |
| `HOST` | `127.0.0.1` | 监听地址 |
| `NODE_ENV` | — | `production` 时关闭 pino-pretty |

### Claude 子进程（UI 里配）

在 UI 里管理多套**环境变量配置（profile）**，新建会话时选一套启动，会话进行中也可切换。

**两个入口**：
- Sidebar 底部"配置管理"按钮 → 管理 profile（增删改查、复制）
- 新建会话页 / 会话头部 → 选 profile 下拉 + 旁边齿轮快速管理

**模型**：没 profile = 空 env = 完全用 CLI 默认。会话随时可切换 profile，只影响后续消息（SDK resume 用新 profile 的 env）。

支持的字段（CLI 真实认的，已从二进制核实）：

| 环境变量 | 说明 |
|---|---|
| `ANTHROPIC_BASE_URL` | API 接入地址（反代/第三方网关改这里） |
| `ANTHROPIC_AUTH_TOKEN` | 认证 token（敏感，密码框） |
| `ANTHROPIC_MODEL` | 主模型 |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | "opus"别名指向的实际模型 |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | "sonnet"别名指向的实际模型 |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | "haiku"别名指向的实际模型（后台任务用） |
| `CLAUDE_CODE_EFFORT_LEVEL` | 思考深度（low/medium/high/xhigh/max），会话级强制覆盖 |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | 自动压缩触发 token 数 |
| `CLAUDE_CODE_SUBAGENT_MODEL` | 子 agent 模型 |

**实现**：
- 后端 `query()` 调用时传 `env: { ...process.env, ...profile.env }`（SDK 的 env 是完全替换，必须 spread process.env）。
- 存储：profile 在 `server/data/profiles.json`；会话与 profile 的绑定在 `sessions.json` 每条记录的 `profileId` 字段。两个文件都已 gitignore（含 token）。
- 删除 profile 时，引用它的会话自动解绑（profileId 置 null）。

## 已知限制 / 后续可做

- **权限**：第一版用 `bypassPermissions`，所有工具自动执行。要做权限弹窗，后端加 `canUseTool` 回调 + 前端弹窗，走 `permission_needed` 事件。
- **认证**：无。纯本地监听 `127.0.0.1`。要远程用得加 token / HTTPS。
- **目录选择**：当前是"输入框 + 单层列表浏览"。可升级成完整树形（`react-arborist`）。
- **diff 渲染**：Edit 工具卡片已做了简单的 +/- 展示，但没接 `diff2html` 之类的高亮 diff。
- **会话标题**：用首条用户消息兜底，没有让 Claude 生成摘要标题（SDK `listSessions` 的 `summary` 字段其实有，可接上）。
- **消息编辑/重发**：不支持。Composer 只发新消息。
- **附件**：不支持上传图片/文件。

## 依赖

- 后端：`fastify`、`@fastify/static`、`@anthropic-ai/claude-agent-sdk`、`zod`
- 前端：`@assistant-ui/react` + `@assistant-ui/react-markdown`（headless Primitive，未引入 shadcn）、`react` 19、`react-router-dom`、`react-markdown` + `remark-gfm` + `rehype-highlight`、`tailwindcss`、`lucide-react`

> 注意：`@assistant-ui/react` 和 `@anthropic-ai/claude-agent-sdk` 都还是 0.x，`package.json` 里精确锁版本号，不用 `^`。
