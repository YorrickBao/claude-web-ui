import { useEffect, useRef, useState } from "react";

/**
 * 上下文占用比例环形指示器。
 * 不显示数字，纯环形图表示已用比例。
 * 点击弹出 Popover 显示百分比 + 实际 token 数 / 窗口总数。
 *
 * used  = 当前已使用的 input tokens
 * max   = 上下文窗口上限（默认 200k）
 */
export interface ContextUsageRingProps {
  used: number;
  max?: number;
}

const DEFAULT_MAX = 200_000;
const R = 6;
const STROKE = 2;
const SIZE = 16;
const CX = SIZE / 2;
const CY = SIZE / 2;
const CIRCUMFERENCE = 2 * Math.PI * R;

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function ContextUsageRing({
  used,
  max = DEFAULT_MAX,
}: ContextUsageRingProps) {
  const [open, setOpen] = useState(false);
  const ratio = Math.min(used / max, 1);

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

  let strokeColor: string;
  if (ratio < 0.4) {
    strokeColor = "oklch(62.7% 0.19 145)";
  } else if (ratio < 0.7) {
    strokeColor = "oklch(77% 0.15 85)";
  } else if (ratio < 0.9) {
    strokeColor = "oklch(70% 0.18 55)";
  } else {
    strokeColor = "oklch(58% 0.22 25)";
  }

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

      {/* Popover */}
      {open && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setOpen(false)}
          />
          <div className="absolute left-1/2 bottom-full z-50 mb-2 -translate-x-1/2 rounded-lg border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-lg whitespace-nowrap">
            <div className="font-semibold text-sm">
              {Math.round(ratio * 100)}%
            </div>
            <div className="text-muted-foreground">
              {formatTokens(used)} / {formatTokens(max)} tokens
            </div>
          </div>
        </>
      )}
    </div>
  );
}
