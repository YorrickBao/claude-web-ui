import type {
  SessionKey,
  SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import fsp from "node:fs/promises";
import path from "node:path";
import { HOME_DIR } from "../env.js";

/**
 * 基于 SessionStore 接口的会话存储适配器
 * 镜像 SDK 的会话转录到本地文件，实现 CLI 和 WebUI 共享
 */
export class LocalSessionStore {
  private storeDir: string;

  constructor(storeDir: string) {
    this.storeDir = storeDir;
  }

  /**
   * 会话存储目录（与 CLI 同步）
   */
  private getTranscriptDir(): string {
    return path.join(this.storeDir, "transcripts");
  }

  /**
   * 写入会话转录条目
   */
  async append(
    key: SessionKey,
    entries: SessionStoreEntry[],
    _options?: { mtime?: number },
  ): Promise<void> {
    const { sessionId, subpath } = key;
    const dir = subpath ? path.join(this.getTranscriptDir(), subpath) : this.getTranscriptDir();
    const fileName = subpath ? `${sessionId}-${subpath}` : `ses_${sessionId}`;
    const filePath = path.join(dir, `${fileName}.jsonl`);

    // 确保目录存在
    await fsp.mkdir(dir, { recursive: true });

    // 追加写入（追加模式）
    const content = entries
      .map((e) => JSON.stringify(e))
      .join("\n") + "\n";

    await fsp.appendFile(filePath, content, "utf8");
  }

  /**
   * 加载会话转录
   */
  async load(key: SessionKey): Promise<SessionStoreEntry[]> {
    const { sessionId, subpath } = key;
    const dir = subpath ? path.join(this.getTranscriptDir(), subpath) : this.getTranscriptDir();
    const fileName = subpath ? `${sessionId}-${subpath}` : `ses_${sessionId}`;
    const filePath = path.join(dir, `${fileName}.jsonl`);

    try {
      const content = await fsp.readFile(filePath, "utf8");
      return content
        .trim()
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  }

  /**
   * 列出所有会话（可选实现）
   */
  async listSessions(): Promise<any[]> {
    const entries: any[] = [];
    const dir = this.getTranscriptDir();

    try {
      const files = await fsp.readdir(dir, { withFileTypes: true });

      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;

        const filePath = path.join(dir, file.name);
        const stat = await fsp.stat(filePath);

        // 从文件名提取 sessionId（如果是 ses_<id>.jsonl）
        const match = file.name.match(/^ses_([a-f0-9-]+)\.jsonl$/);
        if (!match) continue;

        const sessionId = match[1];
        const entry: any = {
          key: { sessionId },
          mtime: stat.mtimeMs,
          data: { _raw: true },
        };

        entries.push(entry);
      }
    } catch {
      // 目录不存在，返回空数组
    }

    return entries;
  }

  /**
   * 列出子会话（可选实现）
   */
  async listSubkeys(key: SessionKey): Promise<string[]> {
    const { sessionId } = key;
    const dir = path.join(this.getTranscriptDir(), "subagents");

    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory() && e.name.startsWith(sessionId))
        .map((e) => `subagents/${e.name}`);
    } catch {
      return [];
    }
  }

  /**
   * 删除会话（可选实现）
   */
  async delete(key: SessionKey): Promise<void> {
    const { sessionId, subpath } = key;
    const dir = subpath ? path.join(this.getTranscriptDir(), subpath) : this.getTranscriptDir();
    const fileName = subpath ? `${sessionId}-${subpath}` : `ses_${sessionId}`;
    const filePath = path.join(dir, `${fileName}.jsonl`);

    try {
      await fsp.unlink(filePath);
    } catch {
      // 文件不存在，忽略
    }
  }
}

/**
 * 创建全局 SessionStore 实例
 * 存储位置：~/.claude-webui/sessions
 */
export const sessionStore = new LocalSessionStore(
  path.join(HOME_DIR, ".claude-webui", "sessions"),
);
