import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileP = promisify(execFile);
/**
 * 获取 Claude Code CLI 版本号（如 "2.1.206"）。
 *
 * spawn `claude --version`（输出形如 "2.1.206 (Claude Code)"，取首个空白前
 * 的 token）。SDK 默认就用 PATH 上的 claude，所以这里和它跑的是同一个 CLI。
 *
 * 成功结果进程内永久缓存（版本在进程生命周期内不会变）；失败不缓存，下次
 * 重试——避免 claude 暂时不可用时永久返回 null。
 */
let cached;
export async function getClaudeVersion() {
    if (cached !== undefined)
        return cached;
    try {
        const { stdout } = await execFileP("claude", ["--version"], {
            timeout: 5_000,
            maxBuffer: 1024,
        });
        const m = stdout.trim().match(/^(\S+)/);
        const v = m ? m[1] : null;
        if (v !== null)
            cached = v; // 只缓存成功
        return v;
    }
    catch {
        // claude 不在 PATH / 超时 / 非零退出：不缓存，下次重试
        return null;
    }
}
