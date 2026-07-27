import { Streamdown } from "streamdown";

/**
 * Markdown 渲染：基于 Streamdown —— 即 @assistant-ui/react-streamdown 的底层引擎。
 *
 * 内置 Shiki 代码高亮（github-light/github-dark 双主题，经 Tailwind `dark:` 变体
 * 随本项目的 `.dark` 类切换）、GFM、rehype-sanitize/harden。替代原先手搓的
 * react-markdown + remark-gfm + rehype-highlight + @tailwindcss/typography 组合。
 *
 * 保留 { children: string; streaming? } 接口以兼容三个调用点
 * （ChatThread 正文 / ToolUIs 思考 / PlanApprovalBanner 计划）：
 * - streaming=true  → mode="streaming"，末尾挂块光标（caret="block"），并按块增量解析
 * - streaming=false → mode="static"，干净终态，无光标
 *
 * 注意：Streamdown 的 children 必须是 string（内部有 typeof 校验）。
 * Streamdown 自身已 memo（按 children/mode 比较），无需再包 memo。
 */
export function Markdown({
  children,
  streaming = false,
}: {
  children: string;
  streaming?: boolean;
}) {
  return (
    <Streamdown
      mode={streaming ? "streaming" : "static"}
      caret={streaming ? "block" : undefined}
    >
      {children}
    </Streamdown>
  );
}
