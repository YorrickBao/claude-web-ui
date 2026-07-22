import fsp from "node:fs/promises";
import path from "node:path";
import type { SlashCommand } from "./types.js";

/**
 * 内置斜杠命令的描述映射表。
 * SDK 的 system/init 只返回命令名字符串，这里补全描述和参数提示。
 */
const BUILTIN: Record<string, { description: string; argumentHint?: string }> = {
  "/clear":     { description: "清空对话历史" },
  "/compact":   { description: "压缩对话上下文", argumentHint: "[保留最近N轮]" },
  "/context":   { description: "显示当前上下文和用量信息" },
  "/cost":      { description: "显示本次会话费用估算" },
  "/usage":     { description: "查看 API 用量统计" },
  "/help":      { description: "显示可用命令帮助" },
  "/init":      { description: "初始化项目 CLAUDE.md 文件" },
  "/todos":     { description: "查看当前任务列表" },
  "/status":    { description: "显示会话状态" },
  "/permissions": { description: "查看和管理权限设置" },
  "/model":     { description: "切换模型", argumentHint: "[模型名]" },
  "/output-style": { description: "设置输出风格" },
  "/add-dir":   { description: "添加工作目录", argumentHint: "[路径]" },
  "/ide":       { description: "管理 IDE 集成" },
  "/agents":    { description: "管理子代理" },
};

/**
 * 尝试从 .claude/commands/*.md 目录解析自定义命令的描述。
 * 每个 .md 文件就是一个命令，文件名就是命令名，第一行 # 标题作为描述。
 */
async function readCustomCommands(cwd: string): Promise<SlashCommand[]> {
  const commandsDir = path.join(cwd, ".claude", "commands");
  try {
    const entries = await fsp.readdir(commandsDir, { withFileTypes: true });
    const commands: SlashCommand[] = [];
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith(".md")) continue;
      const name = "/" + e.name.replace(/\.md$/, "");
      try {
        // 读前 200 字节提取第一行标题作为描述
        const fd = await fsp.open(path.join(commandsDir, e.name), "r");
        const buf = Buffer.alloc(200);
        await fd.read(buf, 0, 200, 0);
        await fd.close();
        const content = buf.toString("utf-8");
        const titleMatch = content.match(/^#\s+(.+)$/m);
        commands.push({ name, description: titleMatch?.[1] ?? name });
      } catch {
        commands.push({ name, description: name });
      }
    }
    return commands;
  } catch {
    return [];
  }
}

/** cwd → commands 的内存缓存 */
const cache = new Map<string, { commands: SlashCommand[]; ts: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 分钟
const MAX_CACHE_SIZE = 50; // 防止无限增长

/**
 * 合并内置命令和项目的自定义命令，返回完整的命令列表。
 * 按 cwd 缓存 5 分钟。
 */
export async function resolveSlashCommands(cwd: string): Promise<SlashCommand[]> {
  const cached = cache.get(cwd);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.commands;
  }

  const custom = await readCustomCommands(cwd);
  const customNames = new Set(custom.map((c) => c.name));

  const result: SlashCommand[] = [];

  // 内置命令：优先，排除被自定义同名的
  for (const [name, info] of Object.entries(BUILTIN)) {
    if (!customNames.has(name)) {
      result.push({ name, ...info });
    }
  }

  // 自定义命令在后
  result.push(...custom);

  cache.set(cwd, { commands: result, ts: Date.now() });

  // 缓存项数超过上限时淘汰最旧的
  if (cache.size > MAX_CACHE_SIZE) {
    let oldestKey = "";
    let oldestTs = Infinity;
    for (const [k, v] of cache) {
      if (v.ts < oldestTs) {
        oldestTs = v.ts;
        oldestKey = k;
      }
    }
    cache.delete(oldestKey);
  }

  return result;
}
