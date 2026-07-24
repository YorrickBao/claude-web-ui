import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * 生成 RFC4122 v4 UUID。
 *
 * crypto.randomUUID() 仅在 secure context（https / localhost）可用，
 * 通过中转 http 或局域网 IP 访问时属于 insecure context，该方法不存在，
 * 需回退到基于 getRandomValues 的实现。
 */
export function uuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // 回退实现：用 getRandomValues 填充 v4 UUID
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // version=4, variant=10xx
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}
