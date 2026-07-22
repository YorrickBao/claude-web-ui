/**
 * 上下文占用比例环形指示器。
 * 不显示数字，纯环形图表示已用比例。
 *
 * used  = 当前已使用的 input tokens
 * max   = 上下文窗口上限（默认 200k）
 */
export interface ContextUsageRingProps {
  used: number;
  max?: number;
}

const DEFAULT_MAX = 200_000;
const R = 6; // 半径
const STROKE = 2; // 线条粗细
const SIZE = 16; // viewBox 尺寸
const CX = SIZE / 2;
const CY = SIZE / 2;
const CIRCUMFERENCE = 2 * Math.PI * R;

export function ContextUsageRing({ used, max = DEFAULT_MAX }: ContextUsageRingProps) {
  const ratio = Math.min(used / max, 1);
  const dash = CIRCUMFERENCE * ratio;
  const gap = CIRCUMFERENCE - dash;

  // 颜色：< 40% 绿色，40-70% 黄色，70-90% 橙色，> 90% 红色
  let strokeColor: string;
  if (ratio < 0.4) {
    strokeColor = "oklch(62.7% 0.19 145)"; // green
  } else if (ratio < 0.7) {
    strokeColor = "oklch(77% 0.15 85)"; // yellow/amber
  } else if (ratio < 0.9) {
    strokeColor = "oklch(70% 0.18 55)"; // orange
  } else {
    strokeColor = "oklch(58% 0.22 25)"; // red
  }

  return (
    <svg
      width={SIZE}
      height={SIZE}
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      className="shrink-0"
      aria-label={`上下文占用 ${Math.round(ratio * 100)}%`}
    >
      <title>{`上下文占用 ${Math.round(ratio * 100)}%`}</title>
      {/* 背景轨道 */}
      <circle
        cx={CX}
        cy={CY}
        r={R}
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.15}
        strokeWidth={STROKE}
      />
      {/* 占用弧 */}
      {ratio > 0 && (
        <circle
          cx={CX}
          cy={CY}
          r={R}
          fill="none"
          stroke={strokeColor}
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${gap}`}
          strokeDashoffset={CIRCUMFERENCE * 0.25} // 从 12 点钟方向开始
          transform={`rotate(-90 ${CX} ${CY})`}
          style={{
            transition: "stroke-dasharray 0.6s ease, stroke 0.6s ease",
          }}
        />
      )}
    </svg>
  );
}
