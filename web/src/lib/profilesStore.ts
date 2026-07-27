import { useEffect, useSyncExternalStore } from "react";
import { listProfiles } from "@/lib/api";
import type { EnvProfile } from "@/lib/types";

/**
 * 全局 profile 列表 store（模块级单例）。
 *
 * 为什么需要它：对话输入框的 profile Select 需要"选中 id（UUID）→ 显示 name"的
 * 映射表。若 profiles 列表比会话 meta 晚到，Select 会因映射表缺键而 fallback
 * 渲染原始 UUID（一闪而过）。把列表提到全局、在应用启动时即预取，可让 profiles
 * fetch 与会话 meta fetch 完全并行，消除串行竞态。
 *
 * 数据源唯一：所有消费方共享同一份缓存；SettingsPage 增删改后调 refreshProfiles()
 * 即可让全局同步更新。
 *
 * 错误处理纪律：
 * - 失败时保留旧数据，绝不把缓存毒化成空数组（否则一次瞬态失败会让全应用的
 *   profile Select 一起退化为只剩"默认"）。
 * - 失败时错误冒泡（re-throw），让 SettingsPage 等调用方能 catch 并展示错误 UI。
 * - ensureProfilesLoaded 失败时保持 loaded=false，使后续挂载可重试，避免长期卡空。
 */

type State = { profiles: EnvProfile[]; loaded: boolean };

let state: State = { profiles: [], loaded: false };
const listeners = new Set<() => void>();
let inflight: Promise<void> | null = null;

function emit() {
  listeners.forEach((fn) => fn());
}

function setState(next: State) {
  state = next;
  emit();
}

/** 幂等：已加载则立即 resolve；进行中复用同一 Promise；否则发起新请求 */
export function ensureProfilesLoaded(): Promise<void> {
  if (state.loaded) return Promise.resolve();
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const ps = await listProfiles();
      setState({ profiles: ps, loaded: true });
    } catch (err) {
      console.warn("profilesStore: 加载 profile 列表失败", (err as Error).message);
      // 保留旧数据（首屏为空数组），不标记 loaded，使后续挂载可重试
      setState({ profiles: state.profiles, loaded: false });
      throw err;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** 强制重新拉取（SettingsPage 增删改后调用，同步全局缓存）。复用进行中的请求避免重叠 */
export function refreshProfiles(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const ps = await listProfiles();
      setState({ profiles: ps, loaded: true });
    } catch (err) {
      console.warn("profilesStore: 刷新 profile 列表失败", (err as Error).message);
      // 保留旧数据，避免瞬态失败毒化全局缓存；标记 loaded=true（已尝试过，
      // 不必让消费方反复重试，由调用方决定是否重试）
      setState({ profiles: state.profiles, loaded: true });
      throw err;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** 乐观写入（如拖拽排序），loaded 保持 true，供消费方即时反映中间态 */
export function setProfiles(ps: EnvProfile[]): void {
  setState({ profiles: ps, loaded: true });
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): State {
  return state;
}

/** React 消费 hook：订阅全局 store，挂载时确保已触发加载 */
export function useProfiles(): State {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    void ensureProfilesLoaded();
  }, []);
  return snap;
}

// 模块加载即触发预取。配合 main.tsx 的 side-effect import，可在应用启动第一时间
// 发起 fetch，与路由解析 / chunk 加载 / 会话 meta fetch 完全并行。
void ensureProfilesLoaded();
