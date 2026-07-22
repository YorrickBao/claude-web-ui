import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 仓库根目录（server/ 的上一级） */
export const ROOT_DIR = path.resolve(__dirname, "..", "..");

/** server/ 目录 */
export const SERVER_DIR = path.resolve(__dirname, "..");

/** 数据目录（存 sessions.json 等） */
export const DATA_DIR = path.join(SERVER_DIR, "data");

/** sessions.json 路径 */
export const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");

/** profiles.json 路径（所有环境变量配置） */
export const PROFILES_FILE = path.join(DATA_DIR, "profiles.json");

/** 前端构建产物（生产模式静态托管） */
export const WEB_DIST_DIR = path.join(ROOT_DIR, "web", "dist");

/** 监听端口（dev 模式下 vite 也走这个端口的 /api 反代） */
export const PORT = Number(process.env.PORT ?? 25174);

/** 监听地址（纯本地部署） */
export const HOST = process.env.HOST ?? "127.0.0.1";
