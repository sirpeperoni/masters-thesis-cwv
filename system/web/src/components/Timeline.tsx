import { CartesianGrid, ReferenceLine, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis } from 'recharts';
import type { Change } from '../api.ts';
import { date, LEVEL, short, topShare } from '../format.ts';

interface Point { x: number; y: number; c: Change }

/**
 * Коммиты проекта во времени: высота — риск по прогнозу (100 — самый рискованный коммит проекта),
 * форма и цвет — результат замера: ▲ регрессия, ● измерен без регрессии, · не измерен, ◆ pull request.
 */
export function Timeline({ changes, selected, onSelect }: { changes: Change[]; selected?: string; onSelect: (c: Change) => void }) {
  const pts = (f: (c: Change) => boolean): Point[] =>
    changes.filter((c) => c.place != null && f(c)).map((c) => ({ x: Date.parse(c.date), y: (1 - (c.place as number)) * 100, c }));
  const unmeasured = pts((c) => !c.measured && c.kind === 'commit');
  const ok = pts((c) => !!c.measured && c.label !== 'regression' && c.kind === 'commit');
  const regression = pts((c) => c.label === 'regression' && c.kind === 'commit');
  const prs = pts((c) => c.kind === 'pr');
  const click = (p: { payload?: Point }) => p?.payload && onSelect(p.payload.c);
  const sel = changes.find((c) => c.sha === selected && c.place != null);
  const xs = changes.filter((c) => c.place != null).map((c) => Date.parse(c.date));
  const domain: [number, number] = xs.length ? [Math.min(...xs), Math.max(...xs)] : [0, 1];
  const ticks = monthTicks(xs);

  return (
    <div>
      <ResponsiveContainer width="100%" height={340}>
        <ScatterChart margin={{ top: 10, right: 24, bottom: 8, left: 0 }}>
          <CartesianGrid stroke="var(--grid)" vertical={false} />
          <XAxis dataKey="x" type="number" domain={domain} scale="time" stroke="var(--axis)" ticks={ticks}
                 tickFormatter={(v) => new Date(v).toLocaleDateString('ru-RU', { month: 'short', year: 'numeric' }).replace(' г.', '')}
                 tick={{ fill: 'var(--muted)', fontSize: 12 }} />
          <YAxis dataKey="y" type="number" domain={[0, 100]} ticks={[0, 20, 40, 60, 80, 95, 100]} width={44}
                 stroke="var(--axis)" tick={{ fill: 'var(--muted)', fontSize: 12 }} />
          <ZAxis range={[40, 40]} />
          <ReferenceLine y={95} stroke="var(--critical)" strokeDasharray="4 4" label={{ value: 'верхние 5 %', position: 'insideBottomRight', fill: 'var(--muted)', fontSize: 11 }} />
          <ReferenceLine y={80} stroke="var(--warning)" strokeDasharray="4 4" label={{ value: 'верхние 20 %', position: 'insideBottomRight', fill: 'var(--muted)', fontSize: 11 }} />
          <Tooltip content={<Tip />} cursor={false} />
          <Scatter data={unmeasured} fill="var(--muted)" fillOpacity={0.35} shape="circle" onClick={click} isAnimationActive={false} />
          <Scatter data={ok} fill="var(--series-1)" fillOpacity={0.85} stroke="var(--surface)" strokeWidth={1} shape="circle" onClick={click} isAnimationActive={false} />
          <Scatter data={regression} fill="var(--critical)" stroke="var(--surface)" strokeWidth={1.5} shape="triangle" onClick={click} isAnimationActive={false} />
          <Scatter data={prs} fill="var(--series-2)" stroke="var(--surface)" strokeWidth={1.5} shape="diamond" onClick={click} isAnimationActive={false} />
          {sel && (
            <ReferenceLine x={Date.parse(sel.date)} stroke="var(--ink-2)" strokeDasharray="2 2" />
          )}
        </ScatterChart>
      </ResponsiveContainer>
      <div className="legend">
        <span><Mark shape="tri" color="var(--critical)" /> регрессия подтверждена замером ({regression.length})</span>
        <span><Mark shape="dot" color="var(--series-1)" /> измерен, регрессии нет ({ok.length})</span>
        <span><Mark shape="dot" color="var(--muted)" faint /> не измерен ({unmeasured.length})</span>
        {prs.length > 0 && <span><Mark shape="dia" color="var(--series-2)" /> pull request ({prs.length})</span>}
        <span className="muted">высота — риск по прогнозу: доля коммитов проекта ниже по риску, %</span>
      </div>
    </div>
  );
}

/** Подписи по началам месяцев: шаг 1, 2, 3, 6 или 12 месяцев — не больше 8 подписей. */
function monthTicks(xs: number[]): number[] {
  if (!xs.length) return [];
  const lo = new Date(Math.min(...xs)), hi = Math.max(...xs);
  const months = (new Date(hi).getFullYear() - lo.getFullYear()) * 12 + new Date(hi).getMonth() - lo.getMonth();
  const step = [1, 2, 3, 6, 12].find((s) => months / s <= 8) ?? 12;
  const out: number[] = [];
  const d = new Date(lo.getFullYear(), lo.getMonth() + 1, 1);
  while (d.getMonth() % step) d.setMonth(d.getMonth() + 1);
  for (; d.getTime() <= hi; d.setMonth(d.getMonth() + step)) out.push(d.getTime());
  return out;
}

function Tip({ active, payload }: { active?: boolean; payload?: { payload: Point }[] }) {
  if (!active || !payload?.length) return null;
  const c = payload[0].payload.c;
  return (
    <div className="tip">
      <div className="muted">{date(c.date)} · <span className="mono">{short(c.sha)}</span>{c.pr ? ` · PR #${c.pr}` : ''}</div>
      <div style={{ margin: '2px 0 4px' }}>{c.subject || '—'}</div>
      {c.level && c.place != null && <div>прогноз: <strong>{LEVEL[c.level].name}</strong> · {topShare(c.place)}</div>}
      <div>замер: <strong>{!c.measured ? 'не измерен' : c.label === 'regression' ? 'регрессия' : 'регрессии нет'}</strong></div>
    </div>
  );
}

function Mark({ shape, color, faint }: { shape: 'tri' | 'dot' | 'dia'; color: string; faint?: boolean }) {
  return (
    <svg width="12" height="12" aria-hidden>
      {shape === 'tri' && <polygon points="6,1 11,11 1,11" fill={color} />}
      {shape === 'dot' && <circle cx="6" cy="6" r="4.5" fill={color} fillOpacity={faint ? 0.4 : 1} />}
      {shape === 'dia' && <polygon points="6,0.5 11.5,6 6,11.5 0.5,6" fill={color} />}
    </svg>
  );
}
