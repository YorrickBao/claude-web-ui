import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import YAML from "yaml";
/**
 * 内置斜杠命令的描述映射表。
 * SDK 的 system/init 只返回命令名字符串，这里补全描述和参数提示。
 */
const BUILTIN = {
    "/clear": { description: "清空对话历史" },
    "/compact": { description: "压缩对话上下文", argumentHint: "[保留最近N轮]" },
    "/context": { description: "显示当前上下文和用量信息" },
    "/cost": { description: "显示本次会话费用估算" },
    "/usage": { description: "查看 API 用量统计" },
    "/help": { description: "显示可用命令帮助" },
    "/init": { description: "初始化项目 CLAUDE.md 文件" },
    "/todos": { description: "查看当前任务列表" },
    "/status": { description: "显示会话状态" },
    "/permissions": { description: "查看和管理权限设置" },
    "/model": { description: "切换模型", argumentHint: "[模型名]" },
    "/output-style": { description: "设置输出风格" },
    "/add-dir": { description: "添加工作目录", argumentHint: "[路径]" },
    "/ide": { description: "管理 IDE 集成" },
    "/agents": { description: "管理子代理" },
};
/** 用户主目录路径 */
const HOME = os.homedir();
/**
 * 从 .claude/commands/*.md 目录解析自定义命令。
 * 文件名就是命令名（去掉 .md），第一行 # 标题作为描述。
 */
async function readCommandsDir(dirPath) {
    try {
        const entries = await fsp.readdir(dirPath, { withFileTypes: true });
        const commands = [];
        for (const e of entries) {
            if (!e.isFile() || !e.name.endsWith(".md"))
                continue;
            const name = "/" + e.name.replace(/\.md$/, "");
            try {
                const raw = await fsp.readFile(path.join(dirPath, e.name), "utf-8");
                const titleMatch = raw.match(/^#\s+(.+)$/m);
                commands.push({ name, description: titleMatch?.[1] ?? name });
            }
            catch {
                commands.push({ name, description: name });
            }
        }
        return commands;
    }
    catch {
        return [];
    }
}
/**
 * 从 SKILL.md 中提取 `---` 包裹的 YAML frontmatter 文本，交给 yaml 库解析。
 * 不自己解析字段值——所有的块标量、引号、转义都交给成熟库处理。
 */
function parseSkillFrontmatter(raw) {
    if (!raw.startsWith("---"))
        return null;
    const endIdx = raw.indexOf("\n---", 3);
    if (endIdx < 0)
        return null;
    const fmText = raw.slice(4, endIdx); // 跳过开头的 "---\n"
    // yaml 库的 parse 接受纯 YAML 字符串（无 --- 分隔符）
    const parsed = YAML.parse(fmText);
    return parsed && typeof parsed === "object" ? parsed : null;
}
/**
 * 从 .claude/skills/<name>/SKILL.md 目录解析 skill。
 * 用成熟的 yaml 库解析 YAML frontmatter，覆盖所有边缘情况。
 */
async function readSkillsDir(dirPath) {
    try {
        const entries = await fsp.readdir(dirPath, { withFileTypes: true });
        const skills = [];
        for (const e of entries) {
            if (!e.isDirectory())
                continue;
            const skillFile = path.join(dirPath, e.name, "SKILL.md");
            try {
                const raw = await fsp.readFile(skillFile, "utf-8");
                const fm = parseSkillFrontmatter(raw);
                if (fm) {
                    const name = "/" + (typeof fm.name === "string" ? fm.name : e.name);
                    const description = typeof fm.description === "string" ? fm.description : e.name;
                    skills.push({ name, description });
                }
                else {
                    skills.push({ name: "/" + e.name, description: e.name });
                }
            }
            catch {
                skills.push({ name: "/" + e.name, description: e.name });
            }
        }
        return skills;
    }
    catch {
        return [];
    }
}
/**
 * 从 installed_plugins.json 读取已安装插件，扫描每个插件的 skills/ 目录。
 * 插件目录结构：<installPath>/skills/<skill-name>/SKILL.md
 */
async function readPluginSkills() {
    const pluginsJson = path.join(HOME, ".claude", "plugins", "installed_plugins.json");
    try {
        const raw = await fsp.readFile(pluginsJson, "utf-8");
        const data = JSON.parse(raw);
        const skills = [];
        for (const entries of Object.values(data.plugins)) {
            const entry = entries[0];
            if (!entry?.installPath)
                continue;
            const skillsDir = path.join(entry.installPath, "skills");
            const pluginSkills = await readSkillsDir(skillsDir);
            skills.push(...pluginSkills);
        }
        return skills;
    }
    catch {
        return [];
    }
}
/** cwd → commands 的内存缓存 */
const cache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_SIZE = 50;
/**
 * 合并内置命令 + 项目级 + 用户级的自定义命令和 skills，返回完整命令列表。
 * 按 cwd 缓存 5 分钟。
 */
export async function resolveSlashCommands(cwd) {
    const cached = cache.get(cwd);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
        return cached.commands;
    }
    // 并行扫描五个来源
    const [projectCommands, projectSkills, userCommands, userSkills, pluginSkills] = await Promise.all([
        readCommandsDir(path.join(cwd, ".claude", "commands")),
        readSkillsDir(path.join(cwd, ".claude", "skills")),
        readCommandsDir(path.join(HOME, ".claude", "commands")),
        readSkillsDir(path.join(HOME, ".claude", "skills")),
        readPluginSkills(),
    ]);
    const customNames = new Set();
    const result = [];
    const addIfNew = (cmd) => {
        if (!customNames.has(cmd.name)) {
            customNames.add(cmd.name);
            result.push(cmd);
        }
    };
    // 优先级：内置 > 项目命令 > 项目 skill > 用户命令 > 用户 skill > 插件 skill
    for (const [name, info] of Object.entries(BUILTIN)) {
        result.push({ name, ...info });
        customNames.add(name);
    }
    for (const cmd of projectCommands)
        addIfNew(cmd);
    for (const cmd of projectSkills)
        addIfNew(cmd);
    for (const cmd of userCommands)
        addIfNew(cmd);
    for (const cmd of userSkills)
        addIfNew(cmd);
    for (const cmd of pluginSkills)
        addIfNew(cmd);
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
