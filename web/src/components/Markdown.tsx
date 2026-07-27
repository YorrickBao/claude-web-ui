import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { memo } from "react";

/**
 * Markdown 渲染。代码块走 highlight.js。
 * 样式靠 tailwind typography 的 prose 类（在容器上加）。
 */
export const Markdown = memo(function Markdown({
  children,
  streaming = false,
}: {
  children: string;
  /** 流式中：在最后一个块级元素末尾挂终端式块光标（见 index.css .md-streaming） */
  streaming?: boolean;
}) {
  return (
    <div className={`prose prose-sm dark:prose-invert max-w-none break-words prose-pre:rounded-xl prose-pre:border prose-pre:border-border/30 prose-pre:bg-black/40 prose-pre:p-3 prose-code:before:hidden prose-code:after:hidden${streaming ? " md-streaming" : ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{
          table: ({ children, ...props }) => (
            <div className="overflow-x-auto">
              <table {...props}>{children}</table>
            </div>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});
