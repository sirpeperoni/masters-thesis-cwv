import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, type Change, type Meta, type MetricKey, useData } from '../api.ts';
import { LevelBadge, ResultBadge } from '../components/Badges.tsx';
import { ChangePanel } from '../components/ChangePanel.tsx';
import { Timeline } from '../components/Timeline.tsx';
import { date, num, short, signed } from '../format.ts';

type Filter = 'regressions' | 'measured' | 'high' | 'pr' | 'all';
const FILTERS: [Filter, string][] = [
  ['regressions', 'Регрессии'], ['high', 'Высокий риск'], ['measured', 'Измеренные'], ['pr', 'Pull request'], ['all', 'Все'],
];
const PAGE = 100;

export function ProjectPage({ meta }: { meta: Meta }) {
  const { name = '' } = useParams();
  const res = useData(() => api.project(name), [name]);
  const [filter, setFilter] = useState<Filter>('regressions');
  const [limit, setLimit] = useState(PAGE);
  const [sel, setSel] = useState<Change>();
  const [patched, setPatched] = useState<Record<string, Change>>({});

  const changes = useMemo(
    () => (res.data?.changes ?? []).map((c) => patched[c.sha + c.kind] ?? c),
    [res.data, patched],
  );
  const rows = useMemo(() => {
    const f: Record<Filter, (c: Change) => boolean> = {
      regressions: (c) => c.label === 'regression',
      measured: (c) => !!c.measured,
      high: (c) => c.level === 'high',
      pr: (c) => c.kind === 'pr',
      all: () => true,
    };
    const out = changes.filter(f[filter]);
    // по риску, если прогноз есть, иначе — новые сверху
    return out.sort((a, b) => (a.place ?? 2) - (b.place ?? 2) || b.date.localeCompare(a.date));
  }, [changes, filter]);

  if (res.error) return <p className="error">{res.error}</p>;
  if (!res.data) return <p className="muted">Загрузка…</p>;
  const p = res.data.project;
  const scored = changes.some((c) => c.place != null);
  const current = sel && (patched[sel.sha + sel.kind] ?? sel);

  return (
    <>
      <h2>{p.name}</h2>
      <p className="lead">
        {p.url && <a href={p.url} target="_blank" rel="noreferrer">{p.url.replace('https://github.com/', '')}</a>} ·{' '}
        {num(p.commits)} коммитов, {num(p.measured)} измерено, регрессий: {num(p.regressions)}
        {p.prs ? `, pull request: ${p.prs}` : ''}
      </p>

      {scored ? (
        <div className="card">
          <h3>Прогноз и замеры во времени</h3>
          <Timeline changes={changes} selected={current?.sha} onSelect={(c) => setSel(c)} />
        </div>
      ) : (
        <div className="notice">
          Модель обучалась на этом проекте — прогноз для его коммитов не показывается (он был бы нечестным).
          Ниже — все замеры стенда.
        </div>
      )}

      <div className={current ? 'layout-split' : ''}>
        <div className="card" style={{ padding: '14px 0 0', overflowX: 'auto' }}>
          <div className="tabs" style={{ padding: '0 14px' }}>
            {FILTERS.filter(([k]) => scored || (k !== 'high')).map(([k, label]) => (
              <button key={k} className={filter === k ? 'on' : ''} onClick={() => { setFilter(k); setLimit(PAGE); }}>
                {label} ({changes.filter((c) => (k === 'all' ? true : k === 'regressions' ? c.label === 'regression' :
                  k === 'measured' ? c.measured : k === 'high' ? c.level === 'high' : c.kind === 'pr')).length})
              </button>
            ))}
          </div>
          <table>
            <thead>
              <tr>
                <th>Дата</th><th>Изменение</th><th>Заголовок</th>{scored && <th>Прогноз</th>}<th>Замер</th>
                {!current && <><th className="num">Δ LCP, мс</th><th className="num">Δ INP, мс</th><th className="num">Δ TBT, мс</th></>}
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, limit).map((c) => (
                <tr key={c.sha + c.kind} className={`click${current?.sha === c.sha ? ' sel' : ''}`} onClick={() => setSel(c)}>
                  <td className="muted">{date(c.date)}</td>
                  <td className="mono">{c.kind === 'pr' ? `PR #${c.pr}` : short(c.sha)}</td>
                  <td className="subject" style={current ? { maxWidth: 240 } : undefined} title={c.subject}>{c.subject || '—'}</td>
                  {scored && <td><LevelBadge level={c.level} place={current ? undefined : c.place} /></td>}
                  <td><ResultBadge change={c} /></td>
                  {!current && <><Delta c={c} k="lcp" /><Delta c={c} k="inp" /><Delta c={c} k="tbt" /></>}
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > limit && (
            <p style={{ padding: '0 14px' }}><button className="primary" onClick={() => setLimit(limit + PAGE)}>Показать ещё ({rows.length - limit})</button></p>
          )}
          {!rows.length && <p className="muted" style={{ padding: '0 14px' }}>Нет изменений в этом фильтре.</p>}
        </div>
        {current && (
          <ChangePanel change={current} project={p} meta={meta}
                       onUpdate={(c) => setPatched((x) => ({ ...x, [c.sha + c.kind]: c }))} />
        )}
      </div>
    </>
  );
}

function Delta({ c, k }: { c: Change; k: MetricKey }) {
  const m = c.metrics?.[k];
  if (!m || m.delta == null) return <td className="num muted">—</td>;
  return (
    <td className={`num${m.label === 'regression' ? ' res-regression' : ''}`}>
      {signed(m.delta)}
    </td>
  );
}
