/**
 * 跨场景复制文本到剪贴板。
 *
 * `navigator.clipboard.writeText` 只在安全上下文（HTTPS 或 localhost）下可用。
 * 本项目常通过 `0.0.0.0` / 局域网 IP / relay 隧道访问，此时 `window.isSecureContext === false`，
 * `navigator.clipboard` 为 `undefined`，调用会抛 `TypeError`。
 *
 * 因此先尝试 Clipboard API；不可用或失败时回退到隐藏 textarea + `document.execCommand("copy")`。
 * 任何异常都打印到 console（遵守 AGENTS.md 禁止静默 catch 的约束），并向上抛出供调用方处理。
 */
export async function copyText(text: string): Promise<void> {
  // 1) 首选：异步 Clipboard API（安全上下文）
  if (
    typeof navigator !== "undefined" &&
    navigator.clipboard &&
    typeof navigator.clipboard.writeText === "function"
  ) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (err) {
      // 权限拒绝或写入失败：打印并继续尝试 fallback
      console.warn(
        "[clipboard] navigator.clipboard.writeText failed, falling back to execCommand:",
        err instanceof Error ? err.message : err,
      );
    }
  } else {
    console.warn(
      "[clipboard] navigator.clipboard 不可用（非安全上下文），使用 execCommand fallback",
    );
  }

  // 2) 回退：隐藏 textarea + execCommand("copy")
  // execCommand 已被标记废弃，但在非安全上下文下仍是唯一可靠的本地复制手段
  const textarea = document.createElement("textarea");
  textarea.value = text;
  // 移出视口，避免滚动跳动；保留可聚焦/可选中
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "0";
  textarea.style.opacity = "0";
  textarea.setAttribute("readonly", "");
  document.body.appendChild(textarea);

  try {
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    const ok = document.execCommand("copy");
    if (!ok) {
      throw new Error("execCommand('copy') returned false");
    }
  } finally {
    document.body.removeChild(textarea);
  }
}
