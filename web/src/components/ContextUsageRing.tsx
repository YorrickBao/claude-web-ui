import { useEffect, useRef, useState } from "react";

/**
 * 上下文占用环形指示器。
 *
 * 设计意图（与产品朱砂/Cinnabar 品牌色一致）：
 *   - 颜色阶梯用 OKLCH hue 25（品牌色相），只变明度+彩度，
 *     不再用通用仪表盘的绿→黄→红。低占用低饱和、高占用提亮提纯。
 *   - 暗色主题下提亮（亮度阈值抬高），避免深底上发灰。
 *   - 点击弹窗承载完整明细：占用比例 + 缓存命中量（prompt cache 的价值所在）。
 *
 * used             = 当前已使用的 input tokens（最近一轮 prompt 实际尺寸）
 * max              = 上下文窗口上限（默认 200k）
 * cacheReadTokens  = 会话累计缓存命中量（弹窗里展示，0 则不显示该行）
 */
export interface ContextUsageRingProps {
  used: number;
  max?: number;
  cacheReadTokens?: number;
}

const DEFAULT_MAX = 200_000;
const R = 6;
const STROKE = 2;
const SIZE = 16;
const CX = SIZE / 2;
const CY = SIZE / 2;
const CIRCUMFERENCE = 2 * Math.PI * R;

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * 占用比例 → 描边色。全部落在 OKLCH hue 25（朱砂色相），
 * 通过明度 L 和彩度 C 表达「越满越紧迫」：
 *   低占用：低彩度灰朱砂（安静）
 *   中占用：标准朱砂（提醒）
 *   高占用：亮纯朱砂（警示，接近 destructive 但保持品牌 hue）
 *
 * @param ratio 占用比例 [0,1]
 * @param dark 是否暗色主题（提亮以保证深底辨识度）
 */
function strokeColorFor(ratio: number, dark: boolean): string {
  if (dark) {
    if (ratio < 0.4) return "oklch(0.68 0.10 25)";
    if (ratio < 0.7) return "oklch(0.72 0.16 25)";
    if (ratio < 0.9) return "oklch(0.76 0.20 25)";
    return "oklch(0.72 0.22 27)";
  }
  if (ratio < 0.4) return "oklch(0.58 0.08 25)";
  if (ratio < 0.7) return "oklch(0.60 0.15 25)";
  if (ratio < 0.9) return "oklch(0.58 0.20 25)";
  return "oklch(0.55 0.22 27)";
}

export function ContextUsageRing({
  used,
  max = DEFAULT_MAX,
  cacheReadTokens = 0,
}: ContextUsageRingProps) {
  const [open, setOpen] = useState(false);
  const ratio = Math.min(used / max, 1);
  const dark = useDarkMode();
  const strokeColor = strokeColorFor(ratio, dark);

  // 动画状态：stroke-dasharray 始终从 0 → target，保证顺时针增长
  const [animDash, setAnimDash] = useState(0);
  const [animGap, setAnimGap] = useState(CIRCUMFERENCE);
  const [animating, setAnimating] = useState(false);
  const prevUsedRef = useRef(used);
  const prevMaxRef = useRef(max);

  useEffect(() => {
    const targetDash = CIRCUMFERENCE * Math.min(used / max, 1);
    const targetGap = CIRCUMFERENCE - targetDash;

    // 值没变则跳过
    if (prevUsedRef.current === used && prevMaxRef.current === max) return;
    prevUsedRef.current = used;
    prevMaxRef.current = max;

    // Phase 1：瞬间重置到 0（关闭过渡动画）
    setAnimating(false);
    setAnimDash(0);
    setAnimGap(CIRCUMFERENCE);

    // Phase 2：等待浏览器提交 Phase 1 的帧后，再开过渡动画增长到目标值
    const raf1 = requestAnimationFrame(() => {
      const raf2 = requestAnimationFrame(() => {
        setAnimating(true);
        setAnimDash(targetDash);
        setAnimGap(targetGap);
      });
      return () => cancelAnimationFrame(raf2);
    });
    return () => cancelAnimationFrame(raf1);
  }, [used, max]);

  return (
    <div className="relative shrink-0">
      <svg
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className="shrink-0 cursor-pointer outline-none"
        role="button"
        tabIndex={0}
        aria-label={`上下文占用 ${Math.round(ratio * 100)}%`}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen(!open);
          }
        }}
      >
        <title>{`上下文占用 ${Math.round(ratio * 100)}%`}</title>
        <circle
          cx={CX}
          cy={CY}
          r={R}
          fill="none"
          stroke="currentColor"
          strokeOpacity={0.15}
          strokeWidth={STROKE}
        />
        {ratio > 0 && (
          <circle
            cx={CX}
            cy={CY}
            r={R}
            fill="none"
            stroke={strokeColor}
            strokeWidth={STROKE}
            strokeLinecap="round"
            strokeDasharray={`${animDash} ${animGap}`}
            transform={`rotate(-90 ${CX} ${CY})`}
            style={{
              transition: animating
                ? "stroke-dasharray 0.6s ease, stroke 0.6s ease"
                : "stroke 0.6s ease",
            }}
          />
        )}
      </svg>

      {/* 明细弹窗：占用比例 + 实际 token + 缓存命中量（prompt cache 的价值） */}
      {open && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setOpen(false)}
          />
          <div className="absolute left-1/2 bottom-full z-50 mb-2 -translate-x-1/2 rounded-lg border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-lg whitespace-nowrap">
            <div className="font-semibold text-sm tabular-nums">
              {Math.round(ratio * 100)}%
            </div>
            <div className="text-muted-foreground tabular-nums">
              {formatTokens(used)} / {formatTokens(max)} tokens
            </div>
            {cacheReadTokens > 0 && (
              <div className="mt-1 border-t border-border/60 pt-1 text-muted-foreground tabular-nums">
                缓存命中 {formatTokens(cacheReadTokens)}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** 监听 .dark 类，返回当前是否暗色主题。 */
function useDarkMode(): boolean {
  const [dark, setDark] = useState(() =>
    typeof document !== "undefined" && document.documentElement.classList.contains("dark"),
  );
  useEffect(() => {
    const el = document.documentElement;
    const observer = new MutationObserver(() => {
      setDark(el.classList.contains("dark"));
    });
    observer.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return dark;
}
