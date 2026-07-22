# AGENTS.md

## 项目首要目标

制作一个 Web UI，方便在浏览器中执行与 Claude Code 等价的操作。

## 关键约束

- 所有设计决策应服务于"浏览器操作等效于终端 `claude` 命令"这一目标
- 会话与 CLI 共享同一份 `~/.claude/` 转录存储，WebUI 和终端 CLI 的会话完全互通
- 工程只存会话"名片"（元信息），不维护自己的消息数据库
- 仅本地使用，无认证，不要暴露到公网

## UI 组件库

- 使用 **Base UI**（`@base-ui/react`），不是 Radix UI
- `Select.Root` 的 `onValueChange` 签名为 `(value: string | null, eventDetails) => void`，value 可能为 null
- **Base UI 的 `SelectValue` 不会自动从 `SelectItem` children 解析显示文本**，必须通过 `Select.Root` 的 `items` prop 传入 `Record<string, string>` 映射值→标签：
  ```tsx
  <Select items={{ val1: "标签1", val2: "标签2" }} value={...} onValueChange={...}>
    <SelectTrigger><SelectValue /></SelectTrigger>
    <SelectContent>
      {Object.entries(items).map(([v, label]) => (
        <SelectItem key={v} value={v}>{label}</SelectItem>
      ))}
    </SelectContent>
  </Select>
  ```
