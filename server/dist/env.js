import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** 仓库根目录（server/ 的上一级） */
export const ROOT_DIR = path.resolve(__dirname, "..", "..");
/** server/ 目录 */
export const SERVER_DIR = path.resolve(__dirname, "..");
/** 用户主目录（~） */
export const HOME_DIR = os.homedir();
/**
 * 数据目录（存 sessions.json 等）。
 * 优先级：$CLAUDE_WEB_UI_DATA → ~/.claude-web-ui/
 * npx/全局安装场景使用用户目录，避免数据随临时缓存丢失。
 */
export const DATA_DIR = process.env.CLAUDE_WEB_UI_DATA || path.join(HOME_DIR, ".claude-web-ui");
/** sessions.json 路径 */
export const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");
/** profiles.json 路径（所有环境变量配置） */
export const PROFILES_FILE = path.join(DATA_DIR, "profiles.json");
/** 前端构建产物（生产模式静态托管） */
export const WEB_DIST_DIR = path.join(ROOT_DIR, "web", "dist");
/** 监听起始端口（占用则 +1 重试） */
export const START_PORT = Number(process.env.PORT ?? 23456);
/** 监听地址（纯本地部署） */
export const HOST = process.env.HOST ?? "127.0.0.1";
