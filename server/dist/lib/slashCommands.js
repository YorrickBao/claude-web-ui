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
/** LRU 式淘汰：缓存满时删掉最旧条目 */
function evictIfNeeded() {
    if (cache.size <= MAX_CACHE_SIZE)
        return;
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
/**
 * 用 BUILTIN 表给 SDK 返回的英文命令补中文描述。
 * 返回的对象 name 带 `/`，description 优先用 BUILTIN（中文），argumentHint 同理。
 */
function localizeSdkCommand(nameWithSlash, sdkCmd) {
    const builtin = BUILTIN[nameWithSlash];
    return {
        name: nameWithSlash,
        description: builtin?.description ?? sdkCmd.description,
        ...(builtin?.argumentHint
            ? { argumentHint: builtin.argumentHint }
            : sdkCmd.argumentHint
                ? { argumentHint: sdkCmd.argumentHint }
                : {}),
    };
}
/**
 * 把 SDK 的 supportedCommands() 结果写入缓存。
 *
 * SDK 返回的列表是"当前环境真正可用的命令"（含交互式面板命令在 headless 下被剔除），
 * 以它为权威；BUILTIN 表仅用于补中文描述。aliases 展开为独立条目以便补全匹配。
 *
 * 注意：SDK 的 commands 只含 CLI 内置命令 + skills，不含用户 .claude/commands/*.md
 * 自定义命令文件。后者由 resolveSlashCommands 在读取时动态追加（见下方）。
 */
export function cacheSlashCommands(cwd, sdkCommands) {
    const commands = [];
    const seen = new Set();
    const push = (cmd) => {
        if (!seen.has(cmd.name)) {
            seen.add(cmd.name);
            commands.push(cmd);
        }
    };
    for (const cmd of sdkCommands) {
        const nameWithSlash = "/" + cmd.name.replace(/^\/+/, "");
        push(localizeSdkCommand(nameWithSlash, cmd));
        // alias 展开为独立条目，方便补全按别名匹配
        if (cmd.aliases) {
            for (const alias of cmd.aliases) {
                push(localizeSdkCommand("/" + alias.replace(/^\/+/, ""), { ...cmd, name: alias }));
            }
        }
    }
    cache.set(cwd, { commands, ts: Date.now() });
    evictIfNeeded();
}
/**
 * 返回完整命令列表。优先读缓存（由 runQuery 的 supportedCommands 填充，
 * 反映当前环境真实可用命令）；缓存未命中时回退到 BUILTIN + 磁盘扫描。
 * 按 cwd 缓存 5 分钟。
 */
export async function resolveSlashCommands(cwd) {
    const cached = cache.get(cwd);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
        // 缓存命中：以 SDK 列表为准，追加磁盘扫描的自定义命令/skills（SDK 不含这些）。
        // 避免每次都扫磁盘——自定义命令/skills 同样缓存进 cached.commands，
        // 但为简单起见这里仍扫一次（磁盘扫描很快，且能感知用户运行中新增的命令文件）。
        const customCommands = await readCustomCommands(cwd);
        const seen = new Set(cached.commands.map((c) => c.name));
        const result = [...cached.commands];
        for (const cmd of customCommands) {
            if (!seen.has(cmd.name)) {
                seen.add(cmd.name);
                result.push(cmd);
            }
        }
        return result;
    }
    // 缓存未命中：回退到 BUILTIN + 磁盘扫描（首次冷启动 / SDK 探测失败时）
    const result = await resolveFromDisk(cwd);
    cache.set(cwd, { commands: result, ts: Date.now() });
    evictIfNeeded();
    return result;
}
/** 扫描项目级 + 用户级的自定义命令和 skills（不含内置命令） */
async function readCustomCommands(cwd) {
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
    // 优先级：项目命令 > 项目 skill > 用户命令 > 用户 skill > 插件 skill
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
    return result;
}
/** 缓存未命中时的兜底：BUILTIN 写死表 + 磁盘扫描自定义命令 */
async function resolveFromDisk(cwd) {
    const customNames = new Set();
    const result = [];
    const addIfNew = (cmd) => {
        if (!customNames.has(cmd.name)) {
            customNames.add(cmd.name);
            result.push(cmd);
        }
    };
    // 内置命令无条件加入（兜底，可能含当前环境不支持的交互式命令）
    for (const [name, info] of Object.entries(BUILTIN)) {
        result.push({ name, ...info });
        customNames.add(name);
    }
    for (const cmd of await readCustomCommands(cwd))
        addIfNew(cmd);
    return result;
}
