import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
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

/** 用户主目录路径 */
const HOME = os.homedir();

/**
 * 从 .claude/commands/*.md 目录解析自定义命令。
 * 文件名就是命令名（去掉 .md），第一行 # 标题作为描述。
 */
async function readCommandsDir(dirPath: string): Promise<SlashCommand[]> {
  try {
    const entries = await fsp.readdir(dirPath, { withFileTypes: true });
    const commands: SlashCommand[] = [];
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith(".md")) continue;
      const name = "/" + e.name.replace(/\.md$/, "");
      try {
        const raw = await fsp.readFile(path.join(dirPath, e.name), "utf-8");
        const titleMatch = raw.match(/^#\s+(.+)$/m);
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

/**
 * 从 YAML frontmatter 中提取单行或多行字段值。
 * 支持 `key: value`、`key: >-`（folded block scalar）和 `key: |`（literal block）。
 */
function parseFmField(frontmatter: string, field: string): string {
  const lines = frontmatter.split("\n");
  let i = lines.findIndex((l) => l.startsWith(field + ":"));
  if (i < 0) return "";
  const first = lines[i];

  // 单行值: "key: value"
  const inlineMatch = first.match(/^[^:]+:\s*(.+)$/);
  if (inlineMatch) {
    const val = inlineMatch[1].trim();
    // 如果值是 YAML 块指示符（>- / |），继续读缩进行
    if (val === ">-" || val === "|" || val === ">") {
      const parts: string[] = [];
      i++;
      while (i < lines.length) {
        const line = lines[i];
        if (!line.startsWith("  ") && !line.startsWith("\t")) break;
        const trimmed = line.trimStart();
        if (trimmed === "") {
          parts.push("");
        } else {
          parts.push(trimmed);
        }
        i++;
      }
      return parts.join(" ").replace(/\s+/g, " ").trim();
    }
    return val;
  }

  // 仅 key:（值在下一行缩进）
  i++;
  if (i < lines.length && lines[i].startsWith("  ")) {
    return lines[i].trim();
  }
  return "";
}

/**
 * 从 .claude/skills/<name>/SKILL.md 目录解析 skill。
 * 每个 skill 是一个子目录，内含 SKILL.md，YAML frontmatter 中
 * `name` 为命令名、`description` 为描述。
 */
async function readSkillsDir(dirPath: string): Promise<SlashCommand[]> {
  try {
    const entries = await fsp.readdir(dirPath, { withFileTypes: true });
    const skills: SlashCommand[] = [];
    for (const e of entries) {
      // 跳过普通文件和符号链接（符号链接指向外部 skill，暂不追踪）
      if (!e.isDirectory()) continue;
      const skillFile = path.join(dirPath, e.name, "SKILL.md");
      try {
        const raw = await fsp.readFile(skillFile, "utf-8");
        const content = raw.slice(0, 2048);
        const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
        if (fmMatch) {
          const cmdName = "/" + (parseFmField(fmMatch[1], "name") || e.name);
          const description = parseFmField(fmMatch[1], "description") || e.name;
          skills.push({ name: cmdName, description });
        } else {
          skills.push({ name: "/" + e.name, description: e.name });
        }
      } catch {
        skills.push({ name: "/" + e.name, description: e.name });
      }
    }
    return skills;
  } catch {
    return [];
  }
}

/** cwd → commands 的内存缓存 */
const cache = new Map<string, { commands: SlashCommand[]; ts: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_SIZE = 50;

/**
 * 合并内置命令 + 项目级 + 用户级的自定义命令和 skills，返回完整命令列表。
 * 按 cwd 缓存 5 分钟。
 */
export async function resolveSlashCommands(cwd: string): Promise<SlashCommand[]> {
  const cached = cache.get(cwd);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.commands;
  }

  // 并行扫描四个目录
  const [projectCommands, projectSkills, userCommands, userSkills] =
    await Promise.all([
      readCommandsDir(path.join(cwd, ".claude", "commands")),
      readSkillsDir(path.join(cwd, ".claude", "skills")),
      readCommandsDir(path.join(HOME, ".claude", "commands")),
      readSkillsDir(path.join(HOME, ".claude", "skills")),
    ]);

  // 自定义命令和 skill 的名称集合（用于去重）
  const customNames = new Set<string>();
  const result: SlashCommand[] = [];

  // 优先级：内置 > 项目命令 > 项目 skill > 用户命令 > 用户 skill
  const addIfNew = (cmd: SlashCommand) => {
    if (!customNames.has(cmd.name)) {
      customNames.add(cmd.name);
      result.push(cmd);
    }
  };

  // 内置命令优先
  for (const [name, info] of Object.entries(BUILTIN)) {
    result.push({ name, ...info });
    customNames.add(name);
  }

  // 项目级命令和 skill
  for (const cmd of projectCommands) addIfNew(cmd);
  for (const cmd of projectSkills) addIfNew(cmd);

  // 用户级命令和 skill
  for (const cmd of userCommands) addIfNew(cmd);
  for (const cmd of userSkills) addIfNew(cmd);

  cache.set(cwd, { commands: result, ts: Date.now() });

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
