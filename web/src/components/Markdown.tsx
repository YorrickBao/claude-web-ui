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
}: {
  children: string;
}) {
  return (
    <div className="prose prose-invert prose-sm max-w-none break-words prose-pre:rounded-xl prose-pre:border prose-pre:border-border/30 prose-pre:bg-black/40 prose-pre:p-3 prose-code:before:hidden prose-code:after:hidden">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});
