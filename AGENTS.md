# AGENTS.md

## 项目首要目标

制作一个 Web UI，方便在浏览器中执行与 Claude Code 等价的操作。

## 关键约束

- 所有设计决策应服务于"浏览器操作等效于终端 `claude` 命令"这一目标
- 会话与 CLI 共享同一份 `~/.claude/` 转录存储，WebUI 和终端 CLI 的会话完全互通
- 工程只存会话"名片"（元信息），不维护自己的消息数据库
- 仅本地使用，无认证，不要暴露到公网

## UI 组件库

- 使用 **shadcn/ui**（底层引擎为 `@base-ui/react`，不是 Radix UI）
- shadcn/ui 组件位于 `web/src/components/ui/`，是对 Base UI 原语的封装
- `Select` 组件的 `onValueChange` 签名为 `(value: string | null, eventDetails) => void`
- **`SelectValue` 不会自动从 `SelectItem` children 提取显示文本**（这是 Base UI 的设计），必须给 `Select.Root` 传 `items` prop（`Record<string, string>`）告诉它值→标签的映射
