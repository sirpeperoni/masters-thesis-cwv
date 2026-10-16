import { Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { Meta } from '../api.ts';
import { pct } from '../format.ts';

/** «Доля проверенных коммитов → доля найденных регрессий»: модель (с 95 % интервалом), «большой коммит», случайный выбор. */
export function BudgetChart({ curve }: { curve: NonNullable<Meta['budget_curve']> }) {
  const data = [
    { b: 0, model: 0, size: 0, random: 0, ci: [0, 0] as [number, number] },
    ...Object.entries(curve.budgets)
      .map(([b, p]) => ({ b: Number(b), model: p.model, size: p.size, random: p.random, ci: p.model_ci }))
      .sort((a, c) => a.b - c.b),
  ];
  return (
    <div>
      <ResponsiveContainer width="100%" height={320}>
        <ComposedChart data={data} margin={{ top: 10, right: 24, bottom: 8, left: 0 }}>
          <CartesianGrid stroke="var(--grid)" vertical={false} />
          <XAxis dataKey="b" type="number" domain={[0, 0.2]} ticks={[0, 0.05, 0.1, 0.15, 0.2]} tickFormatter={(v) => pct(v)}
                 stroke="var(--axis)" tick={{ fill: 'var(--muted)', fontSize: 12 }} />
          <YAxis domain={[0, 1]} ticks={[0, 0.2, 0.4, 0.6, 0.8, 1]} tickFormatter={(v) => pct(v)} width={52}
                 stroke="var(--axis)" tick={{ fill: 'var(--muted)', fontSize: 12 }} />
          <Tooltip content={<BudgetTip />} cursor={{ stroke: 'var(--axis)' }} />
          <Area dataKey="ci" stroke="none" fill="var(--series-1)" fillOpacity={0.12} isAnimationActive={false} />
          <Line dataKey="random" stroke="var(--muted)" strokeWidth={2} strokeDasharray="2 4" dot={false} isAnimationActive={false} />
          <Line dataKey="size" stroke="var(--series-2)" strokeWidth={2} strokeDasharray="6 3" dot={{ r: 4, strokeWidth: 2, fill: 'var(--surface)' }} isAnimationActive={false} />
          <Line dataKey="model" stroke="var(--series-1)" strokeWidth={2} dot={{ r: 4.5, strokeWidth: 2, fill: 'var(--surface)' }} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
      <div className="legend">
        <span><Swatch color="var(--series-1)" /> модель (95 % интервал — заливка)</span>
        <span><Swatch color="var(--series-2)" dash /> эвристика «большой коммит»</span>
        <span><Swatch color="var(--muted)" dash /> случайный выбор</span>
      </div>
    </div>
  );
}

function BudgetTip({ active, payload }: { active?: boolean; payload?: { payload: { b: number; model: number; size: number; random: number; ci: [number, number] } }[] }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  if (!p.b) return null;
  return (
    <div className="tip">
      <div className="muted">проверить {pct(p.b)} коммитов с наибольшим риском</div>
      <div><strong>{pct(p.model)}</strong> регрессий — модель <span className="muted">[{pct(p.ci[0])}; {pct(p.ci[1])}]</span></div>
      <div><strong>{pct(p.size)}</strong> — «большой коммит»</div>
      <div><strong>{pct(p.random)}</strong> — случайный выбор</div>
    </div>
  );
}

export function Swatch({ color, dash }: { color: string; dash?: boolean }) {
  return (
    <svg width="22" height="10" aria-hidden>
      <line x1="1" y1="5" x2="21" y2="5" stroke={color} strokeWidth="2" strokeDasharray={dash ? '5 3' : undefined} />
    </svg>
  );
}
