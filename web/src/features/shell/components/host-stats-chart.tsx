'use client';

import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

type TooltipPayloadEntry = { value?: number | string };

type CustomTipProps = {
  active?: boolean;
  payload?: TooltipPayloadEntry[];
  label?: string | number;
  valueSuffix?: string;
};

/** "now", "12m ago", or "3h ago" relative to the current time. */
function relTime(iso: string | number | undefined): string {
  if (iso === undefined) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const mins = Math.round((Date.now() - then) / 60_000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m ago`;
  return `${Math.round(mins / 60)}h ago`;
}

function CustomTip({ active, payload, label, valueSuffix }: CustomTipProps) {
  if (!active || !payload?.[0]) return null;
  const value = payload[0].value;
  const display = typeof value === 'number' ? Math.round(value) : value;
  return (
    <div
      className="rounded-[5px] px-[7px] py-1 font-mono text-[10px] font-medium whitespace-nowrap text-white shadow-lg"
      style={{ background: 'var(--text)' }}
    >
      {display}
      {valueSuffix ?? ''} · {relTime(label)}
    </div>
  );
}

export function MetricChart({
  data,
  color,
  dataKey,
  yMax,
  valueSuffix,
  stepped,
}: {
  data: Array<Record<string, unknown>>;
  color: string;
  dataKey: string;
  yMax: number | 'dataMax+1';
  valueSuffix?: string;
  stepped?: boolean;
}) {
  const gradientId = `grad-${dataKey}`;
  return (
    <ResponsiveContainer width="100%" height={44}>
      <AreaChart data={data} syncId="host-stats" margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.35} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <XAxis dataKey="t" hide />
        <YAxis hide domain={[0, yMax]} />
        <Tooltip
          cursor={{ stroke: 'var(--faint)', strokeDasharray: '3 3' }}
          content={<CustomTip valueSuffix={valueSuffix} />}
        />
        <Area
          type={stepped ? 'stepAfter' : 'monotone'}
          dataKey={dataKey}
          stroke={color}
          fill={`url(#${gradientId})`}
          strokeWidth={1.5}
          isAnimationActive={false}
          dot={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
