/**
 * Claude Code 版本号缓存。
 *
 * 权威来源是 SDK init 消息的 claude_code_version——实际跑起来的那个 CLI
 * 自报的版本（SDK 自带的 native binary，而非 PATH 上的全局 claude；二者
 * 可能不同，例如本机 PATH claude 是 2.1.206，而 SDK 实际跑的是 2.1.216）。
 *
 * 由 sdk.ts 在每个 query 的 init 事件回填；首个会话 init 之前为 null，
 * 前端此时只显示「Claude Code」标签不带版本。
 *
 * 不用 `claude --version`（取到的是 PATH 全局版本，可能与本工具实际运行的
 * 不符）；也不用 SDK manifest.version（当 pnpm 把平台原生可选依赖解析到
 * 略不同版本时，manifest 声明值与实际 binary 不一致）。
 */
let cached = null;
/** sdk.ts 在 init 事件里回填实际运行的 CLI 版本 */
export function setClaudeVersion(v) {
    if (v)
        cached = v;
}
export function getClaudeVersion() {
    return cached;
}
