import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ROOT_DIR } from "../env.js";

/** WebUI 自身版本（根 package.json） */
export const WEBUI_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(ROOT_DIR, "package.json"), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "";
  } catch {
    return "";
  }
})();

let claudeCodeVersion: string | null = null;

/** sdk.ts 在每个 query 的 init 事件回填实际运行的 CLI 版本 */
export function setClaudeVersion(v: string | null | undefined): void {
  if (v) claudeCodeVersion = v;
}

export function getClaudeVersion(): string | null {
  return claudeCodeVersion;
}

let priming: Promise<void> | null = null;

/**
 * 后台跑一个最小 query，从 init 消息捕获实际运行的 CLI 版本，随即中止并
 * 删除这个临时会话。打开设置页（/api/version）且尚未有版本时触发。
 *
 * 版本是 binary 级的（与 cwd/会话无关），用 homedir 即可。best-effort：
 * 失败（无凭证 / 超时）则静默，等首个真实会话的 init 回填。
 *
 * 为什么不用别的方式：
 * - PATH `claude --version`：取到的是全局安装版本，可能与本工具实际跑的
 *   SDK 自带 native binary 不一致（曾实测 PATH 2.1.206 vs 实际 2.1.216）。
 * - SDK manifest.version：当 pnpm 把平台原生可选依赖解析到略不同版本时，
 *   manifest 声明值与实际 binary 不一致（曾实测 manifest 2.1.218 vs 2.1.216）。
 * init 的 claude_code_version 是实际运行的 CLI 自报，唯一可靠。
 */
export function primeClaudeVersion(): void {
  if (claudeCodeVersion || priming) return;
  priming = (async () => {
    try {
      const { query, deleteSession } = await import(
        "@anthropic-ai/claude-agent-sdk"
      );
      const ctrl = new AbortController();
      let sid: string | undefined;
      const stream = query({
        prompt: ".",
        options: {
          cwd: os.homedir(),
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          abortController: ctrl,
          maxTurns: 1,
        },
      });
      for await (const msg of stream as AsyncIterable<SDKMessage>) {
        if (
          msg.type === "system" &&
          (msg as { subtype?: string }).subtype === "init"
        ) {
          setClaudeVersion(
            (msg as { claude_code_version?: string }).claude_code_version,
          );
          sid = (msg as { session_id?: string }).session_id;
          break;
        }
      }
      ctrl.abort();
      if (sid) await deleteSession(sid).catch(() => {});
    } catch {
      // 忽略：首个真实会话会回填
    } finally {
      priming = null;
    }
  })();
}
