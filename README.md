# Claude WebUI

[![Node.js](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)](https://nodejs.org/)
[![Version](https://img.shields.io/badge/version-0.1.0-blue)](https://github.com/YorrickBao/claude-web-ui)
[![pnpm](https://img.shields.io/badge/pnpm-10.31-orange)](https://pnpm.io/)

基于 [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/typescript) (`@anthropic-ai/claude-agent-sdk`) 的浏览器聊天界面。在网页里用 Claude Code 的全部能力（工具调用、文件编辑、Bash 等），支持多会话、工作目录选择、历史回放。

前端用 [assistant-ui](https://www.assistant-ui.com/) 的 headless Primitive（`ThreadPrimitive` / `MessagePrimitive` / `ComposerPrimitive`）+ Tailwind 自定义样式，**不依赖 shadcn**。

> 仅本地使用。无认证、全权限放行 —— 不要暴露到公网。

## 快速开始

### 零安装（推荐）

前置：Node ≥ 20，本机已 `claude login`（SDK 会 spawn `claude` 子进程）。

```bash
npx github:YorrickBao/claude-web-ui

# 或使用 pnpm / yarn
pnpm dlx github:YorrickBao/claude-web-ui
yarn dlx github:YorrickBao/claude-web-ui
```

浏览器会自动打开。首次运行 SDK 会下载约 250MB 的 `claude` 二进制到 `~/.claude/`，后续秒开。

```bash
# 自定义端口
npx github:YorrickBao/claude-web-ui --port 8080

# 允许局域网访问
npx github:YorrickBao/claude-web-ui --host 0.0.0.0

# 查看选项
npx github:YorrickBao/claude-web-ui --help
```

### 全局安装（短命令）

```bash
npm install -g github:YorrickBao/claude-web-ui
cwu
```

### 开发模式

前置：Node ≥ 20、pnpm ≥ 9。

```bash
pnpm install
pnpm dev
```

打开 http://localhost:25173 —— 前端 25173，后端 23456，dev 模式下 vite 自动反代 `/api`。前端监听 `0.0.0.0`，局域网/容器内可通过主机 IP 访问。

**生产模式**（后端托管前端）：

```bash
pnpm build
pnpm start
# 打开 http://127.0.0.1:23456
```

## 使用指南

### 1. 启动服务

```bash
npx github:YorrickBao/claude-web-ui
# 也可用 pnpm dlx / yarn dlx
```

浏览器自动打开 `http://127.0.0.1:23456`。左侧是会话列表，右侧是对话区。

### 2. 新建会话

点击右上角 **"+ 新建会话"**，进入新建页面：

1. **选工作目录** —— Claude 会在该目录下执行文件读写、Bash 等操作。可以手动输入路径，也可以用下方的目录浏览器点选。默认是你的 home 目录。
2. **选 Profile（可选）** —— 如果配置了自定义模型/API，在下拉框里选对应的 profile；不选则用 CLI 默认。
3. **输入第一条消息** —— 比如 "分析这个项目的结构" 或 "帮我写一个 Python 脚本"。
4. 回车发送，Claude 开始干活。

> 首次运行 SDK 会下载约 250MB 的 `claude` 二进制到 `~/.claude/`，后续秒开。

### 3. 观察 Claude 工作

发送消息后，你会看到：

- **文本流式输出** —— 逐 token 显示，和终端体验一致。
- **工具调用卡片** —— Claude 使用 Bash、Edit、Write、Read 等工具时，会弹出可折叠的工具卡片，展示命令内容、执行结果等。
- **实时进度** —— 每轮工具调用都会即时反馈，直到全部完成。

想中断？点消息上方的 **"中止"** 按钮即可。

### 4. 继续对话

- 左侧会话列表显示所有历史会话，点击即可切换。
- 在已有会话中直接输入新消息，SDK 会自动 `resume` 续接。
- **会话与 CLI 完全互通**：终端 `claude` 创建的会话在 WebUI 里能看到并继续；反过来也一样。

### 5. 管理 Profile（模型/API 配置）

如果需要自定义模型、反代 API 地址或认证 token：

1. 点击左下角 **"设置"** → **"Profile 管理"**。
2. 新建一个 profile，填写需要用到的环境变量（比如 `ANTHROPIC_BASE_URL`、`ANTHROPIC_MODEL` 等）。
3. 新建会话时在 profile 下拉框里选择即可。
4. 会话进行中也可以切换 profile，只影响后续消息。

支持的变量见下方 [配置 → Claude 子进程](#claude-子进程ui-里配)。

> Profile 数据存在 `~/.claude-web-ui/profiles.json`，仅本地存储。

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

### 启动参数

| 参数 | 简写 | 默认 | 说明 |
|---|---|---|---|
| `--port` | `-p` | `23456` | 起始端口（占用则 +1 递增） |
| `--host` | `-h` | `127.0.0.1` | 监听地址（`0.0.0.0` 允许局域网访问） |
| `--help` | | | 打印帮助 |

也可用环境变量 `PORT` 和 `HOST`。

### 后端进程

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
- 存储：profile 在 `~/.claude-web-ui/profiles.json`；会话与 profile 的绑定在 `sessions.json` 每条记录的 `profileId` 字段。
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
