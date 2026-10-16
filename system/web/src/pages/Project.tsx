import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, type Change, type ExternalState, type Meta, type MetricKey, useData } from '../api.ts';
import { LevelBadge, ResultBadge } from '../components/Badges.tsx';
import { ChangePanel } from '../components/ChangePanel.tsx';
import { PullRequests } from '../components/PullRequests.tsx';
import { Timeline } from '../components/Timeline.tsx';
import { date, num, short, signed } from '../format.ts';

type Filter = 'regressions' | 'measured' | 'high' | 'elevated' | 'pr' | 'all';
const PAGE = 100;
const busy = (e?: ExternalState | null) => !!e && e.status !== 'ready' && e.status !== 'error';

export function ProjectPage({ meta, onProjectsChanged }: { meta: Meta; onProjectsChanged: () => void }) {
  const { name = '' } = useParams();
  const nav = useNavigate();
  const res = useData(() => api.project(name), [name], { pollMs: 2000, poll: (d) => busy(d.project.external) });
  const [tab, setTab] = useState<'commits' | 'prs'>('commits');
  const [filter, setFilter] = useState<Filter>();
  const [limit, setLimit] = useState(PAGE);
  const [sel, setSel] = useState<Change>();
  const [patched, setPatched] = useState<Record<string, Change>>({});

  const data = res.data?.project.name === name ? res.data : undefined; // не показывать прошлый проект при переходе
  const changes = useMemo(() => (data?.changes ?? []).map((c) => patched[c.sha + c.kind] ?? c), [data, patched]);
  const p = data?.project;
  const ext = p?.external;
  const hasMeasured = changes.some((c) => c.measured);
  const scored = changes.some((c) => c.place != null);

  const filters = useMemo(() => {
    const all: [Filter, string, (c: Change) => boolean][] = [
      ['regressions', 'Регрессии', (c) => c.label === 'regression'],
      ['high', 'Высокий риск', (c) => c.level === 'high'],
      ['elevated', 'Повышенный', (c) => c.level === 'elevated'],
      ['measured', 'Измеренные', (c) => !!c.measured],
      ['pr', 'Pull request', (c) => c.kind === 'pr'],
      ['all', 'Все', () => true],
    ];
    return all.filter(([k]) => (hasMeasured || (k !== 'regressions' && k !== 'measured')) && (scored || (k !== 'high' && k !== 'elevated'))
      && (k !== 'pr' || changes.some((c) => c.kind === 'pr')));
  }, [hasMeasured, scored, changes]);
  const active = filter && filters.some(([k]) => k === filter) ? filter : filters[0]?.[0];

  const rows = useMemo(() => {
    const f = filters.find(([k]) => k === active)?.[2] ?? (() => true);
    return changes.filter(f).sort((a, b) => (a.place ?? 2) - (b.place ?? 2) || b.date.localeCompare(a.date));
  }, [changes, filters, active]);

  if (res.error && !data) return <p className="error">{res.error}</p>;
  if (!data || !p) return <p className="muted">Загрузка…</p>;
  const current = sel && (patched[sel.sha + sel.kind] ?? sel);
  const title = ext?.name ?? p.name;

  const refresh = async () => { await api.refreshExternal(p.name); onProjectsChanged(); res.reload(); };
  const remove = async () => {
    if (!confirm(`Удалить проект ${title} из панели (вместе с клоном)?`)) return;
    await api.deleteExternal(p.name);
    onProjectsChanged();
    nav('/');
  };

  return (
    <>
      <div className="title-row">
        <div>
          <h2>{title}</h2>
          <p className="lead" style={{ marginBottom: 12 }}>
            {p.url && <a href={p.url} target="_blank" rel="noreferrer">открыть на GitHub ↗</a>}
            {p.commits > 0 && <> · {num(p.commits)} коммитов{hasMeasured && <>, {num(p.measured)} измерено, регрессий: {num(p.regressions)}</>}</>}
            {ext?.branch && <> · ветка <code>{ext.branch}</code></>}
          </p>
        </div>
        {ext && meta.live && (
          <div className="row" style={{ gap: 8 }}>
            <button className="ghost" disabled={busy(ext)} onClick={refresh}>↻ Обновить</button>
            <button className="ghost danger" onClick={remove}>Удалить</button>
          </div>
        )}
      </div>

      {busy(ext) && <Progress e={ext!} />}
      {ext?.status === 'error' && (
        <div className="notice error-notice">Не удалось подготовить проект: {ext.message}
          {meta.live && <> · <button className="link" onClick={refresh}>попробовать снова</button></>}</div>
      )}

      {!busy(ext) && ext?.status !== 'error' && (
        <>
          <div className="tabs big">
            <button className={tab === 'commits' ? 'on' : ''} onClick={() => setTab('commits')}>Коммиты</button>
            {p.url?.startsWith('https://github.com/') && meta.live && (
              <button className={tab === 'prs' ? 'on' : ''} onClick={() => setTab('prs')}>Pull request'ы</button>
            )}
          </div>

          {tab === 'prs' ? (
            <PullRequests project={p.name} meta={meta} onAssessed={() => res.reload()} />
          ) : (
            <>
              {scored ? (
                <div className="card">
                  <h3>Прогноз{hasMeasured ? ' и замеры' : ''} во времени</h3>
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
                    {filters.map(([k, label, f]) => (
                      <button key={k} className={active === k ? 'on' : ''} onClick={() => { setFilter(k); setLimit(PAGE); }}>
                        {label} ({changes.filter(f).length})
                      </button>
                    ))}
                  </div>
                  <table>
                    <thead>
                      <tr>
                        <th>Дата</th><th>Изменение</th><th>Заголовок</th>{scored && <th>Прогноз</th>}
                        {hasMeasured && <th>Замер</th>}
                        {!current && hasMeasured && <><th className="num">Δ LCP, мс</th><th className="num">Δ INP, мс</th><th className="num">Δ TBT, мс</th></>}
                        {!current && !hasMeasured && <th className="num">Строк +/−</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.slice(0, limit).map((c) => (
                        <tr key={c.sha + c.kind} className={`click${current?.sha === c.sha ? ' sel' : ''}`} onClick={() => setSel(c)}>
                          <td className="muted">{date(c.date)}</td>
                          <td className="mono">{c.kind === 'pr' ? `PR #${c.pr}` : short(c.sha)}</td>
                          <td className="subject" style={current ? { maxWidth: 240 } : undefined} title={c.subject}>{c.subject || '—'}</td>
                          {scored && <td><LevelBadge level={c.level} place={current ? undefined : c.place} /></td>}
                          {hasMeasured && <td><ResultBadge change={c} /></td>}
                          {!current && hasMeasured && <><Delta c={c} k="lcp" /><Delta c={c} k="inp" /><Delta c={c} k="tbt" /></>}
                          {!current && !hasMeasured && <td className="num muted">+{num(c.k_la ?? 0)} / −{num(c.k_ld ?? 0)}</td>}
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
                  <ChangePanel change={current} project={p} meta={meta} onClose={() => setSel(undefined)}
                               onUpdate={(c) => setPatched((x) => ({ ...x, [c.sha + c.kind]: c }))} />
                )}
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}

const STEPS: [ExternalState['status'], string][] = [
  ['queued', 'В очереди'], ['clone', 'Скачивание истории'], ['features', 'Признаки изменений'], ['scoring', 'Прогноз'],
];

function Progress({ e }: { e: ExternalState }) {
  const idx = STEPS.findIndex(([s]) => s === e.status);
  const share = e.status === 'features' && e.total ? e.done / e.total : idx >= 3 ? 1 : 0;
  return (
    <div className="card">
      <h3>Готовлю проект — это займёт несколько минут</h3>
      <ol className="steps">
        {STEPS.map(([s, label], i) => (
          <li key={s} className={i < idx ? 'done' : i === idx ? 'now' : ''}>{i < idx ? '✓ ' : ''}{label}</li>
        ))}
      </ol>
      <div className="bar"><div style={{ width: `${Math.round(share * 100)}%` }} /></div>
      <p className="muted" style={{ marginBottom: 0 }}>
        {e.message}{e.status === 'features' && e.total ? ` — ${num(e.done)} из ${num(e.total)} коммитов` : ''}. Страницу можно не держать
        открытой: проект появится в меню слева.
      </p>
    </div>
  );
}

function Delta({ c, k }: { c: Change; k: MetricKey }) {
  const m = c.metrics?.[k];
  if (!m || m.delta == null) return <td className="num muted">—</td>;
  return <td className={`num${m.label === 'regression' ? ' res-regression' : ''}`}>{signed(m.delta)}</td>;
}
