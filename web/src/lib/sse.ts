import type { SSEEvent } from "@/lib/types";

/**
 * 从 fetch 的 ReadableStream 解析 SSE。
 *
 * 为什么不用 EventSource：EventSource 只支持 GET，且不能带 body。
 * 我们的接口是 POST，所以自己解析。
 *
 * SSE 规范很简单：
 *   event: <name>\n
 *   data: <json>\n
 *   \n (空行分隔事件)
 */
export async function* parseSSE(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SSEEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const onAbort = () => reader.cancel().catch(() => {});
  signal?.addEventListener("abort", onAbort);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // 按空行切事件
      let sepIdx: number;
      while ((sepIdx = buffer.indexOf("\n\n")) >= 0) {
        const rawEvent = buffer.slice(0, sepIdx);
        buffer = buffer.slice(sepIdx + 2);
        const evt = parseEventBlock(rawEvent);
        if (evt) yield evt;
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

function parseEventBlock(block: string): SSEEvent | null {
  const dataLines: string[] = [];

  for (const line of block.split("\n")) {
    // event: 行我们忽略 —— 后端约定 data.type 就是事件类型，以 data 为准
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trim());
    }
  }

  if (dataLines.length === 0) return null;
  const dataStr = dataLines.join("\n");

  try {
    const data: unknown = JSON.parse(dataStr);
    // 后端约定：event 名 == data.type；以 data 为准
    return data as SSEEvent;
  } catch {
    return null;
  }
}
